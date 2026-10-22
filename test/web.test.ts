/**
 * web 模块测试（node --test 内置 runner）。
 *
 * 覆盖 Lead 指定的验收点：
 *   1. 服务起在随机端口能响应 /api/status
 *   2. /api/versions 返回数组（fake 注入，不联网）
 *   3. 静态资源路径穿越被拦
 *   4. 未知 API 返回 JSON 错误（不是 500 空响应）
 *   5. 第二个安装请求返回 409
 *   6. server.address().address 是 127.0.0.1
 *
 * 额外覆盖（都是这次真踩过的坑）：
 *   7. 前端 app.js 真的存在且能被静态服务取出（就是「白屏/永远加载中」那个事故）
 *   8. 非 JSON 的 POST 被 415 拒绝（挡表单跨站提交）
 *   9. 跨站 Origin 被 403 拒绝
 *  10. 静态资源只发白名单扩展名（读不到 .ts 源码）
 *  11. 任务表：进度 / 日志 / 完成保留 / 环形缓冲
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { VersionJson, VersionManifest } from '../src/core/types.js';
import type { LoaderKind, LoaderVersion } from '../src/core/loader/index.js';
import { createServer, normalizeHost, type WebServerHandle } from '../src/web/server.js';
import { resolveStaticFile } from '../src/web/static.js';
import { JobTable, stripAnsi } from '../src/web/jobs.js';
import {
  createApiRouter,
  createRealDeps,
  identifyLoaderProfile,
  isSafeVersionId,
  parseLoaderKind,
} from '../src/web/api.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/**
 * 本文件创建过的临时数据根，进程退出前统一删除。
 *
 * 为什么需要：这个文件里有 60+ 个用例，各自建一个数据根，但只有少数几个
 * 在末尾手工 `rmSync`。结果是每跑一次全量测试，%TEMP% 里就多几十个
 * `pcl3-web-*` 目录 —— 实测曾累积到 387 个、几十 MB。
 *
 * 用 `after()` 统一收口：即使某个用例断言失败中途抛错，钩子仍会执行。
 * 已有用例里的手工 `rmSync` 保留（提前释放没问题，重复删除是幂等的）。
 */
const createdDataRoots: string[] = [];

