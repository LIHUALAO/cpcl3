/**
 * 内容源（Modrinth）前端：搜索 → 安装 → 已装模组管理。
 *
 * 约束：纯原生 JS，零依赖、零 CDN、零构建；与 app.js 通过 window.pcl3* 对接。
 *
 * 与 app.js 的分工（和 modpack.js / packs.js 完全一致）：
 *   app.js   顶栏、版本列表、任务面板、日志、账户；模组任务结束时回调 pcl3OnModJob
 *   本文件    搜索面板、结果列表、安装按钮、已装模组列表
 *
 * 四条原则（沿用前面的踩坑经验）：
 *   1. 任何失败都要写进界面（页脚 + 面板里的错误行），不许停在「搜索中…」
 *   2. 每次请求都带超时；迟到的响应不能覆盖新一次搜索的结果（seq 守卫）
 *   3. 图标来自 Modrinth 的 CDN（外部 HTTPS 图片）；加载失败就退化成一个字母块，
 *      **绝不让一张裂图决定这一行的成败**
 *   4. 安装是异步任务：POST 拿 jobId → 复用 app.js 的任务面板轮询（不另起一套）
 */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function messageOf(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    if (error.name === 'AbortError') return '请求超时（服务器没有响应）';
    return error.message ? String(error.message) : String(error);
  }

  /** 统一的 API 调用：带超时、错误里带 HTTP 状态码、优先展示服务端的人话 */
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
        return res.text().then(function (text) {
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
            var hint = data && data.hint ? data.hint : '';
            var err = new Error(detail);
            err.status = res.status;
            err.body = data;
            err.hint = hint;
            throw err;
          }
          return data;
        });
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') {
          throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒无响应）：' + path);
        }
        throw error;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var value = n;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return (value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[i];
  }

  /** 下载量：12.3M / 456.7k —— 一眼看规模，不显示 12345678 */
  function formatCount(n) {
    var value = Number(n);
    if (!isFinite(value) || value < 0) return '—';
    if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
    return String(Math.round(value));
  }

  var PROJECT_TYPE_LABEL = {
    mod: '模组',
    resourcepack: '资源包',
    shader: '光影',
    datapack: '数据包',
    modpack: '整合包'
  };

  var PAGE_SIZE = 20;

  var state = {
    instanceId: '',
    type: 'mod',
    query: '',
    gameVersion: '',
    loader: '',
    offset: 0,
    totalHits: 0,
    hits: [],
    seq: 0,
    busy: false,
    /** 正在安装的 slug → true，防止连点 */
    installing: {}
  };

  function contentError(text) {
    var node = $('content-error');
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.hidden = true;
      node.textContent = '';
    }
  }

  // ───────────────────────────── 实例下拉 ─────────────────────────────

  /**
   * 实例列表从两份数据拼出来：
   *   /api/versions → installed（已装原版）+ loaderProfiles（带 Fabric / Quilt 的版本 id）
   *   /api/instances → 实例目录（实例视图上线后，实例不再等于版本，isolation:true 的才是实例）
   *
   * 为什么要合并：早期的「实例」就是版本目录名，mods/ 落在
   * `<dataRoot>/instances/<版本id>/mods/`；实例视图上线后，用户可能在「实例」面板里
   * 建了独立的实例（`instances/<id>` 带 isolation），那些也必须能装模组。
   * 两份数据都拿不到时才诚实地说「还没有装任何版本」。
   */
  function loadInstances() {
    var select = $('content-instance');
    if (!select) return;

    // 实例概念已移除（「版本选择」取代了它），所以只从 /api/versions 取数据：
    //   installed       → 已安装的版本 id
    //   loaderProfiles  → 哪些版本带加载器、带的是哪种
    var versionsReq = api('/api/versions?limit=200&type=all', { timeoutMs: 30000 }).catch(function () {
      return null;
    });

    Promise.all([versionsReq])
      .then(function (results) {
        var data = results[0] || {};

        var profiles = Array.isArray(data.loaderProfiles) ? data.loaderProfiles : [];
        var installed = Array.isArray(data.installed) ? data.installed : [];

        select.textContent = '';

        var withLoader = {};
        profiles.forEach(function (p) {
          if (p && p.versionId) withLoader[p.versionId] = p;
        });

        // 1) 能装模组的版本（加载器 profile）
        var seen = {};
        var loaderCount = 0;
        var recommended = el('optgroup', null, null);
        recommended.label = '可装模组（带加载器）';
        profiles.forEach(function (p) {
          if (!p || !p.versionId || seen[p.versionId]) return;
          seen[p.versionId] = true;
          var label = p.versionId + '（' + (p.kind === 'quilt' ? 'Quilt' : 'Fabric') + '）';
          var opt = el('option', null, label);
          opt.value = p.versionId;
          recommended.appendChild(opt);
          loaderCount += 1;
        });

        // 2) 其余原版版本：明确标注「装不了模组」，但仍可给资源包面板之外的人看到
        var plainCount = 0;
        var plain = el('optgroup', null, null);
        plain.label = '原版（装不了模组）';
        installed.forEach(function (id) {
          if (withLoader[id] || seen[id]) return;
          seen[id] = true;
          var opt = el('option', null, id);
          opt.value = id;
          plain.appendChild(opt);
          plainCount += 1;
        });

        if (loaderCount > 0) select.appendChild(recommended);
        if (plainCount > 0) select.appendChild(plain);

        if (loaderCount + plainCount === 0) {
          var none = el('option', null, '— 还没有装任何版本 —');
          none.value = '';
          select.appendChild(none);
          return;
        }

        // 默认选第一个能装模组的实例
        var first = profiles[0];
        if (first && first.versionId) {
          select.value = first.versionId;
          state.instanceId = first.versionId;
          syncFiltersFromInstance(first);
        } else if (instanceCount > 0) {
          var firstInst = instances[0];
          var firstId = firstInst && typeof firstInst.instanceId === 'string' ? firstInst.instanceId : '';
          if (firstId.length > 0) {
            select.value = firstId;
            state.instanceId = firstId;
            syncFiltersFromInstance({
              versionId: firstId,
              gameVersion: firstInst.versionId,
              kind: firstInst.loader && firstInst.loader.kind ? firstInst.loader.kind : undefined,
            });
          }
        } else if (installed[0]) {
          select.value = installed[0];
          state.instanceId = installed[0];
        }
        loadMods();
      })
      .catch(function (error) {
        var select2 = $('content-instance');
        if (select2) {
          select2.textContent = '';
          var opt = el('option', null, '版本列表读取失败');
          opt.value = '';
          select2.appendChild(opt);
        }
        contentError('版本列表读取失败：' + messageOf(error));
      });
  }

  /** 按实例推一下版本 / 加载器筛选（用户少点两次下拉） */
  function syncFiltersFromInstance(profile) {
    if (!profile) return;
    var gameSelect = $('content-game-version');
    if (gameSelect && profile.gameVersion) {
      ensureOption(gameSelect, profile.gameVersion);
      gameSelect.value = profile.gameVersion;
      state.gameVersion = profile.gameVersion;
    }
    var loaderSelect = $('content-loader');
    if (loaderSelect && profile.kind) {
      loaderSelect.value = profile.kind;
      state.loader = profile.kind;
    }
  }

  /**
   * 给「游戏版本」下拉补上磁盘上真实存在的版本号。
   *
   * 为什么需要：下拉里的静态选项只有「全部」；如果按实例推出来的版本号不在这份列表里，
   * `select.value = X` 会静默失败（value 变空），用户就看到一个叫「1.21」的入口
   * 下面空着，而搜索其实按 1.21 在过滤 —— 典型的「看起来能用、实际对不上」。
   * 所以启动时先把已装版本灌进去，再谈推不推。
   */
  function seedGameVersions() {
    var select = $('content-game-version');
    if (!select) return Promise.resolve();
    return api('/api/versions?limit=200&type=all', { timeoutMs: 30000 })
      .then(function (data) {
        var ids = Array.isArray(data.installed) ? data.installed : [];
        var profiles = Array.isArray(data.loaderProfiles) ? data.loaderProfiles : [];
        profiles.forEach(function (p) {
          if (p && p.gameVersion) ensureOption(select, p.gameVersion);
        });
        // 已装的原版版本本身就是游戏版本号
        ids.forEach(function (id) {
          ensureOption(select, id);
        });
      })
      .catch(function () {
        /* 拿不到就只用静态选项，不影响搜索 */
      });
  }

  /** 下拉里没有就补一个（游戏版本来自实例，未必在固定清单里） */
  function ensureOption(select, value) {
    if (!select || !value) return;
    var found = false;
    for (var i = 0; i < select.options.length; i += 1) {
      if (select.options[i].value === value) {
        found = true;
        break;
      }
    }
    if (!found) {
      var opt = el('option', null, value);
      opt.value = value;
      select.appendChild(opt);
    }
  }

  // ───────────────────────────── 搜索 ─────────────────────────────

  function doSearch(reset) {
    var input = $('content-q');
    var query = input ? input.value.trim() : '';
    state.query = query;
    state.seq += 1;
    var seq = state.seq;

    if (reset) {
      state.offset = 0;
      state.hits = [];
    }

    var params = [
      'q=' + encodeURIComponent(query),
      'type=' + encodeURIComponent(state.type),
      'limit=' + PAGE_SIZE,
      'offset=' + state.offset
    ];
    if (state.gameVersion) params.push('gameVersion=' + encodeURIComponent(state.gameVersion));
    if (state.loader) params.push('loader=' + encodeURIComponent(state.loader));

    contentError('');
    setResultsMessage(state.offset === 0 ? '正在搜索 Modrinth…' : '正在加载更多…', false);

    var searchBtn = $('btn-content-search');
    if (searchBtn) searchBtn.disabled = true;

    api('/api/content/search?' + params.join('&'), { timeoutMs: 30000 })
      .then(function (data) {
        if (seq !== state.seq) return; // 迟到的响应不能覆盖新搜索
        var hits = Array.isArray(data.hits) ? data.hits : [];
        state.hits = state.offset === 0 ? hits : state.hits.concat(hits);
        state.totalHits = typeof data.totalHits === 'number' ? data.totalHits : state.hits.length;
        renderResults();
      })
      .catch(function (error) {
        if (seq !== state.seq) return;
        var text = messageOf(error);
        if (error && error.hint) text += '\n' + error.hint;
        contentError('搜索失败：' + text);
        setResultsMessage('搜索失败：' + text, true);
        if (typeof window.pcl3ShowError === 'function') window.pcl3ShowError('搜索失败：' + text);
      })
      .finally(function () {
        if (searchBtn) searchBtn.disabled = false;
      });
  }

  function setResultsMessage(text, isError) {
    var host = $('content-results');
    var empty = $('content-empty');
    if (empty) {
      empty.hidden = false;
      empty.className = isError ? 'empty error-text' : 'empty';
      empty.textContent = text;
    }
    if (host) host.textContent = '';
    var wrap = $('content-more-wrap');
    if (wrap) wrap.hidden = true;
  }

  function renderResults() {
    var host = $('content-results');
    var empty = $('content-empty');
    var total = $('content-total');
    if (!host) return;

    host.textContent = '';

    if (total) {
      total.textContent = state.totalHits > 0
        ? '共 ' + state.totalHits + ' 个结果，已显示 ' + state.hits.length + ' 个'
        : '—';
    }

    if (state.hits.length === 0) {
      if (empty) {
        empty.hidden = false;
        empty.className = 'empty';
        empty.textContent = state.query
          ? '没有找到「' + state.query + '」。换个关键词，或把筛选条件放宽。'
          : '这个筛选条件下没有结果。换个类型 / 版本试试。';
      }
      var wrap0 = $('content-more-wrap');
      if (wrap0) wrap0.hidden = true;
      return;
    }

    if (empty) empty.hidden = true;

    var frag = document.createDocumentFragment();
    state.hits.forEach(function (hit) {
      frag.appendChild(buildResultRow(hit));
    });
    host.appendChild(frag);

    var wrap = $('content-more-wrap');
    if (wrap) wrap.hidden = state.hits.length >= state.totalHits;
  }

  /** 一条搜索结果 */
  function buildResultRow(hit) {
    var li = el('li', 'result-item');
    li.setAttribute('data-slug', hit.slug || '');

    // 图标：外部 HTTPS 图片；失败就换成首字母块
    var iconWrap = el('div', 'result-icon');
    if (hit.iconUrl) {
      var img = document.createElement('img');
      img.src = hit.iconUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        iconWrap.textContent = '';
        iconWrap.appendChild(letterBlock(hit.title));
      });
      iconWrap.appendChild(img);
    } else {
      iconWrap.appendChild(letterBlock(hit.title));
    }
    li.appendChild(iconWrap);

    var main = el('div', 'result-main');
    var titleRow = el('div', 'result-title-row');
    var titleEl = el('span', 'result-title', hit.title || hit.slug || '—');
    // 标题本身可点开详情：这是最自然的入口，用户第一反应就是点名字
    titleEl.style.cursor = 'pointer';
    titleEl.title = '点击查看详情';
    titleEl.addEventListener('click', function () {
      openDetail(hit);
    });
    titleRow.appendChild(titleEl);
    var typeLabel = PROJECT_TYPE_LABEL[hit.projectType] || hit.projectType || '';
    if (typeLabel) titleRow.appendChild(el('span', 'tag', typeLabel));
    main.appendChild(titleRow);

    main.appendChild(el('div', 'result-desc', hit.description || '（没有简介）'));

    var meta = el('div', 'result-meta');
    meta.appendChild(el('span', null, '下载 ' + formatCount(hit.downloads)));

    var versions = Array.isArray(hit.latestGameVersions) ? hit.latestGameVersions : [];
    if (versions.length > 0) {
      var tail = versions.slice(-3).join(' / ');
      meta.appendChild(el('span', null, '适配 ' + tail + (versions.length > 3 ? ' …' : '')));
    }
    var cats = Array.isArray(hit.categories) ? hit.categories.slice(0, 3) : [];
    cats.forEach(function (cat) {
      meta.appendChild(el('span', 'tag', cat));
    });
    main.appendChild(meta);

    li.appendChild(main);

    var actions = el('div', 'result-actions');
    var detailBtn = el('button', 'btn btn-ghost btn-sm', '详情');
    detailBtn.type = 'button';
    detailBtn.addEventListener('click', function () {
      openDetail(hit);
    });
    actions.appendChild(detailBtn);

    var btn = el('button', 'btn btn-primary btn-sm', '安装');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      installProject(hit, btn);
    });
    actions.appendChild(btn);
    li.appendChild(actions);

    return li;
  }

  function letterBlock(title) {
    var text = String(title || '?').trim();
    var ch = text.length > 0 ? text.charAt(0).toUpperCase() : '?';
    return el('span', 'result-icon-letter', ch);
  }

  // ───────────────────────────── 详情弹窗 ─────────────────────────────

  /**
   * 打开某个项目的详情。
   *
   * 数据来源分两步：
   *   1. 先用搜索结果里已有的字段立刻渲染（图标 / 标题 / 简介 / 下载量），
   *      这样点开是零延迟的，不会出现「白框转圈」。
   *   2. 同时请求 `/api/content/project/:slug` 拿详情（完整简介、外链、支持的加载器），
   *      回来后再补齐。
   *
   * 外链按钮的取舍（用户点名要的两个）：
   *   「MC 百科」→ mcmod.cn 搜索页。mcmod 没有公开 API，也没有稳定的 slug 映射，
   *                搜索页能保证「点了有东西看」，猜详情页链接大概率 404。
   *   「官网」    → 作者填的 source_url；没填就退到 wiki_url；再没有就不显示按钮，
   *                而不是给一个假链接。
   */
  function openDetail(hit) {
    var backdrop = $('mod-detail');
    if (!backdrop || !hit) return;

    var slug = hit.slug || '';
    if (!slug) return;

    // ── 1. 先填已知信息 ──
    var iconHost = $('mod-detail-icon');
    if (iconHost) {
      iconHost.textContent = '';
      if (hit.iconUrl) {
        var img = document.createElement('img');
        img.src = hit.iconUrl;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', function () {
          iconHost.textContent = '';
          iconHost.appendChild(letterBlock(hit.title));
        });
        iconHost.appendChild(img);
      } else {
        iconHost.appendChild(letterBlock(hit.title));
      }
    }

    setText('mod-detail-title', hit.title || slug);
    setText('mod-detail-desc', hit.description || '（没有简介）');
    setText(
      'mod-detail-meta',
      '下载 ' + formatCount(hit.downloads) +
        (Array.isArray(hit.latestGameVersions) && hit.latestGameVersions.length > 0
          ? ' · 适配 ' + hit.latestGameVersions.slice(-3).join(' / ')
          : '')
    );
    setText('mod-detail-body', '正在读取详情…');

    // 外链先按搜索结果能推出来的填（只有 mcmod 搜索 + Modrinth 页）
    renderDetailLinks(hit, null);

    // 依赖清单：点开详情就该知道还要装什么，而不是点了「安装」才被告知
    renderDependencyList(slug, 'mod-detail-deps', {});

    backdrop.hidden = false;

    // ── 2. 拉详情 ──
    var requestId = String(Date.now()) + Math.random();
    state.detailRequestId = requestId;

    api('/api/content/project/' + encodeURIComponent(slug), { timeoutMs: 25000 })
      .then(function (detail) {
        // 用户可能已经关掉或换了另一个，过期响应直接丢弃
        if (state.detailRequestId !== requestId) return;

        var merged = Object.assign({}, hit, detail || {});
        setText('mod-detail-title', merged.title || slug);
        setText('mod-detail-desc', merged.description || '（没有简介）');

        var body = typeof merged.body === 'string' ? merged.body.trim() : '';
        setText('mod-detail-body', body !== '' ? stripMarkdown(body) : '作者没有填写详细介绍。');

        var extras = [];
        if (Array.isArray(merged.loaders) && merged.loaders.length > 0) {
          extras.push('加载器：' + merged.loaders.join(' / '));
        }
        if (Array.isArray(merged.gameVersions) && merged.gameVersions.length > 0) {
          var gv = merged.gameVersions;
          extras.push('支持版本：' + (gv.length > 6 ? gv.slice(-6).join(' / ') + ' …' : gv.join(' / ')));
        }
        if (typeof merged.follows === 'number') extras.push('关注 ' + formatCount(merged.follows));
        setText('mod-detail-meta', extras.length > 0 ? extras.join('　·　') : '');

        renderDetailLinks(merged, merged);
      })
      .catch(function (err) {
        if (state.detailRequestId !== requestId) return;
        setText('mod-detail-body', '详情读取失败：' + errorText(err) + '\n（不影响安装，可以直接点安装）');
      });
  }

  function setText(id, text) {
    var node = $(id);
    if (node) node.textContent = text;
  }

  /**
   * 渲染详情弹窗底部的链接按钮。
   *
   * 只显示真实存在的链接 —— 缺一个就少一个按钮，绝不放占位。
   */
  function renderDetailLinks(base, detail) {
    var host = $('mod-detail-links');
    if (!host) return;
    host.textContent = '';

    var links = [];

    // MC 百科：搜索页（mcmod 无公开 API，搜索是靠得住的落点）
    var mcmodUrl =
      (detail && detail.mcmodSearchUrl) ||
      base.mcmodSearchUrl ||
      'https://search.mcmod.cn/s?key=' + encodeURIComponent(base.title || base.slug || '');
    links.push({ label: '📖 MC 百科', url: mcmodUrl, hint: '在 MC 百科搜索这个模组' });

    // 官网：优先 source_url，退到 wiki_url
    var official = (detail && (detail.sourceUrl || detail.wikiUrl)) || base.sourceUrl || base.wikiUrl || '';
    if (official !== '') {
      links.push({ label: '🌐 官网', url: official, hint: official });
    }

    // 额外：Modrinth 页面本身（用户常在那边看依赖与更新记录）
    links.push({
      label: 'Modrinth 页面',
      url:
        (detail && detail.modrinthUrl) ||
        base.modrinthUrl ||
        'https://modrinth.com/' + (base.projectType || 'mod') + '/' + (base.slug || ''),
      hint: '',
    });

    if (detail && detail.issuesUrl) {
      links.push({ label: '问题反馈', url: detail.issuesUrl, hint: '' });
    }

    links.forEach(function (item) {
      if (!item.url) return;
      var a = document.createElement('a');
      a.className = 'btn btn-ghost btn-sm mod-detail-link';
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = item.label;
      if (item.hint) a.title = item.hint;
      host.appendChild(a);
    });
  }

  /**
   * 把 Modrinth 的 Markdown 正文降级成纯文本。
   *
   * 为什么不直接 innerHTML：那是第三方内容，塞进我们的 DOM 等于把 XSS 面打开。
   * 这里只做最小清理（去掉标题符号 / 链接语法 / 图片），保留可读性。
   */
  function stripMarkdown(text) {
    return String(text)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/[*_`>]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4000);
  }

  function closeDetail() {
    var backdrop = $('mod-detail');
    if (backdrop) backdrop.hidden = true;
    state.detailRequestId = '';
  }

  /**
   * 把安装响应里的依赖信息呈现给用户。
   *
   * 两级呈现：
   *   - 有依赖 → 面板里显示一块醒目提示（可点「去安装」直接搜那个依赖）
   *   - 没依赖 → 什么都不做，不要无病呻吟
   *
   * 依赖名称后端已经解析过（`requiredDependencyDetails`），拿不到时退回 id。
   */
  function reportDependencies(data, hit) {
    var details = Array.isArray(data && data.requiredDependencyDetails)
      ? data.requiredDependencyDetails
      : [];
    var ids = Array.isArray(data && data.requiredDependencies) ? data.requiredDependencies : [];

    var names = details
      .map(function (d) {
        return d && (d.title || d.id) ? String(d.title || d.id) : '';
      })
      .filter(function (s) {
        return s !== '';
      });

    if (names.length === 0 && ids.length > 0) names = ids.slice();

    var host = $('mods-deps');
    if (names.length === 0) {
      if (host) {
        host.hidden = true;
        host.textContent = '';
      }
      return;
    }

    var text =
      '「' + (hit.title || hit.slug || '这个 mod') + '」还需要前置模组：' + names.join('、') +
      '。没有它们游戏会启动失败。';

    if (typeof window.pcl3AppendLog === 'function') {
      window.pcl3AppendLog('⚠ ' + text, 'warn');
    }
    if (typeof window.pcl3Toast === 'function') {
      window.pcl3Toast('还需要前置模组：' + names.join('、'), false);
    }

    // 面板内提示：比 toast 更持久，用户装完还能看到
    if (host) {
      host.hidden = false;
      host.textContent = '';
      host.appendChild(el('span', 'dep-text', text));

      // 给出一个「去装」的快捷入口：点一下就用依赖名搜索
      var slugs = details
        .map(function (d) {
          return d && d.slug ? String(d.slug) : '';
        })
        .filter(function (s) {
          return s !== '';
        });

      var keyword = slugs.length > 0 ? slugs[0] : names[0];
      var go = el('button', 'btn btn-ghost btn-sm', '去安装 ' + (names[0] || keyword));
      go.type = 'button';
      go.addEventListener('click', function () {
        var input = $('content-q');
        if (input) {
          input.value = keyword;
          input.focus();
        }
        var btn = $('btn-content-search');
        if (btn) btn.click();
      });
      host.appendChild(go);
    }
  }

  /**
   * 依赖清单：在**安装之前**就查出来并渲染成「可一键安装」的列表。
   *
   * 与 reportDependencies 的区别：
   *   - 这个在点「安装」前/详情弹窗里调用，用户先看清要什么
   *   - reportDependencies 是安装响应回来后的补充提示（后端解析好的名称）
   *
   * 数据来自 `GET /api/content/:slug/dependencies`，每一项都已经挑好了
   * 适配当前游戏版本 + 加载器的具体版本，所以「点一下就装对」。
   */
  function renderDependencyList(slug, hostId, opts) {
    var host = $(hostId);
    if (!host) return;

    var instanceId = state.instanceId;
    var params = [];
    if (instanceId) params.push('versionId=' + encodeURIComponent(instanceId));
    if (state.gameVersion) params.push('gameVersion=' + encodeURIComponent(state.gameVersion));
    if (state.loader) params.push('loader=' + encodeURIComponent(state.loader));
    var qs = params.length > 0 ? '?' + params.join('&') : '';

    host.hidden = false;
    host.textContent = '';
    host.appendChild(el('span', 'dep-loading', '正在检查前置模组…'));

    api('/api/content/' + encodeURIComponent(slug) + '/dependencies' + qs, { timeoutMs: 30000 })
      .then(function (data) {
        host.textContent = '';
        var required = Array.isArray(data.required) ? data.required : [];
        var missing = required.filter(function (d) {
          return d && d.installed !== true;
        });

        if (missing.length === 0) {
          // 没有前置需求，或都已经装了 —— 安静收起来，不要制造噪音
          host.hidden = true;
          return;
        }

        host.appendChild(
          el(
            'div',
            'dep-head',
            '这个模组还需要 ' + missing.length + ' 个前置（没有它们游戏会启动失败）：'
          )
        );

        var list = el('ul', 'dep-list');
        missing.forEach(function (dep) {
          var li = el('li', 'dep-item');

          if (dep.iconUrl) {
            var img = document.createElement('img');
            img.className = 'dep-icon';
            img.src = dep.iconUrl;
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            li.appendChild(img);
          }

          var info = el('div', 'dep-info');
          info.appendChild(el('span', 'dep-name', dep.title || dep.slug || dep.id || '未知前置'));
          if (dep.versionNumber) {
            info.appendChild(
              el(
                'span',
                'dep-ver',
                '将安装 ' + dep.versionNumber + (dep.fileSize ? '（' + formatSize(dep.fileSize) + '）' : '')
              )
            );
          } else if (dep.installable === false) {
            info.appendChild(el('span', 'dep-ver', '没有适配当前版本的版本'));
          }
          li.appendChild(info);

          var btn = el('button', 'btn btn-primary btn-sm', '装上前置');
          btn.type = 'button';
          if (dep.installable === false) {
            btn.disabled = true;
            btn.textContent = '无法自动安装';
          } else {
            btn.addEventListener('click', function () {
              installDependency(dep, btn, hostId, slug, opts);
            });
          }
          li.appendChild(btn);

          list.appendChild(li);
        });

        host.appendChild(list);
      })
      .catch(function (err) {
        // 预检失败不该挡住安装：说清楚，然后让用户自己决定
        host.textContent = '';
        host.appendChild(
          el('span', 'dep-loading', '前置检查失败（' + errorText(err) + '），仍可直接安装。')
        );
      });
  }

  /** 装一个前置：直接复用 install 接口，装完刷新清单 */
  function installDependency(dep, button, hostId, slug, opts) {
    var instanceId = state.instanceId;
    if (!instanceId) {
      contentError('先选一个要装到哪个版本。');
      return;
    }
    if (!dep || !dep.installBody) return;

    var body = Object.assign({}, dep.installBody, { versionId: instanceId });

    if (button) {
      button.disabled = true;
      button.textContent = '提交中…';
    }

    api('/api/content/install', { method: 'POST', body: body, timeoutMs: 30000 })
      .then(function (data) {
        if (typeof window.pcl3Toast === 'function') {
          window.pcl3Toast('开始安装前置 ' + (dep.title || dep.slug), true);
        }
        if (typeof window.pcl3AppendLog === 'function') {
          window.pcl3AppendLog('安装前置 ' + (dep.title || dep.slug) + ' 到 ' + instanceId);
        }
        if (typeof window.pcl3FollowJob === 'function') window.pcl3FollowJob(data.jobId);

        if (button) button.textContent = '已提交';
        // 装完重新预检：这个前置消失后，清单会变短甚至消失
        setTimeout(function () {
          renderDependencyList(slug, hostId, opts);
        }, 4000);
      })
      .catch(function (err) {
        if (button) {
          button.disabled = false;
          button.textContent = '装上前置';
        }
        contentError(errorText(err));
      });
  }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // ───────────────────────────── 安装 ─────────────────────────────

  function installProject(hit, button) {
    var instanceId = state.instanceId;
    if (!instanceId) {
      contentError('先在右上角选一个要装到哪个版本。');
      return;
    }
    var slug = hit && hit.slug ? hit.slug : '';
    if (!slug) return;
    if (state.installing[slug]) return;

    state.installing[slug] = true;
    if (button) {
      button.disabled = true;
      button.textContent = '提交中…';
    }
    contentError('');

    if (typeof window.pcl3AppendLog === 'function') {
      window.pcl3AppendLog('请求安装 ' + (hit.title || slug) + ' 到 ' + instanceId + ' …');
    }

    var body = { instanceId: instanceId, slug: slug };
    // 把当前筛选条件一起带上：用户明确选了 1.21 + fabric，就该按这个挑
    if (state.gameVersion) body.gameVersion = state.gameVersion;
    if (state.loader) body.loader = state.loader;

    api('/api/content/install', { method: 'POST', body: body, timeoutMs: 30000 })
      .then(function (data) {
        if (typeof window.pcl3AppendLog === 'function') {
          window.pcl3AppendLog('已创建任务 ' + data.jobId + '：' + (data.filename || ''));
        }
        if (typeof window.pcl3Toast === 'function') {
          window.pcl3Toast('开始下载 ' + (hit.title || slug) + '（' + (data.versionNumber || '') + '）', true);
        }

        // ── 依赖提示 ──
        // 用户装了个需要前置模组的 mod（例如装 X 需要 Fabric API），
        // 不提醒的话他进游戏会看到「缺少依赖」然后一脸问号。
        reportDependencies(data, hit);

        // 复用 app.js 的任务面板：POST 之后由 app.js 的轮询接管
        if (typeof window.pcl3FollowJob === 'function') {
          window.pcl3FollowJob(data.jobId);
        }
      })
      .catch(function (error) {
        var text = messageOf(error);
        if (error && error.hint) text += '\n' + error.hint;
        contentError('安装失败：' + text);
        if (typeof window.pcl3ShowError === 'function') window.pcl3ShowError('安装失败：' + text);
        if (typeof window.pcl3AppendLog === 'function') {
          window.pcl3AppendLog('安装失败：' + text, 'error');
        }
        if (error && error.status === 409 && error.body && error.body.jobId && typeof window.pcl3FollowJob === 'function') {
          window.pcl3FollowJob(error.body.jobId);
        }
      })
      .finally(function () {
        state.installing[slug] = false;
        if (button) {
          button.disabled = false;
          button.textContent = '安装';
        }
      });
  }

  // ───────────────────────────── 已装模组 ─────────────────────────────

  function loadMods() {
    var instanceId = state.instanceId;
    var list = $('mods-list');
    var empty = $('mods-empty');
    var summary = $('mods-summary');

    if (!instanceId) {
      if (list) list.textContent = '';
      if (summary) summary.textContent = '—';
      if (empty) {
        empty.hidden = false;
        empty.className = 'empty';
        empty.textContent = '先在上面选一个版本。';
      }
      return;
    }

    if (empty) {
      empty.hidden = false;
      empty.className = 'empty';
      empty.textContent = '正在读取 mods 目录…';
    }

    api('/api/instances/' + encodeURIComponent(instanceId) + '/mods', { timeoutMs: 30000 })
      .then(function (data) {
        if (state.instanceId !== instanceId) return; // 用户切了实例
        var mods = Array.isArray(data.mods) ? data.mods : [];
        renderMods(mods, data);
      })
      .catch(function (error) {
        if (state.instanceId !== instanceId) return;
        if (list) list.textContent = '';
        if (summary) summary.textContent = '—';
        if (empty) {
          empty.hidden = false;
          empty.className = 'empty error-text';
          empty.textContent = '模组列表读取失败：' + messageOf(error);
        }
      });
  }

  function renderMods(mods, data) {
    var list = $('mods-list');
    var empty = $('mods-empty');
    var summary = $('mods-summary');
    if (!list) return;

    list.textContent = '';

    if (summary) {
      summary.textContent = mods.length === 0
        ? '0 个'
        : mods.length + ' 个（' + (data && typeof data.enabledCount === 'number' ? data.enabledCount : 0) + ' 个启用）';
    }

    if (mods.length === 0) {
      if (empty) {
        empty.hidden = false;
        empty.className = 'empty';
        empty.textContent = data && data.dirExists === false
          ? '这个版本的 mods 目录还不存在 —— 一个模组都没装过。'
          : '这个版本的 mods 目录是空的。搜点什么装一下吧。';
      }
      return;
    }

    if (empty) empty.hidden = true;

    var frag = document.createDocumentFragment();
    mods.forEach(function (mod) {
      frag.appendChild(buildModRow(mod));
    });
    list.appendChild(frag);
  }

  /** 一行已装模组：名称 + 版本 + 文件名 + 大小 + 开关 + 删除 */
  function buildModRow(mod) {
    var li = el('li', 'pack-item' + (mod.enabled ? '' : ' is-disabled'));
    li.setAttribute('data-filename', mod.filename || '');

    var main = el('div', 'pack-main');
    main.appendChild(el('div', 'pack-name', mod.name || mod.id || mod.filename));

    var meta = el('div', 'pack-meta');
    if (mod.version) meta.appendChild(el('span', 'tag tag-pack-format', mod.version));
    if (mod.id && mod.id !== mod.name) meta.appendChild(el('span', 'tag', mod.id));
    meta.appendChild(el('span', null, formatBytes(mod.size)));
    if (!mod.enabled) meta.appendChild(el('span', 'tag', '已禁用'));
    if (mod.metaError) {
      var warn = el('span', null, '元数据读不到');
      warn.title = mod.metaError;
      meta.appendChild(warn);
    }
    main.appendChild(meta);

    main.appendChild(el('div', 'pack-desc', mod.filename));
    li.appendChild(main);

    var actions = el('div', 'pack-actions');

    var toggle = el('button', 'btn btn-ghost btn-sm' + (mod.enabled ? ' btn-on' : ''), mod.enabled ? '启用中' : '已禁用');
    toggle.type = 'button';
    toggle.title = mod.enabled ? '点一下禁用（改名为 .disabled）' : '点一下启用（去掉 .disabled）';
    toggle.addEventListener('click', function () {
      setModEnabled(mod, !mod.enabled, toggle);
    });
    actions.appendChild(toggle);

    var del = el('button', 'btn btn-ghost btn-sm btn-danger-ghost', '删除');
    del.type = 'button';
    del.addEventListener('click', function () {
      removeMod(mod, del);
    });
    actions.appendChild(del);

    li.appendChild(actions);
    return li;
  }

  function setModEnabled(mod, enabled, button) {
    var instanceId = state.instanceId;
    if (!instanceId || !mod || !mod.filename) return;
    if (button) button.disabled = true;

    api(
      '/api/instances/' + encodeURIComponent(instanceId) + '/mods/' + encodeURIComponent(mod.filename) + '/toggle',
      { method: 'POST', body: { enabled: enabled }, timeoutMs: 15000 }
    )
      .then(function (data) {
        if (typeof window.pcl3AppendLog === 'function') {
          window.pcl3AppendLog(
            (enabled ? '已启用 ' : '已禁用 ') + mod.filename + '（磁盘上是 ' + (data.diskName || '?') + '）'
          );
        }
        loadMods();
      })
      .catch(function (error) {
        if (typeof window.pcl3ShowError === 'function') {
          window.pcl3ShowError('切换模组状态失败：' + messageOf(error));
        }
        contentError('切换模组状态失败：' + messageOf(error));
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  }

  function removeMod(mod, button) {
    var instanceId = state.instanceId;
    if (!instanceId || !mod || !mod.filename) return;

    var label = mod.name || mod.filename;
    if (!window.confirm('确定删除「' + label + '」？\n这个操作不可恢复（文件会从 mods 目录里删掉）。')) return;

    if (button) button.disabled = true;

    api('/api/instances/' + encodeURIComponent(instanceId) + '/mods/' + encodeURIComponent(mod.filename), {
      method: 'DELETE',
      timeoutMs: 15000
    })
      .then(function () {
        if (typeof window.pcl3Toast === 'function') window.pcl3Toast('已删除 ' + label, true);
        if (typeof window.pcl3AppendLog === 'function') window.pcl3AppendLog('已删除模组：' + mod.filename);
        loadMods();
      })
      .catch(function (error) {
        var text = messageOf(error);
        contentError('删除失败：' + text);
        if (typeof window.pcl3ShowError === 'function') window.pcl3ShowError('删除失败：' + text);
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  }

  // ───────────────────────────── 事件绑定 ─────────────────────────────

  function bind() {
    var panel = $('content-panel');
    if (!panel) return;

    // ── 详情弹窗的关闭方式：X 按钮 / 点遮罩 / Esc ──
    var detail = $('mod-detail');
    if (detail) {
      detail.addEventListener('click', function (event) {
        // 只有点在遮罩本身（而不是弹窗内容里）才关闭
        if (event.target === detail) closeDetail();
      });
      var closeBtn = $('mod-detail-close');
      if (closeBtn) closeBtn.addEventListener('click', closeDetail);
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !detail.hidden) closeDetail();
      });
    }

    var searchBtn = $('btn-content-search');
    if (searchBtn) {
      searchBtn.addEventListener('click', function () {
        doSearch(true);
      });
    }

    var q = $('content-q');
    if (q) {
      q.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          doSearch(true);
        }
      });
    }

    var typeHost = $('content-type');
    if (typeHost) {
      typeHost.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.getAttribute) return;
        var type = target.getAttribute('data-project-type');
        if (!type) return;
        state.type = type;
        var buttons = typeHost.querySelectorAll('.seg-btn');
        for (var i = 0; i < buttons.length; i += 1) {
          if (buttons[i] === target) buttons[i].classList.add('is-active');
          else buttons[i].classList.remove('is-active');
        }
        doSearch(true);
      });
    }

    var gameSelect = $('content-game-version');
    if (gameSelect) {
      gameSelect.addEventListener('change', function () {
        state.gameVersion = gameSelect.value;
        doSearch(true);
      });
    }

    var loaderSelect = $('content-loader');
    if (loaderSelect) {
      loaderSelect.addEventListener('change', function () {
        state.loader = loaderSelect.value;
        doSearch(true);
      });
    }

    var instanceSelect = $('content-instance');
    if (instanceSelect) {
      instanceSelect.addEventListener('change', function () {
        state.instanceId = instanceSelect.value;
        loadMods();
      });
    }

    var more = $('btn-content-more');
    if (more) {
      more.addEventListener('click', function () {
        state.offset = state.hits.length;
        doSearch(false);
      });
    }

    var refresh = $('btn-content-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        refresh.disabled = true;
        loadMods();
        setTimeout(function () {
          refresh.disabled = false;
        }, 800);
      });
    }

    // 全局唯一入口：app.js 在任务面板、日志、toast 上都是同一份实现
    window.pcl3OnModJob = function () {
      loadMods();
    };

    // 顺序：先把游戏版本下拉灌满（否则按实例推出来的值会静默落空），再读实例列表
    seedGameVersions().finally(function () {
      loadInstances();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
