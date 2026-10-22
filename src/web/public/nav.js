/**
 * 左侧导航：主页 / 下载 / 版本 / 内容 / 整合包 / 设置 —— 纯 CSS 切换，无路由库。
 *
 * 为什么要这个文件（用户原话：「界面是不是可以精炼一些，现在看着很复杂」）：
 *   改版前 main 里 5 个面板纵向堆在一起，一屏装不下；右侧栏又被挤到最下面。
 *   现在改成 PCL2 那种「左导航 + 中内容 + 右常驻栏」，同一时刻只显示一个页面。
 *
 * 本轮改名（用户原话：「实例选项应该改个名字比如版本选择什么的」+「下载界面可以自选下载版本」）：
 *   旧：主页 / 实例 / 内容 / 整合包 / 设置
 *   新：主页 / 下载 / 版本 / 内容 / 整合包 / 设置
 *   - 「实例」→「版本」：实例概念已取消，一个已安装版本就是一个启动目标；
 *   - 「下载」是新页：所有可下载版本（原来堆在主页的 200 张卡片）搬过去了。
 *   为避免老链接失效，`instances` 仍被接受为 `versions` 的别名（见 normalizePage）。
 *
 * 三条硬约束（都是为了不动别人的代码）：
 *   1. **只切显隐，不重新渲染**。页面容器一直留在 DOM 里，切页只是加/去 `.is-active`，
 *      各面板里的列表、滚动位置、输入框内容全部原样保留，所以切换不会闪。
 *   2. **所有元素仍由 `document.getElementById` 找得到**。容器换了层级，id 一个没动；
 *      这里只按 `data-page` 找「页面容器」，从不按 id 找业务元素。
 *   3. **不改任何业务脚本**。packs.js / mods.js / modpack.js / infra.js / folders.js /
 *      preflight.js 一行没碰，它们照旧按 id 干活。
 *
 * URL 同步：`#page=content&tab=mod`
 *   - `page` 决定显示哪个页面；
 *   - `tab` 只在「内容」页有意义（mod / resourcepack / datapack / shader）。
 *
 * 与 packs.js 的 hash 共存（重要）：
 *   packs.js 自己会写 `#packs-kind=datapack&packs-save=新的世界`，并且用
 *   `history.replaceState` 整体替换 hash。两边各写各的会互相抹掉，所以这里在
 *   **每次** 写 hash 之前，先把残留的 `packs-kind` / `packs-save` 读进内存，
 *   再连同导航参数一起写回去；同时把导航状态挂在 `window.pcl3Nav` 上，
 *   万一别的脚本再次整体覆盖 hash，`hashchange` 回调也能把导航恢复回来。
 *   两个方向都做了防御，谁后写都不会把对方搞坏。
 *
 * 顺带补上 packs.js 的一处历史欠账（**不改它的代码**）：
 *   packs.js 重启页面时能从 hash 里读回 `packs-kind=datapack`，但读回之后
 *   从来没调用过 setKind()，标签按钮与列表永远停在「资源包」。这里若发现
 *   hash 指定的标签和 packs.js 当前状态不一致，就替用户点一下那个按钮，
 *   让它走自己原本的流程把列表拉起来。
 */