after(() => {
  for (const dir of createdDataRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
});

function tmpDataRoot(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-web-${tag}-`));
  createdDataRoots.push(dir);
  return dir;
}

/** 静态目录定位：测试跑在源码上，所以直接指 src/web/public */
const PUBLIC_DIR = path.resolve('src', 'web', 'public');

const FAKE_MANIFEST: VersionManifest = {
  latest: { release: '1.21', snapshot: '24w45a' },
  versions: [
    { id: '1.21', type: 'release', url: 'https://example.invalid/1.21.json', time: 't', releaseTime: '2024-06-13T00:00:00+00:00' },
    { id: '1.20.1', type: 'release', url: 'https://example.invalid/1.20.1.json', time: 't', releaseTime: '2023-06-12T00:00:00+00:00' },
    { id: '24w45a', type: 'snapshot', url: 'https://example.invalid/24w45a.json', time: 't', releaseTime: '2024-11-06T00:00:00+00:00' },
  ],
};

/** 只实现契约最小面的 fake 仓库 —— 绝不联网 */
class FakeVersionRepo {
  manifestCalls = 0;
  failManifest = false;

  async fetchManifest(): Promise<VersionManifest> {
    this.manifestCalls += 1;
    if (this.failManifest) throw new Error('假装的网络故障');
    return FAKE_MANIFEST;
  }

  async fetchVersion(id: string): Promise<VersionJson> {
    const found = FAKE_MANIFEST.versions.find((v) => v.id === id);
    if (!found) throw new Error(`version "${id}" not found in manifest`);
    return {
      id: found.id,
      type: found.type,
      mainClass: 'net.minecraft.client.main.Main',
      assets: found.id,
      libraries: [],
    } as VersionJson;
  }

  async resolveInherited(json: VersionJson): Promise<VersionJson> {
    return json;
  }
}

/** 永不返回的 fake 安装器：用来卡住「第二个安装请求」 */
class SlowInstaller {
  readonly started: string[] = [];
  /** 手动放行 */
  private release: (() => void) | undefined;

  async plan(versionId: string): Promise<never> {
    this.started.push(versionId);
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    throw new Error('测试里不该走到这里');
  }

  // 为满足 InstallerLike 的结构约束
  install = async (): Promise<void> => {
    throw new Error('未使用');
  };

  finish(): void {
    this.release?.();
  }
}

/** 立刻成功的 fake 安装器 */
class FastInstaller {
  async plan(versionId: string): Promise<{
    versionId: string;
    tasks: [];
    totalBytes: number;
    natives: [];
    assetIndexId: string;
    versionDir: string;
  }> {
    return {
      versionId,
      tasks: [],
      totalBytes: 0,
      natives: [],
      assetIndexId: versionId,
      versionDir: path.join(os.tmpdir(), 'unused'),
    } as never;
  }

  async install(): Promise<void> {
    return;
  }
}

interface StartOptions {
  dataRoot?: string;
  installer?: unknown;
  repo?: FakeVersionRepo;
  jobRetainMs?: number;
  launcherFactory?: unknown;
}

async function startServer(opts: StartOptions = {}): Promise<{ handle: WebServerHandle; dataRoot: string }> {
  const dataRoot = opts.dataRoot ?? tmpDataRoot('run');
  const repo = opts.repo ?? new FakeVersionRepo();
  const handle = await createServer({
    port: 0,
    dataRoot,
    publicDir: PUBLIC_DIR,
    versionRepo: repo,
    installer: (opts.installer ?? new FastInstaller()) as never,
    downloader: { downloadAll: async () => ({ ok: true, skipped: 0, downloaded: 0, failed: [] }) } as never,
    ...(opts.jobRetainMs === undefined ? {} : { jobRetainMs: opts.jobRetainMs }),
    ...(opts.launcherFactory === undefined ? {} : { launcherFactory: opts.launcherFactory }),
    // 启动链路现在会先跑「启动前体检」。本文件的 FakeVersionRepo 只返回内存里的
    // 版本 JSON，从不往 dataRoot 里写 `<versionId>.json` / `.jar`，所以真实体检
    // 会正确地判定「版本未安装」并拦下启动（409）——这不是产品 bug，是夹具从没
    // 模拟过「装好的版本」。
    //
    // 这里注入一个永远放行的 fake 体检器：本文件测的是 HTTP 路由与任务流转，
    // 不是体检本身（体检由 test/preflight.test.ts 专门覆盖）。
    preflightFactory: () =>
      ({
        check: async (o: { versionId: string }) => ({
          canLaunch: true,
          blocking: [],
          warnings: [],
          infos: [],
          elapsedMs: 0,
          versionId: o.versionId,
        }),
      }) as never,
  } as never);
  return { handle, dataRoot };
}

/** 极简 HTTP 取数：避免依赖 fetch 的默认头，方便测 Origin / Content-Type */
async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string; json: any; contentType: string }> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, contentType: res.headers.get('content-type') ?? '' };
}

// ───────────────────────────── 1. 只监听回环 ─────────────────────────────

test('createServer: 只监听 127.0.0.1，端口随机分配', async () => {
  const { handle } = await startServer();
  try {
    assert.equal(handle.host, '127.0.0.1', 'host 必须是 127.0.0.1');
    const address = handle.server.address();
    assert.ok(address !== null && typeof address === 'object', 'address() 必须返回 AddressInfo');
    assert.equal((address as { address: string }).address, '127.0.0.1');
    assert.ok(handle.port > 0, 'port 应由系统分配为正整数');
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    await handle.close();
  }
});

test('normalizeHost: 任何非回环地址都被拉回 127.0.0.1', () => {
  assert.equal(normalizeHost(undefined), '127.0.0.1');
  assert.equal(normalizeHost('0.0.0.0'), '127.0.0.1', '绝不允许暴露到全网卡');
  assert.equal(normalizeHost('192.168.1.10'), '127.0.0.1');
  assert.equal(normalizeHost('example.com'), '127.0.0.1');
  assert.equal(normalizeHost('localhost'), 'localhost');
  assert.equal(normalizeHost('::1'), '::1');
});

// ───────────────────────────── 2. /api/status ─────────────────────────────

test('GET /api/status: 返回数据目录、版本数、Java 状态', async () => {
  const { handle, dataRoot } = await startServer();
  try {
    const res = await request(`${handle.url}api/status`);
    assert.equal(res.status, 200);
    assert.ok(res.json, '必须是 JSON');
    assert.equal(res.json.dataRoot, dataRoot);
    assert.equal(res.json.latestRelease, '1.21');
    assert.equal(res.json.manifestTotal, 3);
    assert.equal(res.json.versionCount, 0);
    assert.deepEqual(res.json.installedVersions, []);
    assert.equal(typeof res.json.java.found, 'boolean');
    assert.equal(typeof res.json.java.detail, 'string');
    assert.ok(res.json.java.detail.length > 0, 'Java 状态必须给人话说明');
  } finally {
    await handle.close();
  }
});

test('GET /api/status: 已装版本被识别（versions/<id>/<id>.json 存在）', async () => {
  const dataRoot = tmpDataRoot('installed');
  const dir = path.join(dataRoot, 'versions', '1.21');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.21.json'), '{"id":"1.21"}', 'utf8');

  const { handle } = await startServer({ dataRoot });
  try {
    const res = await request(`${handle.url}api/status`);
    assert.equal(res.status, 200);
    assert.equal(res.json.versionCount, 1);
    assert.deepEqual(res.json.installedVersions, ['1.21']);
  } finally {
    await handle.close();
  }
});

test('GET /api/status: manifest 挂掉也返回 200，并如实给出 manifestError', async () => {
  const repo = new FakeVersionRepo();
  repo.failManifest = true;
  const { handle } = await startServer({ repo });
  try {
    const res = await request(`${handle.url}api/status`);
    assert.equal(res.status, 200, '离线不该让首屏整个挂掉');
    assert.match(String(res.json.manifestError), /假装的网络故障/);
  } finally {
    await handle.close();
  }
});

// ───────────────────────────── 3. /api/versions ─────────────────────────────

test('GET /api/versions: 返回数组，字段完整，支持 limit 与类型过滤', async () => {
  const { handle } = await startServer();
  try {
    const all = await request(`${handle.url}api/versions?limit=10`);
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.json.versions), 'versions 必须是数组');
    assert.equal(all.json.versions.length, 3);
    assert.equal(all.json.total, 3);

    const first = all.json.versions[0];
    for (const key of ['id', 'type', 'releaseTime', 'installed', 'latest']) {
      assert.ok(key in first, `版本卡片缺少字段 ${key}`);
    }
    assert.equal(first.id, '1.21');
    assert.equal(first.latest, true);
    assert.equal(first.installed, false);

    const limited = await request(`${handle.url}api/versions?limit=2`);
    assert.equal(limited.json.versions.length, 2);
    assert.equal(limited.json.shown, 2);

    const snapshots = await request(`${handle.url}api/versions?limit=10&type=snapshot`);
    assert.equal(snapshots.json.versions.length, 1);
    assert.equal(snapshots.json.versions[0].id, '24w45a');
  } finally {
    await handle.close();
  }
});

test('GET /api/versions: 已装版本带 installed:true', async () => {
  const dataRoot = tmpDataRoot('installed-flag');
  const dir = path.join(dataRoot, 'versions', '1.20.1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.20.1.json'), '{"id":"1.20.1"}', 'utf8');

  const { handle } = await startServer({ dataRoot });
  try {
    const res = await request(`${handle.url}api/versions?limit=10`);
    const target = res.json.versions.find((v: { id: string }) => v.id === '1.20.1');
    assert.equal(target.installed, true);
    const other = res.json.versions.find((v: { id: string }) => v.id === '1.21');
    assert.equal(other.installed, false);
  } finally {
    await handle.close();
  }
});

// ───────────────────────────── 4. 静态资源与路径穿越 ─────────────────────────────

test('GET /: 首页返回 HTML', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(handle.url);
    assert.equal(res.status, 200);
    assert.match(res.text, /<html/i);
    assert.match(res.text, /PCL3/);
    assert.match(res.text, /\/app\.js/, 'index.html 必须引用前端脚本');
  } finally {
    await handle.close();
  }
});

test('前端脚本真实存在且能被服务取出（白屏事故的回归测试）', async () => {
  for (const file of ['app.js', 'style.css']) {
    const onDisk = path.join(PUBLIC_DIR, file);
    assert.ok(fs.existsSync(onDisk), `src/web/public/${file} 必须存在`);

    const { handle } = await startServer();
    try {
      const res = await request(`${handle.url}${file}`);
      assert.equal(res.status, 200, `GET /${file} 必须 200`);
      assert.ok(res.text.length > 500, `${file} 内容不能是空壳`);
    } finally {
      await handle.close();
    }
  }
});

test('app.js 里真的有版本渲染与错误处理逻辑', () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  assert.match(source, /\/api\/versions/, '必须请求版本列表');
  assert.match(source, /\/api\/install/, '必须能发安装请求');
  assert.match(source, /\/api\/jobs\//, '必须轮询任务进度');
  assert.match(source, /version-grid/, '必须渲染版本卡片容器');
  assert.match(source, /catch\(/, '必须有错误处理');
  assert.doesNotMatch(source, /https?:\/\/[a-z]/i, '不允许引用任何 CDN（全部本地）');
});

test('静态资源：路径穿越一律被拦', async () => {
  const { handle } = await startServer();
  try {
    const attacks = [
      '/../package.json',
      '/../../etc/passwd',
      '/%2e%2e/package.json',
      '/%2e%2e%2fpackage.json',
      '/..%5cpackage.json',
      '/%5c..%5cpackage.json',
      '/subdir/../../package.json',
    ];
    for (const attack of attacks) {
      const res = await request(`${handle.url.replace(/\/$/, '')}${attack}`);
      assert.ok(
        res.status === 403 || res.status === 404,
        `${attack} 必须被拒，实际 ${res.status}`,
      );
      assert.ok(res.json && typeof res.json.error === 'string', `${attack} 必须回 JSON 错误`);
      assert.doesNotMatch(res.text, /"name":\s*"pcl3"/, `${attack} 不能泄露 package.json`);
    }
  } finally {
    await handle.close();
  }
});

test('resolveStaticFile: 直连测试穿越与白名单', async () => {
  const root = PUBLIC_DIR;

  const okFile = await resolveStaticFile(root, '/index.html');
  assert.equal(okFile.ok, true);

  const dirIndex = await resolveStaticFile(root, '/');
  assert.equal(dirIndex.ok, true, '/ 应该解析到 index.html');

  for (const bad of ['/../server.ts', '/..%2fserver.ts', '/%2e%2e%2fserver.ts', '/sub/../../server.ts']) {
    const r = await resolveStaticFile(root, bad);
    assert.equal(r.ok, false, `${bad} 必须被拒`);
  }

  // 扩展名不在白名单：即使真的存在也不发
  const ts = await resolveStaticFile(root, '/../static.ts');
  assert.equal(ts.ok, false);

  // NUL 字节
  const nul = await resolveStaticFile(root, '/app%00.js');
  assert.equal(nul.ok, false);
});

test('静态资源不支持 POST', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}app.js`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.ok(res.json && res.json.error);
  } finally {
    await handle.close();
  }
});

