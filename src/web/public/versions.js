/**
 * 版本选择器（主页当前版本 + 切换 / 重命名）+ 已安装版本列表 + 内容页目标版本标牌。
 *
 * 用户原话（这四条是整份文件的由来）：
 *   1. 「mod 下载列表这边我不知道下载给哪个版本了，选择太不明显了」
 *      → 内容页顶部一条 target-banner：「正在给 26.3 (Fabric 0.19.5) 添加内容」
 *   2. 「实例选项应该改个名字比如版本选择什么的」
 *      → 全局不再出现「实例」；这里是「当前版本」+「切换版本」
 *   3. 「主页所有版本都在这里不太好选，应该也改成一个版本选择按钮，选择的时候再列出所有下载的版本」
 *      → 主页只显示当前版本，切换时弹出已安装版本列表（可搜索）
 *   4. 「版本旁边应该也可以加一个小按钮能重命名版本名字之类的小功能」
 *      → 重命名弹窗，只改显示名（settings.json 的 displayName），目录名一个字不动
 *
 * 与 app.js / mods.js / packs.js 的分工（一条都不能破）：
 *   app.js   版本下载清单（#version-list）、任务面板、日志、toast、启动
 *   本文件    当前版本状态、主页卡片、版本页列表、重命名、内容页标牌
 *   mods.js   内容面板自己的下拉（#content-instance）与已装模组列表
 *   packs.js  本地文件面板自己的下拉（#packs-instance）
 *
 * 同步策略（关键）：
 *   「当前版本」只存一处 —— localStorage 的 `pcl3.version`（键名沿用，语义已明确）。
 *   本文件是**唯一**的读写者，然后用两种方式把它同步出去：
 *     · 直接设置 #content-instance / #packs-instance 的 value 并派发 change，
 *       让 mods.js / packs.js 走它们自己原本的流程（不改它们一行代码）；
 *     · 广播 `pcl3:current-version-changed` 事件，给将来的脚本一个入口。
 *   反过来，用户在 mods.js / packs.js 自己的下拉里改选，也会通过 change 监听
 *   回写到本文件的当前版本，两边永远一致（用户在哪改都算数）。
 *
 * 启动一律走 app.js 的 `window.pcl3StartLaunch(versionId)`：体检闸门、任务面板、
 * 日志、token 打码、崩溃分析全在那边，这里绝不自己拼 POST /api/launch。
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
    return error.message ? String(error.message) : String(error);
  }

  /** 统一的取数：带超时、优先展示服务端的人话错误 */
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
            var err = new Error(detail);
            err.status = res.status;
            err.body = data;
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

  // ───────────────────────────── 常量 ─────────────────────────────

  /** 当前版本只存这一处（键名沿用旧代码，语义现在是「当前选中的版本 id」） */
  var STORAGE_VERSION = 'pcl3.version';
  var LOADER_LABEL = { fabric: 'Fabric', quilt: 'Quilt' };
  var TYPE_LABEL = {
    release: '正式版',
    snapshot: '快照',
    old_beta: '旧 Beta',
    old_alpha: '旧 Alpha'
  };

  // ───────────────────────────── 状态 ─────────────────────────────

  var state = {
    /** 所有已安装版本（来自 /api/versions 的 installedDetails） */
    installed: [],
    /** 当前选中版本 id；空串 = 还没选 */
    current: '',
    /** 版本 id → settings 里的 displayName（懒加载，按需补） */
    names: {},
    /** 版本 id → 官方清单里的类型（release / snapshot …），只用于展示标签 */
    types: {},
    /** 正在读清单 */
    loading: false,
    /** 重命名弹窗正在提交 */
    renaming: false,
    /** 切换面板的搜索词 */
    pickerQuery: '',
    /** 每次切换版本自增：迟到的响应不能覆盖新选择 */
    seq: 0
  };

  // ───────────────────────────── 小工具 ─────────────────────────────

  /** 显示名：有就用，没有就退回版本 id（全站同一条规则） */
  function displayNameOf(versionId) {
    var name = state.names[versionId];
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : versionId;
  }

  function byId(versionId) {
    for (var i = 0; i < state.installed.length; i += 1) {
      if (state.installed[i].versionId === versionId) return state.installed[i];
    }
    return null;
  }

  /** 「26.3 (Fabric 0.19.5)」—— 用户第一条反馈要的就是这句能一眼看懂 */
  function labelWithLoader(versionId) {
    var info = byId(versionId);
    var name = displayNameOf(versionId);
    if (!info) return name;
    var loader = info.loader ? LOADER_LABEL[info.loader] || String(info.loader) : '';
    var parts = [];
    if (loader) {
      parts.push(loader + (info.loaderVersion ? ' ' + info.loaderVersion : ''));
    }
    if (info.gameVersion && info.gameVersion !== versionId && name !== info.gameVersion) {
      parts.push('基于 ' + info.gameVersion);
    }
    return parts.length === 0 ? name : name + '（' + parts.join(' · ') + '）';
  }

  /** ISO → 「2026-10-21 07:50」；没有就「从未启动」 */
  function formatPlayedAt(iso) {
    if (!iso) return '从未启动';
    var date = new Date(String(iso));
    if (isNaN(date.getTime())) return String(iso);
    var pad = function (n) {
      return ('0' + n).slice(-2);
    };
    return (
      date.getFullYear() +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      ' ' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes())
    );
  }

  function showError(text) {
    if (typeof window.pcl3ShowError === 'function') window.pcl3ShowError(text);
  }

  function toast(text, ok) {
    if (typeof window.pcl3Toast === 'function') window.pcl3Toast(text, ok === true);
  }

  function appendLog(text) {
    if (typeof window.pcl3AppendLog === 'function') window.pcl3AppendLog(text);
  }

  function homeError(text) {
    var node = $('home-error');
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.hidden = true;
      node.textContent = '';
    }
  }

  // ───────────────────────────── 读清单 ─────────────────────────────

  /**
   * 读已安装版本清单。
   *
   * `installedDetails` 是 /api/versions 本轮新增的字段（后端一次算好，
   * 含 gameVersion / loader / loaderVersion / lastPlayedAt / dir）。
   * 老后端没有这个字段时退化成用 installed + loaderProfiles 自己拼，
   * 前端不会因为版本不匹配而白屏。
   */
  function loadInstalled(opts) {
    var options = opts || {};
    if (state.loading && options.force !== true) return Promise.resolve(state.installed);
    state.loading = true;

    if (options.quiet !== true) {
      setHomeMessage('正在读取已安装版本…', false);
      setInstalledMessage('正在读取已安装版本…', false);
    }

    return api('/api/versions?limit=200&type=all', { timeoutMs: 30000 })
      .then(function (data) {
        var list = normalizeInstalled(data || {});
        state.installed = list;
        state.types = {};
        (data && data.versions ? data.versions : []).forEach(function (v) {
          if (v && v.id) state.types[v.id] = v.type;
        });

        // 先把显示名缓存清空再补：重命名之后必须是最新的
        var known = {};
        list.forEach(function (item) {
          known[item.versionId] = true;
        });
        Object.keys(state.names).forEach(function (id) {
          if (!known[id]) delete state.names[id];
        });

        resolveCurrent();
        renderHome();
        renderInstalledList();
        return loadNames(list).then(function () {
          renderHome();
          renderInstalledList();
          renderTargets();
          return list;
        });
      })
      .catch(function (error) {
        state.installed = [];
        setHomeMessage('版本列表读取失败：' + messageOf(error), true);
        setInstalledMessage('版本列表读取失败：' + messageOf(error), true);
        showError('版本列表读取失败：' + messageOf(error));
        return [];
      })
      .finally(function () {
        state.loading = false;
      });
  }

  /** 后端字段 / 老后端兜底，统一成一种形状 */
  function normalizeInstalled(data) {
    var details = Array.isArray(data.installedDetails) ? data.installedDetails : null;
    if (details !== null) {
      return details
        .filter(function (d) {
          return d && typeof d.versionId === 'string' && d.versionId.length > 0;
        })
        .slice();
    }

    // 老后端：installed + loaderProfiles 自己拼
    var profiles = {};
    (Array.isArray(data.loaderProfiles) ? data.loaderProfiles : []).forEach(function (p) {
      if (p && p.versionId) profiles[p.versionId] = p;
    });
    var seen = {};
    var out = [];
    var push = function (versionId) {
      if (!versionId || seen[versionId]) return;
      seen[versionId] = true;
      var profile = profiles[versionId];
      out.push({
        versionId: versionId,
        gameVersion: profile && profile.gameVersion ? profile.gameVersion : versionId,
        loader: profile && profile.kind ? profile.kind : null,
        loaderVersion: profile && profile.loaderVersion ? profile.loaderVersion : null,
        official: !profile,
        lastPlayedAt: null,
        dir: ''
      });
    };
    (Array.isArray(data.installed) ? data.installed : []).forEach(push);
    Object.keys(profiles).forEach(push);
    return out;
  }

  /**
   * 当前版本从哪来（按优先级）：
   *   1. localStorage（用户上次选的）
   *   2. 唯一一个已安装版本（没什么可选，就用它）
   *   3. 第一个（后端已按版本号排序）
   *   4. 没有 → ''（主页显示「还没有装任何版本」）
   */
  function resolveCurrent() {
    var saved = readStoredVersion();
    var ids = state.installed.map(function (item) {
      return item.versionId;
    });

    if (saved && ids.indexOf(saved) !== -1) {
      state.current = saved;
      return;
    }
    if (ids.length === 0) {
      state.current = '';
      if (saved) clearStoredVersion();
      return;
    }
    state.current = ids[0];
    writeStoredVersion(state.current);
  }

  function readStoredVersion() {
    try {
      return String(localStorage.getItem(STORAGE_VERSION) || '');
    } catch (e) {
      return '';
    }
  }

  function writeStoredVersion(versionId) {
    try {
      localStorage.setItem(STORAGE_VERSION, String(versionId));
    } catch (e) {
      /* 隐私模式 / 沙箱 iframe 里写不了：本次会话内仍然生效 */
    }
  }

  function clearStoredVersion() {
    try {
      localStorage.removeItem(STORAGE_VERSION);
    } catch (e) {
      /* 同上 */
    }
  }

  /**
   * 补读每个版本的显示名。
   *
   * 为什么要单独一批请求：`installedDetails` 是磁盘扫描的结果，不含 settings.json
   * 里的 displayName（那是用户偏好，不是磁盘事实）。数量通常只有几个，
   * 并发读一遍就够了；失败不影响显示（回落到版本号）。
   */
  function loadNames(list) {
    var targets = list.filter(function (item) {
      return item && item.versionId && state.names[item.versionId] === undefined;
    });
    if (targets.length === 0) return Promise.resolve();

    return Promise.all(
      targets.map(function (item) {
        return api('/api/instances/' + encodeURIComponent(item.versionId) + '/settings', { timeoutMs: 12000 })
          .then(function (data) {
            var name = data && typeof data.displayName === 'string' ? data.displayName.trim() : '';
            state.names[item.versionId] = name;
          })
          .catch(function () {
            // 读不到就当成「没有显示名」，绝不让一个 404 把整个列表打空
            state.names[item.versionId] = '';
          });
      })
    );
  }

  // ───────────────────────────── 选版本 ─────────────────────────────

  /**
   * 切成某个版本，并把这件事同步给全站。
   *
   * 同步方式有三条，缺一不可：
   *   1. localStorage —— 刷新后还在
   *   2. 内容/本地文件两个下拉 —— mods.js / packs.js 靠自己的 change 逻辑重新拉数据
   *   3. 自定义事件 —— 给其它脚本（以及 versions.js 自己的三个渲染点）一个统一入口
   */
  function selectVersion(versionId, opts) {
    var options = opts || {};
    var next = String(versionId || '');
    if (next.length === 0) return;

    if (next !== state.current) {
      state.seq += 1;
      state.current = next;
      writeStoredVersion(next);
      appendLog('当前版本切换为：' + displayNameOf(next) + '（' + next + '）');
    } else if (!options.silent) {
      writeStoredVersion(next);
    }

    renderHome();
    renderInstalledList();
    renderTargets();
    syncLegacySelects();
    announce();

    if (options.closePicker !== false) hidePicker();
  }

  function syncLegacySelects() {
    // mods.js / packs.js 各有一个自己的版本下拉：直接改 value 再派发 change，
    // 它们就会走自己原本的「切了就重新拉数据」流程 —— 不改它们一行代码。
    setSelectValue($('content-instance'), state.current);
    setSelectValue($('packs-instance'), state.current);
  }

  /**
   * 首屏的「追上它们」。
   *
   * 为什么不能只同步一次：`mods.js` / `packs.js` 自己的版本下拉是**异步加载**的
   * （一个等 /api/versions + /api/instances，一个等 /api/versions），加载完会自己
   * 拍一个默认值（第一个条目）。我们同步得太早，选项还是空的，等它们加载完
   * 就会把我们选好的版本覆盖掉 —— 真实症状是「刷新后内容页装到 1.20.1 而不是当前版本」。
   *
   * 所以这里盯一小段时间（约 4 秒，20 次 × 200ms），只要发现下拉和当前版本不一致
   * 就再同步一次；一旦追平就停手，不在后台无限轮询。
   */
  function catchUpLegacySelects() {
    var attempts = 0;
    var tick = function () {
      attempts += 1;
      syncLegacySelects();
      var c = $('content-instance');
      var p = $('packs-instance');
      var ok = (!c || c.value === state.current) && (!p || p.value === state.current);
      if (ok) {
        renderTargets();
        return;
      }
      if (attempts >= 20) return; // 4 秒还没追平：不强求（用户手动换过版本之类）
      setTimeout(tick, 200);
    };
    setTimeout(tick, 0);
  }

  function setSelectValue(select, value) {
    if (!select || !value) return;
    var same = select.value === value;
    var has = false;
    for (var i = 0; i < select.options.length; i += 1) {
      if (select.options[i].value === value) {
        has = true;
        break;
      }
    }
    if (!has) return;
    if (same) return;
    select.value = value;
    try {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      /* 极老浏览器没有 Event 构造器：下拉已经设好值，界面照样对 */
    }
  }

  function announce() {
    try {
      document.dispatchEvent(
        new CustomEvent('pcl3:current-version-changed', {
          detail: { versionId: state.current, displayName: displayNameOf(state.current) }
        })
      );
    } catch (e) {
      /* 老浏览器没有 CustomEvent 构造器：跳过 */
    }
  }

  // ───────────────────────────── 渲染：主页 ─────────────────────────────

  function setHomeMessage(text, isError) {
    var host = $('home-current-card');
    if (!host) return;
    host.textContent = '';
    host.appendChild(el('p', isError ? 'empty error-text' : 'empty', text));
  }

  function setInstalledMessage(text, isError) {
    var list = $('installed-list');
    var empty = $('installed-empty');
    if (list) list.textContent = '';
    if (empty) {
      empty.hidden = false;
      empty.className = isError ? 'empty error-text' : 'empty';
      empty.textContent = text;
    }
  }

  function renderHome() {
    var host = $('home-current-card');
    var launchBtn = $('btn-home-launch');
    var switchBtn = $('btn-home-switch');
    var renameBtn = $('btn-home-rename');
    var settingsBtn = $('btn-home-settings');
    var contentBtn = $('btn-home-content');
    var hint = $('home-launch-hint');

    if (state.installed.length === 0) {
      setHomeMessage('还没有装任何版本。先去「下载」页装一个。', false);
      [launchBtn, switchBtn, renameBtn, settingsBtn, contentBtn].forEach(function (btn) {
        if (btn) btn.disabled = true;
      });
      if (hint) hint.textContent = '装好第一个版本之后，这里就会显示它。';
      homeError('');
      return;
    }

    var info = byId(state.current);
    if (!info) {
      setHomeMessage('当前版本「' + state.current + '」已经不在已安装列表里了，点「切换版本」重选一个。', true);
      if (launchBtn) launchBtn.disabled = true;
      if (switchBtn) switchBtn.disabled = false;
      return;
    }

    [launchBtn, switchBtn, renameBtn, settingsBtn, contentBtn].forEach(function (btn) {
      if (btn) btn.disabled = false;
    });

    host.textContent = '';

    // 名字 + 标签
    var nameRow = el('div', 'home-current-name');
    nameRow.appendChild(el('strong', 'home-current-id', displayNameOf(info.versionId)));

    var type = state.types[info.versionId] || (info.official ? 'release' : '');
    if (info.official && TYPE_LABEL[type]) {
      nameRow.appendChild(el('span', 'tag tag-' + type, TYPE_LABEL[type]));
    }
    if (info.loader) {
      nameRow.appendChild(el('span', 'tag tag-loader tag-' + info.loader, LOADER_LABEL[info.loader] || info.loader));
    }
    if (displayNameOf(info.versionId) !== info.versionId) {
      // 重命名过：把真实目录名也写出来，免得用户忘了它是哪个版本
      nameRow.appendChild(el('span', 'tag', info.versionId));
    }
    host.appendChild(nameRow);

    // 第二行：加载器版本 / 基于哪个原版
    var meta = el('div', 'home-current-meta');
    if (info.loader) {
      meta.appendChild(el('span', null, (LOADER_LABEL[info.loader] || info.loader) + ' ' + (info.loaderVersion || '')));
    }
    if (info.gameVersion && info.gameVersion !== info.versionId) {
      meta.appendChild(el('span', null, '基于 ' + info.gameVersion));
    }
    meta.appendChild(el('span', null, '上次启动：' + formatPlayedAt(info.lastPlayedAt)));
    host.appendChild(meta);

    // 目录：长路径截断，全文挂 title
    if (info.dir) {
      var dirRow = el('div', 'home-current-dir', info.dir);
      dirRow.title = info.dir;
      host.appendChild(dirRow);
    }

    if (launchBtn) {
      launchBtn.textContent = '启 动';
    }
    if (hint) {
      hint.textContent = info.loader
        ? '内容页会带着这个版本走，不会装错地方。'
        : '这个版本是原版（没装加载器）。点「添加额外内容」可以装资源包 / 光影 / 数据包。';
    }
    homeError('');
  }

  // ───────────────────────────── 渲染：版本页 ─────────────────────────────

  function renderInstalledList() {
    var list = $('installed-list');
    var empty = $('installed-empty');
    if (!list) return;

    if (state.installed.length === 0) {
      setInstalledMessage('还没有装任何版本。去「下载」页装一个。', false);
      return;
    }

    var keyword = $('version-manage-search') ? $('version-manage-search').value.trim().toLowerCase() : '';
    var items = state.installed.filter(function (item) {
      if (!keyword) return true;
      var hay = (
        displayNameOf(item.versionId) +
        ' ' +
        item.versionId +
        ' ' +
        String(item.gameVersion || '') +
        ' ' +
        String(item.loader || '')
      ).toLowerCase();
      return hay.indexOf(keyword) !== -1;
    });

    if (items.length === 0) {
      setInstalledMessage('没有匹配的版本。清空搜索框看看。', false);
      return;
    }

    if (empty) empty.hidden = true;
    list.textContent = '';

    var frag = document.createDocumentFragment();
    items.forEach(function (item) {
      frag.appendChild(buildInstalledRow(item));
    });
    list.appendChild(frag);

    var note = el(
      'p',
      'empty',
      '共 ' + state.installed.length + ' 个已安装版本。点「切换」把它设成主页的当前版本；' +
        '「⚙」只改显示名，目录名不会变。'
    );
    note.style.marginTop = '12px';
    list.appendChild(note);
  }

  /** 一行已安装版本：名字 + 标签 + 上次启动 + 切换 / 重命名 / 设置 / 删除 */
  function buildInstalledRow(item) {
    var li = el('li', 'installed-item' + (item.versionId === state.current ? ' is-current' : ''));
    li.setAttribute('data-version-id', item.versionId);

    var main = el('div', 'installed-main');
    var nameRow = el('div', 'installed-name');
    nameRow.appendChild(el('strong', null, displayNameOf(item.versionId)));

    var type = state.types[item.versionId] || (item.official ? 'release' : '');
    if (item.official && TYPE_LABEL[type]) {
      nameRow.appendChild(el('span', 'tag tag-' + type, TYPE_LABEL[type]));
    }
    if (item.loader) {
      nameRow.appendChild(el('span', 'tag tag-loader tag-' + item.loader, LOADER_LABEL[item.loader] || item.loader));
    }
    if (item.versionId === state.current) {
      nameRow.appendChild(el('span', 'tag tag-current', '当前'));
    }
    main.appendChild(nameRow);

    var meta = el('div', 'installed-meta');
    if (displayNameOf(item.versionId) !== item.versionId) meta.appendChild(el('span', null, item.versionId));
    if (item.loader && item.loaderVersion) {
      meta.appendChild(el('span', null, (LOADER_LABEL[item.loader] || item.loader) + ' ' + item.loaderVersion));
    }
    if (item.gameVersion && item.gameVersion !== item.versionId) {
      meta.appendChild(el('span', null, '基于 ' + item.gameVersion));
    }
    meta.appendChild(el('span', null, '上次启动：' + formatPlayedAt(item.lastPlayedAt)));
    main.appendChild(meta);

    if (item.dir) {
      var dirRow = el('div', 'installed-dir', item.dir);
      dirRow.title = item.dir;
      main.appendChild(dirRow);
    }
    li.appendChild(main);

    var actions = el('div', 'installed-actions');

    var switchBtn = el('button', 'btn btn-ghost btn-sm', item.versionId === state.current ? '已选中' : '切换');
    switchBtn.type = 'button';
    switchBtn.disabled = item.versionId === state.current;
    switchBtn.addEventListener('click', function () {
      selectVersion(item.versionId);
      toast('当前版本已切换到 ' + displayNameOf(item.versionId), true);
    });
    actions.appendChild(switchBtn);

    var renameBtn = el('button', 'btn btn-ghost btn-sm btn-rename', '✎');
    renameBtn.type = 'button';
    renameBtn.title = '重命名（只改显示名）';
    renameBtn.setAttribute('aria-label', '重命名 ' + item.versionId);
    renameBtn.addEventListener('click', function () {
      openRenameModal(item.versionId);
    });
    actions.appendChild(renameBtn);

    var settingsBtn = el('button', 'btn btn-ghost btn-sm btn-gear', '⚙');
    settingsBtn.type = 'button';
    settingsBtn.title = '版本设置（内存 / JVM 参数）';
    settingsBtn.setAttribute('data-settings-entry', item.versionId);
    settingsBtn.addEventListener('click', function () {
      // `pcl3OpenSettings` 一直存在（app.js 导出）。曾经这里还挂了一条
      // `window.pcl3App.openSettings` 的回退分支，但 pcl3App 从未在任何脚本里定义，
      // 是死代码 —— 已删除，避免以后有人以为它可用。
      if (typeof window.pcl3OpenSettings === 'function') window.pcl3OpenSettings(item.versionId);
    });
    actions.appendChild(settingsBtn);

    var folderBtn = el('button', 'btn btn-ghost btn-sm', '📁');
    folderBtn.type = 'button';
    folderBtn.title = '打开版本目录';
    folderBtn.addEventListener('click', function () {
      openFolder(item, folderBtn);
    });
    actions.appendChild(folderBtn);

    li.appendChild(actions);
    return li;
  }

  function openFolder(item, button) {
    if (button) button.disabled = true;
    api('/api/instances/' + encodeURIComponent(item.versionId) + '/folders/game/open', {
      method: 'POST',
      body: {},
      timeoutMs: 15000
    })
      .then(function (data) {
        toast('已打开：' + ((data && data.path) || item.dir || item.versionId), true);
      })
      .catch(function (error) {
        if (error && error.status === 404) {
          appendLog('版本目录：' + (item.dir || item.versionId) + '（「打开文件夹」接口暂不可用，可手动复制路径）');
          toast('版本目录已记录到日志，可手动复制');
          return;
        }
        showError('打开文件夹失败：' + messageOf(error));
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  }

  // ───────────────────────────── 渲染：内容页 / 本地文件的目标版本 ─────────────────────────────

  /**
   * 内容页的「正在给谁装」标牌。三处一起写：
   *   1. 顶部大横幅（#content-target-name / #content-target-sub）
   *   2. Mod 面板搜索框上方的 #content-target-vid
   *   3. 本地文件面板的两个下拉（由 syncLegacySelects 负责）
   */
  function renderTargets() {
    var banner = $('content-target');
    var name = $('content-target-name');
    var sub = $('content-target-sub');
    var inline = $('content-target-vid');
    var inlineExtra = $('content-target-inline-extra');

    var has = state.current.length > 0 && byId(state.current) !== null;
    var text = has ? labelWithLoader(state.current) : '— 还没选版本 —';

    if (name) name.textContent = text;
    if (inline) inline.textContent = text;

    var info = has ? byId(state.current) : null;
    if (sub) {
      sub.textContent = info
        ? '文件会落进 ' + (info.dir || state.current) + '，不会影响其它版本。'
        : '先在「版本」页或下面的下拉里选一个版本。';
    }
    if (inlineExtra) inlineExtra.textContent = info && info.dir ? info.dir : '';

    if (banner) {
      if (has) banner.classList.add('is-ready');
      else banner.classList.remove('is-ready');
    }
  }

  // ───────────────────────────── 版本选择面板 ─────────────────────────────

  var pickerOpen = false;
  /** 打开面板的那个按钮：全局「点别处关掉」要能认出它，否则一打开就被自己关掉 */
  var pickerAnchor = null;
  /** 打开时刻：同一次点击冒泡到 document 时不该立刻关闭 */
  var pickerOpenedAt = 0;

  function showPicker(anchor) {
    var picker = $('version-picker');
    if (!picker) return;
    renderPicker();
    picker.hidden = false;
    pickerOpen = true;
    // 记下「谁打开的我」：window 上的「点别处就关」要能认出这两个按钮自己
    pickerAnchor = anchor || null;
    pickerOpenedAt = Date.now();

    // 贴在按钮下方（粗定位即可：面板是 fixed，靠按钮矩形算位置）
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      var rect = anchor.getBoundingClientRect();
      var width = picker.offsetWidth || 320;
      var left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      var top = rect.bottom + 6;
      var maxTop = window.innerHeight - (picker.offsetHeight || 320) - 12;
      picker.style.left = left + 'px';
      picker.style.top = Math.max(12, Math.min(top, maxTop)) + 'px';
    }

    var search = $('version-picker-search');
    if (search) {
      search.value = state.pickerQuery;
      search.focus();
    }
  }

  function hidePicker() {
    var picker = $('version-picker');
    if (picker) picker.hidden = true;
    pickerOpen = false;
  }

  function togglePicker(anchor) {
    if (pickerOpen) hidePicker();
    else showPicker(anchor);
  }

  function renderPicker() {
    var list = $('version-picker-list');
    var empty = $('version-picker-empty');
    if (!list) return;

    var keyword = String(state.pickerQuery || '').trim().toLowerCase();
    var items = state.installed.filter(function (item) {
      if (!keyword) return true;
      var hay = (displayNameOf(item.versionId) + ' ' + item.versionId + ' ' + String(item.gameVersion || '')).toLowerCase();
      return hay.indexOf(keyword) !== -1;
    });

    list.textContent = '';

    if (state.installed.length === 0) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = '还没有已安装的版本。先去「下载」页装一个。';
      }
      return;
    }
    if (items.length === 0) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = '没有匹配「' + state.pickerQuery + '」的版本。';
      }
      return;
    }
    if (empty) empty.hidden = true;

    var frag = document.createDocumentFragment();
    items.forEach(function (item) {
      var li = el('li', 'version-picker-item' + (item.versionId === state.current ? ' is-current' : ''));
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', item.versionId === state.current ? 'true' : 'false');
      li.tabIndex = 0;

      var main = el('div', 'version-picker-main');
      var top = el('div', 'version-picker-name');
      top.appendChild(el('strong', null, displayNameOf(item.versionId)));

      var type = state.types[item.versionId] || (item.official ? 'release' : '');
      if (item.official && TYPE_LABEL[type]) top.appendChild(el('span', 'tag tag-' + type, TYPE_LABEL[type]));
      if (item.loader) {
        top.appendChild(el('span', 'tag tag-loader tag-' + item.loader, LOADER_LABEL[item.loader] || item.loader));
      }
      if (item.versionId === state.current) top.appendChild(el('span', 'tag tag-current', '当前'));
      main.appendChild(top);

      var meta = el('div', 'version-picker-meta');
      if (displayNameOf(item.versionId) !== item.versionId) meta.appendChild(el('span', null, item.versionId));
      if (item.loader && item.loaderVersion) meta.appendChild(el('span', null, item.loaderVersion));
      meta.appendChild(el('span', null, '上次启动：' + formatPlayedAt(item.lastPlayedAt)));
      main.appendChild(meta);

      li.appendChild(main);

      var pick = function () {
        selectVersion(item.versionId);
        toast('当前版本：' + displayNameOf(item.versionId), true);
      };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          pick();
        }
      });

      frag.appendChild(li);
    });
    list.appendChild(frag);
  }

  // ───────────────────────────── 重命名弹窗 ─────────────────────────────

  var renameTarget = '';
  var renameKeyHandler = null;

  function renameError(text) {
    var node = $('rename-error');
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.hidden = true;
      node.textContent = '';
    }
  }

  function openRenameModal(versionId) {
    var backdrop = $('rename-modal');
    if (!backdrop) return;

    renameTarget = String(versionId || '');
    if (!renameTarget) return;
    state.renaming = false;

    var input = $('rename-input');
    if (input) {
      input.value = displayNameOf(renameTarget) === renameTarget ? '' : displayNameOf(renameTarget);
      input.placeholder = renameTarget;
    }
    var dirNode = $('rename-dir');
    if (dirNode) dirNode.textContent = renameTarget;
    var hint = $('rename-hint');
    if (hint) {
      hint.textContent = '留空 = 恢复用版本号显示。最长 48 个字。目录名 ' + renameTarget + ' 不会变。';
    }
    renameError('');
    backdrop.hidden = false;

    renameKeyHandler = function (event) {
      if (event.key === 'Escape') closeRenameModal();
    };
    document.addEventListener('keydown', renameKeyHandler);
    if (input) {
      input.focus();
      if (typeof input.select === 'function') input.select();
    }
  }

  function closeRenameModal() {
    var backdrop = $('rename-modal');
    if (backdrop) backdrop.hidden = true;
    if (renameKeyHandler) {
      document.removeEventListener('keydown', renameKeyHandler);
      renameKeyHandler = null;
    }
  }

  function submitRename() {
    if (state.renaming) return;
    var versionId = renameTarget;
    if (!versionId) return;

    var input = $('rename-input');
    var value = input ? String(input.value || '').trim() : '';
    if (value.length > 48) {
      renameError('显示名最长 48 个字符。');
      return;
    }
    // 换行 / 控制字符：后端也会拒，这里先挡一道，用户少等一次往返
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      renameError('显示名里不能有换行或控制字符。');
      return;
    }

    var save = $('rename-save');
    state.renaming = true;
    if (save) {
      save.disabled = true;
      save.textContent = '保存中…';
    }
    renameError('');

    api('/api/instances/' + encodeURIComponent(versionId) + '/settings', {
      method: 'PUT',
      body: { displayName: value },
      timeoutMs: 15000
    })
      .then(function (data) {
        state.names[versionId] = data && typeof data.displayName === 'string' ? data.displayName : '';
        closeRenameModal();
        renderHome();
        renderInstalledList();
        renderTargets();
        renderPicker();
        announce();
        toast('已重命名：' + displayNameOf(versionId), true);
        appendLog('版本 ' + versionId + ' 的显示名改为「' + displayNameOf(versionId) + '」');
      })
      .catch(function (error) {
        var body = error && error.body;
        var text = messageOf(error);
        if (body && body.problems && body.problems.length) text = body.problems.join('\n');
        renameError(text);
      })
      .finally(function () {
        state.renaming = false;
        if (save) {
          save.disabled = false;
          save.textContent = '保存';
        }
      });
  }

  // ───────────────────────────── 事件绑定 ─────────────────────────────

  function bind() {
    var homePanel = $('home-current-panel');
    if (!homePanel && !$('version-manage-panel') && !$('content-target')) {
      return; // 没有这套 DOM（别的页面 / 测试夹具）就不启动，保持零副作用
    }

    // 主页：启动
    var launch = $('btn-home-launch');
    if (launch) {
      launch.addEventListener('click', function () {
        if (!state.current) return;
        if (typeof window.pcl3StartLaunch === 'function') {
          window.pcl3StartLaunch(state.current);
        } else {
          showError('启动模块还没加载完，稍等一下再点。');
        }
      });
    }

    // 主页：切换版本
    var switchBtn = $('btn-home-switch');
    if (switchBtn) {
      switchBtn.addEventListener('click', function (event) {
        event.preventDefault();
        togglePicker(switchBtn);
      });
    }

    // 主页：重命名
    var renameBtn = $('btn-home-rename');
    if (renameBtn) {
      renameBtn.addEventListener('click', function () {
        if (state.current) openRenameModal(state.current);
      });
    }

    // 主页：设置（复用 app.js 那个内存 / JVM 参数弹窗）
    var settingsBtn = $('btn-home-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', function () {
        if (!state.current) return;
        if (typeof window.pcl3OpenSettings === 'function') window.pcl3OpenSettings(state.current);
        else showError('设置弹窗还没加载完，稍等一下再点。');
      });
    }

    // 主页：打开文件夹
    var foldersBtn = $('btn-home-folders');
    if (foldersBtn) {
      foldersBtn.addEventListener('click', function () {
        var info = byId(state.current);
        if (info) openFolder(info, foldersBtn);
      });
    }

    // 主页：添加额外内容 → 内容页，并带上当前版本
    var contentBtn = $('btn-home-content');
    if (contentBtn) {
      contentBtn.addEventListener('click', function () {
        goContent();
      });
    }

    // 内容页横幅上的「切换版本」
    var targetSwitch = $('btn-content-target-switch');
    if (targetSwitch) {
      targetSwitch.addEventListener('click', function (event) {
        event.preventDefault();
        togglePicker(targetSwitch);
      });
    }

    // 版本页
    var manageRefresh = $('btn-version-manage-refresh');
    if (manageRefresh) {
      manageRefresh.addEventListener('click', function () {
        manageRefresh.disabled = true;
        loadInstalled({ force: true }).finally(function () {
          manageRefresh.disabled = false;
        });
      });
    }

    var manageSearch = $('version-manage-search');
    if (manageSearch) {
      var timer = null;
      manageSearch.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(renderInstalledList, 120);
      });
    }

    // 下载页：刷新官方清单（app.js 负责渲染，这里只按一下它的刷新逻辑）
    var refreshList = $('btn-versions-refresh');
    if (refreshList) {
      refreshList.addEventListener('click', function () {
        refreshList.disabled = true;
        if (typeof window.pcl3LoadVersions === 'function') {
          Promise.resolve(window.pcl3LoadVersions()).finally(function () {
            refreshList.disabled = false;
          });
        } else {
          refreshList.disabled = false;
        }
      });
    }

    // 重命名弹窗
    var renameClose = $('rename-close');
    if (renameClose) renameClose.addEventListener('click', closeRenameModal);
    var renameCancel = $('rename-cancel');
    if (renameCancel) renameCancel.addEventListener('click', closeRenameModal);
    var renameSave = $('rename-save');
    if (renameSave) renameSave.addEventListener('click', submitRename);

    var renameInput = $('rename-input');
    if (renameInput) {
      renameInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitRename();
        }
      });
    }

    var renameBackdrop = $('rename-modal');
    if (renameBackdrop) {
      renameBackdrop.addEventListener('click', function (event) {
        if (event.target === renameBackdrop) closeRenameModal();
      });
    }

    // 版本选择面板：搜索 / 点外面关掉
    var pickerSearch = $('version-picker-search');
    if (pickerSearch) {
      pickerSearch.addEventListener('input', function () {
        state.pickerQuery = pickerSearch.value;
        renderPicker();
      });
      pickerSearch.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          hidePicker();
        }
      });
    }

    document.addEventListener('click', function (event) {
      if (!pickerOpen) return;
      // 同一次点击：按钮的 click 已经把面板打开，冒泡到这里不该立刻关掉
      if (Date.now() - pickerOpenedAt < 120) return;

      var picker = $('version-picker');
      if (!picker) return;
      var node = event.target;
      while (node && node.nodeType === 1) {
        if (node === picker) return;
        // 打开它的那个按钮：交回给按钮自己的 toggle 逻辑，避免「关一次又被打开」
        if (node === pickerAnchor) return;
        if (node.getAttribute && (node.getAttribute('data-nav') === 'versions' || node.getAttribute('data-goto'))) {
          hidePicker();
          return;
        }
        node = node.parentNode;
      }
      hidePicker();
    });

    // 用户可能在 mods.js / packs.js 自己的下拉里改选：回写到「当前版本」。
    //
    // 只认「人点的」：用 pointerdown / keydown 打开一个小窗口，窗口内的 change 才算用户操作。
    // 不加这道闸的话，这两个脚本**加载选项时**自己拍默认值（第一个条目）也会触发 change，
    // 一刷新就把当前版本改成列表第一个 —— 这正是「刷新后内容页装到 1.20.1」那类鬼故事的来源。
    var userPickUntil = 0;
    var armUserPick = function () {
      userPickUntil = Date.now() + 1500;
    };
    ['content-instance', 'packs-instance'].forEach(function (id) {
      var select = $(id);
      if (!select) return;
      select.addEventListener('pointerdown', armUserPick);
      select.addEventListener('keydown', armUserPick);
      select.addEventListener('change', function () {
        if (Date.now() > userPickUntil) return; // 不是人点的（脚本灌默认值）
        userPickUntil = 0;
        if (select.value && select.value !== state.current) {
          selectVersion(select.value, { closePicker: false });
          if (id === 'content-instance') flashTarget();
        }
      });
    });

    // 装完 / 装好加载器之后：版本清单变了，刷新
    document.addEventListener('pcl3:installed-changed', function () {
      loadInstalled({ force: true, quiet: true });
    });
    document.addEventListener('pcl3:page-shown', function (event) {
      var page = event && event.detail ? event.detail.page : '';
      if (page === 'content') {
        renderTargets();
        catchUpLegacySelects();
      } else if (page === 'home' || page === 'versions') {
        renderHome();
        renderInstalledList();
      }
    });

    // 首屏
    loadInstalled().then(function () {
      // 让 mods.js / packs.js 用自己的流程把数据拉起来（它们各自的初始化是异步的，
      // 这里等一拍再同步，避免和它们的初始加载抢同一个状态下标）
      catchUpLegacySelects();
    });
  }

  /**
   * 跳去内容页，并让「正在给 X 装」这件事在视觉上先闪一下。
   *
   * 为什么不一进来就切版本：切页由 nav.js 负责（它自己会记住 page=content），
   * 这里只负责把「目标版本」这件事说清楚；用户第一条反馈就是「看不出来在给谁装」。
   */
  function goContent() {
    if (!state.current) {
      showError('先选一个版本，再添加内容。');
      return;
    }
    renderTargets();
    syncLegacySelects();
    if (window.pcl3Nav && typeof window.pcl3Nav.showPage === 'function') {
      window.pcl3Nav.showPage('content');
    }
    flashTarget();
    catchUpLegacySelects();
  }

  function flashTarget() {
    var banner = $('content-target');
    if (!banner || typeof banner.classList === 'undefined') return;
    banner.classList.remove('is-flash');
    // 强制重排，保证连续两次切换都能看到动画
    void banner.offsetWidth;
    banner.classList.add('is-flash');
    setTimeout(function () {
      banner.classList.remove('is-flash');
    }, 1600);
  }

  // ───────────────────────────── 对外入口 ─────────────────────────────

  window.pcl3Versions = {
    state: state,
    /** 当前版本 id（空串 = 还没选） */
    current: function () {
      return state.current;
    },
    /** 当前版本给用户看的名字（displayName ?? versionId） */
    currentLabel: function () {
      return state.current ? labelWithLoader(state.current) : '';
    },
    /** 当前版本的完整信息（loader / gameVersion / dir …）；没选时 null */
    currentInfo: function () {
      return state.current ? byId(state.current) : null;
    },
    /** 已安装版本清单（只读副本） */
    list: function () {
      return state.installed.slice();
    },
    displayName: displayNameOf,
    select: selectVersion,
    reload: function () {
      return loadInstalled({ force: true });
    },
    openRename: openRenameModal,
    goContent: goContent,
    openPicker: showPicker,
    closePicker: hidePicker
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
