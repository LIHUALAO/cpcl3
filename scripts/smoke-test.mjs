#!/usr/bin/env node
/**
 * PCL3 全链路冒烟测试。
 *
 * 只做一件事：**把 Web 服务真的起起来，用真 HTTP 打一遍关键接口**，
 * 确认「UI → API → 后台任务」这条链是通的，而不是只在单元测试里通。
 *
 * 流程：
 *   1. 用 src/web/server.ts 的 createServer 起服务（端口 0 = 系统分配，绝不抢 37421）
 *   2. GET /api/status        断言 200 且返回 JSON
 *   3. GET /api/versions      断言返回非空数组
 *   4. GET /api/java          只看不判（没有 Java 不算失败，只打印）
 *   5. 若指定/自动识别到已装版本 → POST /api/install + 轮询 /api/jobs/:id
 *      断言任务最终状态 **不是 failed**（安装不完整时会在这里露馅）
 *   6. POST /api/launch       只验证到「任务创建 / 首轮 API 响应」层面，然后立刻放弃该任务，
 *      **绝不真的把游戏拉起来**（会弹窗口）。
 *
 * 用法：
 *   node scripts/smoke-test.mjs [--data-root PATH] [--version ID] [--skip-install] [--timeout MS]
 *
 * 退出码：0 = 全部 PASS（允许 SKIP），1 = 有 FAIL。
 *
 * 设计约束：不写任何文件（除了 install 自己下东西）；不改 src/。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

// ───────────────────────────── 参数 ─────────────────────────────

export const USAGE = `用法：node scripts/smoke-test.mjs [选项]

  --data-root PATH  数据目录，默认走 PCL3_DATA_ROOT / %APPDATA%\\PCL3 / ~/.pcl3
  --version ID      启动检查针对的版本；省略则自动取数据目录里第一个已装版本
  --skip-install    跳过 POST /api/install 那一段（只测只读接口 + 启动响应）
  --timeout MS      单步超时，默认 30000
  -h, --help        显示本说明

退出码：0 = PASS（可能有 SKIP），1 = 有 FAIL。`;

export function parseArgs(argv) {
  const out = {
    dataRoot: undefined,
    versionId: undefined,
    skipInstall: false,
    timeoutMs: 30_000,
    help: false,
    errors: [],
  };
  const takeValue = (arg, next, flags) => {
    if (next === undefined || next.startsWith('--')) {
      out.errors.push(`${arg} 后面要跟一个值。`);
      return undefined;
    }
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      out.help = true;
    } else if (arg === '--skip-install') {
      out.skipInstall = true;
    } else if (arg === '--data-root') {
      const v = takeValue(arg, argv[i + 1]);
      if (v !== undefined) {
        out.dataRoot = v;
        i += 1;
      }
    } else if (arg.startsWith('--data-root=')) {
      out.dataRoot = arg.slice('--data-root='.length);
    } else if (arg === '--version') {
      const v = takeValue(arg, argv[i + 1]);
      if (v !== undefined) {
        out.versionId = v;
        i += 1;
      }
    } else if (arg.startsWith('--version=')) {
      out.versionId = arg.slice('--version='.length);
    } else if (arg === '--timeout') {
      const v = takeValue(arg, argv[i + 1]);
      if (v !== undefined) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) out.errors.push(`--timeout 需要正数毫秒，收到 ${v}`);
        else out.timeoutMs = Math.floor(n);
        i += 1;
      }
    } else if (arg.startsWith('--timeout=')) {
      const n = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(n) || n <= 0) out.errors.push('--timeout 需要正数毫秒。');
      else out.timeoutMs = Math.floor(n);
    } else if (arg.startsWith('-')) {
      out.errors.push(`不认识的参数：${arg}`);
    } else {
      // 位置参数当 versionId 用，方便 `smoke-test.mjs 26.3`
      if (out.versionId === undefined) out.versionId = arg;
      else out.errors.push(`多余的参数：${arg}`);
    }
  }
  void path;
  void fileURLToPath;
  void existsSync;
  void readdirSync;
  return out;
}

// ───────────────────────────── 依赖装载 ─────────────────────────────

/**
 * 装载 src 下的 TypeScript 源码。
 *
 * 为什么要绕这一圈：这是 .mjs 脚本，Node 默认不认 `.ts` 入口，
 * 而仓库里源码是按 TS 规范写 `./foo.js` 指代 `./foo.ts` 的。
 * 运行时用 module.register 挂上仓库自带的 test/ts-resolve-hooks.mjs
 * （它只做 `.js` → `.ts` 的说明符重写），再用动态 import 拿 TypeScript 源码本身。
 * 好处：冒烟测试跑的是**源码**，不会因为 dist/ 过期而报假 PASS。
 */