// ───────────────────────────── 5. 未知 API ─────────────────────────────

test('未知 API 返回 JSON 错误，不是 500 空响应', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/does-not-exist`);
    assert.equal(res.status, 404);
    assert.ok(res.json, '必须是 JSON');
    assert.equal(typeof res.json.error, 'string');
    assert.ok(res.json.error.length > 0);
    assert.match(res.contentType, /json/);
  } finally {
    await handle.close();
  }
});

test('已知路径但方法不对 → 405 JSON', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/install`, { method: 'GET' });
    assert.equal(res.status, 405);
    assert.ok(res.json && typeof res.json.error === 'string');
  } finally {
    await handle.close();
  }
});

test('GET /api/jobs/<不存在> → 404 JSON', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/jobs/00000000-0000-0000-0000-000000000000`);
    assert.equal(res.status, 404);
    assert.ok(res.json && typeof res.json.error === 'string');
  } finally {
    await handle.close();
  }
});

// ───────────────────────────── 6. 安装互斥 ─────────────────────────────

test('POST /api/install: 第一个 202 + jobId，第二个 409', async () => {
  const installer = new SlowInstaller();
  const { handle } = await startServer({ installer });
  try {
    const headers = { 'Content-Type': 'application/json' };

    const first = await request(`${handle.url}api/install`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ versionId: '1.21' }),
    });
    assert.equal(first.status, 202, '第一个安装请求必须立刻返回 202');
    assert.equal(typeof first.json.jobId, 'string');

    const second = await request(`${handle.url}api/install`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ versionId: '1.20.1' }),
    });
    assert.equal(second.status, 409, '第二个安装请求必须 409');
    assert.ok(second.json.error, '409 必须带人话错误');
    assert.match(second.json.error, /安装任务/);
    assert.equal(second.json.jobId, first.json.jobId, '409 要告诉用户「沿用那个任务」');

    // 任务详情可读
    const job = await request(`${handle.url}api/jobs/${first.json.jobId}`);
    assert.equal(job.status, 200);
    assert.equal(job.json.status, 'running');
  } finally {
    installer.finish();
    await handle.close();
  }
});

test('POST /api/install: 缺 versionId → 400；非法 versionId → 400', async () => {
  const { handle } = await startServer();
  try {
    const headers = { 'Content-Type': 'application/json' };

    const missing = await request(`${handle.url}api/install`, { method: 'POST', headers, body: '{}' });
    assert.equal(missing.status, 400);
    assert.match(String(missing.json.error), /versionId/);

    const evil = await request(`${handle.url}api/install`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ versionId: '../../etc/passwd' }),
    });
    assert.equal(evil.status, 400);
    assert.match(String(evil.json.error), /非法字符/);
  } finally {
    await handle.close();
  }
});

test('POST /api/install: 坏 JSON → 400 JSON（不是 500）', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.match(String(res.json.error), /JSON/);
  } finally {
    await handle.close();
  }
});

test('isSafeVersionId: 只放行官方版本号形态', () => {
  assert.equal(isSafeVersionId('1.21'), true);
  assert.equal(isSafeVersionId('24w45a'), true);
  assert.equal(isSafeVersionId('1.21.4-pre1'), true);
  assert.equal(isSafeVersionId('fabric-loader-0.16.9-1.21'), true);
  assert.equal(isSafeVersionId('../etc/passwd'), false);
  assert.equal(isSafeVersionId('a/b'), false);
  assert.equal(isSafeVersionId('..'), false);
  assert.equal(isSafeVersionId(''), false);
});

// ───────────────────────────── 7. 跨站防护 ─────────────────────────────

test('跨站 Origin 被 403 拒绝', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/status`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 403);
    assert.match(String(res.json.error), /本机|跨站/);
  } finally {
    await handle.close();
  }
});

