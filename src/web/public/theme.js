/**
 * 主题与外观自定义（纯原生 JS，零依赖，零 CDN）。
 *
 * 用户原话：「可以添加一些小的自定义功能吗比如主题等」。
 * 所以这里做的是「小但真正能用」的一套：主题、字号、紧凑模式、动效、强调色，
 * 每一项都是即时生效 + 持久化，不需要刷新，也不需要后端。
 *
 * 设计原则（沿用 PCL3 前端的踩坑经验）：
 *   1. **只改 <html> 上的 data-* 属性，不碰任何组件 DOM**。
 *      style.css 里 233 处 `var(--*)` 全部由 themes.css 的变量覆盖驱动，
 *      组件样式一行都不用改 —— 主题再多也不会让 CSS 越长越乱。
 *   2. **首屏不能闪**。主题在 `<head>` 里同步应用（见 index.html 里的内联脚本），
 *      等 DOMContentLoaded 才跑的话会先白/黑一下再变色。
 *   3. **localStorage 读不到也得能用**。隐私模式 / 沙箱 iframe 里 localStorage
 *      会直接抛异常，这里全部包在 try/catch 里，失败只是「记不住」，不影响切换。
 *   4. **不认识的存值一律回落到默认**。用户在旧版本存过 `solarized` 这种已经删掉的主题，
 *      不能让页面变成一片无样式的白纸。
 */