(function () {
  'use strict';

  var PAGES = ['home', 'download', 'versions', 'content', 'modpack', 'settings'];
  var DEFAULT_PAGE = 'home';
  /** 内容页的二级标签：与 mods.js 的 data-project-type / packs.js 的 data-pack-kind 取值一致 */
  var TABS = ['mod', 'resourcepack', 'datapack', 'shader'];
  var DEFAULT_TAB = 'mod';
  var KIND_FROM_TAB = { mod: 'mod', resourcepack: 'resourcepack', datapack: 'datapack', shader: 'shader' };

  var PAGE_LABEL = {
    home: '主页',
    download: '下载',
    versions: '版本',
    content: '内容',
    modpack: '整合包',
    settings: '设置'
  };

  var nav = {
    page: DEFAULT_PAGE,
    tab: DEFAULT_TAB,
    /** 被 packs.js 写过、需要原样带回去的键值对（它用 replaceState 整体覆盖 hash） */
    extras: [],
    /** 程序内调用 replaceState 会触发 hashchange，用这个标记忽略自己引起的事件 */
    selfWrite: 0,
    bound: false
  };

  // ───────────────────────────── 小工具 ─────────────────────────────

  function $(id) {
    return document.getElementById(id);
  }

  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  /** 旧链接兼容：`#page=instances` 落到「版本」页 */
  function normalizePage(name) {
    return name === 'instances' ? 'versions' : name;
  }

  function isPage(name) {
    return PAGES.indexOf(normalizePage(name)) !== -1;
  }

  function isTab(name) {
    return TABS.indexOf(name) !== -1;
  }

  function closestEl(node, selector) {
    while (node && node.nodeType === 1) {
      if (node.matches ? node.matches(selector) : false) return node;
      node = node.parentNode;
    }
    return null;
  }

  // ───────────────────────────── hash 解析 / 写入 ─────────────────────────────

  /** `#page=content&tab=mod&packs-kind=datapack` → { page, tab, extras } */
  function parseHash() {
    var raw = String(window.location.hash || '').replace(/^#/, '');
    var out = { page: '', tab: '', extras: [] };
    if (!raw) return out;

    raw.split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      var key = eq < 0 ? pair : pair.slice(0, eq);
      var value = eq < 0 ? '' : pair.slice(eq + 1);
      var decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch (e) {
        decoded = value;
      }
      if (key === 'page') out.page = decoded;
      else if (key === 'tab') out.tab = decoded;
      else out.extras.push([key, decoded]);
    });
    return out;
  }

  /** 当前 hash 里属于 packs.js 的键值对；一个都没有时沿用上一次记住的 */
  function readExtras() {
    var parsed = parseHash();
    if (parsed.extras.length > 0) nav.extras = parsed.extras;
    return nav.extras.slice();
  }

  /** 按「当前状态 + 记住的 extras」拼出 hash 并写回（never 抛） */
  function commit(page, tab) {
    var pairs = ['page=' + encodeURIComponent(page)];
    if (page === 'content') pairs.push('tab=' + encodeURIComponent(tab));
    readExtras().forEach(function (pair) {
      pairs.push(encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]));
    });
    var hash = '#' + pairs.join('&');

    try {
      if (!window.history || typeof window.history.replaceState !== 'function') return;
      if (window.location.hash === hash) return;
      nav.selfWrite += 1;
      window.history.replaceState(null, '', hash);
    } catch (e) {
      /* 记不住就算了（file:// / 沙箱 iframe 会抛 SecurityError），界面照样能切 */
    }
  }

  // ───────────────────────────── 渲染：只切显隐 ─────────────────────────────

  function markNavigation() {
    all('[data-nav]').forEach(function (btn) {
      var on = btn.getAttribute('data-nav') === nav.page;
      if (on) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
      btn.setAttribute('aria-current', on ? 'page' : 'false');
    });
  }

  function markPages() {
    all('[data-page]').forEach(function (node) {
      var on = node.getAttribute('data-page') === nav.page;
      node.hidden = !on;
      if (on) node.classList.add('is-active');
      else node.classList.remove('is-active');
    });
  }

  /**
   * 判断某个 `data-tab-panel` 节点的取值是否覆盖当前标签。
   * 支持空格分隔写多个值：`data-tab-panel="resourcepack datapack shader"` ——
   * 「本地文件」那一块就是三个标签共用同一个容器（里面有 packs.js 自己的子标签）。
   */
  function panelCovers(node, tab) {
    var value = String(node.getAttribute('data-tab-panel') || '');
    if (!value) return false;
    return value.split(/\s+/).indexOf(tab) !== -1;
  }

  function markTabs() {
    all('[data-tab]').forEach(function (btn) {
      var on = btn.getAttribute('data-tab') === nav.tab;
      if (on) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.setAttribute('tabindex', on ? '0' : '-1');
    });
    all('[data-tab-panel]').forEach(function (node) {
      var on = panelCovers(node, nav.tab);
      node.hidden = !on;
      if (on) node.classList.add('is-active');
      else node.classList.remove('is-active');
    });
  }

  /**
   * 「主页 / 版本」两块面板以前靠 app.js 的 setView() 互斥显隐。
   * 实例概念取消后，两块面板分别由 versions.js（主页版本选择器）和
   * versions.js（版本列表）渲染，互不重入；这里只保留一个**兼容钩子**：
   * 万一还有旧脚本调 `window.pcl3SetView`，转成「切到对应页面」。
   */
  function syncAppView() {
    if (typeof window.pcl3SetView !== 'function') return;
    /* 旧接口仍然存在时不做任何事：页面级显隐由 markPages() 独占，
       两套显隐逻辑同时生效会互相打架（典型症状：切页后一片空白）。 */
  }

  function title() {
    var label = PAGE_LABEL[nav.page] || '';
    return label ? label + ' · PCL3' : 'PCL3 — Minecraft 启动器';
  }

  function render() {
    markNavigation();
    markPages();
    markTabs();
    syncAppView();

    var crumb = $('nav-current');
    if (crumb) crumb.textContent = PAGE_LABEL[nav.page] || '';
    try {
      document.title = title();
    } catch (e) {
      /* 忽略 */
    }
  }

  /**
   * 通知「某个页面刚被打开」。
   * 目前唯一的使用者是 infra.js 的设置页：每次切回来都重读一次 /api/config，
   * 免得用户刚在弹窗里改完、回到页内却看到旧值。用事件而不是直接调用，
   * 是为了让业务脚本不依赖 nav.js 的加载顺序。
   */
  function announce() {
    try {
      document.dispatchEvent(new CustomEvent('pcl3:page-shown', { detail: { page: nav.page, tab: nav.tab } }));
    } catch (e) {
      /* 老浏览器没有 CustomEvent 构造器：跳过，不影响切页 */
    }
  }

  // ───────────────────────────── 对外：切页 / 切标签 ─────────────────────────────

  function showPage(page, tab) {
    var next = isPage(page) ? normalizePage(page) : DEFAULT_PAGE;

    if (isTab(tab)) nav.tab = tab;
    else if (next === 'content' && !isTab(nav.tab)) nav.tab = DEFAULT_TAB;

    nav.page = next;
    commit(nav.page, nav.tab);
    render();
    syncLegacyTabs();
    announce();

    // 之前锚点跳转留下的位置会让新页面停在半路，切页后回到顶部
    var shell = document.querySelector('.content');
    if (shell && typeof shell.scrollTo === 'function') shell.scrollTo(0, 0);
  }

  function showTab(tab) {
    if (!isTab(tab)) return;
    nav.tab = tab;
    commit(nav.page, nav.tab);
    markTabs();
    syncLegacyTabs();
    announce();
  }

  /**
   * 内容页二级标签：Mod / 资源包 / 数据包 / 光影。
   *
   * 为了让 mods.js 与 packs.js **一点都不用改**，切标签时会顺手替用户点一下
   * 两个脚本早就绑好的按钮：
   *   - mods.js 监听 `#content-type` 上的 `[data-project-type]` 点击；
   *   - packs.js 监听 `#packs-tabs` 上的 `[data-pack-kind]` 点击。
   * 它们自己的状态机、接口请求、列表渲染全部照旧，这里只是「替人点按钮」。
   * 已经激活的那个不再点，避免每次切页都重新发一次搜索请求。
   */
  function syncLegacyTabs() {
    if (nav.page !== 'content') return;

    var kind = KIND_FROM_TAB[nav.tab];
    if (!kind) return;

    var typeBtn = document.querySelector('#content-type [data-project-type="' + kind + '"]');
    if (typeBtn && !typeBtn.classList.contains('is-active')) typeBtn.click();

    if (kind !== 'mod') {
      var packBtn = document.querySelector('#packs-tabs [data-pack-kind="' + kind + '"]');
      if (packBtn && !packBtn.classList.contains('is-active')) packBtn.click();
    }

    // packs.js 的 setKind() 会用 replaceState 把 hash 整个换成 `#packs-kind=…`，
    // 把 page / tab 抹掉（刷新后就回不到「内容」页了）。这里是同步调用，
    // 它在上面那个 click() 里刚写完，我们立刻补回来 —— 谁后写谁负责。
    commit(nav.page, nav.tab);
    markPages();
  }

  /**
   * 首屏把 packs.js 从 hash 里读回去的标签追平（见文件头「历史欠账」）。
   * 只在 packs.js 的状态确实和 hash 不一致时才点，避免干扰它自己的初始化。
   */
  function adoptPacksHash() {
    var fromHash = '';
    parseHash().extras.forEach(function (pair) {
      if (pair[0] === 'packs-kind' && KIND_FROM_TAB[pair[1]] && pair[1] !== 'mod') fromHash = pair[1];
    });
    if (!fromHash) return;

    var packs = window.pcl3Packs;
    var current = packs && packs.state ? packs.state.kind : '';
    if (current === fromHash) return;

    var packBtn = document.querySelector('#packs-tabs [data-pack-kind="' + fromHash + '"]');
    if (packBtn && !packBtn.classList.contains('is-active')) {
      packBtn.click();
      // 同上：packs.js 会顺手把 hash 换成它自己那套，这里把它补回来
      commit(nav.page, nav.tab);
    }
  }

  // ───────────────────────────── 事件绑定 ─────────────────────────────

  function bind() {
    if (nav.bound) return;
    nav.bound = true;

    // 左侧导航：事件委托，将来加导航项不用再改这里
    var list = $('nav-list');
    if (list) {
      list.addEventListener('click', function (event) {
        var target = closestEl(event.target, '[data-nav]');
        if (!target) return;
        event.preventDefault();
        showPage(target.getAttribute('data-nav'));
      });
    }

    // 内容页二级标签：同样是委托
    var tabs = $('content-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (event) {
        var target = closestEl(event.target, '[data-tab]');
        if (!target) return;
        event.preventDefault();
        showTab(target.getAttribute('data-tab'));
      });
    }

    // 页面内任何明确的「跳页」按钮（例如空状态里的「去整合包页」）
    document.addEventListener('click', function (event) {
      var target = closestEl(event.target, '[data-goto]');
      if (!target) return;
      event.preventDefault();
      showPage(target.getAttribute('data-goto'), target.getAttribute('data-goto-tab') || '');
    });

    // 浏览器前进/后退、手改 hash：都要回到对应页面
    window.addEventListener('hashchange', function () {
      if (nav.selfWrite > 0) {
        nav.selfWrite -= 1;
        return;
      }
      var parsed = parseHash();
      if (!isPage(parsed.page)) {
        // 别的脚本改的 hash（例如 packs.js 只写了 packs-kind）：导航状态别丢，补回去
        readExtras();
        commit(nav.page, nav.tab);
        return;
      }
      nav.page = normalizePage(parsed.page);
      if (isTab(parsed.tab)) nav.tab = parsed.tab;
      else if (nav.page === 'content' && parsed.extras.length > 0) {
        // 从 `#packs-kind=shader` 这类旧链接进来时，把内容页二级标签对上去
        parsed.extras.forEach(function (pair) {
          if (pair[0] === 'packs-kind' && isTab(pair[1])) nav.tab = pair[1];
        });
      }
      render();
      syncLegacyTabs();
      announce();
    });

    // 首屏：hash 优先，其次回到主页
    var parsed = parseHash();
    nav.extras = parsed.extras;
    nav.page = isPage(parsed.page) ? normalizePage(parsed.page) : DEFAULT_PAGE;
    nav.tab = isTab(parsed.tab) ? parsed.tab : DEFAULT_TAB;
    commit(nav.page, nav.tab);
    render();

    // 各脚本都在 DOMContentLoaded 里绑自己的事件；等它们都绑完，再把
    // 「hash 里指定但页面没追平」的标签补上一次，并通知各页面「当前页已打开」
    setTimeout(function () {
      adoptPacksHash();
      if (nav.page === 'content') syncLegacyTabs();
      announce();
    }, 0);
  }

  window.pcl3Nav = {
    state: nav,
    showPage: function (page) {
      showPage(page);
    },
    showTab: function (tab) {
      showTab(tab);
    },
    current: function () {
      return { page: nav.page, tab: nav.tab };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