test('同源 Origin 放行', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/status`, {
      headers: { Origin: handle.url.replace(/\/$/, '') },
    });
    assert.equal(res.status, 200);
  } finally {
    await handle.close();
  }
});

test('非 JSON 的 POST 被 415 拒绝（挡表单跨站提交）', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'versionId=1.21',
    });
    assert.equal(res.status, 415);
    assert.match(String(res.json.error), /application\/json/);
  } finally {
    await handle.close();
  }
});

// ───────────────────────────── 8. 账户 ─────────────────────────────

test('离线账户：POST 后 GET 能读到，且不回吐令牌', async () => {
  const { handle } = await startServer();
  try {
    const created = await request(`${handle.url}api/account/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Notch' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.account.username, 'Notch');
    // 已知向量：OfflinePlayer:Notch 的 MD5 UUID
    assert.equal(created.json.account.uuid, 'b50ad385-829d-3141-a216-7e7d7539ba7f');

    const list = await request(`${handle.url}api/accounts`);
    assert.equal(list.status, 200);
    assert.equal(list.json.accounts.length, 1);
    assert.equal(list.json.accounts[0].uuid, 'b50ad385-829d-3141-a216-7e7d7539ba7f');
    assert.equal('accessToken' in list.json.accounts[0], false, '令牌不能出现在响应里');
  } finally {
    await handle.close();
  }
});

test('离线账户：空名字 → 400；超长名字 → 400', async () => {
  const { handle } = await startServer();
  try {
    const headers = { 'Content-Type': 'application/json' };

    const empty = await request(`${handle.url}api/account/offline`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: '   ' }),
    });
    assert.equal(empty.status, 400);

    const tooLong = await request(`${handle.url}api/account/offline`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'x'.repeat(40) }),
    });
    assert.equal(tooLong.status, 400);
    assert.match(String(tooLong.json.error), /16/);
  } finally {
    await handle.close();
  }
});

// ───────────────────────────── 9. Java 检测 ─────────────────────────────

test('GET /api/java: 没有 JRE 时如实返回 found:false + 人话', async () => {
  const dataRoot = tmpDataRoot('java-none');
  const { handle } = await startServer({ dataRoot });
  try {
    const res = await request(`${handle.url}api/java`);
    assert.equal(res.status, 200);
    assert.equal(res.json.found, false);
    assert.match(String(res.json.detail), /未安装|没有/);
    assert.ok(typeof res.json.requiredMajor === 'number');
  } finally {
    await handle.close();
  }
});

// ───────────────────────────── 10. 任务表 ─────────────────────────────

test('JobTable: 进度、日志、完成状态', () => {
  const table = new JobTable();
  const id = table.create('install', '安装 1.21');

  assert.equal(table.get(id)?.status, 'running');
  assert.equal(table.runningOf('install')?.id, id);

  table.progress(id, { phase: 'libraries', done: 3, total: 10 });
  const mid = table.get(id);
  assert.equal(mid?.phase, 'libraries');
  assert.equal(mid?.done, 3);
  assert.equal(mid?.ratio, 0.3);

  table.log(id, '第一行\n第二行');
  assert.equal(table.get(id)?.log.length, 2, '多行文本要拆成多条');

  table.succeed(id, { versionId: '1.21', versionDir: 'x' });
  const done = table.get(id);
  assert.equal(done?.status, 'done');
  assert.equal(done?.done, 10, '完成时 done 补齐到 total');
  assert.equal(done?.result?.versionId, '1.21');
  assert.equal(table.runningOf('install'), undefined, '完成后不再算运行中');
});

test('JobTable: 失败带人话错误，并写进日志', () => {
  const table = new JobTable();
  const id = table.create('launch', '启动 1.21');
  table.fail(id, '找不到 Java');
  const snap = table.get(id);
  assert.equal(snap?.status, 'failed');
  assert.equal(snap?.error, '找不到 Java');
  assert.equal(snap?.log.some((l) => l.level === 'error' && l.text === '找不到 Java'), true);
});

test('JobTable: 完成后按 retainMs 清理', async () => {
  const table = new JobTable({ retainMs: 30 });
  const id = table.create('install', 'x');
  table.succeed(id);
  assert.ok(table.get(id));
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(table.get(id), undefined, '超过保留期必须被清理');
});

test('JobTable: 日志环形缓冲有上限', () => {
  const table = new JobTable({ logLimit: 5 });
  const id = table.create('launch', 'x');
  for (let i = 0; i < 20; i += 1) table.log(id, `line ${i}`);
  const log = table.get(id)?.log ?? [];
  assert.equal(log.length, 5);
  assert.equal(log[log.length - 1]?.text, 'line 19', '保留的是尾部');
});

test('stripAnsi: 去掉颜色转义', () => {
  assert.equal(stripAnsi('\u001b[31m红\u001b[0m'), '红');
  assert.equal(stripAnsi('plain'), 'plain');
});

// ───────────────────────────── 11. 生命周期 ─────────────────────────────

test('close(): 关掉之后连不上', async () => {
  const { handle } = await startServer();
  const url = handle.url;
  await handle.close();
  await assert.rejects(async () => {
    await fetch(`${url}api/status`);
  });
});

test('端口被占用时给出人话错误', async () => {
  const { handle } = await startServer();
  try {
    await assert.rejects(
      async () => {
        await createServer({ port: handle.port, dataRoot: tmpDataRoot('conflict'), publicDir: PUBLIC_DIR });
      },
      (error: Error) => {
        assert.match(error.message, /端口 \d+ 已被占用/);
        return true;
      },
    );
  } finally {
    await handle.close();
  }
});

// ───────────────────────────── 12. 加载器（Fabric / Quilt） ─────────────────────────────

/** 只实现加载器契约面的 fake —— 绝不联网 */
class FakeLoaderInstaller {
  readonly listCalls: { kind: string; gameVersion: string }[] = [];
  readonly installCalls: { kind: string; gameVersion: string; loaderVersion: string }[] = [];
  listError: Error | undefined;
  installError: Error | undefined;
  versions: LoaderVersion[] = [
    { version: '0.16.9', stable: true },
    { version: '0.17.0-beta.2', stable: false },
  ];
  /** 安装时写到磁盘的版本 id */
  versionId = 'fabric-loader-0.16.9-1.21';

