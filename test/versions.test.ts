/**
 * 版本目录 / 版本选择器 / 版本重命名 的测试（替换原来的 test/instances.test.ts）。
 *
 * 背景（用户原话）：
 *   「应该可以取消实例概念吧，毕竟是用来做版本隔离的概念，目前版本选择其实已经替代了实例了」
 *
 * 所以本文件测的是「取消实例之后还剩下的东西」，分四块：
 *   A. **版本目录规则**（`<dataRoot>/instances/<versionId>`）—— 这是磁盘上唯一的真源，
 *      实例没了它还得在（用户的存档都在里头）。原来的 `resolveInstanceDir` 有两条分支
 *      （带不带 instanceId），现在只剩一条，但「同一版本目录里的文件互不可见」
 *      这条隔离性质仍然有效，所以迁移过来了。
 *   B. **`/api/versions` 的 `installedDetails`** —— 主页版本选择器的数据源。
 *   C. **显示名**（`displayName`）—— 只改显示、绝不改目录名。
 *   D. **已删除的实例接口** —— 明确断言它们真的 404 了，而不是「碰巧没测到」。
 *
 * 仍然是老规矩：临时目录一律 `after()` 清理，不留 `pcl3-*` 在 %TEMP%。
 */

import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { VersionManifest } from '../src/core/types.js';
import { createServer, type WebServerHandle } from '../src/web/server.js';
import { instanceDirOf, readLastLaunch, recordLastLaunch } from '../src/web/api.js';
import { SettingsStore, SettingsValidationError, DISPLAY_NAME_MAX } from '../src/core/settings/index.js';

// ───────────────────────────── 夹具 ─────────────────────────────

const created: string[] = [];
const servers: WebServerHandle[] = [];

after(async () => {
  for (const handle of servers) {
    try {
      await handle.close();
    } catch {
      /* 已关过就算了 */
    }
  }
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

function tmpDataRoot(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-versions-${tag}-`));
  created.push(dir);
  return dir;
}

const PUBLIC_DIR = path.resolve('src', 'web', 'public');

const FAKE_MANIFEST: VersionManifest = {
  latest: { release: '1.21', snapshot: '24w45a' },
  versions: [
    { id: '1.21', type: 'release', url: 'https://example.invalid/1.21.json', time: 't', releaseTime: '2024-06-13T00:00:00+00:00' },
    { id: '1.20.1', type: 'release', url: 'https://example.invalid/1.20.1.json', time: 't', releaseTime: '2023-06-12T00:00:00+00:00' },
  ],
};

class FakeRepo {
  async fetchManifest(): Promise<VersionManifest> {
    return FAKE_MANIFEST;
  }
  async fetchVersion(id: string): Promise<never> {
    throw new Error(`version "${id}" not found in manifest`);
  }
  async resolveInherited(json: never): Promise<never> {
    return json;
  }
}

/** 造一个「已安装」的版本目录：`versions/<id>/<id>.json` 存在才算装上 */
function installVersionDir(dataRoot: string, versionId: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(dataRoot, 'versions', versionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${versionId}.json`),
    JSON.stringify({ id: versionId, type: 'release', ...extra }, null, 2),
    'utf8',
  );
}

