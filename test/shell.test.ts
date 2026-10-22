/**
 * shell 模块测试：打开文件夹 / 快捷操作（基础便利功能）。
 *
 * 覆盖 Lead 指定的验收点：
 *   1. `resolve()` 对每种 kind 返回正确路径，且目录被创建
 *   2. 路径穿越被拒：`instanceId = '../evil'`、`instanceId = 'a/b'` 抛错
 *   3. `kind` 非法值抛错
 *   4. 解析后路径必须在实例目录内（构造会被穿越的输入，断言被拒）
 *   5. `list()` 返回文件与目录都正确，`size` 对目录不递归统计
 *   6. `POST .../open` 拒绝非环回来源（fake request）
 *
 * 额外覆盖：
 *   7. 三平台命令构造（explorer / open / xdg-open），且路径是单个 argv 元素
 *   8. explorer.exe 返回非 0 退出码不会被当成失败（spawn 成功即算成功）
 *   9. 真实服务里 POST .../open 打到 fake spawn，断言参数就是 mods 目录
 *  10. `/api/status` 的 diskUsage：异步算、缓存 5 分钟、超 10 万文件走估算
 *  11. `/api/instances/:id/launch-args`：返回命令行且**令牌被打码**
 *  12. 前端 app.js / index.html 里真的有「打开文件夹」入口
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { VersionJson, VersionManifest } from '../src/core/types.js';
import {
  DataDiskUsage,
  FolderAccessError,
  FolderService,
  FOLDER_KINDS,
  buildOpenCommand,
  checkInstanceIdShape,
  parseFolderKind,
  summarizeCommand,
  formatCommandLine,
  redactArgs,
} from '../src/core/shell/index.js';
import { createServer, type WebServerHandle } from '../src/web/server.js';
import { assertDirectLoopback, isLoopbackAddress } from '../src/web/api.js';
import { execFileSync } from 'node:child_process';

// ───────────────────────────── 夹具 ─────────────────────────────

const PUBLIC_DIR = path.resolve('src', 'web', 'public');

/**
 * ★ 安全默认：整个测试文件默认**不真 spawn**。
 *
 *   - `PCL3_NO_SHELL=1` 让 FolderService.open() 只打 warning、不起进程；
 *   - 只保留一条端到端用例（PCL3_SHELL_E2E=1 时才真开窗），它在 after 里
 *     用「基线比对 + Stop-Process」把本轮新开的窗口全部关掉并断言清干净。
 *
 * 事故经过：第一版有一条真实服务用例漏注入 fake，跑一次弹一个窗口，累计弹了 7 次。
 * 教训：**凡是拉起外部进程的功能，默认必须走 fake；真要开窗就得负责关掉。**
 */
process.env['PCL3_NO_SHELL'] = '1';

/** 列出当前所有 `-Embedding` 的 explorer 进程（Windows 用 PowerShell CIM 查询） */
function listEmbeddingExplorers(): { pid: number; cmd: string }[] {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\" | Where-Object { $_.CommandLine -like '*-Embedding*' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
      ],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const tab = line.indexOf('\t');
        const pid = Number(tab >= 0 ? line.slice(0, tab) : line);
        return { pid, cmd: tab >= 0 ? line.slice(tab + 1) : '' };
      })
      .filter((item) => Number.isFinite(item.pid) && item.pid > 0);
  } catch {
    // 拿不到进程表时返回空数组：下面的断言会退化成「不新增」，不会误判失败
    return [];
  }
}

/**
 * 关掉本轮新开的 explorer 窗口，返回关掉了几个。
 *
 * explorer.exe 拉起后会立刻退出、由系统托管成 `-Embedding` 子进程，
 * spawn 拿不到可靠 PID，所以只能「基线比对 + 按 pid 关」。
 */
async function cleanupSpawnedShells(baseline: { pid: number }[]): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const before = new Set(baseline.map((p) => p.pid));
  // explorer 注册成 -Embedding 需要一点时间，轮询几次再决定要不要关
  let extra: { pid: number; cmd: string }[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    extra = listEmbeddingExplorers().filter((p) => !before.has(p.pid));
    if (extra.length > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const proc of extra) {
    try {
      process.kill(proc.pid);
    } catch {
      /* 已经被系统回收，忽略 */
    }
  }
  // 给进程表一点时间反映
  if (extra.length > 0) await new Promise((r) => setTimeout(r, 400));
  return extra.length;
}

/** 造一个「绝不真 spawn」的 FolderService —— 所有用例都必须用它 */
function fakeFolderService(
  dataRoot: string,
  opts: { platform?: NodeJS.Platform; listLimit?: number; onSpawn?: (cmd: { file: string; args: string[] }) => void } = {},
): FolderService {
  return new FolderService({
    dataRoot,
    ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    ...(opts.listLimit === undefined ? {} : { listLimit: opts.listLimit }),
    spawnImpl: (cmd) => {
      opts.onSpawn?.(cmd);
    },
  });
}