(function () {
  'use strict';

  // ───────────────────────────── 存储键 ─────────────────────────────

  var KEYS = {
    theme: 'pcl3.theme',
    accent: 'pcl3.accent',
    fontSize: 'pcl3.fontSize',
    density: 'pcl3.density',
    motion: 'pcl3.motion',
    followSystem: 'pcl3.theme.followSystem',
    /** 顶栏 ☀/🌙 用：从浅色切回深色时回到「上一次用的那套深色」 */
    lastDark: 'pcl3.theme.lastDark'
  };

  // ───────────────────────────── 内置主题 ─────────────────────────────
  //
  // 每个主题只需要两个信息：显示名、以及它属于「深色系」还是「浅色系」。
  // 真正的配色在 themes.css 里（`[data-theme='xxx']` 覆盖变量），
  // 这里不重复写一遍颜色，避免两处不一致。
  //
  // `pair` 是顶栏 ☀/🌙 一键切换的去处：深色主题 → 亮的那套，反之亦然。

  var THEMES = [
    { id: 'pcl3-dark', name: '默认深色', scheme: 'dark', pair: 'light', swatch: '#3ddc97' },
    { id: 'graphite', name: '石墨', scheme: 'dark', pair: 'light', swatch: '#b8c2cc' },
    { id: 'ocean', name: '深海', scheme: 'dark', pair: 'light', swatch: '#4db8ff' },
    { id: 'forest', name: '森林', scheme: 'dark', pair: 'light', swatch: '#79c99e' },
    { id: 'sunset', name: '黄昏', scheme: 'dark', pair: 'light', swatch: '#ff9a5c' },
    { id: 'light', name: '浅色', scheme: 'light', pair: 'pcl3-dark', swatch: '#f4f6f8' }
  ];

  var THEME_BY_ID = {};
  THEMES.forEach(function (t) {
    THEME_BY_ID[t.id] = t;
  });

  var DEFAULT_DARK = 'pcl3-dark';
  var DEFAULT_LIGHT = 'light';

  /** 强调色预设：id → { name, dark, light }（dark/light 只是给色块看的，真值在 themes.css） */
  var ACCENTS = [
    { id: 'teal', name: '青绿', swatch: '#3ddc97' },
    { id: 'blue', name: '蓝', swatch: '#5ea8ff' },
    { id: 'purple', name: '紫', swatch: '#b18cff' },
    { id: 'orange', name: '橙', swatch: '#ffa95c' },
    { id: 'pink', name: '粉', swatch: '#ff86bd' },
    { id: 'red', name: '红', swatch: '#ff7f72' }
  ];

  var ACCENT_IDS = ACCENTS.map(function (a) {
    return a.id;
  });

  var FONT_SIZES = ['sm', 'md', 'lg'];
  var FONT_LABEL = { sm: '小', md: '中', lg: '大' };

  // ───────────────────────────── 安全的 localStorage ─────────────────────────────

  function readRaw(key) {
    try {
      var value = window.localStorage.getItem(key);
      return typeof value === 'string' ? value : '';
    } catch (e) {
      return '';
    }
  }

  function writeRaw(key, value) {
    try {
      if (value === null || value === undefined || value === '') window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(value));
    } catch (e) {
      /* 记不住就算了 —— 隐私模式 / 禁用存储时不该影响界面 */
    }
  }

  // ───────────────────────────── 系统偏好 ─────────────────────────────

  function systemPrefersLight() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    } catch (e) {
      return false;
    }
  }

  // ───────────────────────────── 状态 ─────────────────────────────

  var state = {
    theme: DEFAULT_DARK,
    accent: '',
    fontSize: 'md',
    density: 'comfortable',
    motion: 'on',
    /** 是否跟随系统深浅色：开着时不会被用户手动选的主题覆盖 */
    followSystem: false,
    bound: false
  };

  /** 把任意存值规范化成已知值（不认识的统统回落到默认） */
  function normalizeTheme(id) {
    return THEME_BY_ID[id] ? id : '';
  }

  function normalizeAccent(id) {
    return ACCENT_IDS.indexOf(id) !== -1 ? id : '';
  }

  function normalizeFont(id) {
    return FONT_SIZES.indexOf(id) !== -1 ? id : 'md';
  }

  function normalizeDensity(id) {
    return id === 'compact' ? 'compact' : 'comfortable';
  }

  function normalizeMotion(id) {
    return id === 'off' ? 'off' : 'on';
  }

  /** 读一次存储，算出「这次该用什么主题」 */
  function loadState() {
    var storedTheme = normalizeTheme(readRaw(KEYS.theme));
    var storedFollow = readRaw(KEYS.followSystem);

    state.followSystem = storedFollow === '1';
    state.accent = normalizeAccent(readRaw(KEYS.accent));
    state.fontSize = normalizeFont(readRaw(KEYS.fontSize));
    state.density = normalizeDensity(readRaw(KEYS.density));
    state.motion = normalizeMotion(readRaw(KEYS.motion));

    if (state.followSystem) {
      // 跟随系统时，用户手动选过的主题先记着（关掉开关就回到它）
      state.theme = storedTheme || (systemPrefersLight() ? DEFAULT_LIGHT : DEFAULT_DARK);
      if (systemPrefersLight()) state.theme = DEFAULT_LIGHT;
      else if (state.theme === DEFAULT_LIGHT) state.theme = DEFAULT_DARK;
    } else {
      state.theme = storedTheme || (systemPrefersLight() ? DEFAULT_LIGHT : DEFAULT_DARK);
    }
    return state;
  }

  // ───────────────────────────── 应用到 <html> ─────────────────────────────

  /**
   * 把状态写到 <html> 的 data-* 属性上。
   * 所有视觉变化都在 themes.css 里，这里只负责「挂开关」。
   */
  function apply() {
    var root = document.documentElement;
    if (!root) return;

    root.setAttribute('data-theme', state.theme);

    if (state.accent) root.setAttribute('data-accent', state.accent);
    else root.removeAttribute('data-accent');

    // 中号 = 默认值，去掉属性让 CSS 少一层选择器
    if (state.fontSize && state.fontSize !== 'md') root.setAttribute('data-font-size', state.fontSize);
    else root.removeAttribute('data-font-size');

    if (state.density === 'compact') root.setAttribute('data-density', 'compact');
    else root.removeAttribute('data-density');

    // 默认是「有动效」，只在关闭时才挂属性（同样的原因：少一层选择器）
    if (state.motion === 'off') root.setAttribute('data-motion', 'off');
    else root.removeAttribute('data-motion');

    syncTopbarButton();
    syncSettingsControls();
    announce();
  }

  /** 通知关注外观变化的脚本 / 人（目前用于切换后刷新按钮 aria 与状态文本） */
  function announce() {
    try {
      document.dispatchEvent(new CustomEvent('pcl3:theme-changed', { detail: snapshot() }));
    } catch (e) {
      /* 老浏览器：忽略 */
    }
  }

  function snapshot() {
    var meta = THEME_BY_ID[state.theme] || THEME_BY_ID[DEFAULT_DARK];
    return {
      theme: state.theme,
      name: meta.name,
      scheme: meta.scheme,
      accent: state.accent || 'teal',
      fontSize: state.fontSize,
      density: state.density,
      motion: state.motion,
      followSystem: state.followSystem
    };
  }

  // ───────────────────────────── 公开操作 ─────────────────────────────

  function setTheme(id, opts) {
    var next = normalizeTheme(id) || (systemPrefersLight() ? DEFAULT_LIGHT : DEFAULT_DARK);
    state.theme = next;
    // 手动选主题 = 明确不想被系统覆盖
    if (!opts || opts.keepFollow !== true) state.followSystem = false;
    writeRaw(KEYS.theme, next);
    writeRaw(KEYS.followSystem, state.followSystem ? '1' : '');
    apply();
  }

  /**
   * 顶栏 ☀/🌙：在当前主题和它的「对应那套」之间来回。
   * 深色 → 浅色，浅色 → 上次用的深色（记不住就回默认深色）。
   */
  function toggleScheme() {
    var meta = THEME_BY_ID[state.theme] || THEME_BY_ID[DEFAULT_DARK];
    if (meta.scheme === 'light') {
      var back = normalizeTheme(readRaw(KEYS.lastDark)) || DEFAULT_DARK;
      state.followSystem = false;
      setTheme(back);
    } else {
      // 记住这套深色，回来时还它
      writeRaw(KEYS.lastDark, state.theme);
      state.followSystem = false;
      setTheme(meta.pair || DEFAULT_LIGHT);
    }
  }
  function setAccent(id) {
    state.accent = normalizeAccent(id);
    writeRaw(KEYS.accent, state.accent);
    apply();
  }

  function setFontSize(id) {
    state.fontSize = normalizeFont(id);
    writeRaw(KEYS.fontSize, state.fontSize);
    apply();
  }

  function setDensity(id) {
    state.density = normalizeDensity(id);
    writeRaw(KEYS.density, state.density);
    apply();
  }

  function setMotion(on) {
    state.motion = on === false ? 'off' : normalizeMotion(on);
    writeRaw(KEYS.motion, state.motion);
    apply();
  }

  /**
   * 跟随系统深浅色。
   * 打开时立刻按系统切一次；关闭时保留当前这套（用户看到什么就是什么）。
   */
  function setFollowSystem(on) {
    state.followSystem = on === true;
    writeRaw(KEYS.followSystem, state.followSystem ? '1' : '');
    if (state.followSystem) {
      state.theme = systemPrefersLight() ? DEFAULT_LIGHT : DEFAULT_DARK;
      writeRaw(KEYS.theme, state.theme);
    }
    apply();
  }

  /**
   * 恢复默认外观。
   * 「默认」= PCL3 出厂那套：深色 + 青绿 + 中号 + 舒适 + 动效。
   * 这里**不**跟随系统：用户点「恢复默认」就是想回到产品原本的样子，
   * 系统偏好留给「跟随系统」那个开关去管。
   */
  function resetAll() {
    state.theme = DEFAULT_DARK;
    state.accent = '';
    state.fontSize = 'md';
    state.density = 'comfortable';
    state.motion = 'on';
    state.followSystem = false;
    [KEYS.theme, KEYS.accent, KEYS.fontSize, KEYS.density, KEYS.motion, KEYS.followSystem, KEYS.lastDark].forEach(function (key) {
      writeRaw(key, '');
    });
    apply();
  }

  // ───────────────────────────── 顶栏按钮 ─────────────────────────────

  /** ☀/🌙 按钮：图标表示「点一下会切到哪种」，title 说清当前主题 */
  function syncTopbarButton() {
    var btn = document.getElementById('btn-theme-toggle');
    if (!btn) return;
    var meta = THEME_BY_ID[state.theme] || THEME_BY_ID[DEFAULT_DARK];
    var toLight = meta.scheme === 'dark';
    btn.textContent = toLight ? '☀' : '🌙';
    btn.title = toLight ? '切到浅色（当前：' + meta.name + '）' : '切到深色（当前：' + meta.name + '）';
    btn.setAttribute('aria-label', btn.title);
  }

  // ───────────────────────────── 设置页控件 ─────────────────────────────

  /**
   * 把状态同步到设置页的控件上。
   * 控件全部由本文件的 `buildSettingsSection()` 创建，所以这里只用 querySelector 找，
   * 不占用任何既有 id，也不影响 infra.js 的设置页逻辑。
   */
  function syncSettingsControls() {
    var grid = document.getElementById('setting-theme-grid');
    if (grid) {
      var cards = grid.querySelectorAll('[data-theme-choice]');
      for (var i = 0; i < cards.length; i += 1) {
        var card = cards[i];
        var on = card.getAttribute('data-theme-choice') === state.theme;
        if (on) card.classList.add('is-active');
        else card.classList.remove('is-active');
        card.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }

    var accentHost = document.getElementById('setting-accent-row');
    if (accentHost) {
      var swatches = accentHost.querySelectorAll('[data-accent-choice]');
      for (var j = 0; j < swatches.length; j += 1) {
        var sw = swatches[j];
        var active = (sw.getAttribute('data-accent-choice') || '') === (state.accent || 'teal');
        if (active) sw.classList.add('is-active');
        else sw.classList.remove('is-active');
        sw.setAttribute('aria-checked', active ? 'true' : 'false');
      }
    }

    var fontHost = document.getElementById('setting-font-size');
    if (fontHost) {
      var fontBtns = fontHost.querySelectorAll('[data-font-choice]');
      for (var k = 0; k < fontBtns.length; k += 1) {
        var fb = fontBtns[k];
        var fOn = fb.getAttribute('data-font-choice') === state.fontSize;
        if (fOn) fb.classList.add('is-active');
        else fb.classList.remove('is-active');
        fb.setAttribute('aria-checked', fOn ? 'true' : 'false');
      }
    }

    var follow = document.getElementById('setting-follow-system');
    if (follow) {
      follow.checked = state.followSystem;
      follow.setAttribute('aria-checked', state.followSystem ? 'true' : 'false');
    }

    var compact = document.getElementById('setting-compact');
    if (compact) {
      compact.checked = state.density === 'compact';
      compact.setAttribute('aria-checked', compact.checked ? 'true' : 'false');
    }

    var motion = document.getElementById('setting-motion');
    if (motion) {
      motion.checked = state.motion === 'on';
      motion.setAttribute('aria-checked', motion.checked ? 'true' : 'false');
    }

    var summary = document.getElementById('setting-appearance-summary');
    if (summary) {
      var meta = THEME_BY_ID[state.theme] || THEME_BY_ID[DEFAULT_DARK];
      var parts = [meta.name, '字号' + (FONT_LABEL[state.fontSize] || '中')];
      if (state.density === 'compact') parts.push('紧凑');
      if (state.motion === 'off') parts.push('无动效');
      if (state.accent) parts.push('强调色 ' + accentName(state.accent));
      summary.textContent = parts.join(' · ');
    }
  }

  function accentName(id) {
    for (var i = 0; i < ACCENTS.length; i += 1) {
      if (ACCENTS[i].id === id) return ACCENTS[i].name;
    }
    return id;
  }

  // ───────────────────────────── 事件绑定 ─────────────────────────────

  /** 点击委托：设置页里的主题卡 / 色块 / 字号按钮共用一个处理函数 */
  function onClick(event) {
    var node = event.target;
    while (node && node.nodeType === 1) {
      if (node.hasAttribute && node.hasAttribute('data-theme-choice')) {
        setTheme(node.getAttribute('data-theme-choice'));
        return;
      }
      if (node.hasAttribute && node.hasAttribute('data-accent-choice')) {
        setAccent(node.getAttribute('data-accent-choice'));
        return;
      }
      if (node.hasAttribute && node.hasAttribute('data-font-choice')) {
        setFontSize(node.getAttribute('data-font-choice'));
        return;
      }
      node = node.parentNode;
    }
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;

    var btn = document.getElementById('btn-theme-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        toggleScheme();
      });
    }

    var panel = document.getElementById('setting-appearance');
    if (panel) {
      panel.addEventListener('click', onClick);

      var follow = document.getElementById('setting-follow-system');
      if (follow) {
        follow.addEventListener('change', function () {
          setFollowSystem(follow.checked);
        });
      }

      var compact = document.getElementById('setting-compact');
      if (compact) {
        compact.addEventListener('change', function () {
          setDensity(compact.checked ? 'compact' : 'comfortable');
        });
      }

      var motion = document.getElementById('setting-motion');
      if (motion) {
        motion.addEventListener('change', function () {
          setMotion(motion.checked);
        });
      }

      var reset = document.getElementById('setting-appearance-reset');
      if (reset) {
        reset.addEventListener('click', function () {
          resetAll();
          if (typeof window.pcl3Toast === 'function') window.pcl3Toast('外观已恢复默认', true);
        });
      }
    }

    // 系统深浅色变化：只有「跟随系统」开着时才响应
    try {
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: light)');
        var onChange = function () {
          if (!state.followSystem) return;
          state.theme = systemPrefersLight() ? DEFAULT_LIGHT : DEFAULT_DARK;
          apply();
        };
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
        else if (typeof mq.addListener === 'function') mq.addListener(onChange);
      }
    } catch (e) {
      /* 不支持就算 */
    }

    syncSettingsControls();
  }

  // ───────────────────────────── 初始化 ─────────────────────────────

  /**
   * URL 参数入口：`?theme=ocean&accent=purple&font=lg&density=compact&motion=off`
   *
   * 为什么需要它（不只是为了截图）：
   *   - headless 截图（`--virtual-time-budget`）没法先跑一段 JS 写 localStorage
   *     再打开页面，只能靠 URL 传递一次性状态；`#page=…` 那套已经证明这个做法好使。
   *   - 用户想给朋友发一个「你看这套主题」的链接时，也直接有用。
   *
   * 通过 URL 传参**不写 localStorage**：刷新后回到用户自己选的设置，
   * 不会被一个陌生链接永久改掉外观。唯一的例外是 `follow=0/1` 这种显式开关。
   */
  function applyUrlOverrides() {
    var query = String(window.location.search || '');
    if (!query) return;
    var params = {};
    query.replace(/^\?/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      var key = eq < 0 ? pair : pair.slice(0, eq);
      var value = eq < 0 ? '' : pair.slice(eq + 1);
      try {
        params[decodeURIComponent(key)] = decodeURIComponent(value);
      } catch (e) {
        params[key] = value;
      }
    });

    var theme = normalizeTheme(params.theme);
    if (theme) state.theme = theme;

    if ('accent' in params) {
      var accent = normalizeAccent(params.accent);
      if (accent) state.accent = accent;
      else if (params.accent === 'none' || params.accent === '') state.accent = '';
    }

    if ('font' in params) state.fontSize = normalizeFont(params.font);
    if ('density' in params) state.density = normalizeDensity(params.density);
    if ('motion' in params) state.motion = normalizeMotion(params.motion);
  }

  loadState();
  applyUrlOverrides();
  apply();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      apply();
      bind();
    });
  } else {
    bind();
  }

  // 对外暴露（截图验收、其他脚本按需调用）
  window.pcl3Theme = {
    themes: THEMES,
    accents: ACCENTS,
    state: state,
    current: snapshot,
    setTheme: setTheme,
    setAccent: setAccent,
    setFontSize: setFontSize,
    setDensity: setDensity,
    setMotion: setMotion,
    setFollowSystem: setFollowSystem,
    toggleScheme: toggleScheme,
    reset: resetAll
  };
})();
