/**
 * 整合包（.mrpack）前端：导入 → 上传 → 预览 → 确认安装。
 *
 * 约束：纯原生 JS，零依赖、零 CDN、零构建；与 app.js 用 window.pcl3OnModpackJob 对接。
 *
 * 与 app.js 的分工：
 *   app.js   负责顶栏、版本列表、任务面板、日志、账户；整合包任务结束时它会回调本文件
 *   本文件    负责整合包区域：文件选择、上传、解析结果卡片、实例名、安装提交、已装列表
 *
 * 三条原则（沿用 app.js 的踩坑经验）：
 *   1. 任何失败都要写进界面（页脚 + 卡片里的错误行），不许停在「处理中…」
 *   2. 上传用 XHR 而不是 fetch —— 只有 XHR 能拿到上传进度（500 MB 的包不显示进度＝假死）
 *   3. 解析结果必须**先给人看、再安装**：装错包要重装几百 MB，确认一步值得
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

  /** 把任意错误翻成人话（与服务端 `{ error, hint }` 约定对齐） */
  function messageOf(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    var text = error.message ? String(error.message) : String(error);
    return text;
  }

  /** 字节数 → 人话（与服务端 formatBytes 同口径，避免同一个数两边显示不一样） */
  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var value = n;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return (value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[i];
  }

  /** 上传上限（与服务端 MODPACK_UPLOAD_LIMIT_BYTES 一致；前端先拦一道，省一次无效上传） */
  var MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

  var LOADER_LABEL = {
    fabric: 'Fabric',
    quilt: 'Quilt',
    forge: 'Forge',
    neoforge: 'NeoForge'
  };

  /** 整合包区域的全部状态 */
  var state = {
    /** 已上传并解析好的整合包（等待用户确认安装） */
    pending: null,
    /** 当前上传/解析/安装共用的任务 id，用于防重复点击 */
    jobId: null,
    busy: false,
    /** 已装整合包（从 pcl3-modpack.json 读不到，只能由本次会话记录 + 刷新时扫） */
    installed: [],
    uploadXhr: null
  };

  // ───────────────────────────── 错误 / 状态展示 ─────────────────────────────

  function showError(text, sticky) {
    if (typeof window.pcl3ShowError === 'function') {
      window.pcl3ShowError(text, sticky);
      return;
    }
    var node = $('footer-error');
    if (!node) return;
    node.textContent = '⚠ ' + text;
    node.hidden = false;
  }

  function toast(text, ok) {
    if (typeof window.pcl3Toast === 'function') {
      window.pcl3Toast(text, ok);
      return;
    }
    var node = el('div', ok === true ? 'toast is-ok' : 'toast', text);
    document.body.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 6000);
  }

  function appendLog(text, level) {
    if (typeof window.pcl3AppendLog === 'function') window.pcl3AppendLog(text, level);
  }

  /** 任务面板画一条进度（app.js 的 renderJob 负责细节；这里只保证它能被调起来） */
  function renderJob(job) {
    if (typeof window.pcl3RenderJob === 'function') window.pcl3RenderJob(job);
  }

  /**
   * 把落盘路径转成可选中的实体文件名。
   *
   * 浏览器安全限制：`<input type=file>` 的 `value` 只能由用户操作设置，
   * 脚本给它赋值会被忽略 —— 所以「路径输入框」实际是 text，配一个隐藏的 file input，
   * 用户点完文件后我们从 `files[0].name` 取到名字写进去。
   * 这里只负责把名字写回可见输入框，路径本身仍以 text 框的值为准（用户可以手输）。
   */
  function rememberPickedName(picked) {
    var box = $('modpack-path');
    if (box && picked && picked.name) box.value = picked.name;
  }

  function cardError(text) {
    var node = $('modpack-error');
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.hidden = true;
      node.textContent = '';
    }
  }

  function setStatus(text, cls) {
    var badge = $('modpack-status');
    if (!badge) return;
    badge.textContent = text;
    badge.className = 'badge ' + (cls || 'badge-running');
  }

  // ───────────────────────────── 上传 ─────────────────────────────

  function openFilePicker() {
    var input = $('modpack-file');
    if (!input) return;
    // 清空 value：否则连续选同一个文件不会触发 change
    input.value = '';
    input.click();
  }

  function onFileChosen(event) {
    var input = event.target;
    var file = input && input.files ? input.files[0] : null;
    if (!file) return;

    if (!/\.mrpack$/i.test(file.name)) {
      // 不硬拦：有些包被重命名为 .zip，服务端会如实拒绝并说明原因。
      // 但先提醒一句，避免用户上传一个几百 MB 的无关文件。
      if (!/\.zip$/i.test(file.name)) {
        showError('「' + file.name + '」看起来不是 .mrpack 整合包（扩展名不对）。', true);
      }
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showError('文件太大：' + formatBytes(file.size) + '，上限 ' + formatBytes(MAX_UPLOAD_BYTES) + '。', true);
      return;
    }

    uploadPack(file);
  }

  /**
   * 用 XHR 上传（只有它能拿到上传进度）。
   *
   * 服务端约定：POST /api/modpack/upload?name=xxx，body 是二进制，回 202 + jobId。
   */
  function uploadPack(file) {
    if (state.busy) return;
    state.busy = true;

    showPreviewShell(file.name);
    setStatus('上传中 0%', 'badge-running');
    cardError('');
    appendLog('开始上传整合包：' + file.name + '（' + formatBytes(file.size) + '）');

    var xhr = new XMLHttpRequest();
    state.uploadXhr = xhr;
    xhr.open('POST', '/api/modpack/upload?name=' + encodeURIComponent(file.name), true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    if (xhr.upload) {
      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        var percent = Math.round((ev.loaded / ev.total) * 100);
        setStatus('上传中 ' + percent + '%', 'badge-running');
        var note = $('modpack-note');
        if (note) {
          note.hidden = false;
          note.textContent = '已上传 ' + formatBytes(ev.loaded) + ' / ' + formatBytes(ev.total);
        }
      };
    }

    xhr.onload = function () {
      state.busy = false;
      state.uploadXhr = null;
      var data = null;
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch (e) {
        data = null;
      }

      if (xhr.status !== 200 && xhr.status !== 202) {
        var detail = data && data.error ? data.error : 'HTTP ' + xhr.status;
        var hint = data && data.hint ? '\n' + data.hint : '';
        failPreview('上传失败：' + detail + hint);
        return;
      }
      if (!data || !data.jobId) {
        failPreview('上传失败：服务器没有返回任务号。');
        return;
      }

      appendLog('上传完成，正在解析清单…（任务 ' + data.jobId + '）');
      setStatus('解析中…', 'badge-running');
      state.jobId = data.jobId;
      state.pending = { filePath: data.filePath, name: file.name, displayName: file.name };
      pollJob(data.jobId);
    };

    xhr.onerror = function () {
      state.busy = false;
      state.uploadXhr = null;
      failPreview('上传失败：连不上本地服务，请确认 pcl3 web 还在运行。');
    };

    xhr.onabort = function () {
      state.busy = false;
      state.uploadXhr = null;
      failPreview('上传已取消。');
    };

    xhr.send(file);
  }

  /** 轮询任务直到终态；解析/安装共用 */
  function pollJob(jobId) {
    var delay = 400;
    var logOffset = 0;

    var tick = function () {
      fetch('/api/jobs/' + encodeURIComponent(jobId) + '?since=' + logOffset, { headers: { Accept: 'application/json' } })
        .then(function (res) {
          return res.text().then(function (text) {
            var data = null;
            try {
              data = JSON.parse(text);
            } catch (e) {
              data = null;
            }
            if (!res.ok) {
              var detail = data && data.error ? data.error : 'HTTP ' + res.status;
              throw new Error(detail);
            }
            return data || {};
          });
        })
        .then(function (job) {
          var lines = Array.isArray(job.log) ? job.log : [];
          lines.forEach(function (line) {
            appendLog(line.text, line.level);
          });
          var base = typeof job.logOffset === 'number' ? job.logOffset : 0;
          logOffset = base + lines.length;

          // 任务面板由 app.js 画（进度条 / 阶段 / 计数），这里只补整合包卡片上的状态
          renderJob(job);
          if (job.status === 'running') {
            if (job.phase === 'parse') setStatus('解析中…', 'badge-running');
            else setStatus(PHASE_LABEL[job.phase] || '安装中…', 'badge-running');
            delay = 700;
            setTimeout(tick, delay);
            return;
          }

          if (job.status === 'done') {
            onJobDone(job);
          } else {
            onJobFailed(job);
          }
        })
        .catch(function (error) {
          if (error && error.status === 404) {
            failPreview('任务记录已过期（服务端只保留 10 分钟），请重新上传。');
            return;
          }
          appendLog('轮询失败，稍后重试：' + messageOf(error), 'warn');
          delay = Math.min(6000, Math.round(delay * 1.8));
          setTimeout(tick, delay);
        });
    };

    tick();
  }

  var PHASE_LABEL = {
    plan: '检查清单',
    parse: '解析清单',
    vanilla: '安装原版',
    loader: '安装加载器',
    mods: '下载 mod',
    overrides: '解压覆盖',
    done: '完成',
    failed: '失败'
  };

  function onJobDone(job) {
    var result = job.result || {};
    state.busy = false;
    state.jobId = null;

    // 解析结果：有 files 统计就说明这是上传解析任务
    if (result && typeof result.files === 'object' && result.files !== null && !result.instanceId) {
      state.pending = {
        filePath: result.filePath || (state.pending ? state.pending.filePath : ''),
        name: result.name || '整合包',
        summary: result
      };
      renderPreview(result);
      appendLog('解析完成：' + String(result.name || '') + '，确认后点「确认安装」。');
      toast('解析完成：' + String(result.name || '整合包'), true);
      return;
    }

    // 安装结果：有 instanceId
    if (result && result.instanceId) {
      setStatus('已安装', 'badge-done');
      var extra = [];
      if (result.versionId) extra.push('启动版本 ' + result.versionId);
      if (result.gameVersion) extra.push('游戏 ' + result.gameVersion);
      var note = $('modpack-note');
      if (note) {
        note.hidden = false;
        note.textContent =
          '安装完成：' +
          String(result.instanceId) +
          (extra.length ? '（' + extra.join('，') + '）' : '') +
          '。版本列表里已经能看到了。';
      }
      appendLog('整合包装好了：实例 ' + result.instanceId + '，启动版本 ' + (result.versionId || '?'));
      toast('整合包装好了：' + String(result.instanceId), true);
      state.pending = null;
      state.installed.push({
        instanceId: result.instanceId,
        versionId: result.versionId,
        gameVersion: result.gameVersion,
        loader: result.loader || null,
        at: Date.now()
      });
      renderInstalled();
    }
  }

  function onJobFailed(job) {
    state.busy = false;
    state.jobId = null;
    var text = job.error || '任务失败';
    failPreview(text);
    showError(text, true);
    appendLog('整合包任务失败：' + text, 'error');
  }

  /** app.js 在任务结束时回调这里（它负责顶栏与版本列表刷新，UI 细节交给我们） */
  window.pcl3OnModpackJob = function (job) {
    if (!job) return;
    if (job.status === 'done') onJobDone(job);
    else if (job.status === 'failed') onJobFailed(job);
  };

  // ───────────────────────────── 预览卡片 ─────────────────────────────

  function showPreviewShell(fileName) {
    var card = $('modpack-preview');
    if (!card) return;
    card.hidden = false;
    var empty = $('modpack-empty');
    if (empty) empty.hidden = true;

    $('modpack-name').textContent = fileName || '整合包';
    $('modpack-sub').textContent = '正在上传并解析…';
    ['modpack-game', 'modpack-loader', 'modpack-mods', 'modpack-size', 'modpack-overrides', 'modpack-skipped'].forEach(function (id) {
      $(id).textContent = '—';
    });
    var note = $('modpack-note');
    if (note) {
      note.hidden = true;
      note.textContent = '';
    }
    var install = $('btn-modpack-install');
    if (install) install.disabled = true;
    cardError('');
  }

  function failPreview(text) {
    state.busy = false;
    setStatus('失败', 'badge-failed');
    cardError(text);
    showError(text, true);
  }

  /** 把服务端摘要渲染成「确认安装」卡片 */
  function renderPreview(summary) {
    var card = $('modpack-preview');
    if (!card) return;
    card.hidden = false;

    $('modpack-name').textContent = String(summary.name || '未命名整合包');
    var subParts = [];
    if (summary.versionId) subParts.push('版本 ' + summary.versionId);
    if (summary.fileSize) subParts.push('整合包 ' + formatBytes(summary.fileSize));
    if (summary.entryCount) subParts.push(summary.entryCount + ' 个 zip 条目');
    $('modpack-sub').textContent = subParts.join(' · ') || '—';

    var gameVersion = summary.gameVersion || null;
    $('modpack-game').textContent = gameVersion ? String(gameVersion) : '未声明';

    var loader = summary.loader;
    var loaderText = '原版（无加载器）';
    if (loader) {
      var label = loader.label || LOADER_LABEL[loader.kind] || loader.kind;
      loaderText = label + ' ' + loader.version;
      if (loader.supported === false) {
        loaderText += '（本启动器暂不支持）';
      }
    }
    $('modpack-loader').textContent = loaderText;

    var files = summary.files || {};
    var modCount = typeof files.client === 'number' ? files.client : 0;
    $('modpack-mods').textContent = modCount + ' 个（共 ' + String(files.total || 0) + ' 条清单）';

    // totalBytes 是所有客户端文件的 fileSize 之和；有文件缺 fileSize 时只是下限
    $('modpack-size').textContent = formatBytes(summary.totalBytes || 0);

    var overrides = summary.overrides || {};
    $('modpack-overrides').textContent = String(overrides.total || 0) + ' 个';

    var skipped = typeof files.skipped === 'number' ? files.skipped : 0;
    $('modpack-skipped').textContent = skipped + ' 个（服务端专用，客户端不装）';

    var note = $('modpack-note');
    if (note) {
      var notes = [];
      if (!gameVersion) {
        notes.push('这个包没有声明 minecraft 依赖，安装时会因为不知道装哪个游戏版本而中止。');
      }
      if (loader && loader.supported === false) {
        notes.push('它需要 ' + (LOADER_LABEL[loader.kind] || loader.kind) + ' 加载器，本启动器只支持 Fabric / Quilt，装了也启动不了，请换一个包。');
      }
      if (skipped > 0) {
        notes.push('有 ' + skipped + ' 个文件标记为「仅服务端」，装进客户端会导致崩溃，已自动跳过。');
      }
      if (summary.summary) notes.push(String(summary.summary));
      note.textContent = notes.join('\n');
      note.hidden = notes.length === 0;
    }

    // 实例名默认填整合包名（服务端还会再校验一次非法字符）
    var nameInput = $('modpack-instance');
    if (nameInput && !nameInput.value) nameInput.value = String(summary.name || '');

    var install = $('btn-modpack-install');
    if (install) {
      var blocked = !gameVersion || (loader && loader.supported === false);
      install.disabled = blocked;
      install.title = blocked ? '这个整合包缺少必要信息或需要不支持的加载器，无法安装' : '';
    }
    setStatus('待确认', 'badge-running');
    cardError('');
  }

  // ───────────────────────────── 安装 ─────────────────────────────

  function submitInstall() {
    if (state.busy) return;
    var pending = state.pending;
    if (!pending || !pending.filePath) {
      cardError('没有待安装的整合包，请先「导入整合包」。');
      return;
    }

    var nameInput = $('modpack-instance');
    var instanceName = nameInput ? nameInput.value.trim() : '';

    state.busy = true;
    var button = $('btn-modpack-install');
    if (button) {
      button.disabled = true;
      button.textContent = '安装中…';
    }
    setStatus('安装中…', 'badge-running');
    cardError('');
    appendLog('开始安装整合包到实例「' + (instanceName || pending.name) + '」…');

    fetch('/api/modpack/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ filePath: pending.filePath, instanceName: instanceName })
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = null;
          }
          if (!res.ok) {
            var detail = data && data.error ? data.error : 'HTTP ' + res.status;
            var hint = data && data.hint ? '\n' + data.hint : '';
            var err = new Error(detail + hint);
            err.status = res.status;
            throw err;
          }
          return data || {};
        });
      })
      .then(function (data) {
        if (!data.jobId) throw new Error('服务器没有返回任务号。');
        state.jobId = data.jobId;
        appendLog('整合包安装任务已创建：' + data.jobId);
        pollJob(data.jobId);
      })
      .catch(function (error) {
        state.busy = false;
        if (button) {
          button.disabled = false;
          button.textContent = '确认安装';
        }
        var text = '提交安装失败：' + messageOf(error);
        if (error && error.status === 409) {
          text += '\n（已经有一个安装任务在跑，等它结束再来。）';
        }
        cardError(text);
        showError(text, true);
        appendLog(text, 'error');
      });
  }

  function discardPreview() {
    if (state.uploadXhr) {
      try {
        state.uploadXhr.abort();
      } catch (e) {
        /* ignore */
      }
      state.uploadXhr = null;
    }
    state.pending = null;
    state.busy = false;
    state.jobId = null;

    var card = $('modpack-preview');
    if (card) card.hidden = true;
    renderInstalled();

    var button = $('btn-modpack-install');
    if (button) {
      button.disabled = false;
      button.textContent = '确认安装';
    }
    appendLog('已取消整合包导入。');
  }

  // ───────────────────────────── 已装列表 ─────────────────────────────

  function renderInstalled() {
    var list = $('modpack-list');
    var empty = $('modpack-empty');
    if (!list) return;

    list.textContent = '';
    var items = state.installed || [];

    var previewOpen = $('modpack-preview') && !$('modpack-preview').hidden;
    if (empty) empty.hidden = items.length > 0 || previewOpen;

    items.forEach(function (item) {
      var li = el('li', 'modpack-item');
      var left = el('div');
      left.appendChild(el('div', 'modpack-item-name', String(item.instanceId)));
      var meta = [];
      if (item.gameVersion) meta.push('游戏 ' + item.gameVersion);
      if (item.versionId) meta.push('启动版本 ' + item.versionId);
      if (item.loader && item.loader.kind) {
        meta.push((LOADER_LABEL[item.loader.kind] || item.loader.kind) + ' ' + (item.loader.version || ''));
      }
      left.appendChild(el('div', 'modpack-item-meta', meta.join(' · ') || '—'));
      li.appendChild(left);

      var play = el('button', 'btn btn-play btn-sm', '启动');
      play.type = 'button';
      play.addEventListener('click', function () {
        if (typeof window.pcl3StartLaunch === 'function') {
          window.pcl3StartLaunch(item.versionId || item.instanceId);
        } else {
          showError('启动入口还没就绪，请刷新页面重试。', true);
        }
      });
      li.appendChild(play);

      list.appendChild(li);
    });
  }

  /** 从服务端重新读一遍当前会话记录的整合包（本会话之外装的看不到，这是如实行为） */
  function refreshInstalled() {
    if (!state.installed || state.installed.length === 0) {
      renderInstalled();
      toast('本次会话还没有装过整合包。', true);
      return;
    }
    renderInstalled();
  }

  // ───────────────────────────── 绑定 ─────────────────────────────

  function bind() {
    var importBtn = $('btn-modpack-import');
    if (importBtn) importBtn.addEventListener('click', openFilePicker);

    var fileInput = $('modpack-file');
    if (fileInput) fileInput.addEventListener('change', onFileChosen);

    var installBtn = $('btn-modpack-install');
    if (installBtn) installBtn.addEventListener('click', submitInstall);

    var discardBtn = $('btn-modpack-discard');
    if (discardBtn) discardBtn.addEventListener('click', discardPreview);

    var refreshBtn = $('btn-modpack-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshInstalled);

    // 浏览器原生支持拖放：把 .mrpack 直接拖进整合包区域也能导入
    var panel = $('modpack-panel');
    if (panel) {
      panel.addEventListener('dragover', function (event) {
        event.preventDefault();
        panel.classList.add('is-dragover');
      });
      panel.addEventListener('dragleave', function () {
        panel.classList.remove('is-dragover');
      });
      panel.addEventListener('drop', function (event) {
        event.preventDefault();
        panel.classList.remove('is-dragover');
        var files = event.dataTransfer && event.dataTransfer.files;
        var file = files && files.length ? files[0] : null;
        if (!file) return;
        onFileChosen({ target: { files: [file] } });
      });
    }

    renderInstalled();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  // 供 app.js 复用的小工具（不改变 app.js 的行为，只是让它能拿到同一套人话文案）
  window.pcl3Modpack = {
    formatBytes: formatBytes,
    state: state
  };
})();