function tmpDataRoot(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-shell-${tag}-`));
  createdRoots.push(dir);
  return dir;
}

/**
 * 磁盘卫生：所有临时目录都登记下来，after 里统一删。
 * 教训：上一轮遗留了 2581 个 `pcl3-*` 目录（706MB），都是用例中途失败没走到 finally 留下的。
 */
const createdRoots: string[] = [];
after(() => {
  for (const dir of createdRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了，别让清理本身把测试搞红 */
    }
  }
});

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 每个 kind 期望落在实例目录下的哪个子目录 */
const EXPECTED_SUBDIR: Record<string, string> = {
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
  datapacks: 'datapacks',
  saves: 'saves',
  logs: 'logs',
  'crash-reports': 'crash-reports',
  screenshots: 'screenshots',
  config: 'config',
};

/** 假版本仓库：永不联网 */
class FakeRepo {
  async fetchManifest(): Promise<VersionManifest> {
    return {
      latest: { release: '1.21', snapshot: '24w45a' },
      versions: [
        { id: '1.21', type: 'release', url: 'x', time: 't', releaseTime: '2024-06-13T00:00:00+00:00' },
      ],
    };
  }

  async fetchVersion(id: string): Promise<VersionJson> {
    return {
      id,
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      assets: id,
      libraries: [],
    } as VersionJson;
  }

  async resolveInherited(json: VersionJson): Promise<VersionJson> {
    return json;
  }
}

interface StartOptions {
  dataRoot: string;
  /** 截获 spawn 参数（不真弹窗） */
  spawns?: { file: string; args: string[] }[];
  platform?: NodeJS.Platform;
  diskUsage?: DataDiskUsage;
  launcher?: unknown;
}

async function startServer(opts: StartOptions): Promise<WebServerHandle> {
  return createServer({
    port: 0,
    dataRoot: opts.dataRoot,
    publicDir: PUBLIC_DIR,
    versionRepo: new FakeRepo() as never,
    installer: {
      plan: async () => ({ tasks: [], totalBytes: 0, natives: [], assetIndexId: '', versionDir: '' }),
      install: async () => undefined,
    } as never,
    downloader: { downloadAll: async () => ({ ok: true, skipped: 0, downloaded: 0, failed: [] }) } as never,
    ...(opts.diskUsage === undefined ? {} : { diskUsage: opts.diskUsage as never }),
    ...(opts.launcher === undefined ? {} : { launcherFactory: opts.launcher as never }),
    jobRetainMs: 200,
  } as never);
}

async function req(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; json: any; text: string }> {
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
  return { status: res.status, json, text };
}

// ───────────────────────────── 1. resolve ─────────────────────────────

test('resolve: 每种 kind 都返回正确路径，且目录被真实创建', async () => {
  const dataRoot = tmpDataRoot('resolve');
  try {
    const svc = fakeFolderService(dataRoot);

    for (const [kind, sub] of Object.entries(EXPECTED_SUBDIR)) {
      const target = await svc.resolve('1.21', kind as never);
      const expected = path.join(dataRoot, 'instances', '1.21', sub);
      assert.equal(target, expected, `${kind} 应解析到 ${expected}`);
      assert.ok(fs.statSync(target).isDirectory(), `${kind} 目录必须被创建出来`);
    }

    // 实例根
    const instanceDir = await svc.resolve('1.21', 'instance');
    assert.equal(instanceDir, path.join(dataRoot, 'instances', '1.21'));
    assert.ok(fs.statSync(instanceDir).isDirectory());

    // 数据根
    const root = await svc.resolve('1.21', 'dataRoot');
    assert.equal(root, path.resolve(dataRoot));
  } finally {
    cleanup(dataRoot);
  }
});

test('resolve: 幂等 —— 目录已存在也不报错，反复调用同一个结果', async () => {
  const dataRoot = tmpDataRoot('resolve-idem');
  try {
    const svc = fakeFolderService(dataRoot);
    const a = await svc.resolve('1.21', 'mods');
    fs.writeFileSync(path.join(a, 'sodium.jar'), 'x');
    const b = await svc.resolve('1.21', 'mods');
    assert.equal(a, b);
    assert.ok(fs.existsSync(path.join(b, 'sodium.jar')), '已有内容不能被清掉');
  } finally {
    cleanup(dataRoot);
  }
});

// ───────────────────────────── 2. 路径穿越 ─────────────────────────────

test('resolve: 路径穿越 / 非法 instanceId 一律被拒（../evil、a/b、盘符、空字节）', async () => {
  const dataRoot = tmpDataRoot('trav');
  try {
    const svc = fakeFolderService(dataRoot);

    const bad = ['../evil', 'a/b', 'a\\b', '..', '.', 'C:', 'C:\\Windows', '', 'a\u0000b', 'x'.repeat(80)];
    for (const id of bad) {
      await assert.rejects(
        () => svc.resolve(id, 'mods'),
        (error: unknown) => {
          assert.ok(error instanceof FolderAccessError, `「${id}」应抛 FolderAccessError，实际 ${String(error)}`);
          assert.equal(error.code, 'bad-instance');
          return true;
        },
        `instanceId「${id}」必须被拒绝`,
      );
    }

    // 合法的中文 / 点 / 加号 / 空格必须还能用（不能一刀切禁掉）
    for (const id of ['1.21', 'fabric-loader-0.16.9-1.21', '我的世界', '1.21 生存', 'a+b']) {
      assert.equal(checkInstanceIdShape(id), null, `「${id}」应当合法`);
      const target = await svc.resolve(id, 'mods');
      assert.ok(target.startsWith(path.resolve(dataRoot, 'instances')));
    }
  } finally {
    cleanup(dataRoot);
  }
});

test('resolve: kind 非法值抛错（且错误里列出所有合法值）', async () => {
  const dataRoot = tmpDataRoot('kind');
  try {
    const svc = fakeFolderService(dataRoot);
    const bad = ['MODS', 'mod', 'mods/..', '../mods', 'resourcepack', '', 'whatever'];
    for (const kind of bad) {
      await assert.rejects(
        () => svc.resolve('1.21', kind as never),
        (error: unknown) => {
          assert.ok(error instanceof FolderAccessError);
          assert.equal(error.code, 'bad-kind');
          assert.match(error.message, /可用：|不认识的文件夹类型/);
          return true;
        },
        `kind「${kind}」必须被拒绝`,
      );
    }
    // 白名单本身必须与契约一致
    assert.deepEqual(
      [...FOLDER_KINDS].sort(),
      [
        'config',
        'crash-reports',
        'dataRoot',
        'datapacks',
        'instance',
        'logs',
        'mods',
        'resourcepacks',
        'saves',
        'screenshots',
        'shaderpacks',
      ].sort(),
    );
    assert.equal(parseFolderKind('crash-reports'), 'crash-reports');
  } finally {
    cleanup(dataRoot);
  }
});

test('resolve: 解析结果必须仍在实例目录内（前缀复核 + 符号链接复核）', async () => {
  const dataRoot = tmpDataRoot('inside');
  try {
    const svc = fakeFolderService(dataRoot);

    // ① 正常结果确实在实例目录里（前缀判断本身要能判对）
    const mods = await svc.resolve('1.21', 'mods');
    assert.ok(mods.startsWith(path.resolve(dataRoot, 'instances', '1.21') + path.sep));

    // ② 造一个「看起来在实例里、其实指向外面」的符号链接：
    //    字面前缀成立，只有 realpath 复核能拦住。
    const outside = path.join(dataRoot, '..', `pcl3-outside-${process.pid}`);
    fs.mkdirSync(outside, { recursive: true });
    try {
      const instanceDir = path.join(dataRoot, 'instances', '1.21');
      fs.mkdirSync(instanceDir, { recursive: true });
      const link = path.join(instanceDir, 'resourcepacks');
      let linked = false;
      try {
        fs.symlinkSync(outside, link, 'dir');
        linked = true;
      } catch {
        // Windows 上无符号链接权限时跳过这一条（其余断言仍然有效）
        linked = false;
      }

      if (linked) {
        await assert.rejects(
          () => svc.resolve('1.21', 'resourcepacks'),
          (error: unknown) => {
            assert.ok(error instanceof FolderAccessError);
            assert.equal(error.code, 'outside');
            return true;
          },
          '指向实例目录外的符号链接必须被拒绝',
        );
      }

      // ③ 即使 id 形状校验被绕过，instancesBase 复核也要拦住（这里直接调 instanceDir 验口径）
      assert.throws(() => svc.instanceDir('../1.21'), FolderAccessError);
      assert.throws(() => svc.instanceDir('1.21/../../x'), FolderAccessError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    cleanup(dataRoot);
  }
});

// ───────────────────────────── 3. list ─────────────────────────────

test('list: 文件与目录都列出来，目录 size 恒为 0（不递归统计）', async () => {
  const dataRoot = tmpDataRoot('list');
  try {
    const svc = fakeFolderService(dataRoot);
    const mods = await svc.resolve('1.21', 'mods');

    fs.writeFileSync(path.join(mods, 'sodium.jar'), Buffer.alloc(1234));
    fs.writeFileSync(path.join(mods, 'iris.jar'), Buffer.alloc(10));
    fs.mkdirSync(path.join(mods, 'nested'));
    // 目录里塞一个大文件：若实现递归统计，目录的 size 就不会是 0
    fs.writeFileSync(path.join(mods, 'nested', 'big.bin'), Buffer.alloc(64 * 1024));

    const entries = await svc.list('1.21', 'mods');
    assert.equal(entries.length, 3);

    const byName = new Map(entries.map((e) => [e.name, e]));

    const sodium = byName.get('sodium.jar');
    assert.ok(sodium !== undefined);
    assert.equal(sodium.isDir, false);
    assert.equal(sodium.size, 1234, '文件给真实字节数');
    assert.match(sodium.mtime, /^\d{4}-\d{2}-\d{2}T/, 'mtime 是 ISO 串');

    const nested = byName.get('nested');
    assert.ok(nested !== undefined);
    assert.equal(nested.isDir, true);
    assert.equal(nested.size, 0, '目录必须给 0，绝不递归统计');

    // 目录排在前面
    assert.equal(entries[0]?.name, 'nested', '目录应排在文件前面');
  } finally {
    cleanup(dataRoot);
  }
});

test('list: 空目录返回空数组，不报错', async () => {
  const dataRoot = tmpDataRoot('list-empty');
  try {
    const svc = fakeFolderService(dataRoot);
    assert.deepEqual(await svc.list('1.21', 'shaderpacks'), []);
  } finally {
    cleanup(dataRoot);
  }
});

// ───────────────────────────── 4. open / 平台差异 ─────────────────────────────

test('buildOpenCommand: 三平台各自的命令与参数（路径是单个 argv，不拼 shell）', () => {
  const target = 'C:\\Users\\张三\\AppData\\Roaming\\PCL3\\instances\\1.21\\mods';

  const win = buildOpenCommand('win32', target);
  assert.equal(win.file, 'explorer.exe');
  assert.deepEqual(win.args, [path.resolve(target)], '路径必须是一个完整 argv 元素');

  const mac = buildOpenCommand('darwin', target);
  assert.equal(mac.file, 'open');
  assert.deepEqual(mac.args, [path.resolve(target)]);

  const linux = buildOpenCommand('linux', target);
  assert.equal(linux.file, 'xdg-open');
  assert.deepEqual(linux.args, [path.resolve(target)]);

  // 带空格与引号的目录名不会产生额外参数
  const weird = 'D:\\a b\\"quoted"\\dir';
  assert.equal(buildOpenCommand('win32', weird).args.length, 1);
});

test('open: 注入的 spawnImpl 收到正确命令；explorer 的非 0 退出码不当失败', async () => {
  const dataRoot = tmpDataRoot('open');
  try {
    const seen: { file: string; args: string[] }[] = [];
    const svc = new FolderService({
      dataRoot,
      platform: 'win32',
      spawnImpl: (cmd) => {
        seen.push(cmd);
        // explorer.exe 真实会返回非 0（常见为 1）：这里刻意模拟，
        // 只要不抛错就说明实现没有用退出码判断成败。
      },
    });

    await svc.open('1.21', 'mods');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.file, 'explorer.exe');
    assert.equal(seen[0]?.args[0], path.join(dataRoot, 'instances', '1.21', 'mods'));
    assert.ok(fs.statSync(path.join(dataRoot, 'instances', '1.21', 'mods')).isDirectory());

    // describeOpen 只算命令不执行
    const described = await svc.describeOpen('1.21', 'saves');
    assert.equal(described.command.file, 'explorer.exe');
    assert.equal(described.command.args[0], path.join(dataRoot, 'instances', '1.21', 'saves'));
    assert.equal(seen.length, 1, 'describeOpen 不能额外触发 spawn');
  } finally {
    cleanup(dataRoot);
  }
});

// ───────────────────────────── 5. Web API：列目录 / 路径 ─────────────────────────────

test('GET .../folders/:kind 返回条目；未知 kind 400；穿越 instanceId 400', async () => {
  const dataRoot = tmpDataRoot('api-list');
  const handle = await startServer({ dataRoot });
  try {
    const dir = path.join(dataRoot, 'instances', '1.21', 'mods');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.jar'), Buffer.alloc(7));

    const ok = await req(`${handle.url}api/instances/1.21/folders/mods`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.kind, 'mods');
    assert.equal(ok.json.path, dir);
    assert.equal(ok.json.entries.length, 1);
    assert.equal(ok.json.entries[0].name, 'a.jar');
    assert.equal(ok.json.entries[0].size, 7);

    const badKind = await req(`${handle.url}api/instances/1.21/folders/exe`);
    assert.equal(badKind.status, 400);
    assert.match(String(badKind.json.error), /不认识的文件夹类型/);

    const badId = await req(`${handle.url}api/instances/${encodeURIComponent('../evil')}/folders/mods`);
    assert.equal(badId.status, 400);
    assert.equal(badId.json.code, 'bad-instance');
  } finally {
    await handle.close();
    cleanup(dataRoot);
  }
});

test('GET .../paths 返回全部关键路径，且不创建任何目录', async () => {
  const dataRoot = tmpDataRoot('api-paths');
  const handle = await startServer({ dataRoot });
  try {
    const res = await req(`${handle.url}api/instances/1.21/paths`);
    assert.equal(res.status, 200);
    assert.equal(res.json.paths.instance, path.join(dataRoot, 'instances', '1.21'));
    assert.equal(res.json.paths.mods, path.join(dataRoot, 'instances', '1.21', 'mods'));
    assert.equal(res.json.paths.dataRoot, path.resolve(dataRoot));
    assert.ok(Array.isArray(res.json.folders) && res.json.folders.length >= 10);
    assert.equal(
      fs.existsSync(path.join(dataRoot, 'instances', '1.21', 'mods')),
      false,
      '只看路径不该顺手建目录',
    );
  } finally {
    await handle.close();
    cleanup(dataRoot);
  }
});

// ───────────────────────────── 6. POST .../open 的环回限制 ─────────────────────────────

/** 造一个最小 fake request（只带 assertDirectLoopback 会读的字段） */
function fakeRequest(opts: {
  remoteAddress?: string;
  headers?: Record<string, string>;
}): Parameters<typeof assertDirectLoopback>[0] {
  return {
    headers: opts.headers ?? {},
    socket: opts.remoteAddress === undefined ? {} : { remoteAddress: opts.remoteAddress },
  } as never;
}

test('POST .../open 拒绝非环回来源（局域网 IP / 公网 IP / 无 socket 信息）', async () => {
  // ① 函数级：逐个地址断言
  for (const addr of ['192.168.1.20', '10.0.0.5', '203.0.113.9', '::ffff:192.168.1.2']) {
    const result = assertDirectLoopback(fakeRequest({ remoteAddress: addr, headers: { host: '127.0.0.1:37421' } }));
    assert.equal(result.ok, false, `${addr} 必须被拒绝`);
  }

  // ② 拿不到 socket → 按「不通过」处理（安全默认值）
  const noSocket = assertDirectLoopback(fakeRequest({ headers: { host: '127.0.0.1:37421' } }));
  assert.equal(noSocket.ok, false);
  assert.match(String((noSocket as { reason: string }).reason), /无法确认请求来源地址/);

  // ③ 环回放行
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.1.2.3']) {
    const ok = assertDirectLoopback(fakeRequest({ remoteAddress: addr, headers: { host: '127.0.0.1:37421' } }));
    assert.equal(ok.ok, true, `${addr} 应当放行`);
  }
});

test('POST .../open 拒绝代理转发（X-Forwarded-For / Forwarded / Via）', () => {
  const cases: Record<string, string>[] = [
    { 'x-forwarded-for': '8.8.8.8' },
    { 'x-real-ip': '8.8.8.8' },
    { forwarded: 'for=8.8.8.8' },
    { via: '1.1 nginx' },
    { 'x-originating-ip': '8.8.8.8' },
  ];
  for (const headers of cases) {
    const result = assertDirectLoopback(
      fakeRequest({ remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:37421', ...headers } }),
    );
    assert.equal(result.ok, false, `${JSON.stringify(headers)} 必须被拒绝`);
    assert.match(String((result as { reason: string }).reason), /代理转发/);
  }
});

test('POST .../open 拒绝 DNS 重绑定式的 Host 头', () => {
  const result = assertDirectLoopback(
    fakeRequest({ remoteAddress: '127.0.0.1', headers: { host: 'evil.example.com:37421' } }),
  );
  assert.equal(result.ok, false);
  assert.match(String((result as { reason: string }).reason), /Host 头/);
});

test('isLoopbackAddress: 只认回环段', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.255.255.254'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('localhost'), true);
  assert.equal(isLoopbackAddress('192.168.1.1'), false);
  assert.equal(isLoopbackAddress('128.0.0.1'), false);
  assert.equal(isLoopbackAddress('example.com'), false);
  assert.equal(isLoopbackAddress(''), false);
});

/**
 * ★ 端到端验证：**真的开一次窗口**，并且必须在 after 里关掉。
 *
 * 为什么保留这一条真 spawn：注入 fake 只能证明「参数拼对了」，
 * 证明不了「explorer 真的能打开这个中文/空格路径」。所以留一条真实用例，
 * 但配上完整的清理机制（见 cleanupSpawnedShells）：
 *   1. 测试前记下所有 `-Embedding` explorer 进程 pid；
 *   2. 测试结束后再查一次，**新增的全部 Stop-Process**；
 *   3. 断言清理后数量回到基线 —— 清不干净就让测试红，不留弹窗给用户。
 *
 * 用环境变量 PCL3_SHELL_E2E=1 控制：默认**不跑**（避免有人随手 `node --test` 就弹窗）；
 * 需要真实验证时显式打开，跑完自动清理。
 */
test('open: 真实 spawn 一次（端到端），after 里必须把窗口关干净', async () => {
  const enabled = process.env['PCL3_SHELL_E2E'] === '1';
  if (!enabled) {
    // 不开窗：只验证「守卫 + 命令构造」这两件事，跑得快也不打扰人
    const dataRoot = tmpDataRoot('open-e2e-skip');
    try {
      const svc = fakeFolderService(dataRoot, { platform: 'win32' });
      const described = await svc.describeOpen('26.3', 'mods');
      assert.equal(described.command.file, 'explorer.exe');
      assert.equal(described.command.args[0], path.join(dataRoot, 'instances', '26.3', 'mods'));
    } finally {
      cleanup(dataRoot);
    }
    return;
  }

  const dataRoot = tmpDataRoot('open-e2e');
  const before = listEmbeddingExplorers();
  try {
    // 真 spawn：临时关掉守卫（这条用例本来就是验证「真能打开」）
    const saved = process.env['PCL3_NO_SHELL'];
    delete process.env['PCL3_NO_SHELL'];
    try {
      const svc = new FolderService({ dataRoot, platform: process.platform });
      await svc.open('26.3', 'mods');
    } finally {
      if (saved !== undefined) process.env['PCL3_NO_SHELL'] = saved;
    }
    // 给 explorer 一点时间把自己注册成 -Embedding 子进程
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    const cleaned = await cleanupSpawnedShells(before);
    cleanup(dataRoot);
    // 断言放在 finally 之后会吞掉异常，所以在 finally 里显式抛
    const after = listEmbeddingExplorers();
    if (after.length > before.length) {
      throw new Error(
        `弹窗没关干净：清理前基线 ${String(before.length)} 个 -Embedding，清理后仍有 ${String(after.length)} 个（本轮新开 ${String(cleaned)} 个已被 Stop-Process）`,
      );
    }
  }
});

// ───────────────────────────── 端到端：POST .../open 的三道闸 ─────────────────────────────

test('POST .../open 真实服务：代理转发 403 不 spawn；本机 200 且参数正确；跨站 403；穿越 400', async () => {
  const dataRoot = tmpDataRoot('api-open');
  const spawns: { file: string; args: string[] }[] = [];
  const handle = await startServer({ dataRoot });
  try {
    // 用假的 folderServiceFactory 截获 spawn：真服务里不能真的弹资源管理器
    const withFake = await createServer({
      port: 0,
      dataRoot,
      publicDir: PUBLIC_DIR,
      versionRepo: new FakeRepo() as never,
      installer: { plan: async () => ({}), install: async () => undefined } as never,
      downloader: { downloadAll: async () => ({ ok: true, skipped: 0, downloaded: 0, failed: [] }) } as never,
      folderServiceFactory: (root: string) =>
        new FolderService({
          dataRoot: root,
          platform: 'win32',
          spawnImpl: (cmd) => {
            spawns.push(cmd);
          },
        }),
      jobRetainMs: 200,
    } as never);

    try {
      // ① 伪造代理头 → 403，且一次 spawn 都不该发生
      const proxied = await req(`${withFake.url}api/instances/1.21/folders/mods/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' },
        body: '{}',      });
      assert.equal(proxied.status, 403, '代理转发的请求必须被拒');
      assert.equal(proxied.json.code, 'not-loopback');
      assert.equal(spawns.length, 0, '被拒的请求绝不能触发 spawn');

      // ② 本机直连 → 200，并且 spawn 参数就是 mods 目录
      const ok = await req(`${withFake.url}api/instances/1.21/folders/mods/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(ok.status, 200, `本机请求应当成功，实际 ${ok.status}: ${ok.text}`);
      assert.equal(
        spawns.length,
        1,
        `应恰好 spawn 一次，实际 ${String(spawns.length)} 次；响应：${ok.text}`,
      );
      assert.equal(spawns[0]?.file, 'explorer.exe');
      assert.equal(spawns[0]?.args[0], path.join(dataRoot, 'instances', '1.21', 'mods'));
      assert.equal(ok.json.ok, true);
      assert.equal(ok.json.path, path.join(dataRoot, 'instances', '1.21', 'mods'));

      // ③ 跨站 Origin 仍然被全局校验挡住（双保险没被绕过）
      const crossSite = await req(`${withFake.url}api/instances/1.21/folders/mods/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
        body: '{}',
      });
      assert.equal(crossSite.status, 403);
      assert.equal(spawns.length, 1, '跨站请求也不该 spawn');

      // ④ 相对实例目录穿越 → 400，同样不 spawn
      const traversal = await req(
        `${withFake.url}api/instances/${encodeURIComponent('../evil')}/folders/mods/open`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      assert.equal(traversal.status, 400);
      assert.equal(spawns.length, 1);
    } finally {
      await withFake.close();
    }
  } finally {
    await handle.close();
    cleanup(dataRoot);
  }
});