async function loadServerModule() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hooksPath = path.join(repoRoot, 'test', 'ts-resolve-hooks.mjs');
  const { register } = await import('node:module');
  register(pathToFileHref(hooksPath), pathToFileHref(import.meta.url));
  return import(pathToFileHref(path.join(repoRoot, 'src', 'web', 'server.ts')));
}

function pathToFileHref(p) {
  const abs = path.resolve(p).replace(/\\/g, '/');
  return `file:///${abs.replace(/^\/+/, '')}`;
}

// ───────────────────────────── HTTP 小工具 ─────────────────────────────

class Checker {
  constructor() {
    this.results = [];
  }

  pass(name, detail) {
    this.results.push({ name, ok: true, skipped: false, detail });
    console.log(`  ✓ PASS  ${name}${detail ? `  —— ${detail}` : ''}`);
  }

  fail(name, detail) {
    this.results.push({ name, ok: false, skipped: false, detail });
    console.log(`  ✗ FAIL  ${name}${detail ? `  —— ${detail}` : ''}`);
  }

  skip(name, detail) {
    this.results.push({ name, ok: true, skipped: true, detail });
    console.log(`  - SKIP  ${name}${detail ? `  —— ${detail}` : ''}`);
  }

  get failed() {
    return this.results.filter((r) => !r.ok);
  }

  get skippedCount() {
    return this.results.filter((r) => r.skipped).length;
  }

