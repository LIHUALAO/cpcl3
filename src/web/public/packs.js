/**
 * 内容面板：资源包 / 数据包 / 光影包的本地管理（纯原生 JS，零 CDN，零构建）。
 *
 * 与 app.js 的分工（重要）：
 *   - 本文件**只新增** DOM 与事件，不修改 app.js 里已有的函数与结构；
 *   - app.js 里的通用工具（api/el/toast/messageOf）没有暴露到 window，
 *     所以这里自己实现一份最小版，而不是去改 app.js（并行开发期间谁都不想被对方的重排打乱）。
 *
 * 三条与后端对齐的约定：
 *   1. `filename` 一律用**原文件名**（不带 `.disabled`）。启停是服务端改扩展名的事，
 *      前端表格里永远只显示一个「材质包.zip」，避免同一个包出现两行。
 *   2. 数据包的 `saveName` 传空字符串 = 全局 datapacks/；传存档名 = saves/<名>/datapacks/。
 *   3. 上传走 `multipart/form-data`（`<input type="file">` 的原生形态），
 *      后端会自己解析，不需要 base64。
 */
(function () {
  'use strict';

  // ───────────────────────────── 小工具 ─────────────────────────────

  function $(id) {
    return document.getElementById(id);
  }

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
    if (error instanceof Error && error.message) return error.message;
    try {
      return JSON.stringify(error);
    } catch (e) {
      return String(error);
    }
  }

  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n = n / 1024;
      i += 1;
    }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  }

  /** 带超时的 fetch（贴 app.js 的 api()，但独立实现） */
  function api(path, options) {
    var opts = options || {};
    var timeoutMs = opts.timeoutMs || 30000;
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
            var err = new Error(detail);
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

  function toast(text, ok) {
    var existing = document.querySelector('.toast');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var node = el('div', ok === true ? 'toast is-ok' : 'toast', text);
    document.body.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 5000);
  }

  // ───────────────────────────── 状态 ─────────────────────────────

  var KIND_LABEL = { resourcepack: '资源包', datapack: '数据包', shader: '光影包' };
  var STORAGE_INSTANCE = 'pcl3.packs.instance';

  var state = {
    /** 当前实例（= 版本 id / 实例目录名） */
    instanceId: localStorage.getItem(STORAGE_INSTANCE) || '',
    /** 当前标签 */
    kind: 'resourcepack',
    /** 数据包的目标存档；空 = 全局 */
    saveName: '',
    packs: [],
    saves: [],
    /** 版本列表（给「选版本」下拉用） */
    instances: [],
    busy: false
  };

  function errorNode(text) {
    var node = $('packs-error');
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.hidden = true;
      node.textContent = '';
    }
  }

  // ───────────────────────────── 实例（版本）选择 ─────────────────────────────

  /** 从 /api/versions 里拿已装版本（含加载器 profile），拼成下拉 */
  function loadInstances() {
    var select = $('packs-instance');
    if (!select) return Promise.resolve();

    return api('/api/versions?limit=200&type=all', { timeoutMs: 30000 })
      .then(function (data) {
        var ids = [];
        (data.installed || []).forEach(function (id) {
          if (ids.indexOf(id) === -1) ids.push(id);
        });
        (data.loaderProfiles || []).forEach(function (p) {
          if (p && p.versionId && ids.indexOf(p.versionId) === -1) ids.push(p.versionId);
        });
        state.instances = ids.sort();

        select.textContent = '';
        if (ids.length === 0) {
          var opt = el('option', null, '— 还没有已安装的版本 —');
          opt.value = '';
          select.appendChild(opt);
          select.disabled = true;
          return;
        }
        select.disabled = false;
        ids.forEach(function (id) {
          var option = el('option', null, id);
          option.value = id;
          select.appendChild(option);
        });

        if (!state.instanceId || ids.indexOf(state.instanceId) === -1) {
          state.instanceId = ids[0];
        }
        select.value = state.instanceId;
        localStorage.setItem(STORAGE_INSTANCE, state.instanceId);
      })
      .catch(function (error) {
        errorNode('读取版本列表失败：' + messageOf(error));
      });
  }

  // ───────────────────────────── 列表渲染 ─────────────────────────────

  function instanceQuery() {
    var query = '?kind=' + encodeURIComponent(state.kind);
    if (state.kind === 'datapack' && state.saveName) {
      query += '&save=' + encodeURIComponent(state.saveName);
    }
    return query;
  }

  function loadPacks() {
    var list = $('pack-list');
    var empty = $('packs-empty');
    if (!list) return Promise.resolve();

    if (!state.instanceId) {
      list.textContent = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = '先在上面选一个版本，再看看这一类里有什么。';
      }
      return Promise.resolve();
    }

    errorNode('');
    if (empty) {
      empty.hidden = false;
      empty.textContent = '正在读取 ' + KIND_LABEL[state.kind] + '…';
    }

    return api('/api/instances/' + encodeURIComponent(state.instanceId) + '/packs' + instanceQuery(), {
      timeoutMs: 20000
    })
      .then(function (data) {
        state.packs = Array.isArray(data.packs) ? data.packs : [];
        state.saves = Array.isArray(data.saves) ? data.saves : [];
        renderSaves();
        renderList(data.dir);
      })
      .catch(function (error) {
        state.packs = [];
        if (list) list.textContent = '';
        if (empty) {
          empty.hidden = false;
          empty.textContent = '读取失败：' + messageOf(error);
        }
        errorNode('读取' + KIND_LABEL[state.kind] + '失败：' + messageOf(error));
      });
  }

  function renderSaves() {
    var field = $('packs-save-field');
    var select = $('packs-save');
    if (!field || !select) return;

    field.hidden = state.kind !== 'datapack';
    if (state.kind !== 'datapack') return;

    select.textContent = '';
    var globalOpt = el('option', null, '全局（所有存档，1.20+）');
    globalOpt.value = '';
    select.appendChild(globalOpt);

    state.saves.forEach(function (save) {
      var option = el('option', null, save.name + (save.hasDatapacks ? '' : '（还没有 datapacks 目录）'));
      option.value = save.name;
      select.appendChild(option);
    });

    // 选中的存档可能已经不在了（被删），退回全局
    if (state.saveName) {
      var exists = state.saves.some(function (s) {
        return s.name === state.saveName;
      });
      if (!exists) state.saveName = '';
    }
    select.value = state.saveName;
  }

  function formatOf(pack) {
    if (state.kind === 'shader') {
      return pack.hasShaders === true ? 'shaders/ 已识别' : '未发现 shaders/';
    }
    if (typeof pack.packFormat === 'number') {
      var range = pack.packFormatRange;
      if (range && typeof range.maxInclusive === 'number' && range.maxInclusive !== pack.packFormat) {
        return 'pack_format ' + pack.packFormat + '–' + range.maxInclusive;
      }
      return 'pack_format ' + pack.packFormat;
    }
    return '未知格式';
  }

  function renderList(dir) {
    var list = $('pack-list');
    var empty = $('packs-empty');
    if (!list) return;
    list.textContent = '';

    if (state.packs.length === 0) {
      if (empty) {
        empty.hidden = false;
        empty.textContent =
          '这个 ' +
          KIND_LABEL[state.kind] +
          '目录里还没有东西' +
          (state.kind === 'datapack' && state.saveName ? '（存档「' + state.saveName + '」）' : '（全局）') +
          '。点右上角「导入本地文件」放一个 .zip 进来。';
      }
      return;
    }
    if (empty) empty.hidden = true;

    state.packs.forEach(function (pack) {
      list.appendChild(buildRow(pack, dir));
    });
  }

  function buildRow(pack, dir) {
    var item = el('li', 'pack-item' + (pack.enabled ? '' : ' is-disabled'));
    item.setAttribute('data-pack-name', pack.filename);
    item.setAttribute('data-pack-kind', pack.kind);

    var main = el('div', 'pack-main');
    main.appendChild(el('div', 'pack-name', pack.filename));

    var meta = el('div', 'pack-meta');
    meta.appendChild(el('span', 'tag tag-pack-format', formatOf(pack)));
    meta.appendChild(el('span', 'muted', formatBytes(pack.size)));
    if (pack.description) {
      meta.appendChild(el('span', 'pack-desc', pack.description));
    }
    main.appendChild(meta);

    // 元数据读不出来时如实说明（例如 mcmeta 坏了 / zip 损坏），但不阻止用户继续用
    if (pack.mcmetaError) {
      main.appendChild(el('p', 'hint field-note-warn', '⚠ ' + pack.mcmetaError));
    }
    item.appendChild(main);

    var actions = el('div', 'pack-actions');

    // 启用开关
    var toggle = el('button', 'btn btn-sm ' + (pack.enabled ? 'btn-on' : 'btn-ghost'), pack.enabled ? '已启用' : '已禁用');
    toggle.type = 'button';
    toggle.setAttribute('data-pack-toggle', pack.filename);
    toggle.title = pack.enabled ? '点击禁用（改名为 .disabled）' : '点击启用（恢复 .zip）';
    toggle.addEventListener('click', function () {
      var next = !pack.enabled;
      toggle.disabled = true;
      setEnabled(pack, next).finally(function () {
        toggle.disabled = false;
      });
    });
    actions.appendChild(toggle);

    var del = el('button', 'btn btn-ghost btn-sm btn-danger-ghost', '删除');
    del.type = 'button';
    del.setAttribute('data-pack-delete', pack.filename);
    del.addEventListener('click', function () {
      remove(pack, del);
    });
    actions.appendChild(del);

    item.appendChild(actions);
    return item;
  }

  // ───────────────────────────── 启停 / 删除 ─────────────────────────────

  function setEnabled(pack, enabled) {
    if (state.busy) return Promise.resolve();
    state.busy = true;

    var body = { kind: state.kind, enabled: enabled };
    if (state.kind === 'datapack' && state.saveName) body.saveName = state.saveName;

    var url =
      '/api/instances/' +
      encodeURIComponent(state.instanceId) +
      '/packs/' +
      encodeURIComponent(pack.filename) +
      '/toggle';

    return api(url, { method: 'POST', body: body, timeoutMs: 15000 })
      .then(function () {
        toast((enabled ? '已启用：' : '已禁用：') + pack.filename, true);
        return loadPacks();
      })
      .catch(function (error) {
        errorNode('切换状态失败：' + messageOf(error));
      })
      .finally(function () {
        state.busy = false;
      });
  }

  function remove(pack, button) {
    if (state.busy) return;
    var sure = window.confirm('确定删除「' + pack.filename + '」？这会从磁盘上删掉文件，无法撤销。');
    if (!sure) return;

    state.busy = true;
    if (button) button.disabled = true;

    var url =
      '/api/instances/' +
      encodeURIComponent(state.instanceId) +
      '/packs/' +
      encodeURIComponent(pack.filename) +
      '?kind=' +
      encodeURIComponent(state.kind) +
      (state.kind === 'datapack' && state.saveName ? '&saveName=' + encodeURIComponent(state.saveName) : '');

    api(url, { method: 'DELETE', timeoutMs: 15000 })
      .then(function (data) {
        toast(data && data.removed === false ? '文件本来就不在了：' + pack.filename : '已删除：' + pack.filename, true);
        return loadPacks();
      })
      .catch(function (error) {
        errorNode('删除失败：' + messageOf(error));
      })
      .finally(function () {
        state.busy = false;
        if (button) button.disabled = false;
      });
  }

  // ───────────────────────────── 导入本地文件（上传） ─────────────────────────────

  function ensureFileInput() {
    var input = $('packs-file');
    if (input) return input;
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'packs-file';
    input.accept = '.zip,application/zip,application/x-zip-compressed';
    input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var files = input.files;
      var file = files && files.length ? files[0] : null;
      if (file) upload(file);
      input.value = '';
    });
    return input;
  }

  function upload(file) {
    if (!state.instanceId) {
      errorNode('请先选择一个版本，再导入文件。');
      return;
    }
    if (!/\.zip$/i.test(String(file.name))) {
      errorNode('只接受 .zip 文件。' + KIND_LABEL[state.kind] + '是打包好的 zip，不能是文件夹。');
      return;
    }

    errorNode('');
    var importBtn = $('btn-packs-import');
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.textContent = '上传中…';
    }

    var form = new FormData();
    form.append('kind', state.kind);
    if (state.kind === 'datapack' && state.saveName) form.append('saveName', state.saveName);
    form.append('file', file, file.name);

    var url = '/api/instances/' + encodeURIComponent(state.instanceId) + '/packs/upload';

    // 上传不能设 Content-Type：浏览器要自己带 boundary
    fetch(url, { method: 'POST', body: form, headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (e) {
            data = null;
          }
          if (!res.ok) {
            var detail = data && data.error ? data.error : text || '（无响应内容）';
            throw new Error(detail);
          }
          return data || {};
        });
      })
      .then(function (data) {
        toast('已导入：' + (data.filename || file.name), true);
        if (data.warning) errorNode(data.warning);
        return loadPacks();
      })
      .catch(function (error) {
        errorNode('导入失败：' + messageOf(error));
      })
      .finally(function () {
        if (importBtn) {
          importBtn.disabled = false;
          importBtn.textContent = '导入本地文件';
        }
      });
  }

  // ───────────────────────────── 初始标签（URL hash） ─────────────────────────────

  var KIND_FROM_HASH = { resourcepack: 'resourcepack', datapack: 'datapack', shader: 'shader' };

  /**
   * 从 URL hash 里读初始标签与存档：`#packs-kind=datapack&packs-save=新的世界`。
   *
   * 存在的理由有两个，都很实际：
   *   1. 刷新页面后还停在刚才那一页（有人习惯按 F5 看文件到底落盘没有）；
   *   2. 端到端验收（headless 截图）需要一个「打开就是数据包标签」的入口，
   *      否则只能靠模拟点击，反而更难保证测的是真实交互。
   * 交互切换标签时也会把 hash 写回去，保持两者一致。
   */
  function readHashState() {
    var hash = String(window.location.hash || '').replace(/^#/, '');
    if (hash.length === 0) return null;

    var out = { kind: '', saveName: '' };
    hash.split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq < 0) return;
      var key = pair.slice(0, eq);
      var value = '';
      try {
        value = decodeURIComponent(pair.slice(eq + 1));
      } catch (e) {
        value = pair.slice(eq + 1);
      }
      if (key === 'packs-kind' && KIND_FROM_HASH[value]) out.kind = value;
      if (key === 'packs-save') out.saveName = value;
    });

    return out.kind || out.saveName ? out : null;
  }

  /** 把当前标签写回 hash（不改滚动位置，不新增历史记录） */
  function writeHashState() {
    // replaceState 在某些环境（file:// / 沙箱 iframe）会抛 SecurityError。
    // 它只是个「刷新后还记得住」的便利功能，绝不能因为它把后面的初始化打断。
    try {
      if (!window.history || typeof window.history.replaceState !== 'function') return;
      var hash = '#packs-kind=' + encodeURIComponent(state.kind);
      if (state.kind === 'datapack' && state.saveName) {
        hash += '&packs-save=' + encodeURIComponent(state.saveName);
      }
      if (window.location.hash !== hash) {
        window.history.replaceState(null, '', hash);
      }
    } catch (e) {
      /* 记不住就算了，不影响界面 */
    }
  }

  // ───────────────────────────── 事件绑定 ─────────────────────────────

  function setKind(kind, fromHash) {
    if (kind !== 'resourcepack' && kind !== 'datapack' && kind !== 'shader') return;
    state.kind = kind;

    var host = $('packs-tabs');
    if (host) {
      var buttons = host.querySelectorAll('.seg-btn');
      for (var i = 0; i < buttons.length; i += 1) {
        var btn = buttons[i];
        if (btn.getAttribute('data-pack-kind') === kind) btn.classList.add('is-active');
        else btn.classList.remove('is-active');
      }
    }
    errorNode('');
    if (fromHash !== true) writeHashState();
    loadPacks();
  }

  function bind() {
    var panel = $('packs-panel');
    if (!panel) return; // 没有这套 DOM（例如别的页面）就不启动，保持零副作用

    var tabs = $('packs-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.getAttribute) return;
        var kind = target.getAttribute('data-pack-kind');
        if (kind) setKind(kind);
      });
    }

    var instanceSelect = $('packs-instance');
    if (instanceSelect) {
      instanceSelect.addEventListener('change', function () {
        state.instanceId = instanceSelect.value;
        state.saveName = '';
        localStorage.setItem(STORAGE_INSTANCE, state.instanceId);
        loadPacks();
      });
    }

    var saveSelect = $('packs-save');
    if (saveSelect) {
      saveSelect.addEventListener('change', function () {
        state.saveName = saveSelect.value;
        writeHashState();
        loadPacks();
      });
    }

    var importBtn = $('btn-packs-import');
    if (importBtn) {
      importBtn.addEventListener('click', function () {
        var input = ensureFileInput();
        input.click();
      });
    }

    var refreshBtn = $('btn-packs-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        refreshBtn.disabled = true;
        loadInstances().then(function () {
          return loadPacks();
        }).finally(function () {
          refreshBtn.disabled = false;
        });
      });
    }

    var saveReload = $('btn-packs-save-reload');
    if (saveReload) {
      saveReload.addEventListener('click', function () {
        loadPacks();
      });
    }

    // 其它面板（版本列表 / 整合包）装完东西后，这里也应该跟着刷新
    document.addEventListener('pcl3:installed-changed', function () {
      loadInstances().then(function () {
        return loadPacks();
      });
    });

    // 初始标签 / 存档：URL hash 优先（刷新与截图验收都靠它）
    var fromHash = readHashState();
    if (fromHash !== null) {
      state.saveName = fromHash.saveName;
      setKind(fromHash.kind || state.kind, true);
    }

    return loadInstances().then(function () {
      if (state.instanceId) return loadPacks();
      return undefined;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  // 供 app.js / 测试使用（只读，不改变别人的行为）
  window.pcl3Packs = {
    state: state,
    setKind: setKind,
    loadPacks: loadPacks,
    formatBytes: formatBytes
  };
})();