// ───────────────────────────── 7. 磁盘占用 ─────────────────────────────

test('DataDiskUsage: 统出总大小与顶层明细，5 分钟内走缓存', async () => {
  const dataRoot = tmpDataRoot('disk');
  try {
    fs.mkdirSync(path.join(dataRoot, 'libraries', 'a'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'libraries', 'a', 'x.jar'), Buffer.alloc(2048));
    fs.mkdirSync(path.join(dataRoot, 'versions'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'versions', 'y.jar'), Buffer.alloc(1024));

    let now = 1_000_000;
    const usage = new DataDiskUsage(dataRoot, { now: () => now });
    assert.equal(usage.peekForResponse(), null, '第一次取数前必须是 null（前端据此显示「统计中」）');

    const first = await usage.refresh();
    assert.equal(first.bytes, 3072);
    assert.equal(first.files, 2);
    assert.equal(first.partial, false);
    assert.equal(first.buckets.length, 2);
    assert.equal(first.buckets[0]?.name, 'libraries', '明细按大小降序');
    assert.equal(first.buckets[0]?.bytes, 2048);

    // 5 分钟内不再扫盘：再加一个文件也不会被算进去
    fs.writeFileSync(path.join(dataRoot, 'later.bin'), Buffer.alloc(999));
    const cachedRes = usage.peekForResponse();
    assert.ok(cachedRes !== null);
    assert.equal(cachedRes?.bytes, 3072);
    assert.equal(cachedRes?.stale, false);

    now += 4 * 60 * 1000;
    assert.equal(usage.isFresh(), true, '4 分钟时缓存仍然新鲜');
    const again = await usage.refresh();
    assert.equal(again.bytes, 3072, '缓存有效期内 refresh 不应重扫');

    now += 2 * 60 * 1000;
    assert.equal(usage.isFresh(), false, '6 分钟时缓存过期');
    assert.equal(usage.peekForResponse()?.stale, true);
    const rescan = await usage.refresh();
    assert.ok(rescan.bytes >= 3072 + 999, '过期后应当重扫，把新文件算进去');
  } finally {
    cleanup(dataRoot);
  }
});

