/**
 * 启动前体检（preflight）前端。
 *
 * 这是 PCL2 那个「点启动之前先说清楚」的体验：
 *   点「启动」→ POST /api/preflight（< 1 秒）→
 *     · 有阻断项 → 弹窗列出问题 + 每项一个「一键修复」按钮，**不进游戏**
 *     · 只有警告 → toast 提一句，照常启动
 *     · 全绿    → 直接启动
 *
 * 设计约束：
 *   1. **不改 app.js 的既有逻辑**。这个文件只做两件事：
 *      a) 暴露 `window.pcl3Preflight`，由 app.js 的启动按钮在合适的时机调用；
 *      b) 自己没有入口注册时，退化为「接管 [data-pf-hook] 的按钮」——
 *         这样即使 app.js 没接线，体检也不会成为死代码。
 *   2. 修复动作**复用既有接口**，不新造写逻辑：
 *        download-java        → 直接启动（启动链路自己会下 Java，见后端注释）
 *        install-version      → POST /api/install
 *        install-loader       → 打开加载器弹窗（用户要选版本，不能替他决定）
 *        raise-memory         → PUT /api/instances/:id/settings（只改 memoryMB）
 *        remove-duplicate-mod → DELETE /api/instances/:id/mods/:filename（逐个删）
 *        rescan-files         → POST /api/install（幂等：已存在的文件会被跳过）
 *   3. 修复完自动**重跑体检**，让用户看到「真的修好了」而不是一句「已提交」。
 *   4. 全部文本用 textContent（详情里带用户文件名，绝不能用 innerHTML）。
 *
 * 依赖（都由 app.js 挂在 window 上）：
 *   pcl3Api / pcl3El / pcl3MessageOf / pcl3AppendLog / pcl3Toast / pcl3ShowError
 */