async function startServer(dataRoot: string): Promise<WebServerHandle> {
  const handle = await createServer({
    port: 0,
    dataRoot,
    publicDir: PUBLIC_DIR,
    versionRepo: new FakeRepo() as never,
    installer: { plan: async () => ({}), install: async () => undefined } as never,
    downloader: { downloadAll: async () => ({ ok: true, skipped: 0, downloaded: 0, failed: [] }) } as never,
    // 本文件测路由与磁盘形态，不测体检本身（见 test/preflight.test.ts）
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
  servers.push(handle);
  return handle;
}

async function getJson(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function sendJson(url: string, method: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ═════════════════════════ A. 版本目录规则 ═════════════════════════

describe('A. 版本目录：<dataRoot>/instances/<versionId>（实例概念取消后唯一规则）', () => {
  test('instanceDirOf 永远是 <dataRoot>/instances/<versionId>', () => {
    assert.equal(instanceDirOf('D:/PCL3', '1.21'), path.join('D:/PCL3', 'instances', '1.21'));
    assert.equal(
      instanceDirOf('D:/PCL3', 'fabric-loader-0.19.5-26.3'),
      path.join('D:/PCL3', 'instances', 'fabric-loader-0.19.5-26.3'),
    );
  });

  test('不同版本的目录互不相同，同一版本永远指向同一目录', () => {
    const root = 'D:/PCL3';
    assert.notEqual(instanceDirOf(root, '1.21'), instanceDirOf(root, '1.20.1'));
    assert.equal(instanceDirOf(root, '1.21'), instanceDirOf(root, '1.21'));
  });

  test('目录一律落在 instances/ 之下（不会被版本号里的点号带出去）', () => {
    const root = path.resolve(os.tmpdir(), 'pcl3-dataroot');
    for (const id of ['1.21', '1.21-pre1', '24w45a', 'fabric-loader-0.19.5-26.3']) {
      const dir = path.resolve(instanceDirOf(root, id));
      assert.ok(
        dir.startsWith(path.join(root, 'instances') + path.sep),
        `${id} 的目录 ${dir} 必须落在 instances/ 之下`,
      );
    }
  });

  test('同一版本目录里的文件互不可见（原来「隔离」那条性质迁移到这里）', async () => {
    const dataRoot = tmpDataRoot('isolation');
    const dirA = instanceDirOf(dataRoot, '1.21-fabric');
    const dirB = instanceDirOf(dataRoot, '1.21-forge');

    fs.mkdirSync(path.join(dirA, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(dirB, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(dirA, 'mods', 'sodium.jar'), 'x');
    fs.writeFileSync(path.join(dirB, 'mods', 'jei.jar'), 'x');

    const listA = fs.readdirSync(path.join(dirA, 'mods'));
    const listB = fs.readdirSync(path.join(dirB, 'mods'));
    assert.deepEqual(listA, ['sodium.jar']);
    assert.deepEqual(listB, ['jei.jar'], '两个版本的 mods 不能互相看见');
  });

  test('目录不存在时不自动创建（读路径这件事不该产生副作用）', () => {
    const dataRoot = tmpDataRoot('nodir');
    const dir = instanceDirOf(dataRoot, '1.21');
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(dataRoot), true, '数据根本身是测试造的，当然在');
  });
});

// ═════════════════════════ B. 上次启动时间 ═════════════════════════

describe('B. 上次启动时间：单独一个 .pcl3/ 隐藏目录，不碰 settings.json', () => {
  test('recordLastLaunch 之后 readLastLaunch 能读回，且落在 .pcl3/last-launch.json', async () => {
    const dataRoot = tmpDataRoot('lastlaunch');
    const at = await recordLastLaunch(dataRoot, '26.3');

    const file = path.join(instanceDirOf(dataRoot, '26.3'), '.pcl3', 'last-launch.json');
    assert.ok(fs.existsSync(file), `应该写到 ${file}`);
    assert.equal(await readLastLaunch(dataRoot, '26.3'), at);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastPlayedAt, at);
  });

  test('从没启动过 → undefined（不是空串、不抛错）', async () => {
    const dataRoot = tmpDataRoot('lastlaunch-none');
    assert.equal(await readLastLaunch(dataRoot, '1.21'), undefined);
  });

  test('文件坏了 → undefined，不让一条坏记录把整个列表带崩', async () => {
    const dataRoot = tmpDataRoot('lastlaunch-bad');
    const dir = path.join(instanceDirOf(dataRoot, '1.21'), '.pcl3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'last-launch.json'), '{ broken', 'utf8');
    assert.equal(await readLastLaunch(dataRoot, '1.21'), undefined);
  });

  test('不碰用户数据：mods / saves 一个字节都不动', async () => {
    const dataRoot = tmpDataRoot('lastlaunch-safe');
    const dir = instanceDirOf(dataRoot, '1.21');
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'sodium.jar'), 'jar');

    await recordLastLaunch(dataRoot, '1.21');
    assert.equal(fs.readFileSync(path.join(dir, 'mods', 'sodium.jar'), 'utf8'), 'jar');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.pcl3', 'mods']);
  });
});

// ═════════════════════════ C. /api/versions 的 installedDetails ═════════════════════════

describe('C. GET /api/versions → installedDetails（主页版本选择器的数据源）', () => {
  test('已装原版出现在 installedDetails 里，official=true、loader=null', async () => {
    const dataRoot = tmpDataRoot('details-plain');
    installVersionDir(dataRoot, '1.21');
    const handle = await startServer(dataRoot);

    const res = await getJson(`${handle.url}api/versions?type=all`);
    assert.equal(res.status, 200);
    const details = res.json.installedDetails as {
      versionId: string;
      gameVersion: string | null;
      loader: string | null;
      official: boolean;
      lastPlayedAt: string | null;
    }[];
    assert.ok(Array.isArray(details), '必须有 installedDetails 数组');

    const one = details.find((d) => d.versionId === '1.21');
    assert.ok(one, '已装的 1.21 必须在清单里');
    assert.equal(one.official, true);
    assert.equal(one.loader, null);
    assert.equal(one.gameVersion, '1.21', '原版的 gameVersion 就是它自己');
    assert.equal(one.lastPlayedAt, null, '从没启动过');
  });

  test('加载器 profile 出现在 installedDetails 里，带 loader / loaderVersion / gameVersion', async () => {
    const dataRoot = tmpDataRoot('details-loader');
    installVersionDir(dataRoot, '1.21');
    installVersionDir(dataRoot, 'fabric-loader-0.19.5-1.21', { inheritsFrom: '1.21' });
    const handle = await startServer(dataRoot);

    const res = await getJson(`${handle.url}api/versions?type=all`);
    const details = res.json.installedDetails as {
      versionId: string;
      gameVersion: string | null;
      loader: string | null;
      loaderVersion: string | null;
      official: boolean;
    }[];
    const loader = details.find((d) => d.versionId === 'fabric-loader-0.19.5-1.21');
    assert.ok(loader, '加载器 profile 也必须在清单里（否则主页选不到它）');
    assert.equal(loader.loader, 'fabric');
    assert.equal(loader.loaderVersion, '0.19.5');
    assert.equal(loader.gameVersion, '1.21');
    assert.equal(loader.official, false);
  });

  test('installedDetails 里的 lastPlayedAt 反映真实记录', async () => {
    const dataRoot = tmpDataRoot('details-played');
    installVersionDir(dataRoot, '26.3');
    const at = await recordLastLaunch(dataRoot, '26.3');
    const handle = await startServer(dataRoot);

    const res = await getJson(`${handle.url}api/versions?type=all`);
    const one = (res.json.installedDetails as { versionId: string; lastPlayedAt: string | null }[]).find(
      (d) => d.versionId === '26.3',
    );
    assert.equal(one?.lastPlayedAt, at);
  });

  test('没有任何已装版本时 installedDetails 是空数组（不是 null / 缺字段）', async () => {
    const dataRoot = tmpDataRoot('details-empty');
    const handle = await startServer(dataRoot);
    const res = await getJson(`${handle.url}api/versions?type=all`);
    assert.deepEqual(res.json.installedDetails, []);
  });

  test('installedDetails 里的 dir 就是 <dataRoot>/instances/<versionId>', async () => {
    const dataRoot = tmpDataRoot('details-dir');
    installVersionDir(dataRoot, '1.21');
    const handle = await startServer(dataRoot);
    const res = await getJson(`${handle.url}api/versions?type=all`);
    const one = (res.json.installedDetails as { versionId: string; dir: string }[]).find((d) => d.versionId === '1.21');
    assert.equal(one?.dir, instanceDirOf(dataRoot, '1.21'));
  });
});

// ═════════════════════════ D. 显示名 displayName ═════════════════════════

describe('D. 显示名：只改显示，绝不改目录名', () => {
  test('PUT 只提交 displayName：落盘、读回，目录名一点没变', async () => {
    const dataRoot = tmpDataRoot('rename');
    installVersionDir(dataRoot, '26.3');
    const handle = await startServer(dataRoot);

    const put = await sendJson(`${handle.url}api/instances/26.3/settings`, 'PUT', { displayName: '生存服（勿删）' });
    assert.equal(put.status, 200);
    assert.equal(put.json.displayName, '生存服（勿删）');

    const get = await getJson(`${handle.url}api/instances/26.3/settings`);
    assert.equal(get.json.displayName, '生存服（勿删）');
    assert.equal(get.json.versionId, '26.3', 'versionId 不能被显示名覆盖');

    // 目录名还是 26.3，没有多出一个叫「生存服（勿删）」的目录
    assert.equal(fs.existsSync(path.join(dataRoot, 'instances', '26.3')), true);
    assert.equal(fs.existsSync(path.join(dataRoot, 'instances', '生存服（勿删）')), false);
  });

  test('displayName 为空串 = 取消显示名（不是把目录改成空名）', async () => {
    const dataRoot = tmpDataRoot('rename-clear');
    const handle = await startServer(dataRoot);

    await sendJson(`${handle.url}api/instances/1.21/settings`, 'PUT', { displayName: '临时名字' });
    const put = await sendJson(`${handle.url}api/instances/1.21/settings`, 'PUT', { displayName: '   ' });
    assert.equal(put.status, 200);
    assert.equal(put.json.displayName, undefined, '空串/空白一律当成「没有显示名」');
  });

  test('displayName 含换行 / 控制字符 → 400，且磁盘上那份设置不受影响', async () => {
    const dataRoot = tmpDataRoot('rename-bad');
    const handle = await startServer(dataRoot);
    await sendJson(`${handle.url}api/instances/1.21/settings`, 'PUT', { displayName: '正常名字' });

    const bad = await sendJson(`${handle.url}api/instances/1.21/settings`, 'PUT', { displayName: '第一行\n第二行' });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error), /显示名/);

    const still = await getJson(`${handle.url}api/instances/1.21/settings`);
    assert.equal(still.json.displayName, '正常名字');
  });

  test('displayName 超长 → 400', async () => {
    const dataRoot = tmpDataRoot('rename-long');
    const handle = await startServer(dataRoot);
    const res = await sendJson(`${handle.url}api/instances/1.21/settings`, 'PUT', {
      displayName: 'x'.repeat(DISPLAY_NAME_MAX + 1),
    });
    assert.equal(res.status, 400);
    assert.match(String(res.json.error), /过长/);
  });

  test('重命名不影响内存设置（PUT 只带 displayName 时，其它字段保持原样）', async () => {
    const dataRoot = tmpDataRoot('rename-keep');
    const handle = await startServer(dataRoot);

    await sendJson(`${handle.url}api/instances/1.21/settings`, 'PUT', { memoryMB: 6144, displayName: '旧名' });
    const put = await sendJson(`${handle.url}api/instances/1.21/settings`, 'PUT', { displayName: '新名' });
    assert.equal(put.status, 200);
    assert.equal(put.json.displayName, '新名');
    assert.equal(put.json.memoryMB, 6144, '只改显示名时，内存必须原样保留');
  });

  test('SettingsStore 直接读写 displayName（CLI 未来也会用同一份文件）', () => {
    const dataRoot = tmpDataRoot('rename-store');
    const store = new SettingsStore({ dataRoot });

    store.save({ id: '1.21', versionId: '1.21', displayName: '我的 1.21', memoryMB: 4096 });
    const loaded = store.load('1.21');
    assert.equal(loaded?.displayName, '我的 1.21');
    assert.equal(loaded?.memoryMB, 4096);

    assert.throws(
      () => store.save({ id: '1.21', versionId: '1.21', displayName: 'a\u0000b' }),
      (error: unknown) => error instanceof SettingsValidationError,
    );
  });
});

// ═════════════════════════ E. 实例接口确实没了 ═════════════════════════

describe('E. 实例概念已移除：四条接口真的不在了', () => {
  test('GET /api/instances → 404（不是空列表）', async () => {
    const dataRoot = tmpDataRoot('gone-list');
    const handle = await startServer(dataRoot);
    const res = await getJson(`${handle.url}api/instances`);
    assert.equal(res.status, 404);
    assert.match(String(res.json.error), /未知接口/);
  });

  test('POST /api/instances → 404，不会真的建出目录', async () => {
    const dataRoot = tmpDataRoot('gone-create');
    const handle = await startServer(dataRoot);
    const res = await sendJson(`${handle.url}api/instances`, 'POST', { name: 'x', versionId: '1.21' });
    assert.equal(res.status, 404);
    assert.equal(fs.existsSync(path.join(dataRoot, 'instances', 'x')), false);
  });

  test('GET /api/instances/1.21 → 404（:id 详情没了）', async () => {
    const dataRoot = tmpDataRoot('gone-detail');
    const handle = await startServer(dataRoot);
    const res = await getJson(`${handle.url}api/instances/1.21`);
    assert.equal(res.status, 404);
  });

  test('DELETE /api/instances/1.21 → 404，且原本的目录还在（不删用户数据）', async () => {
    const dataRoot = tmpDataRoot('gone-delete');
    const dir = instanceDirOf(dataRoot, '1.21');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');

    const handle = await startServer(dataRoot);
    const res = await fetch(`${handle.url}api/instances/1.21`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'keep');
  });

  test('设置 / mods / 资源包这些按版本的接口照旧可用（语义正好对上 versionId）', async () => {
    const dataRoot = tmpDataRoot('gone-keep');
    const handle = await startServer(dataRoot);

    const settings = await getJson(`${handle.url}api/instances/1.21/settings`);
    assert.equal(settings.status, 200);

    const mods = await getJson(`${handle.url}api/instances/1.21/mods`);
    assert.equal(mods.status, 200);
    assert.deepEqual(mods.json.mods, []);

    const packs = await getJson(`${handle.url}api/instances/1.21/packs?kind=resourcepack`);
    assert.equal(packs.status, 200);
  });

  test('POST /api/launch 只认 versionId：带 instanceId 也不会 400，按 versionId 启动', async () => {
    const dataRoot = tmpDataRoot('gone-launch');
    installVersionDir(dataRoot, '1.21');
    const seen: { versionId: string; instanceDir: string }[] = [];
    const handle = await createServer({
      port: 0,
      dataRoot,
      publicDir: PUBLIC_DIR,
      versionRepo: new FakeRepo() as never,
      installer: { plan: async () => ({}), install: async () => undefined } as never,
      downloader: { downloadAll: async () => ({ ok: true, skipped: 0, downloaded: 0, failed: [] }) } as never,
      launcherFactory: (() => ({
        buildCommand: async (opts: { versionId: string; instanceDir: string }) => {
          seen.push({ versionId: opts.versionId, instanceDir: opts.instanceDir });
          throw new Error('测试不启动真实进程');
        },
      })) as never,
      preflightFactory: () =>
        ({
          check: async () => ({ canLaunch: true, blocking: [], warnings: [], infos: [], elapsedMs: 0 }),
        }) as never,
    } as never);
    servers.push(handle);

    const res = await sendJson(`${handle.url}api/launch`, 'POST', {
      versionId: '1.21',
      username: 'Steve',
      // 老前端可能还在带这个：必须被安静忽略，而不是变成 400
      instanceId: '随便什么',
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.instanceId, undefined, '202 里不该再有 instanceId');

    const deadline = Date.now() + 8000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.versionId, '1.21');
    assert.equal(seen[0]?.instanceDir, instanceDirOf(dataRoot, '1.21'), '实例目录只由 versionId 决定');
  });
});

// ═════════════════════════ F. 前端结构（版本选择器 / 重命名 / 下载页） ═════════════════════════

describe('F. 前端结构：版本选择器 / 重命名 / 下载独立成页', () => {
  test('index.html 有「当前版本」卡片、切换/重命名按钮、下载页与版本页', () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    assert.match(html, /data-page="home"/);
    assert.match(html, /data-page="download"/, '下载必须独立成页');
    assert.match(html, /data-page="versions"/, '「实例」改名为「版本」');
    assert.doesNotMatch(html, /data-page="instances"/, '旧「实例」页必须消失');
    assert.match(html, /id="home-current-card"/, '主页要有当前版本卡片');
    assert.match(html, /id="btn-home-launch"/, '主页要有启动大按钮');
    assert.match(html, /id="btn-home-switch"/, '主页要有切换版本按钮');
    assert.match(html, /id="btn-home-rename"/, '主页要有重命名按钮');
    assert.match(html, /id="btn-home-content"/, '主页要有「添加额外内容」入口');
    assert.match(html, /id="rename-modal"/, '重命名弹窗');
    assert.doesNotMatch(html, /实例设置/, '弹窗标题不该再叫「实例设置」');
  });

  test('nav.js 的页面清单是 主页/下载/版本/内容/整合包/设置', () => {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, 'nav.js'), 'utf8');
    assert.match(source, /var PAGES = \['home', 'download', 'versions', 'content', 'modpack', 'settings'\]/);
    assert.doesNotMatch(source, /instances:/, '导航里不许再有 instances');
  });

  test('versions.js 真的存在，且带着版本选择 / 重命名 / 目标版本提示', () => {
    const file = path.join(PUBLIC_DIR, 'versions.js');
    assert.ok(fs.existsSync(file), 'versions.js 必须存在（主页版本选择器 + 重命名弹窗）');
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /pcl3\.version/, '当前版本存在 localStorage 的 pcl3.version');
    assert.match(source, /\/api\/versions/, '要有已安装版本清单');
    assert.match(source, /displayName/, '要读显示名');
    assert.match(source, /正在给/, '内容页目标版本的文案');
    assert.match(source, /pcl3Versions/, '要暴露 pcl3Versions 入口');
    assert.match(source, /id="content-target-name"|content-target-name/, '要写目标版本横幅');
    assert.doesNotMatch(source, /https?:\/\/[a-z]/i, '不允许引用任何 CDN');
  });

  test('app.js 不再有实例视图 / 新建实例的残留', () => {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    assert.doesNotMatch(source, /openInstanceModal/);
    assert.doesNotMatch(source, /loadInstances/);
    assert.doesNotMatch(source, /btn-instance-new/);
  });

  test('内容页顶部有醒目的「正在给 X 添加内容」', () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    assert.match(html, /id="content-target"/, '内容页必须有目标版本条');
    assert.match(html, /id="content-target-name"/);
    assert.match(html, /id="btn-content-target-switch"/);
  });

  test('style.css 有当前版本卡片与目标版本条的样式', () => {
    const css = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
    assert.match(css, /\.home-current/);
    assert.match(css, /\.btn-launch-big/);
    assert.match(css, /\.target-banner/);
    assert.match(css, /\.version-picker/);
  });
});