  get passedCount() {
    return this.results.filter((r) => r.ok && !r.skipped).length;
  }
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

/** 发一个请求并把响应解析成 { status, json, text } */
async function call(baseUrl, method, pathname, body, timeoutMs) {
  const init = {
    method,
    signal: timeoutSignal(timeoutMs),
    headers: {
      // 只发 JSON，服务端对非 JSON 的写操作会直接 415（这是刻意的防 CSRF 设计）
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(new URL(pathname, baseUrl), init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

/** 轮询任务直到结束或超时 */
async function pollJob(baseUrl, jobId, timeoutMs, shouldAbort) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await call(baseUrl, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`, undefined, timeoutMs);
    if (res.status !== 200 || res.json === undefined) {
      return { status: 'http-error', httpStatus: res.status, body: res.text.slice(0, 300) };
    }
    last = res.json;
    if (last.status !== 'running') return last;
    if (shouldAbort?.()) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ...(last ?? {}), status: 'timeout' };
}

// ───────────────────────────── 主流程 ─────────────────────────────

export async function runSmokeTest(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const error = io.error ?? ((s) => process.stderr.write(`${s}\n`));
  void log;
  void error;
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) error(`错误：${e}`);
    error('');
    error(USAGE);
    return 2;
  }

  const check = new Checker();
  const started = Date.now();
  console.log('');
  console.log('═'.repeat(78));
  console.log('PCL3 全链路冒烟测试');
  console.log('═'.repeat(78));

  // ── 起服务 ─────────────────────────────────────────────────────
  let handle;
  let serverModule;
  try {
    serverModule = await loadServerModule();
  } catch (err) {
    console.error(`致命：无法装载 src/web/server.ts —— ${String(err?.message ?? err)}`);
    console.error('      多半是 tsc 没过或源码引用了不存在的模块。先跑 tsc 再试。');
    return 2;
  }

  const dataRoot = path.resolve(args.dataRoot ?? (serverModule.dataRootForSmoke ?? defaultRoot()));
  console.log(`数据目录 ：${dataRoot}`);
  try {
    handle = await serverModule.createServer({ port: 0, ...(args.dataRoot ? { dataRoot } : {}) });
  } catch (err) {
    console.error(`致命：Web 服务起不来 —— ${String(err?.message ?? err)}`);
    return 2;
  }
  console.log(`服务地址 ：${handle.url}（仅本机回环）`);
  console.log('');

  const base = handle.url;
  const t = args.timeoutMs;

  try {
    // ── 1) /api/status ───────────────────────────────────────────
    try {
      const r = await call(base, 'GET', '/api/status', undefined, t);
      if (r.status === 200 && r.json !== undefined) {
        check.pass('GET /api/status → 200 JSON', `版本数 ${String(r.json.versionCount ?? '?')}，latest ${String(r.json.latestRelease ?? '?')}`);
        if (Array.isArray(r.json.installedVersions)) {
          check.pass('status.installedVersions 是数组', `[${r.json.installedVersions.join(', ')}]`);
        } else {
          check.fail('status.installedVersions 是数组', '字段缺失或不是数组');
        }
      } else {
        check.fail('GET /api/status → 200 JSON', `实际 HTTP ${String(r.status)}，body=${r.text.slice(0, 200)}`);
      }
    } catch (err) {
      check.fail('GET /api/status', String(err?.message ?? err));
    }

    // ── 2) /api/versions ─────────────────────────────────────────
    try {
      const r = await call(base, 'GET', '/api/versions', undefined, t);
      const list = r.json?.versions;
      if (r.status === 200 && Array.isArray(list) && list.length > 0) {
        check.pass('GET /api/versions → 非空数组', `${String(list.length)} 条（总 ${String(r.json?.total ?? '?')}）`);
      } else if (r.status === 200 && Array.isArray(list)) {
        // 空数组但接口本身正常：多半是离线且无缓存，不该判 PASS
        check.fail('GET /api/versions → 非空数组', '返回了空数组（离线？meta 缓存缺失？）');
      } else {
        check.fail('GET /api/versions', `实际 HTTP ${String(r.status)}，body=${r.text.slice(0, 200)}`);
      }
    } catch (err) {
      check.fail('GET /api/versions', String(err?.message ?? err));
    }

    // ── 3) /api/java（只看不判） ─────────────────────────────────
    let javaMajor = null;
    try {
      const r = await call(base, 'GET', '/api/java', undefined, t);
      if (r.status === 200 && r.json !== undefined) {
        javaMajor = r.json.majorVersion;
        check.pass('GET /api/java → 200', r.json.found ? `找到 Java ${String(javaMajor ?? '?')}` : '未找到 Java（不影响本次冒烟）');
      } else {
        check.fail('GET /api/java → 200', `实际 HTTP ${String(r.status)}`);
      }
    } catch (err) {
      check.fail('GET /api/java', String(err?.message ?? err));
    }

    // ── 4) 静态资源（前端那个 app.js 白屏事故的回归点） ──────────
    try {
      const res = await fetch(new URL('/app.js', base), { signal: timeoutSignal(t) });
      if (res.ok) {
        const body = await res.text();
        if (body.length > 0) check.pass('GET /app.js → 200 非空', `${String(body.length)} 字节`);
        else check.fail('GET /app.js → 200 非空', '拿到了 0 字节');
      } else {
        check.fail('GET /app.js', `HTTP ${String(res.status)}`);
      }
    } catch (err) {
      check.fail('GET /app.js', String(err?.message ?? err));
    }

    // ── 5) 选版本 ────────────────────────────────────────────────
    const installed = existsSync(path.join(dataRoot, 'versions'))
      ? readdirSync(path.join(dataRoot, 'versions')).filter((n) =>
          existsSync(path.join(dataRoot, 'versions', n, `${n}.json`)),
        )
      : [];
    const versionId = args.versionId ?? installed[0];
    if (versionId === undefined) {
      check.skip('版本相关检查', `数据目录下没有已装版本（${path.join(dataRoot, 'versions')}）`);
    } else {
      const isInstalled = installed.includes(versionId);
      console.log('');
      console.log(`目标版本 ：${versionId}${isInstalled ? '（已安装）' : '（未安装）'}`);

      // ── 5a) install：真正的假成功探测器 ──────────────────────
      if (args.skipInstall) {
        check.skip('POST /api/install 全流程', '--skip-install');
      } else if (!isInstalled) {
        check.skip('POST /api/install 全流程', `版本 ${versionId} 未安装，跳过（避免联网下载几个 GB）`);
      } else {
        try {
          const r = await call(base, 'POST', '/api/install', { versionId }, t);
          if (r.status === 202 && typeof r.json?.jobId === 'string') {
            check.pass('POST /api/install → 202 + jobId', r.json.jobId);
            const snap = await pollJob(base, r.json.jobId, Math.max(t, 120_000));
            if (snap.status === 'done') {
              check.pass('install job → done', `phase=${String(snap.phase)} ${String(snap.done)}/${String(snap.total)}`);
            } else if (snap.status === 'failed') {
              check.fail('install job → done（不是 failed）', `失败原因：${String(snap.error ?? '(未提供)')}`);
            } else {
              check.fail('install job → done', `最终状态 ${String(snap.status)}`);
            }
          } else {
            check.fail('POST /api/install → 202 + jobId', `实际 HTTP ${String(r.status)}，body=${r.text.slice(0, 200)}`);
          }
        } catch (err) {
          check.fail('POST /api/install 全流程', String(err?.message ?? err));
        }
      }

      // ── 5b) launch：只测到任务创建/首轮响应，不等游戏 ────────
      try {
        const r = await call(base, 'POST', '/api/launch', { versionId, username: 'SmokeTest' }, t);
        if (r.status === 202 && typeof r.json?.jobId === 'string') {
          // 只取一次快照就放弃：绝不能等游戏进程起来（会弹窗口）
          const snap = await pollJob(base, r.json.jobId, 1_000, () => true);
          const observed = snap?.status ?? 'unknown';
          if (observed === 'failed') {
            check.fail('POST /api/launch → 202', `任务立刻失败：${String(snap?.error ?? '(无错误信息)')}`);
          } else {
            check.pass(
              'POST /api/launch → 202 + jobId（未真正启动游戏）',
              `jobId=${r.json.jobId}，首轮 phase=${String(snap?.phase ?? '?')} status=${observed}`,
            );
          }
        } else if (r.status === 400 || r.status === 409) {
          check.skip('POST /api/launch', `接口按预期拒绝（HTTP ${String(r.status)}）：${String(r.json?.error ?? '')}`);
        } else {
          check.fail('POST /api/launch → 202', `实际 HTTP ${String(r.status)}，body=${r.text.slice(0, 200)}`);
        }
      } catch (err) {
        check.fail('POST /api/launch', String(err?.message ?? err));
      }
    }
  } finally {
    // 无条件关服务；jobs.clear() 里会一并断掉后台任务与端口
    try {
      await handle.close();
    } catch {
      /* 关不掉也别把结果盖掉 */
    }
  }

  // ── 汇总 ─────────────────────────────────────────────────────
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log('─'.repeat(78));
  console.log(
    `汇总：PASS ${String(check.passedCount)} / SKIP ${String(check.skippedCount)} / FAIL ${String(check.failed.length)}` +
      `（耗时 ${elapsed}s，数据目录 ${dataRoot}）`,
  );
  if (check.failed.length > 0) {
    console.log('');
    for (const f of check.failed) console.log(`  ✗ ${f.name} —— ${f.detail ?? ''}`);
    console.log('');
    console.log('结果：FAIL');
  } else {
    console.log('');
    console.log('结果：PASS');
  }
  console.log('─'.repeat(78));
  console.log('');

  return check.failed.length > 0 ? 1 : 0;
}

/** 兜底：与服务端同源的默认数据根（server 侧自己会算，这里只用于打印） */
function defaultRoot() {
  const env = process.env['PCL3_DATA_ROOT'];
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (typeof appData === 'string' && appData.trim() !== '') return path.resolve(appData, 'PCL3');
  }
  return path.resolve(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.', '.pcl3');
}

// 仅在被当作脚本执行时跑
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runSmokeTest(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`冒烟测试自身出错：${String(err?.stack ?? err)}`);
      process.exitCode = 2;
    });
}
