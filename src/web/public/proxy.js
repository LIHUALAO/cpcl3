/**
 * 网络代理设置面板。
 *
 * 为什么单独一个文件：设置页现在已经有 theme.js / infra.js 各自管一块，
 * 代理也是独立职责（探测、测试、保存），塞进哪一边都会让那个文件变杂。
 *
 * 依赖 app.js 暴露的 window.pcl3Api / pcl3Toast / pcl3ShowError。
 */
(function () {
  'use strict';

  var state = {
    /** 'off' | 'system' | 'manual' */
    mode: 'system',
    url: '',
    bypass: '127.0.0.1,localhost',
    busy: false
  };

  function $(id) {
    return document.getElementById(id);
  }

  function api(path, opts) {
    if (typeof window.pcl3Api === 'function') return window.pcl3Api(path, opts);
    throw new Error('pcl3Api 不可用');
  }

  function toast(text, ok) {
    if (typeof window.pcl3Toast === 'function') window.pcl3Toast(text, ok);
  }

  function errorText(err) {
    if (typeof window.pcl3MessageOf === 'function') return window.pcl3MessageOf(err);
    var body = err && err.body;
    if (body && body.error) return body.error;
    return (err && err.message) || String(err);
  }

  // ───────────────────────────── 渲染 ─────────────────────────────

  function paintMode() {
    var group = $('proxy-mode');
    if (group) {
      Array.prototype.forEach.call(group.querySelectorAll('[data-proxy-mode]'), function (btn) {
        var on = btn.getAttribute('data-proxy-mode') === state.mode;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }

    var manual = $('proxy-manual-field');
    if (manual) manual.hidden = state.mode !== 'manual';

    var note = $('proxy-mode-note');
    if (note) {
      if (state.mode === 'off') {
        note.textContent = '全部直连。国内网络下 cdn.modrinth.com 可能无法下载 mod。';
      } else if (state.mode === 'manual') {
        note.textContent = '使用下面填的地址。支持 http:// 与 socks5:// 两种。';
      } else {
        note.textContent = '跟随系统代理设置；系统没配就等于不使用代理。';
      }
    }

    var bypass = $('proxy-bypass');
    if (bypass && document.activeElement !== bypass) bypass.value = state.bypass;

    var urlInput = $('proxy-url');
    if (urlInput && document.activeElement !== urlInput) urlInput.value = state.url;
  }

  function paintStatus(text, ok) {
    var el = $('proxy-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = ok === true ? 'var(--accent)' : ok === false ? 'var(--danger)' : '';
  }

  function showError(text) {
    var el = $('proxy-error');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function showTestResult(text, ok) {
    var el = $('proxy-test-result');
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    el.style.color = ok ? 'var(--accent)' : 'var(--danger)';
  }

  // ───────────────────────────── 读配置 ─────────────────────────────

  function load() {
    return api('/api/config', { timeoutMs: 15000 })
      .then(function (data) {
        var cfg = (data && data.config) || {};
        var proxy = cfg.proxy || {};
        state.mode = proxy.mode === 'off' || proxy.mode === 'manual' ? proxy.mode : 'system';
        state.url = proxy.url || '';
        state.bypass = proxy.bypass || '127.0.0.1,localhost';
        paintMode();
        paintStatus(
          state.mode === 'off' ? '未启用' : state.mode === 'manual' ? state.url || '未填写' : '跟随系统',
          null
        );
      })
      .catch(function (err) {
        showError('读取代理配置失败：' + errorText(err));
      });
  }

  // ───────────────────────────── 保存 ─────────────────────────────

  function save() {
    if (state.busy) return;
    showError('');

    var payload = {
      proxy: {
        mode: state.mode,
        bypass: state.bypass
      }
    };
    if (state.mode === 'manual') {
      var url = String(state.url || '').trim();
      if (url === '') {
        showError('手动模式下必须填写代理地址，例如 http://127.0.0.1:7897');
        return;
      }
      payload.proxy.url = url;
    }

    state.busy = true;
    var btn = $('btn-proxy-save');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '保存中…';
    }

    api('/api/config', { method: 'PUT', body: payload, timeoutMs: 20000 })
      .then(function (data) {
        var applied = data && data.proxyApplied;
        if (applied && applied.applied) {
          toast('代理已生效：' + (applied.url || ''), true);
          paintStatus('已生效', true);
        } else {
          toast('代理已保存' + (applied && applied.reason ? '（' + applied.reason + '）' : ''), true);
          paintStatus('已保存（未生效）', false);
        }
      })
      .catch(function (err) {
        var body = err && err.body;
        var problems = body && body.problems;
        showError(problems && problems.length ? problems.join('\n') : errorText(err));
      })
      .finally(function () {
        state.busy = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = '保存代理';
        }
      });
  }

  // ───────────────────────────── 探测 / 测试 ─────────────────────────────

  function detect() {
    var btn = $('btn-proxy-detect');
    var hint = $('proxy-detect-hint');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '探测中…';
    }
    if (hint) hint.textContent = '正在扫描常见代理端口…';

    api('/api/proxy/detect', { timeoutMs: 30000 })
      .then(function (data) {
        var found = data && data.found;
        if (found && found.url) {
          state.url = found.url;
          state.mode = 'manual';
          paintMode();
          if (hint) hint.textContent = '✓ ' + (found.label || '检测到代理') + '：' + found.url + '（点「保存代理」生效）';
          toast('检测到代理 ' + found.url, true);
        } else {
          if (hint) {
            hint.textContent =
              '没有检测到运行中的代理。如果你用的是 Clash / v2rayN，请先启动它；' +
              '或者手动填写端口（Clash 常见 7890 / 7897，v2rayN 常见 10809）。';
          }
        }
      })
      .catch(function (err) {
        if (hint) hint.textContent = '探测失败：' + errorText(err);
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '自动探测';
        }
      });
  }

  function test() {
    var btn = $('btn-proxy-test');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '测试中…';
    }
    showTestResult('正在连接 cdn.modrinth.com…', true);

    var body = {};
    if (state.mode === 'manual' && String(state.url || '').trim() !== '') {
      body.url = String(state.url).trim();
    }

    api('/api/proxy/test', { method: 'POST', body: body, timeoutMs: 30000 })
      .then(function (data) {
        if (data && data.ok) {
          showTestResult(
            '✓ 连接成功（' + (data.viaProxy ? '经代理' : '直连') + '，' + String(data.latencyMs) + 'ms）',
            true
          );
        } else {
          showTestResult(
            '✗ 连接失败：' + ((data && data.error) || '未知原因') +
              (state.mode === 'manual' ? '' : '（当前是直连测试，可先填代理再测）'),
            false
          );
        }
      })
      .catch(function (err) {
        showTestResult('✗ 测试失败：' + errorText(err), false);
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '测试连接';
        }
      });
  }

  // ───────────────────────────── 绑定 ─────────────────────────────

  function bind() {
    var group = $('proxy-mode');
    if (!group) return;

    group.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('[data-proxy-mode]') : null;
      if (!btn) return;
      state.mode = btn.getAttribute('data-proxy-mode');
      paintMode();
    });

    var urlInput = $('proxy-url');
    if (urlInput) {
      urlInput.addEventListener('input', function () {
        state.url = urlInput.value;
      });
    }

    var bypass = $('proxy-bypass');
    if (bypass) {
      bypass.addEventListener('input', function () {
        state.bypass = bypass.value;
      });
    }

    var detectBtn = $('btn-proxy-detect');
    if (detectBtn) detectBtn.addEventListener('click', detect);

    var testBtn = $('btn-proxy-test');
    if (testBtn) testBtn.addEventListener('click', test);

    var saveBtn = $('btn-proxy-save');
    if (saveBtn) saveBtn.addEventListener('click', save);
  }

  function init() {
    if (!$('setting-proxy')) return;
    bind();
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 供调试与其他脚本调用
  window.pcl3Proxy = {
    reload: load,
    save: save,
    detect: detect,
    test: test,
    getState: function () {
      return { mode: state.mode, url: state.url, bypass: state.bypass };
    }
  };
})();