(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  function api() {
    var fn = window.pcl3Api;
    if (typeof fn !== 'function') throw new Error('体检模块缺少 pcl3Api（app.js 未加载？）');
    return fn.apply(null, arguments);
  }

  function el() {
    var fn = window.pcl3El;
    if (typeof fn !== 'function') throw new Error('体检模块缺少 pcl3El（app.js 未加载？）');
    return fn.apply(null, arguments);
  }

  function messageOf(error) {
    var fn = window.pcl3MessageOf;
    if (typeof fn === 'function') return fn(error);
    return error && error.message ? error.message : String(error);
  }

  function appendLog(text, level) {
    if (typeof window.pcl3AppendLog === 'function') window.pcl3AppendLog(text, level);
  }

  function toast(text, ok) {
    if (typeof window.pcl3Toast === 'function') window.pcl3Toast(text, ok);
  }

  // ───────────────────────────── 状态 ─────────────────────────────

  var state = {
    /** 当前弹窗对应的启动请求 */
    versionId: '',
    instanceId: '',
    /** 最近一次体检报告 */
    report: null,
    /** 用户点「仍然启动」时的回调（有不可修阻断项时才用得上） */
    onForceLaunch: null,
    busy: false
  };

  // ───────────────────────────── 弹窗 ─────────────────────────────

  function setError(text) {
    var node = $('preflight-error');
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.hidden = true;
      node.textContent = '';
    }
  }

  function openModal(title) {
    var backdrop = $('preflight-modal');
    if (!backdrop) return false;
    $('preflight-title').textContent = title || '启动前体检';
    $('preflight-sub').textContent = '正在检查这个版本能不能启动…';
    $('preflight-list').textContent = '';
    $('preflight-empty').hidden = true;
    $('preflight-summary').hidden = true;
    $('preflight-count-blocking').textContent = '0 个阻断';
    $('preflight-count-warning').textContent = '0 个警告';
    $('preflight-elapsed').textContent = '';
    setError('');
    var launchBtn = $('preflight-launch');
    if (launchBtn) launchBtn.hidden = true;
    backdrop.hidden = false;
    document.addEventListener('keydown', onKeydown);
    return true;
  }

  function closeModal() {
    var backdrop = $('preflight-modal');
    if (backdrop) backdrop.hidden = true;
    document.removeEventListener('keydown', onKeydown);
    state.busy = false;
  }

  function onKeydown(event) {
    if (event.key === 'Escape') closeModal();
  }

  // ───────────────────────────── 渲染 ─────────────────────────────

  var SEVERITY_LABEL = { blocking: '阻断', warning: '警告', info: '提示' };

  function renderPill(node, count, label) {
    if (!node) return;
    node.textContent = String(count) + ' 个' + label;
    node.classList.toggle('is-zero', count === 0);
  }

  function buildIssueNode(issue) {
    var item = el('li', 'pf-item is-' + issue.severity);
    item.setAttribute('data-code', issue.code || '');

    var head = el('div', 'pf-item-head');
    var title = el('div', 'pf-item-title', '[' + (SEVERITY_LABEL[issue.severity] || '提示') + '] ' + (issue.title || ''));
    head.appendChild(title);
    if (issue.code) {
      var code = el('span', 'pf-item-code', issue.code);
      code.title = '问题类型代码（报 bug 时用得上）';
      head.appendChild(code);
    }
    item.appendChild(head);

    if (issue.detail) {
      // 详情里有换行与路径；CSS 用 white-space: pre-wrap 保证换行生效
      item.appendChild(el('div', 'pf-item-detail', issue.detail));
    }

    if (issue.fix) {
      var actions = el('div', 'pf-item-actions');
      var btn = el('button', 'btn btn-primary pf-fix-btn', issue.fix.label || '一键修复');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        runFix(issue, btn, item);
      });
      actions.appendChild(btn);
      item.appendChild(actions);
    }

    return item;
  }

  function renderReport(report) {
    var list = $('preflight-list');
    var empty = $('preflight-empty');
    var summary = $('preflight-summary');
    if (!list) return;

    list.textContent = '';
    state.report = report;

    var blocking = Array.isArray(report.blocking) ? report.blocking : [];
    var warnings = Array.isArray(report.warnings) ? report.warnings : [];
    var infos = Array.isArray(report.infos) ? report.infos : [];
    // info 级问题只在「没有别的可说」时展示，避免弹窗被十几条「核对通过」刷屏
    var show = blocking.concat(warnings);
    if (show.length === 0) show = infos;

    for (var i = 0; i < show.length; i += 1) list.appendChild(buildIssueNode(show[i]));

    if (summary) summary.hidden = false;
    renderPill($('preflight-count-blocking'), blocking.length, '阻断');
    renderPill($('preflight-count-warning'), warnings.length, '警告');
    var elapsed = $('preflight-elapsed');
    if (elapsed) {
      elapsed.textContent =
        typeof report.elapsedMs === 'number' ? '体检耗时 ' + report.elapsedMs + ' ms' : '';
    }

    if (empty) empty.hidden = show.length !== 0;

    var sub = $('preflight-sub');
    if (sub) {
      if (blocking.length > 0) {
        sub.textContent = '有 ' + blocking.length + ' 个问题会阻止启动。按下面的按钮修复，或先不启动。';
      } else if (warnings.length > 0) {
        sub.textContent = '可以启动，但有 ' + warnings.length + ' 个问题建议先处理。';
      } else {
        sub.textContent = '体检通过。';
      }
    }

    // 「仍然启动」只在**有阻断但用户可能想硬来**时出现。
    // 注意：能自动修的阻断（download-java）后端会直接放行，不会走到这里。
    var launchBtn = $('preflight-launch');
    if (launchBtn) launchBtn.hidden = blocking.length === 0;

    return report;
  }

  // ───────────────────────────── 修复动作 ─────────────────────────────

  var FIX_LOG_LABEL = {
    'download-java': '下载 Java',
    'install-version': '安装版本',
    'install-loader': '装模组加载器',
    'raise-memory': '调整内存',
    'remove-duplicate-mod': '清理重复 mod',
    'rescan-files': '重新校验文件'
  };

  function setBusy(button, busy, label) {
    state.busy = busy;
    if (!button) return;
    button.classList.toggle('is-busy', busy);
    button.disabled = busy;
    if (label !== undefined) button.textContent = label;
  }

  function showFixError(item, text) {
    if (!item) return;
    var old = item.querySelector('.pf-fix-error');
    if (old) old.parentNode.removeChild(old);
    if (!text) return;
    item.appendChild(el('div', 'pf-fix-error', text));
  }

  /** 修复完成后的统一收尾：重跑一次体检，让用户看到结果 */
  function afterFix(okText) {
    toast(okText, true);
    appendLog(okText);
    return runCheck(state.versionId, state.instanceId, { silent: true }).then(function (report) {
      if (report) renderReport(report);
      return report;
    });
  }

  /**
   * 执行某条问题的修复。
   *
   * 每条分支都只做「最少够用」的事，然后交给 afterFix 重跑体检 ——
   * 不给用户「以为修好了其实没修」的错觉。
   */
  function runFix(issue, button, item) {
    if (state.busy) return;
    var fix = issue.fix;
    if (!fix) return;

    var args = fix.args || {};
    var label = FIX_LOG_LABEL[fix.kind] || '修复';
    showFixError(item, '');
    setBusy(button, true, '处理中…');
    appendLog('体检修复：' + label + '（' + (issue.title || '') + '）');

    var task;

    switch (fix.kind) {
      case 'download-java':
        // Java 的下载由启动链路自己完成（GameLauncher → JavaAutoProvisioner）。
        // 这里不额外触发下载：用户点这个按钮的意思是「那就启动吧」。
        task = afterFix('启动时会自动下载 Java，正在重新检查…');
        break;

      case 'install-version':
      case 'rescan-files': {
        var vid = String(args.versionId || state.versionId);
        task = api('/api/install', { method: 'POST', body: { versionId: vid }, timeoutMs: 20000 }).then(
          function (data) {
            appendLog('已提交安装任务 ' + (data && data.jobId ? data.jobId : '') + '，可在任务面板查看进度');
            toast('已开始' + (fix.kind === 'rescan-files' ? '重新校验并补齐文件' : '安装 ' + vid), true);
            return null;
          }
        );
        break;
      }

      case 'install-loader':
        // 装加载器要用户选 Fiber/Quilt + 版本，不能替他决定：打开既有弹窗就好
        closeModal();
        if (typeof window.openLoaderModal === 'function') {
          window.openLoaderModal(String(args.versionId || state.versionId));
        } else {
          var host = document.querySelector('[data-loader-entry]');
          if (host) host.click();
          else toast('请点版本卡片上的「装模组加载器」');
        }
        return;

      case 'raise-memory': {
        var target = Number(args.memoryMB);
        var id = state.instanceId || state.versionId;
        task = api('/api/instances/' + encodeURIComponent(id) + '/settings', {
          method: 'PUT',
          body: { memoryMB: Number.isFinite(target) ? target : 2048 },
          timeoutMs: 20000
        }).then(function () {
          return afterFix('内存已改为 ' + String(target) + ' MB');
        });
        break;
      }

      case 'remove-duplicate-mod': {
        var instance = state.instanceId || state.versionId;
        var filenames = String(args.remove || '')
          .split('|')
          .filter(function (s) {
            return s.length > 0;
          });
        if (filenames.length === 0) {
          setBusy(button, false, fix.label || '一键修复');
          showFixError(item, '这条问题没带需要删除的文件名，无法自动处理。请到「已装模组」里手动删。');
          return;
        }
        task = filenames
          .reduce(function (chain, filename) {
            return chain.then(function () {
              return api(
                '/api/instances/' +
                  encodeURIComponent(instance) +
                  '/mods/' +
                  encodeURIComponent(filename).replace(/%2F/gi, '/'),
                { method: 'DELETE', timeoutMs: 20000 }
              ).then(function () {
                appendLog('已删除重复 mod：' + filename);
              });
            });
          }, Promise.resolve())
          .then(function () {
            return afterFix('已清理 ' + filenames.length + ' 个重复 mod');
          });
        break;
      }

      default:
        setBusy(button, false, fix.label || '一键修复');
        showFixError(item, '这个修复动作前端还不认识（' + String(fix.kind) + '），请手动处理。');
        return;
    }

    task
      .then(function (report) {
        // afterFix 已经在内部重跑过体检；这里只负责收尾按钮状态
        if (report === null || report === undefined) {
          // 安装类修复拿不到 report，重跑一次让按钮/列表刷新
          return runCheck(state.versionId, state.instanceId, { silent: true }).then(function (r) {
            if (r) renderReport(r);
          });
        }
        return undefined;
      })
      .catch(function (error) {
        showFixError(item, '修复失败：' + messageOf(error));
        appendLog('修复失败：' + messageOf(error), 'error');
      })
      .finally(function () {
        setBusy(button, false, fix.label || '一键修复');
      });
  }

  // ───────────────────────────── 体检入口 ─────────────────────────────

  /**
   * 跑一次体检。
   *
   * @param silent true 时不开弹窗、不显示 loading（用于修复后刷新报告）
   * @returns 报告；连不上后端时返回 null（绝不抛错打断启动）
   */
  function runCheck(versionId, instanceId, opts) {
    var options = opts || {};
    var body = { versionId: versionId };
    if (instanceId) body.instanceId = instanceId;

    if (!options.silent) {
      if (!openModal('启动前体检：' + versionId)) return Promise.resolve(null);
    }

    return api('/api/preflight', { method: 'POST', body: body, timeoutMs: 15000 })
      .then(function (report) {
        appendLog(
          '体检 ' +
            versionId +
            '：' +
            (report.blocking && report.blocking.length ? report.blocking.length + ' 个阻断，' : '') +
            (report.warnings && report.warnings.length ? report.warnings.length + ' 个警告' : '') +
            (report.blocking && report.blocking.length === 0 && (!report.warnings || report.warnings.length === 0)
              ? '通过'
              : '') +
            '（' +
            (report.elapsedMs || 0) +
            ' ms）',
          report.blocking && report.blocking.length ? 'warn' : 'info'
        );
        return report;
      })
      .catch(function (error) {
        // 体检接口都连不上：不拦启动，如实记一笔
        appendLog('体检请求失败（不影响启动）：' + messageOf(error), 'warn');
        if (!options.silent) setError('体检请求失败：' + messageOf(error) + '。可以关掉这个窗口直接启动。');
        return null;
      });
  }

  /**
   * 「点启动」的统一入口 —— 由 app.js 调用。
   *
   * @param opts.versionId  版本 id
   * @param opts.instanceId 实例 id（可选）
   * @param opts.onLaunch   真正执行启动的回调；体检通过 / 只有警告 / 阻断可自动修时调用
   */
  function guardLaunch(opts) {
    var options = opts || {};
    var versionId = String(options.versionId || '');
    var instanceId = String(options.instanceId || '');
    if (!versionId) return Promise.resolve(false);

    state.versionId = versionId;
    state.instanceId = instanceId;
    state.onForceLaunch = typeof options.onLaunch === 'function' ? options.onLaunch : null;

    return runCheck(versionId, instanceId, { silent: false }).then(function (report) {
      if (report === null) {
        // 体检不可用 → 不拦，走老路
        closeModal();
        if (state.onForceLaunch) state.onForceLaunch();
        return true;
      }
      renderReport(report);

      var blocking = report.blocking || [];
      var autoFixable = blocking.filter(function (issue) {
        return issue.fix && issue.fix.kind === 'download-java';
      });
      var unfixable = blocking.filter(function (issue) {
        return !(issue.fix && issue.fix.kind === 'download-java');
      });

      if (unfixable.length > 0) {
        // 有修不了的阻断：留在弹窗里让用户处理，绝不进游戏
        appendLog('体检未通过，已阻止启动：' + unfixable.map(function (i) {
          return i.title;
        }).join('；'), 'warn');
        return false;
      }

      if (blocking.length > 0 && autoFixable.length > 0) {
        appendLog('体检发现 ' + autoFixable.length + ' 个可自动处理的问题（Java 会在启动时自动下载）');
      } else if ((report.warnings || []).length > 0) {
        toast('体检有 ' + report.warnings.length + ' 个警告，仍会启动');
      }

      closeModal();
      if (state.onForceLaunch) state.onForceLaunch();
      return true;
    });
  }

  /**
   * 直接展示一份**已有的**报告（不重新请求体检）。
   *
   * 用途：前端先发 `/api/launch`，后端体检拦下时回 409 + 完整报告。
   * 这时报告已经拿到手了，再跑一次 `/api/preflight` 是白费一次 IO，
   * 而且两次体检之间用户可能刚改过东西 —— 展示后端真正拦下他的那份才是对的。
   *
   * @param report    后端 409 body 里的 `preflight`
   * @param opts.versionId / opts.instanceId / opts.onLaunch
   */
  function explain(report, opts) {
    var options = opts || {};
    if (!report || typeof report !== 'object') return false;
    state.versionId = String(options.versionId || '');
    state.instanceId = String(options.instanceId || '');
    state.onForceLaunch = typeof options.onLaunch === 'function' ? options.onLaunch : null;

    if (!openModal('启动前体检：' + (state.versionId || ''))) return false;
    renderReport(report);
    return true;
  }

  // ───────────────────────────── 事件绑定 ─────────────────────────────

  function bind() {
    var close = $('preflight-close');
    if (close) close.addEventListener('click', closeModal);

    var cancel = $('preflight-cancel');
    if (cancel) cancel.addEventListener('click', closeModal);

    var backdrop = $('preflight-modal');
    if (backdrop) {
      backdrop.addEventListener('click', function (event) {
        if (event.target === backdrop) closeModal();
      });
    }

    var launch = $('preflight-launch');
    if (launch) {
      launch.addEventListener('click', function () {
        closeModal();
        if (state.onForceLaunch) state.onForceLaunch();
      });
    }

    autoOpenFromQuery();
  }

  /**
   * 调试/取证钩子：URL 带 `?pf=1.21` 时，页面加载后自动跑一次体检并弹窗。
   *
   * 为什么要有：截图与人工验收都需要「不点任何按钮就看到弹窗」。
   * 只在显式带参数时生效，正常访问（无参数）**完全不受影响**。
   * 只接受形如 `?pf=<versionId>`；非法 id 直接忽略，不拼进任何请求路径之外的地方。
   */
  function autoOpenFromQuery() {
    var raw = '';
    try {
      raw = new URLSearchParams(window.location.search).get('pf') || '';
    } catch (e) {
      return;
    }
    if (raw.length === 0) return;
    // 只允许版本 id 允许的字符，避免把奇怪的串塞进请求
    if (!/^[A-Za-z0-9._+-]{1,64}$/.test(raw)) return;
    setTimeout(function () {
      runCheck(raw, '', { silent: false }).then(function (report) {
        if (report) renderReport(report);
      });
    }, 250);
  }

  // ───────────────────────────── 对外 ─────────────────────────────

  window.pcl3Preflight = {
    /** 跑一次体检并渲染报告（不改启动流程） */
    check: function (versionId, instanceId) {
      return runCheck(String(versionId || ''), instanceId ? String(instanceId) : '', { silent: false });
    },
    /** 「点启动」闸门：体检通过才调 onLaunch */
    guardLaunch: guardLaunch,
    /** 展示一份已有的报告（后端 409 时用，不重新请求） */
    explain: explain,
    /** 关掉弹窗（别的模块切换视图时用） */
    close: closeModal,
    /** 当前报告（调试 / 其它模块复用） */
    report: function () {
      return state.report;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