  async listVersions(kind: LoaderKind, gameVersion: string): Promise<LoaderVersion[]> {
    this.listCalls.push({ kind, gameVersion });
    if (this.listError !== undefined) throw this.listError;
    return this.versions;
  }

  async checkApplicable(): Promise<boolean> {
    return true;
  }

  async install(
    kind: LoaderKind,
    gameVersion: string,
    loaderVersion: string,
    onProgress?: (p: { phase: string; done: number; total: number }) => void,
  ): Promise<{ versionId: string }> {
    this.installCalls.push({ kind, gameVersion, loaderVersion });
    onProgress?.({ phase: 'libraries', done: 1, total: 2 });
    if (this.installError !== undefined) throw this.installError;
    onProgress?.({ phase: 'libraries', done: 2, total: 2 });
    onProgress?.({ phase: 'meta', done: 1, total: 1 });
    onProgress?.({ phase: 'done', done: 1, total: 1 });
    return { versionId: this.versionId };
  }
}

/** 建一个「原版已安装」的数据根（版本 JSON + client jar 都在） */
function makeVanillaDataRoot(gameVersion: string): string {
  const dataRoot = tmpDataRoot(`vanilla-${gameVersion}`);
  const dir = path.join(dataRoot, 'versions', gameVersion);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${gameVersion}.json`), JSON.stringify({ id: gameVersion }), 'utf8');
  fs.writeFileSync(path.join(dir, `${gameVersion}.jar`), 'fake-jar', 'utf8');
  return dataRoot;
}

/** 等后台任务跑到终态（或超时），避免测试依赖固定 sleep */
async function waitJob(
  baseUrl: string,
  jobId: string,
  timeoutMs = 5000,
): Promise<{ status: string; error?: string; result?: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(`${baseUrl}api/jobs/${jobId}`);
    if (res.status === 200 && res.json.status !== 'running') return res.json;
    if (Date.now() > deadline) throw new Error(`任务 ${jobId} 超时未结束`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function startLoaderServer(opts: {
  dataRoot: string;
  loader?: FakeLoaderInstaller;
  installer?: unknown;
}): Promise<WebServerHandle> {
  const { handle } = await startServer({
    dataRoot: opts.dataRoot,
    ...(opts.installer === undefined ? {} : { installer: opts.installer }),
  });
  return handle;
}

test('GET /api/loaders/fabric/versions?gameVersion=1.21 返回数组（fake 注入）', async () => {
  const loader = new FakeLoaderInstaller();
  const dataRoot = makeVanillaDataRoot('1.21');
  const srv = await startRouterWithLoader({ dataRoot, loader });
  try {
    const res = await request(`${srv.url}api/loaders/fabric/versions?gameVersion=1.21`);
    assert.equal(res.status, 200);
    assert.equal(res.json.kind, 'fabric');
    assert.equal(res.json.label, 'Fabric');
    assert.equal(res.json.gameVersion, '1.21');
    assert.ok(Array.isArray(res.json.versions), 'versions 必须是数组');
    assert.equal(res.json.versions.length, 2);
    assert.equal(res.json.versions[0].version, '0.16.9');
    assert.equal(res.json.versions[0].stable, true);
    assert.equal(res.json.versions[0].stableSource, 'inferred', 'unknown 会让 UI 无法标注，必须给可显示的来源');
    assert.equal(res.json.versions[1].stable, false);
    assert.deepEqual(loader.listCalls, [{ kind: 'fabric', gameVersion: '1.21' }]);
  } finally {
    await srv.close();
  }
});

test('GET /api/loaders/quilt/versions: meta 网络故障 → 502 + 人话（不是 500）', async () => {
  const loader = new FakeLoaderInstaller();
  loader.listError = new Error('fetch failed');
  const srv = await startRouterWithLoader({ dataRoot: makeVanillaDataRoot('1.21'), loader });
  try {
    const res = await request(`${srv.url}api/loaders/quilt/versions?gameVersion=1.21`);
    assert.equal(res.status, 502, '网络问题必须是 502');
    assert.match(String(res.json.error), /网络问题|连不上/);
    assert.ok(String(res.json.hint).length > 0, '必须给 hint');
  } finally {
    await srv.close();
  }
});

test('GET /api/loaders/forge/versions → 400（只有 fabric / quilt）', async () => {
  const { handle } = await startServer({ dataRoot: makeVanillaDataRoot('1.21') });
  try {
    for (const kind of ['forge', 'neoforge', 'vanilla', 'FABRICX']) {
      const res = await request(`${handle.url}api/loaders/${kind}/versions?gameVersion=1.21`);
      assert.equal(res.status, 400, `${kind} 必须 400`);
      assert.match(String(res.json.error), /fabric \/ quilt|不认识的加载器类型/);
    }
  } finally {
    await handle.close();
  }
});

test('GET /api/loaders/fabric/versions 缺 gameVersion → 400', async () => {
  const { handle } = await startServer({ dataRoot: makeVanillaDataRoot('1.21') });
  try {
    const res = await request(`${handle.url}api/loaders/fabric/versions`);
    assert.equal(res.status, 400);
    assert.match(String(res.json.error), /gameVersion/);
  } finally {
    await handle.close();
  }
});

/**
 * 起一个只挂 API 路由的最小服务器，并把 fake 加载器注入进去。
 * 这样既不联网，也不必改动 `createServer` 的公开参数面。
 */
async function startRouterWithLoader(opts: {
  dataRoot: string;
  loader: FakeLoaderInstaller;
  jobs?: JobTable;
}): Promise<{ base: string; url: string; close: () => Promise<void>; jobs: JobTable }> {
  const jobs = opts.jobs ?? new JobTable();
  const real = createRealDeps(opts.dataRoot, jobs);
  const router = createApiRouter({
    ...real,
    loaderInstallerFactory: () => ({
      listVersions: (k: LoaderKind, gv: string) => opts.loader.listVersions(k, gv),
      checkApplicable: () => Promise.resolve(true),
      install: async (
        k: LoaderKind,
        gv: string,
        lv: string,
        onProgress?: (p: { phase: string; done: number; total: number }) => void,
      ) => {
        const result = await opts.loader.install(k, gv, lv, onProgress);
        // 真实实现会落盘；fake 这里补上，因为后端成功路径会复核文件存在
        const dir = path.join(opts.dataRoot, 'versions', result.versionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${result.versionId}.json`),
          JSON.stringify({ id: result.versionId, inheritsFrom: gv, libraries: [] }),
          'utf8',
        );
        return result;
      },
    }),
  });

  const server = http.createServer((req, res) => {
    void router(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${String(address.port)}/`,
    jobs,
    url: `http://127.0.0.1:${String(address.port)}/`,
    close: async () => {
      jobs.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

test('POST /api/loaders/install: 返回 jobId，任务成功并回 versionId', async () => {
  const dataRoot = makeVanillaDataRoot('1.21');
  const loader = new FakeLoaderInstaller();
  const versionId = 'fabric-loader-0.16.9-1.21';
  loader.versionId = versionId;

  const srv = await startRouterWithLoader({ dataRoot, loader });
  try {
    const res = await request(`${srv.base}api/loaders/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'fabric', gameVersion: '1.21', loaderVersion: '0.16.9' }),
    });
    assert.equal(res.status, 202, '必须立刻 202');
    assert.equal(typeof res.json.jobId, 'string', '必须返回 jobId');
    assert.equal(res.json.kind, 'fabric');
    assert.equal(res.json.loaderVersion, '0.16.9');

    const job = await waitJob(srv.base, res.json.jobId);
    assert.equal(job.status, 'done', `任务应成功，实际 ${job.status}：${String(job.error ?? '')}`);
    assert.equal(job.result?.versionId, versionId);
    assert.equal(job.result?.kind, 'fabric');
    assert.equal(loader.installCalls.length, 1);
    assert.deepEqual(loader.installCalls[0], { kind: 'fabric', gameVersion: '1.21', loaderVersion: '0.16.9' });
  } finally {
    await srv.close();
  }
});

test('POST /api/loaders/install: 不给 loaderVersion 时自动取稳定版', async () => {
  const dataRoot = makeVanillaDataRoot('1.21');
  const loader = new FakeLoaderInstaller();
  loader.versionId = 'quilt-loader-0.16.9-1.21';

  const srv = await startRouterWithLoader({ dataRoot, loader });
  try {
    const res = await request(`${srv.base}api/loaders/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'quilt', gameVersion: '1.21' }),
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.loaderVersion, '0.16.9', '应自动选第一条 stable');

    const job = await waitJob(srv.base, res.json.jobId);
    assert.equal(job.status, 'done');
    assert.equal(loader.listCalls.length, 1, '应在服务端自动查一次列表');
    assert.equal(loader.installCalls[0]?.loaderVersion, '0.16.9');
  } finally {
    await srv.close();
  }
});

test('POST /api/loaders/install: 后台安装失败 → 任务 failed 且错误是人话', async () => {
  const dataRoot = makeVanillaDataRoot('1.21');
  const loader = new FakeLoaderInstaller();
  loader.installError = new Error('fetch failed');

  const srv = await startRouterWithLoader({ dataRoot, loader });
  try {
    const res = await request(`${srv.base}api/loaders/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'fabric', gameVersion: '1.21' }),
    });
    assert.equal(res.status, 202);
    const job = await waitJob(srv.base, res.json.jobId);
    assert.equal(job.status, 'failed');
    assert.match(String(job.error), /网络问题|连不上/);
    assert.doesNotMatch(String(job.error), /fetch failed$/, '不能把原始异常原样丢给用户');
  } finally {
    await srv.close();
  }
});

test('POST /api/loaders/install: kind 非法 → 400', async () => {
  const { handle } = await startServer({ dataRoot: makeVanillaDataRoot('1.21') });
  try {
    for (const kind of ['forge', '', 'FORGEX']) {
      const res = await request(`${handle.url}api/loaders/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, gameVersion: '1.21' }),
      });
      assert.equal(res.status, 400, `kind=${kind} 必须 400`);
      assert.match(String(res.json.error), /kind|fabric 或 quilt/);
    }
  } finally {
    await handle.close();
  }
});

