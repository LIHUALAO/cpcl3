/**
 * 基础便利功能：打开文件夹 / 复制路径 / 复制启动参数 / 显示磁盘占用。
 *
 * 约束与其他前端文件一致：纯原生 JS、无框架、无 CDN、无构建步骤。
 *
 * 用户原话：「一些方便的基础功能也不能缺少，比如下载位置自定义，打开游戏文件夹，
 * mod 文件夹之类的，这些都没有」。
 *
 * 设计要点：
 *   1. **不改 app.js 的既有结构**：卡片上的按钮用 MutationObserver 追加，
 *      现有渲染逻辑一行不动 —— 四个代理同时在改前端，动别人的代码最容易撞车。
 *   2. **失败要说话**：复制失败必须降级成「选中输入框让你手动复制」，
 *      而不是静默无反应（用户会以为按钮坏了）。
 *   3. **打开文件夹失败要解释原因**：403 的时候很可能是「非本机直连」，
 *      这句话必须原样转达，否则用户根本不知道为什么点了没反应。
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
    if (error.message) return error.message;
    return String(error);
  }

  /** 与其他前端文件同款的 API 封装（各自独立，避免跨文件依赖顺序） */
  function api(path, options) {
    var opts = options || {};
    var timeoutMs = opts.timeoutMs || 15000;
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
          if (data === null) throw new Error('服务器返回的不是 JSON：' + String(text).slice(0, 120));
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

  function toast(text, ok) {
    var existing = document.querySelector('.toast');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var node = el('div', ok === true ? 'toast is-ok' : 'toast', text);
    document.body.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 6000);
  }

  function showError(text) {
    var node = $('footer-error');
    if (!node) {
      toast(text);
      return;
    }
    node.textContent = '⚠ ' + text;
    node.hidden = false;
  }

  // ───────────────────────────── 文件夹清单 ─────────────────────────────

  /** kind → 中文名。与后端 FOLDER_LABEL_CN 保持一致（后端是权威，这里只为少一次往返）。 */
  var FOLDER_LABEL = {
    instance: '游戏目录',
    mods: 'mods（模组）',
    resourcepacks: '资源包',
    shaderpacks: '光影',
    datapacks: '数据包',
    saves: '存档',
    logs: '日志',
    config: '配置',
    screenshots: '截图',
    'crash-reports': '崩溃报告'
  };

  /** 卡片上下拉菜单里展示哪些（顺序即用户心智顺序：先常用的） */
  var MENU_KINDS = [
    'instance',
    'mods',
    'resourcepacks',
    'shaderpacks',
    'saves',
    'logs',
    'crash-reports'
  ];

  // ───────────────────────────── 剪贴板（带降级） ─────────────────────────────

  /**
   * 复制文本。
   *
   * 三级降级（这个顺序是刻意的）：
   *   1. navigator.clipboard.writeText —— 现代浏览器，但要求安全上下文/用户手势；
   *   2. 临时 textarea + execCommand('copy') —— 老 Edge / http 页面；
   *   3. 弹出可编辑输入框并全选 —— 前两条都失败时，至少让用户能按 Ctrl+C。
   */
  function copyText(text, label) {
    var value = String(text === undefined || text === null ? '' : text);
    if (value.length === 0) {
      toast('没有可复制的内容');
      return Promise.resolve(false);
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard
        .writeText(value)
        .then(function () {
          toast('已复制' + (label ? '：' + label : ''), true);
          return true;
        })
        .catch(function () {
          return fallbackCopy(value, label);
        });
    }
    return Promise.resolve(fallbackCopy(value, label));
  }

  function fallbackCopy(value, label) {
    // 第 2 级：textarea + execCommand
    try {
      var area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(area);
      if (ok) {
        toast('已复制' + (label ? '：' + label : ''), true);
        return true;
      }
    } catch (e) {
      /* 落到第 3 级 */
    }
    // 第 3 级：明确告诉用户「请手动复制」，并把内容选中
    manualCopyDialog(value, label);
    return false;
  }

  /** 手动复制兜底：一个输入框 + 已经全选好的文本 */
  function manualCopyDialog(value, label) {
    var backdrop = el('div', 'modal-backdrop');
    var modal = el('div', 'modal');
    var head = el('div', 'modal-head');
    head.appendChild(el('h3', null, '手动复制' + (label ? '：' + label : '')));
    var closeBtn = el('button', 'btn btn-ghost btn-sm', '✕');
    closeBtn.type = 'button';
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var body = el('div', 'modal-body');
    body.appendChild(
      el('p', 'modal-sub', '浏览器不允许自动复制（多半是页面不是 https，或权限被拦）。下面的内容已经全选，按 Ctrl+C 即可。')
    );
    var input = el('input', 'input input-full');
    input.type = 'text';
    input.value = value;
    body.appendChild(input);
    modal.appendChild(body);

    var foot = el('div', 'modal-foot');
    var ok = el('button', 'btn btn-primary', '关闭');
    ok.type = 'button';
    foot.appendChild(ok);
    modal.appendChild(foot);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    var dismiss = function () {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    };
    closeBtn.addEventListener('click', dismiss);
    ok.addEventListener('click', dismiss);
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) dismiss();
    });
    input.focus();
    input.select();
  }

  // ───────────────────────────── 路径行（可点击复制） ─────────────────────────────

  function buildPathRow(label, pathValue) {
    var row = el('div', 'path-row');
    row.appendChild(el('span', 'path-label', label));

    var path = el('code', 'path-value', pathValue);
    path.title = '点击复制：' + pathValue;
    path.setAttribute('role', 'button');
    path.setAttribute('tabindex', '0');
    var copy = function () {
      copyText(pathValue, label);
    };
    path.addEventListener('click', copy);
    path.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        copy();
      }
    });
    row.appendChild(path);

    var btn = el('button', 'btn btn-ghost btn-sm', '复制');
    btn.type = 'button';
    btn.addEventListener('click', copy);
    row.appendChild(btn);
    return row;
  }

  // ───────────────────────────── 打开文件夹 ─────────────────────────────

  /** 菜单当前对应的实例 */
  var menuState = { instanceId: '', anchor: null };
  var menuKeyHandler = null;

  function closeFolderMenu() {
    var menu = $('folder-menu');
    if (menu) menu.hidden = true;
    if (menuKeyHandler) {
      document.removeEventListener('keydown', menuKeyHandler);
      menuKeyHandler = null;
    }
    if (menuState.anchor && menuState.anchor.setAttribute) {
      menuState.anchor.setAttribute('aria-expanded', 'false');
    }
    menuState.anchor = null;
    menuState.instanceId = '';
  }

  function openFolderMenu(instanceId, anchor) {
    var menu = $('folder-menu');
    if (!menu) return;

    var already = !menu.hidden && menuState.instanceId === instanceId && menuState.anchor === anchor;
    if (already) {
      closeFolderMenu();
      return;
    }

    menuState.instanceId = instanceId;
    menuState.anchor = anchor;
    if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');

    menu.textContent = '';
    menu.appendChild(el('div', 'folder-menu-title', instanceId));

    // ── 打开各类目录 ──
    MENU_KINDS.forEach(function (kind) {
      var item = el('button', 'folder-menu-item', FOLDER_LABEL[kind] || kind);
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('data-folder-open', kind);
      item.addEventListener('click', function () {
        openFolder(instanceId, kind, item);
      });
      menu.appendChild(item);
    });

    menu.appendChild(el('div', 'folder-menu-sep'));

    // ── 复制路径 / 复制启动参数 ──
    var copyPaths = el('button', 'folder-menu-item', '复制全部路径…');
    copyPaths.type = 'button';
    copyPaths.setAttribute('data-folder-paths', instanceId);
    copyPaths.addEventListener('click', function () {
      closeFolderMenu();
      showPathsModal(instanceId);
    });
    menu.appendChild(copyPaths);

    var copyArgs = el('button', 'folder-menu-item', '复制启动参数');
    copyArgs.type = 'button';
    copyArgs.setAttribute('data-folder-args', instanceId);
    copyArgs.addEventListener('click', function () {
      closeFolderMenu();
      copyLaunchArgs(instanceId, copyArgs);
    });
    menu.appendChild(copyArgs);

    menu.hidden = false;

    // 定位到按钮下方（fixed 定位，避免被卡片的 overflow 裁掉）
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      var rect = anchor.getBoundingClientRect();
      var width = menu.offsetWidth || 220;
      var left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
      menu.style.left = Math.max(8, left) + 'px';
      menu.style.top = rect.bottom + 6 + 'px';
    }

    menuKeyHandler = function (event) {
      if (event.key === 'Escape') closeFolderMenu();
    };
    document.addEventListener('keydown', menuKeyHandler);
  }

  function openFolder(instanceId, kind, button) {
    if (button) button.disabled = true;
    api('/api/instances/' + encodeURIComponent(instanceId) + '/folders/' + encodeURIComponent(kind) + '/open', {
      method: 'POST',
      body: {},
      timeoutMs: 15000
    })
      .then(function (data) {
        toast('已打开 ' + (data.label || kind));
        appendLog('打开文件夹：' + (data.path || kind));
        closeFolderMenu();
      })
      .catch(function (error) {
        // 403 最常见的原因是「不是本机直连」或「经代理转发」，后端已经把原因写清楚了，原样转达
        var text = messageOf(error);
        showError('打开文件夹失败：' + text);
        appendLog('打开文件夹失败：' + text, 'error');
        toast('打开失败：' + text);
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  }

  /** 往主日志区追加一行（主日志在 app.js 里，这里只做最保守的 DOM 追加） */
  function appendLog(text, level) {
    var box = $('log');
    if (!box) return;
    var line = el('span', 'l-line');
    line.appendChild(el('span', 'l-' + (level || 'info'), text));
    line.appendChild(document.createTextNode('\n'));
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  // ───────────────────────────── 全部路径弹窗 ─────────────────────────────

  function showPathsModal(instanceId) {
    var backdrop = el('div', 'modal-backdrop');
    var modal = el('div', 'modal modal-wide');
    var head = el('div', 'modal-head');
    head.appendChild(el('h3', null, '路径 · ' + instanceId));
    var closeBtn = el('button', 'btn btn-ghost btn-sm', '✕');
    closeBtn.type = 'button';
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var body = el('div', 'modal-body');
    body.appendChild(el('p', 'modal-sub', '点任意一行即可复制。用来在文件管理器里手动定位，或贴给别人排查问题。'));
    var list = el('div', 'path-list');
    list.textContent = '';
    list.appendChild(el('p', 'empty', '正在读取路径…'));
    body.appendChild(list);
    modal.appendChild(body);

    var foot = el('div', 'modal-foot');
    var openRootBtn = el('button', 'btn btn-ghost', '打开游戏目录');
    openRootBtn.type = 'button';
    foot.appendChild(openRootBtn);
    var spacer = el('span', 'foot-spacer');
    foot.appendChild(spacer);
    var done = el('button', 'btn btn-primary', '关闭');
    done.type = 'button';
    foot.appendChild(done);
    modal.appendChild(foot);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    var dismiss = function () {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    };
    closeBtn.addEventListener('click', dismiss);
    done.addEventListener('click', dismiss);
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) dismiss();
    });
    openRootBtn.addEventListener('click', function () {
      openFolder(instanceId, 'instance', openRootBtn);
    });

    api('/api/instances/' + encodeURIComponent(instanceId) + '/paths', { timeoutMs: 12000 })
      .then(function (data) {
        list.textContent = '';
        var folders = Array.isArray(data.folders) ? data.folders : [];
        if (folders.length === 0) {
          list.appendChild(el('p', 'empty', '没有拿到任何路径。'));
          return;
        }
        folders.forEach(function (folder) {
          list.appendChild(buildPathRow(folder.label || folder.kind, folder.path));
        });
      })
      .catch(function (error) {
        list.textContent = '';
        list.appendChild(el('p', 'empty error-text', '路径读取失败：' + messageOf(error)));
      });
  }

  // ───────────────────────────── 复制启动参数 ─────────────────────────────

  function copyLaunchArgs(instanceId, button) {
    if (button) button.disabled = true;
    api('/api/instances/' + encodeURIComponent(instanceId) + '/launch-args', { timeoutMs: 25000 })
      .then(function (data) {
        var line = String(data.commandLine || '');
        if (line.length === 0) throw new Error('服务器没有返回命令行。');
        copyText(line, instanceId + ' 的启动参数');
        appendLog(
          '启动参数（' +
            instanceId +
            '）：' +
            (data.argCount || '?') +
            ' 个参数，' +
            (data.length || line.length) +
            ' 字符' +
            (data.redacted ? '，令牌已打码' : '')
        );
        // 顺手把命令行摊在日志区，方便对着看（已打码，不会泄露账号）
        appendLog(line);
      })
      .catch(function (error) {
        var text = messageOf(error);
        var hint = error && error.body && error.body.hint ? '\n' + error.body.hint : '';
        showError('复制启动参数失败：' + text + hint);
        toast('复制启动参数失败：' + text);
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  }

  // ───────────────────────────── 磁盘占用 ─────────────────────────────

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var value = bytes;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return (value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[i];
  }

  /** 把 /api/status 的 diskUsage 写进顶栏的小标签（没有就新建一个） */
  function renderDiskUsage(usage) {
    if (!usage) return;
    var chip = $('chip-disk');
    if (!chip) {
      var bar = $('statusbar');
      if (!bar) return;
      chip = el('span', 'chip');
      chip.id = 'chip-disk';
      chip.title = '数据目录占用';
      chip.appendChild(el('span', 'chip-label', '占用'));
      var value = el('span', 'chip-value', '—');
      value.id = 'disk-usage';
      chip.appendChild(value);
      // 插在「已装」前面，视觉上更靠近数据目录那个标签
      var anchorChip = null;
      for (var i = 0; i < bar.children.length; i += 1) {
        if (bar.children[i].id !== 'chip-data-root' && bar.children[i].classList.contains('chip')) {
          anchorChip = bar.children[i];
          break;
        }
      }
      if (anchorChip && anchorChip.parentNode) anchorChip.parentNode.insertBefore(chip, anchorChip);
      else bar.appendChild(chip);
    }

    var node = $('disk-usage');
    if (!node) return;

    if (usage.ready !== true) {
      node.textContent = '统计中…';
      chip.title = usage.detail || '正在统计数据目录占用';
      return;
    }
    node.textContent = formatBytes(usage.bytes);
    var detail = '共 ' + String(usage.files || 0) + ' 个文件';
    if (usage.sampled === true) detail += '（文件过多，只做了估算）';
    else if (usage.partial === true) detail += '（统计被截断，数值偏小）';
    if (usage.stale === true) detail += '；正在刷新';
    chip.title = detail;
  }

  /**
   * 取一次状态并刷新占用。
   *
   * 后端是异步算的：第一次可能返回「统计中」，所以要过几秒再问一次。
   * 只在磁盘数字还没就绪时重试，避免无脑轮询。
   */
  function refreshDiskUsage(attempt) {
    var tries = attempt || 0;
    api('/api/status', { timeoutMs: 25000 })
      .then(function (data) {
        renderDiskUsage(data.diskUsage);
        if (data.dataRoot) {
          var rootChip = $('chip-data-root');
          if (rootChip) rootChip.title = '数据目录：' + data.dataRoot;
        }
        var usage = data.diskUsage || {};
        if (usage.ready !== true && tries < 6) {
          setTimeout(function () {
            refreshDiskUsage(tries + 1);
          }, 2500);
        }
      })
      .catch(function () {
        // 状态接口失败不额外弹错（app.js 已经在首屏报过一次了）
      });
  }

  // ───────────────────────────── 数据根：打开 / 复制 ─────────────────────────────

  function buildDataRootTools() {
    var existing = $('data-root-tools');
    if (existing) return;

    var chip = $('chip-data-root');
    if (!chip || !chip.parentNode) return;

    var wrap = el('span', 'data-root-tools');
    wrap.id = 'data-root-tools';

    var openBtn = el('button', 'btn btn-ghost btn-sm', '打开');
    openBtn.type = 'button';
    openBtn.title = '在文件管理器中打开数据目录';
    openBtn.id = 'btn-open-data-root';
    openBtn.addEventListener('click', function () {
      // 数据根不属于任何实例：用一个占位实例 id 走同一条路由，服务端对 dataRoot 不做实例校验
      api('/api/instances/instance/folders/dataRoot/open', { method: 'POST', body: {}, timeoutMs: 15000 })
        .then(function (data) {
          toast('已打开数据目录');
          appendLog('打开数据目录：' + (data.path || ''));
        })
        .catch(function (error) {
          showError('打开数据目录失败：' + messageOf(error));
        });
    });

    var copyBtn = el('button', 'btn btn-ghost btn-sm', '复制');
    copyBtn.type = 'button';
    copyBtn.title = '复制数据目录路径';
    copyBtn.id = 'btn-copy-data-root';
    copyBtn.addEventListener('click', function () {
      var value = $('data-root') ? $('data-root').textContent : '';
      copyText(value, '数据目录');
    });

    wrap.appendChild(openBtn);
    wrap.appendChild(copyBtn);
    chip.parentNode.insertBefore(wrap, chip.nextSibling);
  }

  // ───────────────────────────── 给版本卡片追加入口 ─────────────────────────────

  /**
   * 在每张版本卡片上补一个「打开文件夹」按钮。
   *
   * 为什么用 MutationObserver 而不是改 app.js：app.js 的 buildCard / buildLoaderCard
   * 是别人的代码，四个代理同时在改它。这里只「观察列表变化，往新卡片的按钮区塞一个自己的按钮」，
   * 双方互不影响，谁先合并都不会坏。
   */
  function buildFolderButton(versionId) {
    var wrap = el('div', 'card-actions card-actions-folders');
    var btn = el('button', 'btn btn-ghost btn-folder', '📂 打开文件夹');
    btn.type = 'button';
    btn.title = '打开 mods / 资源包 / 存档 / 日志 等目录';
    btn.setAttribute('data-folder-entry', versionId);
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      openFolderMenu(versionId, btn);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function decorateCards(root) {
    var cards = root.querySelectorAll('.card[data-version-id]');
    for (var i = 0; i < cards.length; i += 1) {
      var card = cards[i];
      var id = card.getAttribute('data-version-id');
      if (!id) continue;
      if (card.querySelector('[data-folder-entry]')) continue;
      card.appendChild(buildFolderButton(id));
    }
  }

  function observeVersionList() {
    var host = $('version-list');
    if (!host) return;
    decorateCards(host);

    if (typeof MutationObserver !== 'function') return;
    var observer = new MutationObserver(function () {
      decorateCards(host);
    });
    observer.observe(host, { childList: true, subtree: true });
  }

  // ───────────────────────────── 启动 ─────────────────────────────

  function bindGlobal() {
    // 点别处 / 滚动 / 窗口变化都关掉菜单（否则它会飘在错误的位置）
    document.addEventListener('click', function (event) {
      var menu = $('folder-menu');
      if (!menu || menu.hidden) return;
      var target = event.target;
      if (menu.contains(target)) return;
      if (target && target.getAttribute && target.getAttribute('data-folder-entry')) return;
      if (menuState.anchor && menuState.anchor.contains && menuState.anchor.contains(target)) return;
      closeFolderMenu();
    });

    window.addEventListener('resize', closeFolderMenu);
    document.addEventListener('scroll', function () {
      var menu = $('folder-menu');
      if (menu && !menu.hidden) closeFolderMenu();
    }, true);

    var refresh = $('btn-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        refreshDiskUsage(0);
      });
    }
  }

  function boot() {
    bindGlobal();
    buildDataRootTools();
    observeVersionList();
    refreshDiskUsage(0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
