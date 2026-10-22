/**
 * 基础设施前端（infra-dev）：全局设置（数据目录 / 下载源）、源测速展示、崩溃分析结果。
 *
 * 约束（与仓库既有约定一致）：
 *   1. 纯原生 JS，无框架、无 CDN、无构建步骤。
 *   2. **只追加**：本文件不改 app.js 的任何既有行为，只复用它的公共入口
 *      （window.pcl3AppendLog / pcl3ShowError / pcl3Toast），拿不到就降级成 console。
 *   3. 失败必须让用户看见：任何 fetch 失败都写进对应区域，不许停在「读取中…」。
 *   4. 一律 textContent 写 DOM，杜绝 HTML 注入（崩溃日志是外部内容）。
 */
(function () {
  'use strict';

  // ───────────────────────────── 与 app.js 的接口 ─────────────────────────────

  function log(text, level) {
    if (typeof window.pcl3AppendLog === 'function') {
      window.pcl3AppendLog(text, level);
      return;
    }
    // eslint-disable-next-line no-console
    console.log('[infra]', text);
  }

  function showError(text) {
    if (typeof window.pcl3ShowError === 'function') {
      window.pcl3ShowError(text);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[infra]', text);
  }

  function toast(text, ok) {
    if (typeof window.pcl3Toast === 'function') {
      window.pcl3Toast(text, ok);
      return;
    }
    // eslint-disable-next-line no-console
    console.log('[infra]', text);
  }

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * 运行期安装的崩溃分析入口：app.js / modpack.js 在任务失败时调用
   * `window.pcl3AnalyzeCrash(instanceId)`。
   *
   * 说明：脚本加载顺序（app.js → infra.js）意味着 app.js 在**加载时**拿不到这个函数，
   * 但它在**运行时**（用户点启动、任务失败之后）才读取 `window.pcl3AnalyzeCrash`，
   * 所以那时已经就绪。任何调用方都必须做 `typeof ... === 'function'` 判断。
   */

  /** 把任意错误翻成人话（与 app.js 的 messageOf 同语义） */
  function messageOf(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    if (error.name === 'AbortError') return '请求超时（服务器没有响应）';
    if (error.message) return error.message;
    try {
      return JSON.stringify(error);
    } catch (e) {
      return String(error);
    }
  }

  /**
   * 与 app.js 的 api() 同语义：带超时、带 JSON 解析、错误里带状态码。
   * 刻意另写一份而不是复用：app.js 的 api 在闭包里，不对外暴露。
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
            var err = new Error('HTTP ' + res.status + '：' + detail);
            err.status = res.status;
            err.body = data;
            throw err;
          }
          return data === null ? {} : data;
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

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // ───────────────────────────── 下载源测速 ─────────────────────────────

  var MIRROR_LABEL = {
    mojang: 'Mojang 官方',
    piston: 'Mojang Piston CDN',
    bmclapi: 'BMCLAPI 镜像'
  };

  function mirrorLabel(id) {
    return MIRROR_LABEL[id] || id;
  }

  function renderMirrors(mirrors, hintText) {
    var list = $('mirror-list');
    if (!list) return;
    list.textContent = '';

    if (!mirrors || mirrors.length === 0) {
      var empty = el('li', 'muted', '还没有测速结果，点下面「重新测速」。');
      list.appendChild(empty);
      if ($('mirror-hint')) $('mirror-hint').textContent = hintText || '未测速';
      return;
    }

    mirrors.forEach(function (m, index) {
      var item = el('li', 'mirror-item' + (index === 0 && m.ok ? ' is-best' : ''));

      var left = el('div', 'mirror-main');
      var name = el('span', 'mirror-name', (index === 0 && m.ok ? '★ ' : '') + mirrorLabel(m.id));
      var latency = el(
        'span',
        m.ok ? 'mirror-latency' : 'mirror-latency is-bad',
        m.ok ? Math.round(m.latencyMs) + ' ms' : '不可用'
      );
      left.appendChild(name);
      left.appendChild(latency);
      item.appendChild(left);

      var note = el('div', 'mirror-base', m.base || '');
      item.appendChild(note);
      list.appendChild(item);
    });

    if ($('mirror-hint')) {
      var best = mirrors.filter(function (m) {
        return m.ok;
      })[0];
      $('mirror-hint').textContent = best ? '当前：' + mirrorLabel(best.id) : '全部不可用';
    }
  }

  function loadMirrors() {
    return api('/api/mirrors', { timeoutMs: 25000 })
      .then(function (data) {
        var mirrors = data && data.mirrors ? data.mirrors : [];
        renderMirrors(mirrors);
        return mirrors;
      })
      .catch(function (error) {
        var list = $('mirror-list');
        if (list) {
          list.textContent = '';
          list.appendChild(el('li', 'muted error-text', '测速结果读取失败：' + messageOf(error)));
        }
        if ($('mirror-hint')) $('mirror-hint').textContent = '不可用';
        throw error;
      });
  }

  function probeMirrors() {
    var button = $('btn-mirror-probe');
    if (button) {
      button.disabled = true;
      button.textContent = '测速中…';
    }
    if ($('mirror-hint')) $('mirror-hint').textContent = '测速中…';

    return api('/api/mirrors/probe', { method: 'POST', timeoutMs: 60000 })
      .then(function (data) {
        var mirrors = data && data.mirrors ? data.mirrors : [];
        renderMirrors(mirrors);
        var best = mirrors.filter(function (m) {
          return m.ok;
        })[0];
        if (best) {
          toast('测速完成：最快是 ' + mirrorLabel(best.id) + '（' + Math.round(best.latencyMs) + ' ms）', true);
          log('下载源测速完成，选用 ' + best.id + '：' + Math.round(best.latencyMs) + ' ms');
        } else {
          showError('所有下载源都测不通，安装会失败。请检查网络 / 代理。');
        }
        return mirrors;
      })
      .catch(function (error) {
        showError('测速失败：' + messageOf(error));
      })
      .finally(function () {
        if (button) {
          button.disabled = false;
          button.textContent = '重新测速';
        }
      });
  }

  // ───────────────────────────── 全局设置弹窗 ─────────────────────────────

  var state = {
    config: null,
    busy: false,
    checkedDir: null
  };

  function configError(text) {
    var node = $('config-error');
    if (!node) return;
    if (!text) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.textContent = text;
    node.hidden = false;
  }

  function setHint(id, text, hidden) {
    var node = $(id);
    if (!node) return;
    node.textContent = text || '';
    node.hidden = hidden === true;
  }

  /** 把 /api/config 的响应铺进表单 */
  function fillConfigForm(data) {
    state.config = data || {};
    var cfg = state.config.config || {};

    var rootInput = $('config-data-root');
    if (rootInput) rootInput.value = cfg.dataRoot || '';

    // 没有配置来源时退回 /api/status 报告的实际目录，别让「当前」一栏空着
    var effectiveRoot = state.config.dataRoot || '';
    setHint(
      'config-data-root-current',
      effectiveRoot ? '当前生效：' + effectiveRoot : '当前生效目录未知（读取 /api/status 失败）'
    );

    var mode = $('config-mirror-mode');
    var idSel = $('config-mirror-id');
    var fixed = cfg.autoProbeMirror === false && !!cfg.preferredMirror;
    if (mode) mode.value = fixed ? 'fixed' : 'auto';
    if (idSel) {
      idSel.disabled = !fixed;
      if (cfg.preferredMirror) idSel.value = cfg.preferredMirror;
    }
    setHint(
      'config-path-line',
      '配置文件：' + (state.config.configPath || '未知') + '（不在数据目录里，改目录不会丢配置）'
    );

    if (state.config.warning) configError(state.config.warning);
    else configError('');
  }

  function fillMirrorOptions() {
    var sel = $('config-mirror-id');
    if (!sel) return;
    var current = sel.value;
    sel.textContent = '';
    Object.keys(MIRROR_LABEL).forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = MIRROR_LABEL[id] + '（' + id + '）';
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  function openConfigModal() {
    var backdrop = $('config-modal');
    if (!backdrop) return;
    backdrop.hidden = false;
    configError('');
    setHint('config-data-root-check', '', true);
    setHint('config-data-root-notice', '', true);
    state.checkedDir = null;

    var save = $('config-save');
    if (save) {
      save.disabled = true;
      save.textContent = '读取中…';
    }
    fillMirrorOptions();

    api('/api/config', { timeoutMs: 15000 })
      .then(function (data) {
        fillConfigForm(data);
        if (save) {
          save.disabled = false;
          save.textContent = '保存';
        }
      })
      .catch(function (error) {
        configError('配置读取失败：' + messageOf(error));
        if (save) {
          save.disabled = false;
          save.textContent = '保存';
        }
      });
  }

  function closeConfigModal() {
    var backdrop = $('config-modal');
    if (backdrop) backdrop.hidden = true;
  }

  /** 校验当前输入框里的目录，结果写进 config-data-root-check */
  function validateDirInput() {
    var input = $('config-data-root');
    var dir = input ? input.value.trim() : '';
    if (!dir) {
      setHint('config-data-root-check', '请先填一个目录路径。');
      state.checkedDir = null;
      return Promise.resolve(null);
    }

    setHint('config-data-root-check', '正在校验…');
    return api('/api/config/validate-dir', { method: 'POST', body: { dir: dir }, timeoutMs: 20000 })
      .then(function (check) {
        var lines = [];
        if (check.ok) {
          lines.push('✔ 可以用作数据目录' + (check.exists ? '（目录已存在）' : '（目录会被创建）'));
          state.checkedDir = check.dir;
        } else {
          lines.push('✘ ' + (check.reason || '这个目录不能用作数据目录'));
          state.checkedDir = null;
        }
        if (check.looksLikeDataRoot) lines.push('这个目录里已经有 versions / libraries / assets，像是另一份 PCL3 数据。');
        (check.warnings || []).forEach(function (w) {
          lines.push('! ' + w);
        });
        setHint('config-data-root-check', lines.join('\n'));

        if (check.ok && check.notice) setHint('config-data-root-notice', check.notice, false);
        else setHint('config-data-root-notice', '', true);

        return check;
      })
      .catch(function (error) {
        setHint('config-data-root-check', '校验失败：' + messageOf(error));
        state.checkedDir = null;
        return null;
      });
  }

  function submitConfig() {
    if (state.busy) return;
    var save = $('config-save');

    var rootInput = $('config-data-root');
    var typedRoot = rootInput ? rootInput.value.trim() : '';
    var savedRoot =
      state.config && state.config.config && state.config.config.dataRoot
        ? String(state.config.config.dataRoot)
        : '';

    var body = {};
    var mode = $('config-mirror-mode');
    var idSel = $('config-mirror-id');
    if (mode && mode.value === 'fixed') {
      var id = idSel ? idSel.value : '';
      if (!id) {
        configError('选了「固定源」就必须挑一个源；想自动选请切到「自动测速」。');
        return;
      }
      body.preferredMirror = id;
      body.autoProbeMirror = false;
    } else {
      body.preferredMirror = null;
      body.autoProbeMirror = true;
    }
    if (typedRoot !== savedRoot) body.dataRoot = typedRoot;

    if (Object.keys(body).length === 0) {
      configError('没有任何改动。');
      return;
    }
    configError('');
    state.busy = true;
    if (save) {
      save.disabled = true;
      save.textContent = '保存中…';
    }

    api('/api/config', { method: 'PUT', body: body, timeoutMs: 30000 })
      .then(function (data) {
        fillConfigForm(data);
        var result = data.dataRootResult;
        if (result && result.notice) {
          setHint('config-data-root-notice', result.notice, false);
          toast('数据目录已切换（旧数据没有自动搬走，请看提示）', true);
          log('数据目录已切换：' + data.dataRoot);
        } else {
          toast('全局设置已保存', true);
          log('全局设置已保存（下载源：' + (body.preferredMirror || '自动测速') + '）');
        }
        // 目录变了就刷新顶栏与列表
        if (typeof window.pcl3LoadVersions === 'function') {
          setTimeout(function () {
            if (typeof window.pcl3LoadVersions === 'function') window.pcl3LoadVersions();
          }, 400);
        }
      })
      .catch(function (error) {
        var bodyErr = error && error.body;
        var text = messageOf(error);
        if (bodyErr && bodyErr.problems && bodyErr.problems.length) text = bodyErr.problems.join('\n');
        configError(text);
        showError('保存全局设置失败：' + text);
      })
      .finally(function () {
        state.busy = false;
        if (save) {
          save.disabled = false;
          save.textContent = '保存';
        }
      });
  }

  function bindConfigModal() {
    var backdrop = $('config-modal');
    if (!backdrop) return;

    var close = $('config-close');
    if (close) close.addEventListener('click', closeConfigModal);
    var cancel = $('config-cancel');
    if (cancel) cancel.addEventListener('click', closeConfigModal);

    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) closeConfigModal();
    });

    var validateBtn = $('config-validate-dir');
    if (validateBtn) validateBtn.addEventListener('click', validateDirInput);

    var mode = $('config-mirror-mode');
    if (mode) {
      mode.addEventListener('change', function () {
        var idSel = $('config-mirror-id');
        if (idSel) idSel.disabled = mode.value !== 'fixed';
        var hint = $('config-mirror-hint');
        if (hint) {
          hint.textContent =
            mode.value === 'fixed'
              ? '固定源不做测速：连不上也不会自动换，适合你知道自己在用哪个源的情况。'
              : '自动测速会在启动时和安装前测一次延迟，连续失败会自动换源。';
        }
      });
    }

    var save = $('config-save');
    if (save) save.addEventListener('click', submitConfig);

    bindSettingsPage();
  }

  // ───────────────────────────── 设置页（页内版本，与弹窗共用接口） ─────────────────────────────
  //
  // 布局改版后，「设置」成了左侧导航里的一个独立页面。数据目录与下载源这两块
  // 现在页内也有一份（弹窗版 #config-modal 原样保留，`window.pcl3OpenConfig` 照旧可用）。
  //
  // 这里只**新增**一段绑定：页内输入框 id 统一是 `setting-*`，不认识就静默跳过，
  // 所以旧页面（没有这些元素）行为完全不变。它调的是同三个接口：
  //   GET  /api/config              —— 读当前值
  //   POST /api/config/validate-dir —— 校验目录
  //   PUT  /api/config              —— 保存
  // 与弹窗版本互不依赖，只共享 state.config 这一份缓存。

  function settingError(text) {
    var node = $('setting-error');
    if (!node) return;
    if (!text) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.textContent = text;
    node.hidden = false;
  }

  function settingMirrorError(text) {
    var node = $('setting-mirror-error');
    if (!node) return;
    if (!text) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.textContent = text;
    node.hidden = false;
  }

  /** 把 /api/config 的结果铺进设置页那份表单 */
  function fillSettingsPage(data) {
    var rootInput = $('setting-data-root');
    if (rootInput) rootInput.value = (data.config && data.config.dataRoot) || '';

    var current = $('setting-data-root-current');
    if (current) {
      current.textContent = data.dataRoot ? '当前：' + data.dataRoot : '当前：未知（读取 /api/status 失败）';
    }

    var pathLine = $('setting-path-line');
    if (pathLine) {
      pathLine.textContent = '配置文件：' + (data.configPath || '未知') + '（不在数据目录里，改目录不会丢配置）';
    }

    // 内存默认值：这里只显示，不写回；真实默认值由后端决定
    var mem = data.config && typeof data.config.defaultMemoryMB === 'number' ? data.config.defaultMemoryMB : 2048;
    var memNode = $('setting-memory-default');
    if (memNode) memNode.textContent = String(mem);

    var mode = $('setting-mirror-mode');
    var idSel = $('setting-mirror-id');
    var cfg = data.config || {};
    if (idSel) {
      var previous = idSel.value;
      idSel.textContent = '';
      Object.keys(MIRROR_LABEL).forEach(function (id) {
        var opt = document.createElement('option');
        opt.value = id;
        opt.textContent = MIRROR_LABEL[id] + '（' + id + '）';
        idSel.appendChild(opt);
      });
      var wanted = cfg.preferredMirror || previous;
      if (wanted) idSel.value = wanted;
    }
    var fixed = cfg.autoProbeMirror === false && cfg.preferredMirror;
    if (mode) mode.value = fixed ? 'fixed' : 'auto';
    if (idSel) idSel.disabled = !fixed;
  }

  /** 读一次 /api/config 并铺进设置页 */
  function loadSettingsPage() {
    var hasAny = $('setting-data-root') || $('setting-mirror-mode');
    if (!hasAny) return Promise.resolve();
    return api('/api/config', { timeoutMs: 15000 })
      .then(function (data) {
        state.config = data || {};
        fillSettingsPage(state.config);
        settingError('');
      })
      .catch(function (error) {
        settingError('配置读取失败：' + messageOf(error));
      });
  }

  function validateSettingDir() {
    var input = $('setting-data-root');
    var check = $('setting-data-root-check');
    var notice = $('setting-data-root-notice');
    var dir = input ? input.value.trim() : '';

    function setCheck(text) {
      if (!check) return;
      if (!text) {
        check.hidden = true;
        check.textContent = '';
      } else {
        check.hidden = false;
        check.textContent = text;
      }
    }

    if (!dir) {
      setCheck('请先填一个目录路径。');
      return Promise.resolve(null);
    }

    setCheck('正在校验…');
    return api('/api/config/validate-dir', { method: 'POST', body: { dir: dir }, timeoutMs: 20000 })
      .then(function (result) {
        var lines = [];
        if (result.ok) {
          lines.push('✔ 可以用作数据目录' + (result.exists ? '（目录已存在）' : '（目录会被创建）'));
        } else {
          lines.push('✘ ' + (result.reason || '这个目录不能用作数据目录'));
        }
        if (result.looksLikeDataRoot) lines.push('这个目录里已经有 versions / libraries / assets，像是另一份 PCL3 数据。');
        (result.warnings || []).forEach(function (w) {
          lines.push('! ' + w);
        });
        setCheck(lines.join('\n'));
        if (notice) {
          if (result.ok && result.notice) {
            notice.textContent = result.notice;
            notice.hidden = false;
          } else {
            notice.hidden = true;
            notice.textContent = '';
          }
        }
        return result;
      })
      .catch(function (error) {
        setCheck('校验失败：' + messageOf(error));
        return null;
      });
  }

  /** 只保存数据目录（不动下载源） */
  function saveSettingsRoot() {
    var input = $('setting-data-root');
    var button = $('setting-save');
    var typed = input ? input.value.trim() : '';
    var saved =
      state.config && state.config.config && state.config.config.dataRoot
        ? String(state.config.config.dataRoot)
        : '';
    if (!typed) {
      settingError('数据目录不能为空。想恢复默认请点「打开完整设置弹窗」里清空后保存。');
      return Promise.resolve();
    }
    if (typed === saved) {
      settingError('数据目录没有变化。');
      return Promise.resolve();
    }

    settingError('');
    if (button) {
      button.disabled = true;
      button.textContent = '保存中…';
    }
    return api('/api/config', { method: 'PUT', body: { dataRoot: typed }, timeoutMs: 30000 })
      .then(function (data) {
        state.config = data || {};
        fillSettingsPage(state.config);
        var result = data.dataRootResult;
        if (result && result.notice) {
          var notice = $('setting-data-root-notice');
          if (notice) {
            notice.textContent = result.notice;
            notice.hidden = false;
          }
          toast('数据目录已切换（旧数据没有自动搬走，请看提示）', true);
        } else {
          toast('数据目录已保存', true);
        }
        log('数据目录已切换：' + data.dataRoot);
        if (typeof window.pcl3LoadVersions === 'function') {
          setTimeout(function () {
            if (typeof window.pcl3LoadVersions === 'function') window.pcl3LoadVersions();
          }, 400);
        }
      })
      .catch(function (error) {
        var body = error && error.body;
        var text = messageOf(error);
        if (body && body.problems && body.problems.length) text = body.problems.join('\n');
        settingError(text);
        showError('保存数据目录失败：' + text);
      })
      .finally(function () {
        if (button) {
          button.disabled = false;
          button.textContent = '保存目录';
        }
      });
  }

  /** 只保存下载源（不动数据目录） */
  function saveSettingsMirror() {
    var mode = $('setting-mirror-mode');
    var idSel = $('setting-mirror-id');
    var button = $('setting-save-mirror');
    var body = {};

    if (mode && mode.value === 'fixed') {
      var id = idSel ? idSel.value : '';
      if (!id) {
        settingMirrorError('选了「固定源」就必须挑一个源；想自动选请切到「自动测速」。');
        return Promise.resolve();
      }
      body.preferredMirror = id;
      body.autoProbeMirror = false;
    } else {
      body.preferredMirror = null;
      body.autoProbeMirror = true;
    }

    settingMirrorError('');
    if (button) {
      button.disabled = true;
      button.textContent = '保存中…';
    }
    return api('/api/config', { method: 'PUT', body: body, timeoutMs: 30000 })
      .then(function (data) {
        state.config = data || {};
        fillSettingsPage(state.config);
        toast('下载源设置已保存' + (body.preferredMirror ? '：固定 ' + mirrorLabel(body.preferredMirror) : '：自动测速'), true);
        log('下载源设置已保存（' + (body.preferredMirror || '自动测速') + '）');
      })
      .catch(function (error) {
        var text = messageOf(error);
        settingMirrorError(text);
        showError('保存下载源失败：' + text);
      })
      .finally(function () {
        if (button) {
          button.disabled = false;
          button.textContent = '保存下载源';
        }
      });
  }

  function bindSettingsPage() {
    if (!$('setting-data-root') && !$('setting-mirror-mode')) return; // 没有这套 DOM 就静默跳过

    var mode = $('setting-mirror-mode');
    if (mode) {
      mode.addEventListener('change', function () {
        var idSel = $('setting-mirror-id');
        if (idSel) idSel.disabled = mode.value !== 'fixed';
        var note = $('setting-mirror-note');
        if (note) {
          note.textContent =
            mode.value === 'fixed'
              ? '固定源不做测速：连不上也不会自动换，适合你知道自己在用哪个源的情况。'
              : '自动测速会在启动时和安装前测一次延迟，连续失败会自动换源。';
        }
      });
    }

    var validate = $('setting-validate-dir');
    if (validate) validate.addEventListener('click', validateSettingDir);

    var saveRoot = $('setting-save');
    if (saveRoot) saveRoot.addEventListener('click', saveSettingsRoot);

    var saveMirror = $('setting-save-mirror');
    if (saveMirror) saveMirror.addEventListener('click', saveSettingsMirror);

    // 「打开完整设置弹窗」：走弹窗那条既有路径（openConfigModal 自己会拉 /api/config）
    var openModal = $('setting-open-config');
    if (openModal) openModal.addEventListener('click', openConfigModal);

    // 首屏读一次；之后每次切回设置页再读，保证看到的是最新值
    loadSettingsPage();
    document.addEventListener('pcl3:page-shown', function (event) {
      var detail = event && event.detail;
      if (detail && detail.page === 'settings') loadSettingsPage();
    });
  }

  // ───────────────────────────── 崩溃分析 ─────────────────────────────

  var crashState = { findings: [], summary: '', busy: false };

  function renderCrashResult(instanceId, data) {
    var list = $('crash-list');
    if (!list) return;
    list.textContent = '';
    crashState.findings = (data && data.findings) || [];
    crashState.summary = (data && data.summary) || '';

    var sub = $('crash-sub');
    if (sub) {
      sub.textContent = crashState.findings.length
        ? '发现 ' + crashState.findings.length + ' 条可疑原因（按可能性排序）'
        : '没有从日志里认出已知原因';
    }

    if (crashState.findings.length === 0) {
      list.appendChild(
        el('li', 'crash-item', (data && data.reason) || '没有找到崩溃报告，可能还没崩过。')
      );
    } else {
      crashState.findings.forEach(function (finding, index) {
        var item = el('li', 'crash-item');
        item.appendChild(el('div', 'crash-title', '【' + (index + 1) + '】' + finding.title));
        if (finding.detail) item.appendChild(el('div', 'crash-detail', finding.detail));
        if (finding.evidence && finding.evidence.length) {
          var ev = el('div', 'crash-evidence-label', '证据：');
          item.appendChild(ev);
          var pre = el('pre', 'crash-evidence');
          pre.textContent = finding.evidence.join('\n');
          item.appendChild(pre);
        }
        list.appendChild(item);
      });
    }

    var pathLine = $('crash-report-path');
    if (pathLine) {
      pathLine.textContent = data && data.reportPath ? '报告：' + data.reportPath : '';
    }
    if ($('crash-error')) $('crash-error').hidden = true;

    log(
      '实例 ' + instanceId + ' 崩溃分析：' +
        (crashState.findings.length ? crashState.findings[0].title : '未识别')
    );
  }

  function openCrashModal(instanceId) {
    var backdrop = $('crash-modal');
    if (!backdrop) return;
    backdrop.hidden = false;
    crashState.findings = [];
    crashState.summary = '';

    var sub = $('crash-sub');
    if (sub) sub.textContent = '正在读取最近的崩溃报告…';
    var list = $('crash-list');
    if (list) {
      list.textContent = '';
      list.appendChild(el('li', 'crash-item', '读取中…'));
    }
    if ($('crash-report-path')) $('crash-report-path').textContent = '';

    api('/api/instances/' + encodeURIComponent(instanceId) + '/crash-analysis', { timeoutMs: 25000 })
      .then(function (data) {
        renderCrashResult(instanceId, data);
      })
      .catch(function (error) {
        if (sub) sub.textContent = '崩溃分析失败';
        var node = $('crash-error');
        if (node) {
          node.textContent = messageOf(error);
          node.hidden = false;
        }
      });
  }

  function closeCrashModal() {
    var backdrop = $('crash-modal');
    if (backdrop) backdrop.hidden = true;
  }

  function copyCrashSummary() {
    var text = crashState.summary;
    if (!text) {
      toast('没有可复制的结论', false);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast('结论已复制到剪贴板', true);
        },
        function () {
          toast('复制失败，请手动选中文本', false);
        }
      );
      return;
    }
    toast('这个浏览器不支持自动复制，请手动选中文本', false);
  }

  function bindCrashModal() {
    var close = $('crash-close');
    if (close) close.addEventListener('click', closeCrashModal);
    var ok = $('crash-ok');
    if (ok) ok.addEventListener('click', closeCrashModal);
    var copy = $('crash-copy');
    if (copy) copy.addEventListener('click', copyCrashSummary);
    var backdrop = $('crash-modal');
    if (backdrop) {
      backdrop.addEventListener('click', function (event) {
        if (event.target === backdrop) closeCrashModal();
      });
    }
  }

  // ───────────────────────────── 启动失败时自动分析 ─────────────────────────────

  /**
   * 任务面板出现 failed 时调用：先取最近一次崩溃报告的分析。
   *
   * 为什么在这里主动弹：用户看到的就是「任务失败」，唯一有用的下一步是
   * 「为什么失败、我该改什么」——原始堆栈帮不上忙。分析器没有结论时
   * 也只说「没认出」，绝不编造。
   */
  function analyzeAfterFailure(instanceId) {
    if (!instanceId || typeof instanceId !== 'string') return;
    if (crashState.busy) return;
    crashState.busy = true;
    openCrashModal(instanceId);
    setTimeout(function () {
      crashState.busy = false;
    }, 800);
  }

  // ───────────────────────────── 启动 ─────────────────────────────

  function bind() {
    bindConfigModal();
    bindCrashModal();

    var openConfig = $('btn-open-config');
    if (openConfig) openConfig.addEventListener('click', openConfigModal);

    var probe = $('btn-mirror-probe');
    if (probe) probe.addEventListener('click', probeMirrors);

    // 首屏：只有 /api/status 已经有测速缓存时才立刻有数据；否则这里补一次
    loadMirrors().catch(function () {});

    // 刷新按钮一起刷新源状态（app.js 的刷新只刷版本/状态/账户）
    var refresh = $('btn-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        loadMirrors().catch(function () {});
      });
    }
  }

  // 对外暴露：启动任务失败时由 app.js/modpack.js 之类调用
  window.pcl3AnalyzeCrash = analyzeAfterFailure;
  window.pcl3OpenConfig = openConfigModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