test('POST /api/loaders/install: 原版没装 → 409 并说清「请先安装」', async () => {
  const dataRoot = tmpDataRoot('no-vanilla');
  const { handle } = await startServer({ dataRoot });
  try {
    const res = await request(`${handle.url}api/loaders/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'fabric', gameVersion: '1.21', loaderVersion: '0.16.9' }),
    });
    assert.equal(res.status, 409, '原版未装必须是 409，不是 500');
    assert.match(String(res.json.error), /原版 1\.21 还没安装/);
    assert.match(String(res.json.hint), /pcl3 install 1\.21|安装/);
    assert.equal(res.json.needVanilla, '1.21');
  } finally {
    await handle.close();
  }
});

test('POST /api/loaders/install: 缺 gameVersion → 400', async () => {
  const { handle } = await startServer({ dataRoot: makeVanillaDataRoot('1.21') });
  try {
    const res = await request(`${handle.url}api/loaders/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'fabric' }),
    });
    assert.equal(res.status, 400);
    assert.match(String(res.json.error), /gameVersion/);
  } finally {
    await handle.close();
  }
});

test('装完加载器后，新版本出现在 /api/versions 的 loaderProfiles 里', async () => {
  const dataRoot = makeVanillaDataRoot('1.21');
  const versionId = 'fabric-loader-0.16.9-1.21';
  const dir = path.join(dataRoot, 'versions', versionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${versionId}.json`),
    JSON.stringify({ id: versionId, inheritsFrom: '1.21', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [] }),
    'utf8',
  );

  const { handle } = await startServer({ dataRoot });
  try {
    const res = await request(`${handle.url}api/versions?limit=10`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.loaderProfiles), '必须带 loaderProfiles');
    assert.equal(res.json.loaderProfiles.length, 1);
    const profile = res.json.loaderProfiles[0];
    assert.equal(profile.versionId, versionId);
    assert.equal(profile.kind, 'fabric');
    assert.equal(profile.loaderVersion, '0.16.9');
    assert.equal(profile.gameVersion, '1.21');
    // 同时它也被算进已装集合
    assert.ok(res.json.installed.includes(versionId));
  } finally {
    await handle.close();
  }
});

test('identifyLoaderProfile: 从版本 id 认出 fabric / quilt', () => {
  assert.deepEqual(identifyLoaderProfile('fabric-loader-0.16.9-1.21'), {
    kind: 'fabric',
    loaderVersion: '0.16.9',
    gameVersion: '1.21',
  });
  const quilt = identifyLoaderProfile('quilt-loader-0.26.0-1.20.1');
  assert.equal(quilt?.kind, 'quilt');
  assert.equal(identifyLoaderProfile('1.21'), undefined);
  assert.equal(identifyLoaderProfile('fabric-loader-broken'), undefined);
});

test('parseLoaderKind: 只认 fabric / quilt', () => {
  assert.equal(parseLoaderKind('fabric'), 'fabric');
  assert.equal(parseLoaderKind('Quilt'), 'quilt');
  assert.equal(parseLoaderKind(' forge '), undefined);
  assert.equal(parseLoaderKind(''), undefined);
  assert.equal(parseLoaderKind(null), undefined);
});

test('前端 app.js 真的有加载器入口与弹窗逻辑', () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  assert.match(source, /\/api\/loaders\//, '必须请求加载器版本列表');
  assert.match(source, /\/api\/loaders\/install/, '必须能提交加载器安装');
  assert.match(source, /装模组加载器/, '卡片上必须有「装模组加载器」入口');
  assert.match(source, /openLoaderModal/, '必须有弹窗打开逻辑');
  assert.match(source, /loaderProfiles/, '必须渲染已装加载器卡片');
  assert.match(source, /stableSource/, '必须如实标注 stable 是否推断');
  assert.doesNotMatch(source, /https?:\/\/[a-z]/i, '不允许引用任何 CDN');
});

test('index.html 里有加载器弹窗结构', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.match(html, /id="loader-modal"/);
  assert.match(html, /id="loader-version"/);
  assert.match(html, /id="loader-confirm"/);
  assert.match(html, /data-kind="fabric"/);
  assert.match(html, /data-kind="quilt"/);
});

// ───────────────────────────── 实例设置（内存 / JVM 参数） ─────────────────────────────

function putJson(url: string, body: unknown): Promise<{ status: number; text: string; json: any; contentType: string }> {
  return request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/instances/:id/settings: 没存过返回默认 2048', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/instances/1.21/settings`);
    assert.equal(res.status, 200);
    assert.equal(res.json.memoryMB, 2048, '默认内存必须是 2048');
    assert.equal(res.json.versionId, '1.21');
    assert.equal(res.json.id, '1.21');
    assert.equal(res.json.source, 'default', '必须如实说明这是默认值不是存下来的');
  } finally {
    await handle.close();
  }
});