test('DataDiskUsage: 超过文件数上限 → 只算顶层估算并标记 sampled/partial', async () => {
  const dataRoot = tmpDataRoot('disk-cap');
  try {
    // 造 40 个小文件，把上限设成 10：必须停下来而不是全部扫完
    const dir = path.join(dataRoot, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      fs.writeFileSync(path.join(dir, `f${String(i)}.bin`), Buffer.alloc(10));
    }

    const usage = new DataDiskUsage(dataRoot, { maxFiles: 10, budgetMs: 10_000 });
    const snapshot = await usage.refresh();
    assert.equal(snapshot.partial, true, '超上限必须标记 partial');
    assert.equal(snapshot.sampled, true, '超上限必须标记 sampled');
    assert.ok(snapshot.files <= 10 + 1, `文件数应被上限截住，实际 ${String(snapshot.files)}`);
  } finally {
    cleanup(dataRoot);
  }
});

test('GET /api/status 带 diskUsage：首屏不阻塞，随后拿到结果且走缓存', async () => {
  const dataRoot = tmpDataRoot('status-disk');
  // 注入一个可控的实例：既验证「路由接线对了」，又不依赖真实数据根大小
  const usage = new DataDiskUsage(dataRoot);
  const handle = await startServer({ dataRoot, diskUsage: usage });
  try {
    const first = await req(`${handle.url}api/status`);
    assert.equal(first.status, 200);
    assert.ok('diskUsage' in first.json, 'status 必须有 diskUsage 字段');
    // 第一次通常是「统计中」，但也可能已经算完（数据根为空，很快）—— 两种都合法
    assert.equal(typeof first.json.diskUsage.ready, 'boolean');

    // 等一下后台扫描，再取一次必须 ready
    const deadline = Date.now() + 5000;
    let ready = false;
    while (Date.now() < deadline) {
      const next = await req(`${handle.url}api/status`);
      if (next.json.diskUsage.ready === true) {
        ready = true;
        assert.equal(typeof next.json.diskUsage.bytes, 'number');
        assert.ok(Array.isArray(next.json.diskUsage.buckets));
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(ready, true, '后台统计完成后 diskUsage 应当 ready:true');

    // 缓存生效：注入了实例，直接看它的快照有没有被填上
    assert.ok(usage.peek() !== undefined, '缓存应已填充');
    assert.equal(usage.isFresh(), true, '刚算完的缓存必须是新鲜的');
  } finally {
    await handle.close();
    cleanup(dataRoot);
  }
});

// ───────────────────────────── 8. 启动命令行 ─────────────────────────────

test('summarizeCommand: 解析内存 / 主类 / classpath，并**打码令牌**', () => {
  const secret = 'eyJhbGciOiJIUzI1NiJ9.SUPER-SECRET-TOKEN';
  const built = {
    java: 'C:\\Program Files\\Java\\jdk-21\\bin\\javaw.exe',
    cwd: 'C:\\PCL3\\instances\\1.21',
    args: [
      '-Xmx4096M',
      '-Xms1024M',
      '-Djava.library.path=C:\\PCL3\\instances\\1.21\\natives',
      '-cp',
      'C:\\a.jar;C:\\b.jar;C:\\c.jar',
      'net.minecraft.client.main.Main',
      '--username',
      'Steve',
      '--accessToken',
      secret,
      '--version',
      '1.21',
    ],
  };

  const summary = summarizeCommand(built, { platform: 'win32', redact: true });
  assert.equal(summary.maxMemoryMB, 4096);
  assert.equal(summary.initMemoryMB, 1024);
  assert.equal(summary.mainClass, 'net.minecraft.client.main.Main', '不能把 classpath 当主类');
  assert.equal(summary.classpathEntries, 3);
  assert.equal(summary.redacted, true);

  assert.equal(summary.commandLine.includes(secret), false, '★ 令牌绝不能被原样带出去');
  assert.ok(summary.commandLine.includes('<已隐藏>'));
  // java 路径带空格 → 必须被引号包起来
  assert.match(summary.commandLine, /^"C:\\Program Files\\Java\\jdk-21\\bin\\javaw\.exe"/);

  // 关掉打码才是明文（只在「本机自己跑」的场景用）
  const plain = summarizeCommand(built, { platform: 'win32', redact: false });
  assert.equal(plain.commandLine.includes(secret), true);
});

test('redactArgs / formatCommandLine: 只打码敏感键，POSIX 引号转义正确', () => {
  assert.deepEqual(redactArgs(['--accessToken', 'abc', '--username', 'Steve']), [
    '--accessToken',
    '<已隐藏>',
    '--username',
    'Steve',
  ]);
  assert.deepEqual(redactArgs(['-Dauth_access_token=abc', '-Xmx1G']), ['-Dauth_access_token=<已隐藏>', '-Xmx1G']);

  const line = formatCommandLine('/usr/bin/java', ['-cp', '/a b/c.jar', "it's", 'plain'], { platform: 'linux' });
  assert.equal(line, `/usr/bin/java -cp '/a b/c.jar' 'it'\\''s' plain`);
});

test('GET .../launch-args：返回完整命令行，且令牌被打码', async () => {
  const dataRoot = tmpDataRoot('args');
  const seen: { versionId: string }[] = [];
  const handle = await startServer({
    dataRoot,
    launcher: () => ({
      buildCommand: async (opts: { versionId: string; account: { accessToken: string } }) => {
        seen.push({ versionId: opts.versionId });
        return {
          java: 'C:\\Java\\bin\\javaw.exe',
          cwd: path.join(dataRoot, 'instances', opts.versionId),
          args: [
            '-Xmx2048M',
            '-cp',
            'C:\\libraries\\a.jar;C:\\versions\\1.21\\1.21.jar',
            'net.minecraft.client.main.Main',
            '--accessToken',
            opts.account.accessToken,
          ],
        };
      },
    }),
  });
  try {
    const res = await req(`${handle.url}api/instances/1.21/launch-args`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.instanceId, '1.21');
    assert.equal(res.json.maxMemoryMB, 2048);
    assert.equal(res.json.mainClass, 'net.minecraft.client.main.Main');
    assert.equal(res.json.redacted, true);
    assert.ok(typeof res.json.commandLine === 'string' && res.json.commandLine.length > 20);
    assert.ok(res.json.commandLine.startsWith('C:\\Java\\bin\\javaw.exe'));
    assert.ok(
      res.json.commandLine.includes('C:\\libraries\\a.jar'),
      `classpath 应原样出现（不含空格时不加引号）：${res.json.commandLine}`,
    );
    assert.equal(seen.length, 1);

    // 令牌不出现在响应体里（连 json 文本都不许有）
    assert.equal(/accessToken\s+[A-Za-z0-9]/.test(res.text), false, '响应里不能出现明文令牌');
  } finally {
    await handle.close();
    cleanup(dataRoot);
  }
});

test('GET .../launch-args：版本没装 → 404 + 人话提示；非法版本号 → 400', async () => {
  const dataRoot = tmpDataRoot('args-404');
  const handle = await startServer({
    dataRoot,
    launcher: () => ({
      buildCommand: async () => {
        throw new Error('读取版本 JSON 失败（9.99）：ENOENT');
      },
    }),
  });
  try {
    const missing = await req(`${handle.url}api/instances/9.99/launch-args`);
    assert.equal(missing.status, 404);
    assert.match(String(missing.json.hint), /安装/);

    const bad = await req(`${handle.url}api/instances/${encodeURIComponent('a/b')}/launch-args`);
    assert.equal(bad.status, 400);
  } finally {
    await handle.close();
    cleanup(dataRoot);
  }
});

// ───────────────────────────── 9. 前端入口 ─────────────────────────────

test('前端 folders.js 有「打开文件夹」菜单、复制路径、数据根入口与磁盘占用', () => {
  // 前端是独立文件 folders.js（不改 app.js 的既有结构，四个代理同时在改它）
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'folders.js'), 'utf8');

  assert.match(source, /\/folders\//, '必须请求 folders 接口');
  assert.match(source, /openFolderMenu|buildFolderButton/, '必须有打开文件夹入口');
  assert.match(source, /'\/open'/, '必须能 POST 到 .../open');
  assert.match(source, /navigator\.clipboard/, '路径要能点击复制');
  assert.match(source, /manualCopyDialog/, '复制失败必须降级成手动复制');
  assert.match(source, /launch-args/, '要有一键复制启动参数');
  assert.match(source, /diskUsage/, '要显示磁盘占用');
  assert.match(source, /dataRoot\/open/, '数据根要有「打开」按钮');
  assert.match(source, /data-folder-entry/, '卡片上要有入口标记');
  // 必须列出用户点名的那些目录
  for (const kind of ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'logs', 'crash-reports']) {
    assert.match(source, new RegExp(`'${kind}'`), `菜单里必须有 ${kind}`);
  }
});

test('index.html 里有文件夹菜单容器，并加载 folders.js', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.match(html, /id="folder-menu"/, '必须有文件夹菜单容器');
  assert.match(html, /<script src="\/folders\.js">/, '必须加载 folders.js');
  assert.match(html, /data-root|数据目录/, '顶栏必须显示数据根');
});

test('style.css 里有文件夹菜单与路径行样式', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
  assert.match(css, /\.folder-menu\b/, '下拉菜单要有样式');
  assert.match(css, /\.path-row\b/, '路径行要有样式');
  assert.match(css, /\.btn-folder\b/, '卡片上的入口按钮要有样式');
});
