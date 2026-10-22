/**
 * PCL3 Web UI 前端逻辑。
 *
 * 约束：纯原生 JS，无框架、无 CDN、无构建步骤。浏览器直接跑源码。
 *
 * 设计原则（这次踩坑换来的）：
 *   1. **加载失败必须让用户看见**。任何 fetch 失败都要把错误写进对应区域，
 *      绝不允许界面永远停在「正在加载…」——那和静默失败没区别。
 *   2. 每次请求都带超时（AbortController），卡住的请求不能把 UI 锁死。
 *   3. 轮询有上限、有间隔退避，任务结束/页面隐藏时停掉，不烧 CPU。
 *   4. 所有用户可见文案一律中文、一律人话，不暴露 `[object Object]`。
 */
(function () {
  'use strict';

  // ───────────────────────────── 小工具 ─────────────────────────────

  var $ = function (id) {
    return document.getElementById(id);
  };

  /** 把任意错误翻成人话 */
  function messageOf(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    if (error.name === 'AbortError') return '请求超时（服务器没有响应）';
    if (error instanceof Error && error.message) return error.message;
    try {
      return JSON.stringify(error);
    } catch (e) {
      return String(error);
    }
  }

  /**
   * 统一的 API 调用：带超时、带 JSON 解析、错误里带 HTTP 状态码。
   * 服务端约定所有错误都是 `{ error: "人话" }`，这里优先取它。
   */
  function api(path, options) {
    var opts = options || {};
    var timeoutMs = opts.timeoutMs || 20000;
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);

    var init = {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    return fetch(path, init)
      .then(function (res) {
        return res
          .text()
          .then(function (text) {
            var data = null;
            if (text) {
              try {
                data = JSON.parse(text);
              } catch (e) {
                data = null;
              }
            }
            if (!res.ok) {
              var detail = data && data.error ? data.error : text || '（无响应内容）';
              var err = new Error('HTTP ' + res.status + '：' + detail);
              err.status = res.status;
              err.body = data;
              throw err;
            }
            if (data === null) {
              throw new Error('服务器返回的不是 JSON：' + String(text).slice(0, 160));
            }
            return data;
          });
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') {
          throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒无响应）：' + path);
        }
        if (error instanceof TypeError && /fetch/i.test(String(error.message))) {
          throw new Error('连不上本地服务，请确认 pcl3 web 还在运行：' + path);
        }
        throw error;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  /** 把文本安全地塞进 DOM（一律 textContent，杜绝 HTML 注入） */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatTime(iso) {
    if (!iso) return '—';
    // 元数据里是 2024-06-13T08:24:03+00:00
    var text = String(iso);
    var datePart = text.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : text;
  }

  var TYPE_LABEL = {
    release: '正式版',
    snapshot: '快照',
    old_beta: '旧 Beta',
    old_alpha: '旧 Alpha'
  };

  // ───────────────────────────── 应用状态 ─────────────────────────────

  var state = {
    versions: [],
    /** 客户端展示用的完整清单（服务器只按 limit 给了前 N 条） */
    shown: 0,
    total: 0,
    installed: {},
    /** 已装的加载器 profile（fabric-loader-… / quilt-loader-…），服务器在 /api/versions 里一并给出 */
    loaderProfiles: [],
    account: localStorage.getItem('pcl3.username') || '',
    jobId: null,
    jobTimer: null,
    jobLogOffset: 0,
    logLines: 0,
    lastJobStatus: null,
    /** 加载器弹窗当前上下文 */
    loader: {
      kind: 'fabric',
      gameVersion: '',
      versions: [],
      busy: false
    }
  };

  var MAX_LOG_LINES = 1500;

  // ───────────────────────────── 顶栏错误提示 ─────────────────────────────

  var errorTimer = null;
  function showError(text, sticky) {
    var node = $('footer-error');
    if (!node) return;
    node.textContent = '⚠ ' + text;
    node.hidden = false;
    if (errorTimer) clearTimeout(errorTimer);
    if (!sticky) {
      errorTimer = setTimeout(function () {
        node.hidden = true;
        node.textContent = '';
      }, 12000);
    }
  }

  function clearError() {
    var node = $('footer-error');
    if (!node) return;
    node.hidden = true;
    node.textContent = '';
  }

  function toast(text, ok) {
    var existing = document.querySelector('.toast');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var node = el('div', ok === true ? 'toast is-ok' : 'toast', text);
    document.body.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 6000);
  }

  // ───────────────────────────── 日志面板 ─────────────────────────────

  function appendLog(text, level, time) {
    var box = $('log');
    if (!box) return;
    if (state.logLines === 0) box.textContent = '';

    var atTop = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;

    var line = el('span', 'l-line');
    if (time) {
      var stamp = new Date(time);
      var hh = ('0' + stamp.getHours()).slice(-2);
      var mm = ('0' + stamp.getMinutes()).slice(-2);
      var ss = ('0' + stamp.getSeconds()).slice(-2);
      line.appendChild(el('span', 'l-time', '[' + hh + ':' + mm + ':' + ss + '] '));
    }
    line.appendChild(el('span', 'l-' + (level || 'info'), text));
    line.appendChild(document.createTextNode('\n'));
    box.appendChild(line);

    state.logLines += 1;
    while (box.childNodes.length > MAX_LOG_LINES) {
      box.removeChild(box.firstChild);
      state.logLines -= 1;
    }

    // 只有用户本来就在底部时才自动跟随，避免打断向上翻看
    if (atTop) box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    var box = $('log');
    if (!box) return;
    box.textContent = '等待输出…';
    state.logLines = 0;
  }

  // ───────────────────────────── 顶栏状态 ─────────────────────────────

  function setChip(chipId, valueId, ok, text) {
    var chip = $(chipId);
    var value = $(valueId);
    if (value) value.textContent = text;
    if (!chip) return;
    var dot = chip.querySelector('.dot');
    if (dot) {
      dot.className = 'dot ' + (ok === true ? 'dot-ok' : ok === false ? 'dot-bad' : 'dot-idle');
    }
  }

  function loadStatus() {
    return api('/api/status', { timeoutMs: 25000 })
      .then(function (data) {
        setChip('chip-data-root', 'data-root', true, data.dataRoot || '未知');
        $('data-root').title = data.dataRoot || '';

        var java = data.java || {};
        var javaText = java.found
          ? 'Java ' + (java.majorVersion || '?') + '（' + (java.requiredMajor || '?') + '+ 可用）'
          : '未安装';
        setChip('chip-java', 'java-value', java.found === true, javaText);
        $('chip-java').title = java.detail || '';

        $('installed-count').textContent = String(data.versionCount || 0);

        if (data.manifestError) {
          showError('版本元数据获取失败：' + data.manifestError, true);
        } else {
          clearError();
        }
        return data;
      })
      .catch(function (error) {
        setChip('chip-data-root', 'data-root', false, '不可用');
        setChip('chip-java', 'java-value', false, '不可用');
        showError('状态读取失败：' + messageOf(error), true);
        throw error;
      });
  }

  // ───────────────────────────── 版本列表 ─────────────────────────────

  var loadSeq = 0;

  function loadVersions() {
    var typeSel = $('filter-type');
    var type = typeSel ? typeSel.value : 'release';
    var seq = ++loadSeq;

    setVersionsMessage('正在加载版本列表…', false);

    var query = '/api/versions?limit=200&type=' + encodeURIComponent(type);
    return api(query, { timeoutMs: 30000 })
      .then(function (data) {
        // 迟到的响应不能覆盖新一次请求的结果
        if (seq !== loadSeq) return;
        state.versions = Array.isArray(data.versions) ? data.versions : [];
        state.shown = data.shown || state.versions.length;
        state.total = data.total || 0;
        state.installed = {};
        (data.installed || []).forEach(function (id) {
          state.installed[id] = true;
        });
        state.loaderProfiles = Array.isArray(data.loaderProfiles) ? data.loaderProfiles : [];
        renderVersions();
      })
      .catch(function (error) {
        if (seq !== loadSeq) return;
        state.versions = [];
        setVersionsMessage('版本列表加载失败：' + messageOf(error), true, true);
        showError('版本列表加载失败：' + messageOf(error), true);
      });
  }

  function setVersionsMessage(text, isError, withRetry) {
    var host = $('version-list');
    if (!host) return;
    host.textContent = '';
    var p = el('p', isError ? 'empty error-text' : 'empty', text);
    host.appendChild(p);
    if (withRetry) {
      var btn = el('button', 'btn btn-ghost btn-sm', '重试');
      btn.type = 'button';
      btn.style.marginTop = '10px';
      btn.addEventListener('click', function () {
        loadVersions();
      });
      host.appendChild(btn);
    }
  }

  function matchesSearch(version) {
    var input = $('search');
    var keyword = input ? input.value.trim().toLowerCase() : '';
    if (!keyword) return true;
    return String(version.id).toLowerCase().indexOf(keyword) !== -1;
  }

  function renderVersions() {
    var host = $('version-list');
    if (!host) return;
    host.textContent = '';

    var list = state.versions.filter(matchesSearch);

    if (state.versions.length === 0) {
      setVersionsMessage('这个类型下没有拿到版本。换个类型选项试试，或点右上角「刷新清单」。', false);
      return;
    }
    if (list.length === 0) {
      setVersionsMessage('没有匹配的版本号。清空搜索框看看。', false);
      return;
    }

    var grid = el('div', 'version-grid');
    var frag = document.createDocumentFragment();

    /**
     * 已装的加载器卡片前置。
     * 理由：这些卡片是「我刚装好的东西」，落在 200 张原版卡片的最后等于没出现；
     * 只有搜索时才按其它卡片一样过滤，不额外排序。
     */
    loaderProfilesFor(list).forEach(function (profile) {
      frag.appendChild(buildLoaderCard(profile));
    });

    list.forEach(function (version) {
      frag.appendChild(buildCard(version));
    });

    grid.appendChild(frag);
    host.appendChild(grid);

    if (state.total > state.shown) {
      var note = el(
        'p',
        'empty',
        '共 ' + state.total + ' 个版本，这里显示最新 ' + state.shown + ' 个。用搜索框可以直接找到更早的版本。'
      );
      note.style.marginTop = '12px';
      host.appendChild(note);
    }
  }

  /**
   * 挑出「跟当前列表里的原版有关」的加载器 profile：
   * 只显示它是基于可见原版装的那种，避免搜「1.20」时刷出一堆 1.21 的加载器。
   */
  function loaderProfilesFor(list) {
    var visible = {};
    list.forEach(function (v) {
      visible[v.id] = true;
    });
    var keyword = $('search') ? $('search').value.trim().toLowerCase() : '';

    return (state.loaderProfiles || []).filter(function (p) {
      if (!p || !p.versionId) return false;
      if (keyword) return String(p.versionId).toLowerCase().indexOf(keyword) !== -1;
      // 没有搜索词时：只显示关联原版在当前结果里的（或者认不出关联关系的也显示）
      if (p.gameVersion && !visible[p.gameVersion]) return false;
      return true;
    });
  }

  var LOADER_NAME = { fabric: 'Fabric', quilt: 'Quilt' };

  function buildCard(version) {
    var installed = version.installed === true || state.installed[version.id] === true;

    var card = el('div', 'card' + (installed ? ' is-installed' : '') + (version.latest ? ' is-latest' : ''));
    card.setAttribute('data-version-id', version.id);

    card.appendChild(el('div', 'card-id', version.id));

    var meta = el('div', 'card-meta');
    var typeLabel = TYPE_LABEL[version.type] || version.type || '未知';
    meta.appendChild(el('span', 'tag tag-' + (version.type || 'other'), typeLabel));
    meta.appendChild(el('span', null, formatTime(version.releaseTime)));
    card.appendChild(meta);

    var actions = el('div', 'card-actions');

    if (installed) {
      var playBtn = el('button', 'btn btn-play', '启动');
      playBtn.type = 'button';
      playBtn.addEventListener('click', function () {
        startLaunch(version.id, playBtn);
      });
      actions.appendChild(playBtn);

      var reinstallBtn = el('button', 'btn btn-ghost', '重装');
      reinstallBtn.type = 'button';
      reinstallBtn.addEventListener('click', function () {
        startInstall(version.id, reinstallBtn);
      });
      actions.appendChild(reinstallBtn);

      // 内存 / JVM 参数：已装才有意义（要启动才有内存可分配）
      actions.appendChild(buildSettingsButton(version.id));
    } else {
      var installBtn = el('button', 'btn btn-primary', '安装');
      installBtn.type = 'button';
      installBtn.addEventListener('click', function () {
        startInstall(version.id, installBtn);
      });
      actions.appendChild(installBtn);
    }

    card.appendChild(actions);

    // 「装模组加载器」：原版没装也能点，弹窗里会明确告诉你先装原版
    var secondRow = el('div', 'card-actions');
    var loaderBtn = el('button', 'btn btn-ghost btn-loader', '装模组加载器');
    loaderBtn.type = 'button';
    loaderBtn.setAttribute('data-loader-entry', version.id);
    loaderBtn.addEventListener('click', function () {
      openLoaderModal(version.id);
    });
    secondRow.appendChild(loaderBtn);
    card.appendChild(secondRow);

    return card;
  }

  /** 卡片上的齿轮按钮：打开该版本的设置（内存 / JVM 参数 / Java 路径） */
  function buildSettingsButton(versionId) {
    var gear = el('button', 'btn btn-ghost btn-gear', '⚙');
    gear.type = 'button';
    gear.title = '版本设置（内存 / JVM 参数）';
    gear.setAttribute('aria-label', '版本设置');
    gear.setAttribute('data-settings-entry', versionId);
    gear.addEventListener('click', function () {
      openSettingsModal(versionId);
    });
    return gear;
  }

  /** 已装加载器版本的卡片：带 Fabric / Quilt 标签，可以启动或重装加载器 */
  function buildLoaderCard(profile) {
    var id = profile.versionId;
    var kind = profile.kind;
    var label = LOADER_NAME[kind] || '加载器';

    var card = el('div', 'card is-installed is-loader');
    card.setAttribute('data-version-id', id);
    card.setAttribute('data-loader-kind', kind || '');

    card.appendChild(el('div', 'card-id', id));

    var meta = el('div', 'card-meta');
    if (kind) {
      meta.appendChild(el('span', 'tag tag-loader tag-' + kind, label));
    } else {
      meta.appendChild(el('span', 'tag tag-loader', '加载器'));
    }
    if (profile.loaderVersion) {
      meta.appendChild(el('span', null, label + ' ' + profile.loaderVersion));
    }
    if (profile.gameVersion) {
      meta.appendChild(el('span', null, '基于 ' + profile.gameVersion));
    }
    card.appendChild(meta);

    var actions = el('div', 'card-actions');

    var playBtn = el('button', 'btn btn-play', '启动');
    playBtn.type = 'button';
    playBtn.addEventListener('click', function () {
      startLaunch(id, playBtn);
    });
    actions.appendChild(playBtn);

    var reinstallBtn = el('button', 'btn btn-ghost', '重装');
    reinstallBtn.type = 'button';
    reinstallBtn.addEventListener('click', function () {
      // 重装 = 用同一个原版再点一次「装模组加载器」，让用户在弹窗里确认版本
      openLoaderModal(profile.gameVersion || '');
    });
    actions.appendChild(reinstallBtn);

    // 加载器 profile 的设置是独立的：改内存不会影响它继承的原版设置
    actions.appendChild(buildSettingsButton(id));

    card.appendChild(actions);
    return card;
  }

  // ───────────────────────────── 任务面板 ─────────────────────────────

  var PHASE_LABEL = {
    starting: '准备中',
    plan: '计算安装计划',
    prepare: '准备启动',
    meta: '下载版本文件',
    libraries: '下载依赖库',
    natives: '解压原生库',
    assets: '下载游戏资源',
    running: '运行中',
    download: '下载文件',
    parse: '解析清单',
    vanilla: '安装原版',
    loader: '安装加载器',
    mods: '下载模组',
    overrides: '解压覆盖文件',
    done: '完成',
    failed: '失败'
  };

  function renderJob(job) {
    var card = $('job-card');
    var empty = $('job-empty');
    if (!card) return;

    card.hidden = false;
    if (empty) empty.hidden = true;

    $('job-title').textContent = job.title || job.kind || '任务';

    var badge = $('job-status');
    badge.textContent = job.status === 'done' ? '完成' : job.status === 'failed' ? '失败' : '进行中';
    badge.className = 'badge badge-' + job.status;

    var bar = $('job-bar');
    var ratio = typeof job.ratio === 'number' ? job.ratio : 0;
    if (job.status === 'failed') {
      bar.classList.remove('is-indeterminate');
      bar.style.width = '100%';
      bar.style.background = 'linear-gradient(90deg,#b93a31,#f2695c)';
    } else if (job.status === 'done') {
      bar.classList.remove('is-indeterminate');
      bar.style.background = '';
      bar.style.width = '100%';
    } else if (!job.total || job.total <= 0) {
      // 还没拿到总量：走不确定态动画，别显示一个假百分比
      bar.style.width = '';
      bar.classList.add('is-indeterminate');
    } else {
      bar.classList.remove('is-indeterminate');
      bar.style.background = '';
      bar.style.width = Math.round(ratio * 100) + '%';
    }

    $('job-phase').textContent = PHASE_LABEL[job.phase] || job.phase || '—';
    $('job-count').textContent =
      job.total > 0 ? String(job.done) + ' / ' + String(job.total) : job.total === 0 && job.done > 0 ? String(job.done) : '';

    if (job.status === 'running') {
      $('job-hint').textContent = '进行中…';
    } else if (job.status === 'done') {
      $('job-hint').textContent = '已完成';
    } else {
      $('job-hint').textContent = '失败';
    }

    if (job.status === 'failed' && job.error) {
      showError(job.error, true);
    }
  }

  function stopPolling() {
    if (state.jobTimer) {
      clearTimeout(state.jobTimer);
      state.jobTimer = null;
    }
  }

  function pollJob(jobId) {
    stopPolling();
    state.jobLogOffset = 0;
    state.lastJobStatus = null;

    var delay = 400;

    var tick = function () {
      if (state.jobId !== jobId) return;

      api('/api/jobs/' + encodeURIComponent(jobId) + '?since=' + state.jobLogOffset, { timeoutMs: 15000 })
        .then(function (job) {
          if (state.jobId !== jobId) return;

          renderJob(job);

          var lines = Array.isArray(job.log) ? job.log : [];
          lines.forEach(function (line) {
            appendLog(line.text, line.level, line.time);
          });
          var base = typeof job.logOffset === 'number' ? job.logOffset : 0;
          state.jobLogOffset = base + lines.length;

          if (job.status === 'running') {
            delay = 700;
            state.jobTimer = setTimeout(tick, delay);
            return;
          }

          // 终态：停轮询，刷新已装列表与状态条
          stopPolling();
          state.lastJobStatus = job.status;

          if (job.status === 'done') {
            // 任何「装完了」的终态都广播一次：版本列表 / 内容页据此自己刷新，
            // 不必彼此知道对方的存在（以前这段逻辑散在实例视图里）。
            if (job.kind === 'install' || job.kind === 'loaders' || job.kind === 'modpack') {
              if (typeof window.pcl3AnnounceInstalledChange === 'function') window.pcl3AnnounceInstalledChange();
            }
            if (job.kind === 'install') {
              var vid = job.result && job.result.versionId;
              if (vid) state.installed[vid] = true;
              toast('安装完成：' + (vid || job.title));
              loadStatus().catch(function () {});
              loadVersions();
            } else if (job.kind === 'loaders') {
              // 加载器装完：版本 id 由后端返回，重新拉一遍列表才会出现新的卡片
              var loaderVid = job.result && job.result.versionId;
              toast('加载器装好了：' + (loaderVid || job.title) + '，可以直接启动');
              if (loaderVid) appendLog('新版本 id：' + loaderVid + '（已在版本列表里）');
              loadStatus().catch(function () {});
              loadVersions();
            } else if (job.kind === 'modpack') {
              // 整合包任务有两副面孔：上传解析（结果里有 files 统计）与安装（结果里有 instanceId）
              if (typeof window.pcl3OnModpackJob === 'function') {
                window.pcl3OnModpackJob(job);
              }
              loadStatus().catch(function () {});
              loadVersions();
            } else if (job.kind === 'mods' || job.kind === 'content') {
              // 装模组（Modrinth）：结果里有目标版本与文件名。
              // 面板由 mods.js 渲染，这里只负责「说一声 + 让那块自己刷新」。
              var modName = (job.result && job.result.title) || job.title;
              toast('模组装好了：' + modName + '，重启游戏生效', true);
              appendLog('模组已安装：' + modName + '（' + ((job.result && job.result.filename) || '?') + '）');
              if (typeof window.pcl3OnModJob === 'function') {
                window.pcl3OnModJob(job);
              }
            } else {
              toast('游戏已启动' + (job.result && job.result.pid ? '，PID ' + job.result.pid : ''));
            }
          } else if (job.status === 'failed') {
            showError(job.error || '任务失败', true);
            // 启动失败时把「原始堆栈」换成「人话分析」（infra.js 提供，运行期才存在）
            if (job.kind === 'launch' && typeof window.pcl3AnalyzeCrash === 'function') {
              var crashId =
                (job.result && job.result.versionId) || job.title.replace(/^启动\s*/, '') || '';
              if (crashId) window.pcl3AnalyzeCrash(crashId);
            }
          }
        })
        .catch(function (error) {
          if (state.jobId !== jobId) return;
          // 404 = 任务已被清理（超过 10 分钟保留期），如实告诉用户并停轮询
          if (error && error.status === 404) {
            stopPolling();
            appendLog('任务记录已过期：' + messageOf(error), 'warn');
            $('job-hint').textContent = '记录已过期';
            return;
          }
          appendLog('轮询失败，' + Math.round(delay / 1000) + ' 秒后重试：' + messageOf(error), 'warn');
          delay = Math.min(8000, Math.round(delay * 1.8));
          state.jobTimer = setTimeout(tick, delay);
        });
    };

    tick();
  }

  // ───────────────────────────── 安装 / 启动 ─────────────────────────────

  var busyVersions = {};

  function setBusy(versionId, busy) {
    busyVersions[versionId] = busy;
    var card = document.querySelector('.card[data-version-id="' + cssEscape(versionId) + '"]');
    if (!card) return;
    var buttons = card.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].disabled = busy;
    }
  }

  /** CSS.escape 在旧 Edge 上可能没有；退化成只转义引号与反斜杠 */
  function cssEscape(text) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
    return String(text).replace(/["\\]/g, '\\$&');
  }

  function startInstall(versionId, button) {
    if (busyVersions[versionId]) return;
    setBusy(versionId, true);
    if (button) button.textContent = '提交中…';

    appendLog('请求安装 ' + versionId + ' …');
    $('job-card').hidden = false;
    $('job-empty').hidden = true;
    $('job-title').textContent = '安装 ' + versionId;
    $('job-status').textContent = '进行中';
    $('job-status').className = 'badge badge-running';
    $('job-hint').textContent = '已提交';

    api('/api/install', { method: 'POST', body: { versionId: versionId }, timeoutMs: 20000 })
      .then(function (data) {
        state.jobId = data.jobId;
        appendLog('安装任务已创建：' + data.jobId);
        pollJob(data.jobId);
        setBusy(versionId, false);
        if (button) button.textContent = '安装';
      })
      .catch(function (error) {
        setBusy(versionId, false);
        if (button) button.textContent = '安装';

        var body = error && error.body;
        if (error && error.status === 409) {
          var runningJob = body && body.jobId ? body.jobId : null;
          showError(messageOf(error), true);
          appendLog('已经有一个安装任务在跑：' + messageOf(error), 'warn');
          if (runningJob) {
            state.jobId = runningJob;
            $('job-hint').textContent = '沿用进行中的任务';
            pollJob(runningJob);
          }
          return;
        }

        showError('安装失败：' + messageOf(error), true);
        appendLog('安装失败：' + messageOf(error), 'error');
        $('job-hint').textContent = '失败';
      });
  }

  function startLaunch(versionId, button) {
    if (busyVersions[versionId]) return;

    var name = currentUsername();
    if (!name) {
      showError('请先在右侧填写并保存一个离线玩家名，然后再启动。', true);
      var input = $('offline-name');
      if (input) input.focus();
      return;
    }

    /**
     * 启动前体检闸门（preflight）。
     *
     * 流程：点「启动」→ 体检（< 1 秒）→
     *   · 有修不了的阻断 → 弹窗列出问题 + 一键修复，**不进游戏**
     *   · 只有警告 / 能自动修 → 照常启动
     *   · 体检模块没加载 / 接口不可用 → 直接走原来的启动（体检绝不能成为新的故障点）
     *
     * 真正的 POST /api/launch 收在 doLaunch 里，保证「体检一次只启动一次」。
     */
    function doLaunch() {
      if (busyVersions[versionId]) return;
      setBusy(versionId, true);
      if (button) button.textContent = '启动中…';
      appendLog('请求以离线账户「' + name + '」启动 ' + versionId + ' …');

      api('/api/launch', { method: 'POST', body: { versionId: versionId, username: name }, timeoutMs: 20000 })
        .then(function (data) {
          state.jobId = data.jobId;
          appendLog('启动任务已创建：' + data.jobId);
          pollJob(data.jobId);
          setBusy(versionId, false);
          if (button) button.textContent = '启动';
        })
        .catch(function (error) {
          setBusy(versionId, false);
          if (button) button.textContent = '启动';
          // 409 + preflight：后端体检拦下了。把报告交给体检模块展示，而不是甩一句 "HTTP 409"
          var body = error && error.body;
          if (body && body.preflight && window.pcl3Preflight && typeof window.pcl3Preflight.explain === 'function') {
            window.pcl3Preflight.explain(body.preflight, { versionId: versionId, onLaunch: doLaunch });
            appendLog('启动被体检拦下：' + messageOf(error), 'warn');
            return;
          }
          showError('启动失败：' + messageOf(error), true);
          appendLog('启动失败：' + messageOf(error), 'error');
        });
    }

    var guard = window.pcl3Preflight;
    if (guard && typeof guard.guardLaunch === 'function') {
      guard.guardLaunch({ versionId: versionId, onLaunch: doLaunch });
      return;
    }
    doLaunch();
  }

  // ───────────────────────────── 装模组加载器 ─────────────────────────────

  /** 弹窗打开时的键盘回调（Esc 关闭），关闭时摘掉，避免多个监听叠着 */
  var loaderKeyHandler = null;

  function loaderError(text) {
    var node = $('loader-error');
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.hidden = true;
      node.textContent = '';
    }
  }

  function openLoaderModal(gameVersion) {
    var backdrop = $('loader-modal');
    if (!backdrop) return;

    state.loader.gameVersion = String(gameVersion || '');
    state.loader.versions = [];

    $('loader-sub').textContent = state.loader.gameVersion
      ? '为 ' + state.loader.gameVersion + ' 装一个模组加载器。需要先装好原版。'
      : '先在「下载」页挑一个原版，再装加载器。';

    setLoaderKind(state.loader.kind, true);
    loaderError('');
    backdrop.hidden = false;

    loaderKeyHandler = function (event) {
      if (event.key === 'Escape') closeLoaderModal();
    };
    document.addEventListener('keydown', loaderKeyHandler);

    if (state.loader.gameVersion) {
      loadLoaderVersions();
    } else {
      renderLoaderVersions([], '缺少原版版本号，请关掉弹窗重新点一次。');
    }
  }

  function closeLoaderModal() {
    var backdrop = $('loader-modal');
    if (backdrop) backdrop.hidden = true;
    if (loaderKeyHandler) {
      document.removeEventListener('keydown', loaderKeyHandler);
      loaderKeyHandler = null;
    }
  }

  function setLoaderKind(kind, refresh) {
    state.loader.kind = kind === 'quilt' ? 'quilt' : 'fabric';

    var host = $('loader-kind');
    if (host) {
      var buttons = host.querySelectorAll('.seg-btn');
      for (var i = 0; i < buttons.length; i += 1) {
        var btn = buttons[i];
        if (btn.getAttribute('data-kind') === state.loader.kind) btn.classList.add('is-active');
        else btn.classList.remove('is-active');
      }
    }
    if (refresh && state.loader.gameVersion) loadLoaderVersions();
  }

  function loadLoaderVersions() {
    var kind = state.loader.kind;
    var gameVersion = state.loader.gameVersion;
    var select = $('loader-version');

    renderLoaderVersions([], '正在读取 ' + LOADER_NAME[kind] + ' 版本列表…');
    if (select) select.disabled = true;
    loaderError('');

    var url =
      '/api/loaders/' +
      encodeURIComponent(kind) +
      '/versions?gameVersion=' +
      encodeURIComponent(gameVersion);

    api(url, { timeoutMs: 30000 })
      .then(function (data) {
        // 用户可能在请求期间切了 kind / 版本，迟到的响应不能覆盖新状态
        if (state.loader.kind !== kind || state.loader.gameVersion !== gameVersion) return;
        var list = Array.isArray(data.versions) ? data.versions : [];
        state.loader.versions = list;
        renderLoaderVersions(list, list.length === 0 ? '这个游戏版本下没有拿到加载器版本。' : '');
      })
      .catch(function (error) {
        if (state.loader.kind !== kind || state.loader.gameVersion !== gameVersion) return;
        state.loader.versions = [];
        renderLoaderVersions([], '');
        loaderError('版本列表获取失败：' + messageOf(error));
      });
  }

  /**
   * 把版本列表填进 select。
   * `stableSource === 'inferred'` 的意思是「meta 没有 stable 字段，是我们按版本号猜的」，
   * 必须如实标注 —— 别让用户以为那是官方声明。
   */
  function renderLoaderVersions(list, emptyText) {
    var select = $('loader-version');
    var hint = $('loader-version-hint');
    var confirm = $('loader-confirm');
    if (!select) return;

    select.textContent = '';

    if (!list || list.length === 0) {
      var opt = el('option', null, emptyText || '— 没有可用版本 —');
      opt.value = '';
      select.appendChild(opt);
      select.disabled = true;
      if (confirm) confirm.disabled = true;
      if (hint) hint.textContent = '';
      return;
    }

    var inferred = false;
    var preferIndex = -1;
    list.forEach(function (item, index) {
      var text = item.version + (item.stable ? '（稳定）' : '（更可能有兼容问题）');
      var option = el('option', null, text);
      option.value = item.version;
      select.appendChild(option);
      // 默认选中第一条「稳定」版；meta 顺序是新 → 旧，所以这就是最新稳定版
      if (preferIndex < 0 && item.stable) preferIndex = index;
      if (item.stableSource === 'inferred') inferred = true;
    });
    select.disabled = false;
    // 一条 stable 都没有（例如 Quilt 全是 beta）时退回第一条
    select.selectedIndex = preferIndex >= 0 ? preferIndex : 0;
    if (confirm) confirm.disabled = false;

    if (hint) {
      var label = LOADER_NAME[state.loader.kind];
      hint.textContent = inferred
        ? label + ' 官方 meta 没有「稳定版」标记，列表里的稳定/不稳定是按版本号推断的。'
        : '「稳定」来自 ' + label + ' 官方 meta 声明。';
    }
  }

  function confirmLoaderInstall() {
    if (state.loader.busy) return;

    var select = $('loader-version');
    var loaderVersion = select ? select.value : '';
    var gameVersion = state.loader.gameVersion;

    if (!gameVersion) {
      loaderError('缺少原版版本号，请关掉弹窗重新点一次。');
      return;
    }
    if (!loaderVersion) {
      loaderError('请先选一个加载器版本。');
      return;
    }

    var kind = state.loader.kind;
    var label = LOADER_NAME[kind];
    var confirm = $('loader-confirm');

    state.loader.busy = true;
    if (confirm) {
      confirm.disabled = true;
      confirm.textContent = '提交中…';
    }
    loaderError('');

    appendLog('请求安装 ' + label + ' ' + loaderVersion + '（基于 ' + gameVersion + '）…');
    $('job-card').hidden = false;
    $('job-empty').hidden = true;
    $('job-title').textContent = '安装 ' + label + ' ' + loaderVersion;
    $('job-status').textContent = '进行中';
    $('job-status').className = 'badge badge-running';
    $('job-hint').textContent = '已提交';

    api('/api/loaders/install', {
      method: 'POST',
      body: { kind: kind, gameVersion: gameVersion, loaderVersion: loaderVersion },
      timeoutMs: 30000
    })
      .then(function (data) {
        state.jobId = data.jobId;
        appendLog('加载器安装任务已创建：' + data.jobId);
        closeLoaderModal();
        pollJob(data.jobId);
      })
      .catch(function (error) {
        var body = error && error.body;
        // 原版没装：把后端给的人话 + 指引直接摊开，别让用户猜
        var text = messageOf(error);
        if (body && body.hint) text += '\n' + body.hint;
        loaderError(text);
        showError(text, true);
        appendLog('安装加载器失败：' + text, 'error');
        $('job-hint').textContent = '失败';
      })
      .finally(function () {
        state.loader.busy = false;
        if (confirm) {
          confirm.disabled = false;
          confirm.textContent = '开始安装';
        }
      });
  }

  function bindLoaderModal() {
    var backdrop = $('loader-modal');
    if (!backdrop) return;

    var kindHost = $('loader-kind');
    if (kindHost) {
      kindHost.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.getAttribute) return;
        var kind = target.getAttribute('data-kind');
        if (kind) setLoaderKind(kind, true);
      });
    }

    var close = $('loader-close');
    if (close) close.addEventListener('click', closeLoaderModal);

    var cancel = $('loader-cancel');
    if (cancel) cancel.addEventListener('click', closeLoaderModal);

    var reload = $('loader-reload');
    if (reload) {
      reload.addEventListener('click', function () {
        if (state.loader.gameVersion) loadLoaderVersions();
      });
    }

    var confirm = $('loader-confirm');
    if (confirm) confirm.addEventListener('click', confirmLoaderInstall);

    // 点遮罩关闭（点内容不关）
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) closeLoaderModal();
    });
  }

  // ───────────────────────────── 版本设置（内存 / JVM 参数） ─────────────────────────────

  var MEMORY_MIN = 512;
  var MEMORY_MAX = 65536;
  var SLIDER_MIN = 512;
  var SLIDER_MAX = 16384;
  var SLIDER_STEP = 512;

  /** 弹窗当前上下文 */
  state.settings = { versionId: '', busy: false, saved: null };
  var settingsKeyHandler = null;

  function settingsError(text) {
    var node = $('settings-error');
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.hidden = true;
      node.textContent = '';
    }
  }

  /** MB → 「4 GB」；不是整 GB 就保留 MB，别把 6144 说成 6 GB 让人以为凑整 */
  function humanMemory(mb) {
    if (mb >= 1024 && mb % 1024 === 0) return mb / 1024 + ' GB';
    return mb + ' MB';
  }

  /** 系统物理内存（GB）。拿不到返回 0 —— 下面据此决定要不要给建议值 */
  function systemMemoryGB() {
    var nav = window.navigator || {};
    var gb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
    return gb > 0 ? gb : 0;
  }

  /** 按物理内存给建议值：1/4 物理内存，向上取整到 512 的倍数，夹在 [1024, 8192] */
  function advisedMemoryMB() {
    var gb = systemMemoryGB();
    if (gb <= 0) return 0;
    var quarter = (gb * 1024) / 4;
    var rounded = Math.ceil(quarter / SLIDER_STEP) * SLIDER_STEP;
    return Math.min(8192, Math.max(1024, rounded));
  }

  /** 刷新「当前 4096 MB（约 4 GB）」与建议值那两行 */
  function renderMemoryHint(mb) {
    var label = $('settings-memory-label');
    if (label) {
      label.textContent = '';
      label.appendChild(document.createTextNode('当前 '));
      var strong = el('strong', null, mb + ' MB');
      label.appendChild(strong);
      label.appendChild(document.createTextNode('（约 ' + humanMemory(mb) + '）'));
    }

    var advice = $('settings-memory-advice');
    if (!advice) return;
    advice.className = 'hint';
    var gb = systemMemoryGB();
    if (gb <= 0) {
      advice.textContent = '原版建议 2048～4096 MB；加模组后按需上调，别超过物理内存的一半。';
      return;
    }
    var suggested = advisedMemoryMB();
    var text =
      '本机物理内存约 ' + gb + ' GB，建议 ' + suggested + ' MB（' + humanMemory(suggested) + '）。';
    if (mb > gb * 1024 * 0.9) {
      advice.className = 'hint field-note-warn';
      text += '这个值已经接近物理内存总量，系统会频繁换页，反而更卡。';
    } else if (mb < 1024) {
      advice.className = 'hint field-note-warn';
      text += '低于 1024 MB 时原版 + 模组很容易 OOM。';
    }
    advice.textContent = text;
  }

  /** 滑块与数字框互相联动：拖滑块 → 数字变；输数字 → 滑块跟（超范围就夹住并提示） */
  function setMemoryValue(raw, fromInput) {
    var value = Math.round(Number(raw));
    if (!isFinite(value)) value = 2048;
    if (value < MEMORY_MIN) {
      value = fromInput ? MEMORY_MIN : SLIDER_MIN;
      if (fromInput) settingsError('内存不能小于 ' + MEMORY_MIN + ' MB，已改成 ' + MEMORY_MIN + ' MB。');
    }
    if (value > MEMORY_MAX) {
      value = MEMORY_MAX;
      if (fromInput) settingsError('内存上限 ' + MEMORY_MAX + ' MB（64 GB），已改成上限值。');
    }

    var range = $('settings-memory-range');
    var input = $('settings-memory');
    if (input) input.value = String(value);
    if (range) {
      // 滑块上限 16384；超过时滑块停在最右端，数字框仍显示真实值
      range.value = String(Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, value)));
    }
    renderMemoryHint(value);
    return value;
  }

  function currentMemoryValue() {
    var input = $('settings-memory');
    var value = input ? Math.round(Number(input.value)) : 2048;
    return isFinite(value) && value > 0 ? value : 2048;
  }

  /** 多行文本 ↔ 数组：一条一行，空行丢掉 */
  function parseArgLines(value) {
    if (!value) return [];
    return String(value)
      .split(/\r?\n/)
      .map(function (line) {
        return line.trim();
      })
      .filter(function (line) {
        return line.length > 0;
      });
  }

  function fillSettingsForm(settings) {
    var s = settings || {};
    var memory = typeof s.memoryMB === 'number' ? s.memoryMB : 2048;
    settingsError('');
    setMemoryValue(memory, false);

    var minInput = $('settings-min-memory');
    if (minInput) minInput.value = typeof s.minMemoryMB === 'number' ? String(s.minMemoryMB) : '';

    var jvm = $('settings-jvm-args');
    if (jvm) jvm.value = (s.extraJvmArgs || []).join('\n');

    var game = $('settings-game-args');
    if (game) game.value = (s.extraGameArgs || []).join('\n');

    var javaPath = $('settings-java-path');
    if (javaPath) javaPath.value = s.javaPath || '';

    state.settings.saved = s;
  }

  function openSettingsModal(versionId) {
    var backdrop = $('settings-modal');
    if (!backdrop) return;

    state.settings.versionId = String(versionId || '');
    state.settings.busy = false;

    var sub = $('settings-sub');
    if (sub) {
      sub.textContent =
        '这些设置只属于「' + state.settings.versionId + '」，其它版本的设置各自独立。';
    }

    fillSettingsForm({ memoryMB: 2048 });
    var save = $('settings-save');
    if (save) {
      save.disabled = true;
      save.textContent = '读取中…';
    }

    backdrop.hidden = false;
    settingsKeyHandler = function (event) {
      if (event.key === 'Escape') closeSettingsModal();
    };
    document.addEventListener('keydown', settingsKeyHandler);

    api('/api/instances/' + encodeURIComponent(state.settings.versionId) + '/settings', { timeoutMs: 15000 })
      .then(function (data) {
        if (state.settings.versionId !== String(versionId || '')) return;
        fillSettingsForm(data);
        if (save) {
          save.disabled = false;
          save.textContent = '保存';
        }
        if (data && data.source === 'default') {
          appendLog('版本 ' + versionId + ' 还没有保存过设置，当前为默认值（内存 2048 MB）。');
        }
      })
      .catch(function (error) {
        settingsError('设置读取失败：' + messageOf(error));
        if (save) {
          save.disabled = false;
          save.textContent = '保存';
        }
      });
  }

  function closeSettingsModal() {
    var backdrop = $('settings-modal');
    if (backdrop) backdrop.hidden = true;
    if (settingsKeyHandler) {
      document.removeEventListener('keydown', settingsKeyHandler);
      settingsKeyHandler = null;
    }
  }

  /** 收集表单 → 提交。前端先做一遍同样的校验，省一次往返，也避免写出会被拒的东西 */
  function submitSettings(extra) {
    if (state.settings.busy) return;
    var versionId = state.settings.versionId;
    if (!versionId) return;

    var memory = currentMemoryValue();
    if (memory < MEMORY_MIN || memory > MEMORY_MAX) {
      settingsError('内存必须在 ' + MEMORY_MIN + ' ～ ' + MEMORY_MAX + ' MB 之间。');
      return;
    }

    var minRaw = $('settings-min-memory') ? $('settings-min-memory').value.trim() : '';
    var minMemory = minRaw === '' ? null : Math.round(Number(minRaw));
    if (minMemory !== null) {
      if (!isFinite(minMemory) || minMemory < MEMORY_MIN || minMemory > MEMORY_MAX) {
        settingsError('最小内存必须在 ' + MEMORY_MIN + ' ～ ' + MEMORY_MAX + ' MB 之间，或留空自动。');
        return;
      }
      if (minMemory > memory) {
        settingsError('最小内存不能大于最大内存。');
        return;
      }
    }

    var body = {
      memoryMB: memory,
      extraJvmArgs: parseArgLines($('settings-jvm-args') ? $('settings-jvm-args').value : ''),
      extraGameArgs: parseArgLines($('settings-game-args') ? $('settings-game-args').value : '')
    };
    if (minMemory !== null) body.minMemoryMB = minMemory;

    var javaPath = $('settings-java-path') ? $('settings-java-path').value.trim() : '';
    if (javaPath) body.javaPath = javaPath;

    var save = $('settings-save');
    state.settings.busy = true;
    if (save) {
      save.disabled = true;
      save.textContent = '保存中…';
    }
    settingsError('');

    var request =
      extra && extra.reset === true
        ? api('/api/instances/' + encodeURIComponent(versionId) + '/settings', {
            method: 'PUT',
            body: { memoryMB: 2048 },
            timeoutMs: 15000
          })
        : api('/api/instances/' + encodeURIComponent(versionId) + '/settings', {
            method: 'PUT',
            body: body,
            timeoutMs: 15000
          });

    request
      .then(function (data) {
        fillSettingsForm(data);
        toast(
          (extra && extra.reset === true ? '已恢复默认设置：' : '设置已保存：') +
            versionId +
            '，内存 ' +
            (data.memoryMB || memory) +
            ' MB',
          true
        );
        appendLog(
          '版本设置已保存：' +
            versionId +
            '（内存 ' +
            (data.memoryMB || memory) +
            ' MB' +
            (data.extraJvmArgs && data.extraJvmArgs.length ? '，JVM 参数 ' + data.extraJvmArgs.join(' ') : '') +
            '）'
        );
        closeSettingsModal();
      })
      .catch(function (error) {
        var body2 = error && error.body;
        var text = messageOf(error);
        if (body2 && body2.problems && body2.problems.length) text = body2.problems.join('\n');
        settingsError(text);
        showError('保存设置失败：' + text, true);
      })
      .finally(function () {
        state.settings.busy = false;
        if (save) {
          save.disabled = false;
          save.textContent = '保存';
        }
      });
  }

  function bindSettingsModal() {
    var backdrop = $('settings-modal');
    if (!backdrop) return;

    var range = $('settings-memory-range');
    if (range) {
      range.addEventListener('input', function () {
        setMemoryValue(range.value, false);
      });
    }

    var input = $('settings-memory');
    if (input) {
      input.addEventListener('input', function () {
        // 输入过程中不夹值（否则删到空会立刻变成 512，没法继续输入），只在合法时同步显示
        var raw = Math.round(Number(input.value));
        if (isFinite(raw) && raw >= MEMORY_MIN && raw <= MEMORY_MAX) {
          var rangeEl = $('settings-memory-range');
          if (rangeEl) rangeEl.value = String(Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, raw)));
          renderMemoryHint(raw);
        }
      });
      input.addEventListener('change', function () {
        setMemoryValue(input.value, true);
      });
    }

    var close = $('settings-close');
    if (close) close.addEventListener('click', closeSettingsModal);

    var cancel = $('settings-cancel');
    if (cancel) cancel.addEventListener('click', closeSettingsModal);

    var save = $('settings-save');
    if (save) {
      save.addEventListener('click', function () {
        submitSettings(null);
      });
    }

    var reset = $('settings-reset');
    if (reset) {
      reset.addEventListener('click', function () {
        fillSettingsForm({ memoryMB: 2048 });
        submitSettings({ reset: true });
      });
    }

    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) closeSettingsModal();
    });
  }

  // ───────────────────────────── 离线账户 ─────────────────────────────

  function currentUsername() {
    var input = $('offline-name');
    var typed = input ? input.value.trim() : '';
    if (typed) return typed;
    return state.account || '';
  }

  function renderAccounts(accounts) {
    var list = $('account-list');
    if (!list) return;
    list.textContent = '';

    if (!accounts || accounts.length === 0) {
      var li = el('li', 'account-item');
      li.appendChild(el('span', 'muted', '还没有离线账户，先在上面填个名字。'));
      list.appendChild(li);
      return;
    }

    accounts.forEach(function (acc) {
      var item = el('li', 'account-item');
      var left = el('div');
      left.appendChild(el('div', 'account-name', acc.username + (acc.type === 'microsoft' ? '（正版）' : '')));
      left.appendChild(el('div', 'account-uuid', acc.uuid));
      item.appendChild(left);

      var useBtn = el('button', 'btn btn-ghost btn-sm', '选用');
      useBtn.type = 'button';
      useBtn.addEventListener('click', function () {
        state.account = acc.username;
        localStorage.setItem('pcl3.username', acc.username);
        if ($('offline-name')) $('offline-name').value = acc.username;
        $('offline-hint').textContent = '当前使用离线账户：' + acc.username;
      });
      item.appendChild(useBtn);
      list.appendChild(item);
    });
  }

  function loadAccounts() {
    return api('/api/accounts', { timeoutMs: 12000 })
      .then(function (data) {
        var accounts = Array.isArray(data.accounts) ? data.accounts : [];
        renderAccounts(accounts);
        // 没有保存过名字时，默认挑第一个离线账户
        if (!state.account) {
          var first = accounts.filter(function (a) {
            return a.type === 'offline';
          })[0];
          if (first) {
            state.account = first.username;
            localStorage.setItem('pcl3.username', first.username);
            if ($('offline-name')) $('offline-name').value = first.username;
          }
        }
        return accounts;
      })
      .catch(function (error) {
        var list = $('account-list');
        if (list) {
          list.textContent = '';
          var li = el('li', 'account-item error-text', '账户读取失败：' + messageOf(error));
          list.appendChild(li);
        }
        showError('账户列表读取失败：' + messageOf(error));
      });
  }

  function bindOfflineForm() {
    var form = $('offline-form');
    if (!form) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = $('offline-name');
      var name = input ? input.value.trim() : '';
      if (!name) {
        showError('请填写玩家名（1~16 个字符）。', true);
        if (input) input.focus();
        return;
      }

      var submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;

      api('/api/account/offline', { method: 'POST', body: { username: name }, timeoutMs: 12000 })
        .then(function (data) {
          var acc = data.account || {};
          state.account = acc.username || name;
          localStorage.setItem('pcl3.username', state.account);
          $('offline-hint').textContent = '已保存离线账户：' + state.account;
          appendLog('离线账户已保存：' + state.account + '（UUID ' + (acc.uuid || '?') + '）');
          return loadAccounts();
        })
        .catch(function (error) {
          showError('保存离线账户失败：' + messageOf(error), true);
        })
        .finally(function () {
          if (submit) submit.disabled = false;
        });
    });
  }

  // ───────────────────────────── 事件绑定 ─────────────────────────────

  function bindControls() {
    var search = $('search');
    if (search) {
      var searchTimer = null;
      search.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(renderVersions, 120);
      });
    }

    var typeSel = $('filter-type');
    if (typeSel) {
      typeSel.addEventListener('change', function () {
        loadVersions();
      });
    }

    var refresh = $('btn-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        refresh.disabled = true;
        clearError();
        Promise.all([loadStatus().catch(function () {}), loadVersions(), loadAccounts()]).finally(function () {
          refresh.disabled = false;
        });
      });
    }

    var clearBtn = $('btn-clear-log');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearLog);
    }

    // 页面隐藏时停掉轮询，回来时恢复（省电也避免后台刷屏）
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopPolling();
      } else if (state.jobId && state.lastJobStatus === null) {
        pollJob(state.jobId);
      }
    });
  }

  // ───────────────────────────── 启动 ─────────────────────────────

  /**
   * 暴露给 modpack.js 的几个入口。
   *
   * 为什么这么做：整合包的功能有自己的文件（modpack.js），但它必须
   * 复用这里的「日志区 / 页脚错误 / toast / 任务面板 / 启动」，
   * 否则同一件事要写两份、两处文案还会不一致。
   * 只是把已有函数挂到 window 上，没有改变任何既有行为。
   */
  window.pcl3AppendLog = appendLog;
  window.pcl3ShowError = showError;
  window.pcl3Toast = toast;
  window.pcl3RenderJob = renderJob;
  /**
   * 供 preflight.js（启动前体检）复用的底层入口。
   * 体检要发请求、要往日志里写东西、要 toast —— 这些必须和主程序用同一份，
   * 否则「日志区不滚动」「toast 叠两个」这类小毛病会在两处各冒一次。
   */
  window.pcl3Api = api;
  window.pcl3El = el;
  window.pcl3MessageOf = messageOf;
  window.pcl3StartLaunch = function (versionId) {
    startLaunch(versionId, null);
  };
  window.pcl3LoadVersions = loadVersions;
  /** 主页 / 版本页的「设置」按钮用它打开同一个弹窗（内存 / JVM 参数只有一份实现） */
  window.pcl3OpenSettings = function (versionId) {
    if (versionId) openSettingsModal(String(versionId));
  };
  /**
   * 接管一个已经存在的任务：别的面板（mods.js / packs.js）POST 完拿到 jobId 后调用它，
   * 就能复用这里的任务面板 + 日志滚动 + 终态回调，不用各自再写一套轮询。
   */
  window.pcl3FollowJob = function (jobId) {
    if (!jobId) return;
    state.jobId = jobId;
    state.lastJobStatus = null;
    appendLog('开始跟踪任务 ' + jobId);
    pollJob(jobId);
  };

  // ───────────────────────────── 对外入口 ─────────────────────────────
  //
  // 实例视图（同一版本多套独立实例）已整块删除：用户原话
  // 「应该可以取消实例概念吧，毕竟是用来做版本隔离的概念，目前版本选择其实已经替代了实例了」。
  // 现在「已安装版本 = 目录 = 启动目标」，版本选择器与版本列表都由 versions.js 负责。
  // 这里只留两个仍然被外部用到的入口：
  //   pcl3SetView  —— 兼容旧调用，转成「切到对应页面」（不参与显隐计算）
  //   pcl3StartLaunch / pcl3FollowJob / pcl3LoadVersions 等，见上面一段。

  window.pcl3SetView = function (view) {
    if (!window.pcl3Nav) return;
    window.pcl3Nav.showPage(view === 'instances' ? 'versions' : 'home');
  };
  window.pcl3LaunchInstance = function () {
    /* 实例没了，这个入口只是为了不把旧脚本打断 */
  };
  /** 通知别的面板「装了什么，该刷新了」（以前散落在实例视图里，现在独立常驻） */
  window.pcl3AnnounceInstalledChange = function () {
    try {
      document.dispatchEvent(new CustomEvent('pcl3:installed-changed'));
    } catch (e) {
      /* 老浏览器没有 CustomEvent 构造器：跳过 */
    }
  };

  function boot() {
    bindControls();
    bindOfflineForm();
    bindLoaderModal();
    bindSettingsModal();

    var nameInput = $('offline-name');
    if (nameInput && state.account) {
      nameInput.value = state.account;
      $('offline-hint').textContent = '当前使用离线账户：' + state.account;
    }

    if (!window.fetch) {
      setVersionsMessage('这个浏览器太旧了（不支持 fetch），请换 Edge / Chrome 最新版。', true);
      showError('浏览器不支持 fetch，界面无法工作。', true);
      return;
    }

    appendLog('PCL3 Web UI 已加载，正在读取状态…');

    // 三个请求并发，互不阻塞：任何一个失败都只影响自己那块区域
    loadStatus().catch(function () {});
    loadVersions();
    loadAccounts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