test('PUT 然后 GET：设置真的落到磁盘并可读回', async () => {
  const dataRoot = tmpDataRoot('settings-roundtrip');
  const { handle } = await startServer({ dataRoot });
  try {
    const put = await putJson(`${handle.url}api/instances/1.21/settings`, {
      memoryMB: 4096,
      minMemoryMB: 1024,
      extraJvmArgs: ['-XX:+UseG1GC', '-Dfoo=bar'],
      extraGameArgs: ['--demo'],
      javaPath: 'C:\\Java\\bin\\javaw.exe',
    });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.memoryMB, 4096);
    assert.equal(put.json.source, 'stored');

    const file = path.join(dataRoot, 'instances', '1.21', 'settings.json');
    assert.ok(fs.existsSync(file), `必须写到 ${file}`);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { memoryMB: number };
    assert.equal(onDisk.memoryMB, 4096);

    const get = await request(`${handle.url}api/instances/1.21/settings`);
    assert.equal(get.status, 200);
    assert.equal(get.json.memoryMB, 4096);
    assert.equal(get.json.minMemoryMB, 1024);
    assert.deepEqual(get.json.extraJvmArgs, ['-XX:+UseG1GC', '-Dfoo=bar']);
    assert.deepEqual(get.json.extraGameArgs, ['--demo']);
    assert.equal(get.json.source, 'stored');
  } finally {
    await handle.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PUT: memoryMB 越界（511 / 65537）→ 400 并说明', async () => {
  const { handle } = await startServer();
  try {
    for (const bad of [511, 65537]) {
      const res = await putJson(`${handle.url}api/instances/1.21/settings`, { memoryMB: bad });
      assert.equal(res.status, 400, `${String(bad)} 必须是 400，实际 ${res.status}`);
      assert.match(String(res.json.error), /memoryMB|内存/);
      assert.ok(Array.isArray(res.json.problems) && res.json.problems.length > 0, '要带结构化的 problems');
    }
    // 边界值本身合法
    const ok = await putJson(`${handle.url}api/instances/1.21/settings`, { memoryMB: 512 });
    assert.equal(ok.status, 200);
    const ok2 = await putJson(`${handle.url}api/instances/1.21/settings`, { memoryMB: 65536 });
    assert.equal(ok2.status, 200);
  } finally {
    await handle.close();
  }
});

test('PUT: extraJvmArgs 含换行 → 400，且文件不被写坏', async () => {
  const dataRoot = tmpDataRoot('settings-newline');
  const { handle } = await startServer({ dataRoot });
  try {
    const res = await putJson(`${handle.url}api/instances/1.21/settings`, {
      memoryMB: 4096,
      extraJvmArgs: ['-Da=1\n-cp /tmp/evil.jar'],
    });
    assert.equal(res.status, 400);
    assert.match(String(res.json.error), /换行/);
    assert.equal(
      fs.existsSync(path.join(dataRoot, 'instances', '1.21', 'settings.json')),
      false,
      '被拒的请求不能留下任何文件',
    );

    const nul = await putJson(`${handle.url}api/instances/1.21/settings`, {
      extraJvmArgs: ['-Da=1\u0000-evil'],
    });
    assert.equal(nul.status, 400);
    assert.match(String(nul.json.error), /空字节/);
  } finally {
    await handle.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PUT: 未知字段忽略不报错（向前兼容）', async () => {
  const { handle } = await startServer();
  try {
    const res = await putJson(`${handle.url}api/instances/1.21/settings`, {
      memoryMB: 3072,
      futureField: { hello: 'world' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.memoryMB, 3072);
    assert.equal('futureField' in res.json, false, '未知字段不该被存下来');
  } finally {
    await handle.close();
  }
});

test('GET/PUT /api/instances/../settings 之类非法版本号 → 400 或被 URL 层挡掉', async () => {
  const { handle } = await startServer();
  try {
    // `..` 这类点段会被 URL 解析器先吃掉（路径归一化），根本到不了 handler——
    // 那是更早的一层拦住了，所以接受 404；但凡是能进到 handler 的，必须是 400 且带人话。
    for (const bad of ['..', 'a%2Fb', '%2e%2e', 'a%5Cb']) {
      const get = await request(`${handle.url}api/instances/${bad}/settings`);
      assert.ok(
        get.status === 400 || get.status === 404,
        `GET ${bad} 必须被拒（400/404），实际 ${get.status}`,
      );
      assert.ok(get.json && typeof get.json.error === 'string', `${bad} 必须回 JSON 错误`);
      assert.doesNotMatch(get.text, /settings\.json/, `${bad} 不能泄露真实文件路径`);
    }

    // 真正能进 handler 的非法版本号（含路径分隔符）必须是 400，不是 404
    const slash = await request(`${handle.url}api/instances/a%2Fb/settings`);
    assert.equal(slash.status, 400);
    assert.match(String(slash.json.error), /非法字符/);
  } finally {
    await handle.close();
  }
});

test('PUT 不是 JSON → 415（挡表单跨站提交）', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/instances/1.21/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'memoryMB=4096',
    });
    assert.equal(res.status, 415);
  } finally {
    await handle.close();
  }
});

test('POST /api/instances/1.21/settings → 405（只接受 GET/PUT）', async () => {
  const { handle } = await startServer();
  try {
    const res = await request(`${handle.url}api/instances/1.21/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 405);
  } finally {
    await handle.close();
  }
});

test('GET /api/instances/settings: 列出全部已保存实例', async () => {
  const dataRoot = tmpDataRoot('settings-list');
  const { handle } = await startServer({ dataRoot });
  try {
    await putJson(`${handle.url}api/instances/1.21/settings`, { memoryMB: 4096 });
    await putJson(`${handle.url}api/instances/1.20.1/settings`, { memoryMB: 2048 });

    const res = await request(`${handle.url}api/instances/settings`);
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 2);
    assert.deepEqual(
      res.json.instances.map((s: { id: string }) => s.id),
      ['1.20.1', '1.21'],
    );
  } finally {
    await handle.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('启动任务用的是设置里的内存：memoryMB=4096 时命令行带 -Xmx4096M', async () => {
  const dataRoot = tmpDataRoot('settings-launch');
  const first = (await startServer({ dataRoot })).handle;
  const seen: { versionId: string; memoryMB?: number; extraJvmArgs?: string[] }[] = [];
  let second: WebServerHandle | undefined;
  try {
    // 先把设置写进去
    const put = await putJson(`${first.url}api/instances/1.21/settings`, {
      memoryMB: 4096,
      extraJvmArgs: ['-XX:+UseG1GC'],
    });
    assert.equal(put.status, 200);

    // 用 launcherFactory 截获真正传给 buildCommand 的 LaunchOptions
    const withLauncher = await startServer({
      dataRoot,
      launcherFactory: (() => ({
        buildCommand: async (opts: {
          versionId: string;
          memoryMB?: number;
          extraJvmArgs?: string[];
          instanceDir: string;
          account: { username: string };
        }) => {
          seen.push({
            versionId: opts.versionId,
            ...(opts.memoryMB === undefined ? {} : { memoryMB: opts.memoryMB }),
            ...(opts.extraJvmArgs === undefined ? {} : { extraJvmArgs: opts.extraJvmArgs }),
          });
          // 立刻返回一个必然 spawn 失败的命令：只关心「参数拿对了没有」，不真的去跑 java
          throw new Error('测试不启动真实进程');
        },
      })) as never,
    });
    second = withLauncher.handle;

    const launch = await request(`${withLauncher.handle.url}api/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: '1.21', username: 'Steve' }),
    });
    assert.equal(launch.status, 202, '启动请求应立刻 202');

    // 等后台任务走到 buildCommand
    const deadline = Date.now() + 8000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(seen.length, 1, `buildCommand 应被调用一次，实际 ${String(seen.length)} 次`);
    assert.equal(seen[0]?.memoryMB, 4096, '启动必须用设置里的 4096，不是写死的 2048');
    assert.deepEqual(seen[0]?.extraJvmArgs, ['-XX:+UseG1GC'], '附加 JVM 参数要一起传下去');
  } finally {
    if (second !== undefined) await second.close();
    await first.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('设置文件损坏时 GET 仍返回默认值（不 500）', async () => {
  const dataRoot = tmpDataRoot('settings-corrupt-web');
  const dir = path.join(dataRoot, 'instances', '1.21');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ broken', 'utf8');

  const { handle } = await startServer({ dataRoot });
  try {
    const res = await request(`${handle.url}api/instances/1.21/settings`);
    assert.equal(res.status, 200, '坏文件不能让接口 500');
    assert.equal(res.json.memoryMB, 2048);
    assert.equal(res.json.source, 'default');
  } finally {
    await handle.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('前端 app.js 有设置入口、弹窗逻辑与实时内存提示', () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  assert.match(source, /\/api\/instances\//, '必须请求实例设置接口');
  assert.match(source, /openSettingsModal/, '必须有设置弹窗打开逻辑');
  assert.match(source, /settings-memory-range/, '必须有内存滑块');
  assert.match(source, /settings-memory-label/, '必须实时显示当前内存');
  assert.match(source, /data-settings-entry/, '卡片上必须有设置入口');
  assert.match(source, /humanMemory/, '必须把 MB 换算成 GB 展示');
  assert.match(source, /deviceMemory/, '必须按物理内存给建议值');
  assert.match(source, /method: 'PUT'/, '保存必须走 PUT');
  assert.match(source, /settings-jvm-args/, '必须有 JVM 参数输入框');
  assert.match(source, /settings-java-path/, '必须有 Java 路径输入框');
  assert.doesNotMatch(source, /https?:\/\/[a-z]/i, '不允许引用任何 CDN');
});

test('index.html 里有设置弹窗结构', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.match(html, /id="settings-modal"/);
  assert.match(html, /id="settings-memory-range"/);
  assert.match(html, /id="settings-memory"/);
  assert.match(html, /id="settings-min-memory"/);
  assert.match(html, /id="settings-jvm-args"/);
  assert.match(html, /id="settings-game-args"/);
  assert.match(html, /id="settings-java-path"/);
  assert.match(html, /id="settings-save"/);
  assert.match(html, /min="512"/, '滑块下限 512');
  assert.match(html, /max="16384"/, '滑块上限 16384');
  assert.match(html, /step="512"/, '步进 512');
});

test('style.css 里有设置弹窗与滑块样式', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
  assert.match(css, /\.btn-gear/, '齿轮按钮样式');
  assert.match(css, /\.range/, '滑块样式');
  assert.match(css, /\.modal-wide/, '宽版弹窗');
  assert.match(css, /\.toast\.is-ok/, '成功提示样式');
});
