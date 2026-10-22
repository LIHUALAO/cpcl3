/**
 * install 完整性测试 —— 专门抓「假成功」。
 *
 * 为什么单独开一个文件：现有 273 个测试全绿却漏掉了真实事故
 * （asset index 声明 5147 个对象、磁盘只有 87 个，UI 仍然显示「安装成功」）。
 * 复盘的结论是测试断言的层次错了：install 测试用的是 FakeDownloader，
 * 它把「任务交给我了」当成「文件已经落盘」，于是 install() 的返回值
 * 与磁盘上究竟有没有文件之间**从来没有被比较过**。
 *
 * 这里补齐三件事：
 *
 *   A. 契约级：downloader 返回 ok:false 时 install() 必须抛错，
 *      并且**不能**把这个失败吞掉继续往下跑（含中途失败的阶段顺序断言）。
 *   B. 真实副作用级：用真实 Downloader 把一个真实小版本（1.8.9）装到临时目录，
 *      然后**逐文件**核对磁盘：asset index 里的每个 hash、每个 library artifact、
 *      client jar 都必须存在且大小一致。网络不可达时整组 SKIP 并说明理由。
 *   C. 工具级：scripts/audit-install.mjs 作为独立的判据，必须在「少一个文件」的
 *      假目录上报出缺失并给出退出码 1；也要在完整目录上报 0 缺失 —— 否则它自己
 *      就是个只会喊 OK 的假工具。
 *
 * 环境变量：
 *   PCL3_SKIP_NETWORK_TESTS=1  强制跳过 B 组（CI 里没网时用）
 *   PCL3_REAL_INSTALL_TEST=1   **B 组默认关闭**，只有显式设为 1 才跑真实下载。
 *                              为什么默认关：B 组要真下整个 1.8.9（上百 MB、
 *                              几分钟），而且网络抖动时会长时间挂起，把 `npm test`
 *                              拖成「看起来卡死」。日常回归用 A/C 两组足够；
 *                              发版前或改过下载/安装逻辑时再手动开一次。
 *   PCL3_TEST_CACHE            真实安装测试的缓存目录，默认项目下 test/.cache
 *   PCL3_TMP_ROOT              临时数据根所在目录，默认系统 temp
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AssetIndex,
  DownloadResult,
  DownloadProgress,
  DownloadTask,
  VersionJson,
} from '../src/core/types.js';
import { VanillaInstaller } from '../src/core/install/index.js';
import type { OsInfo } from '../src/core/install/rules.js';
import { Downloader, resetDataRootCache } from '../src/core/download/index.js';
import { VersionRepository } from '../src/core/version/index.js';

// ───────────────────────────── 路径与常量 ─────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'audit-install.mjs');
const WINDOWS: OsInfo = { name: 'windows', arch: 'x86_64', version: '10.0.19045' };

/** 真实安装测试的目标版本：小、稳、结构简单（没有继承链） */
const REAL_VERSION = '1.8.9';

/** 单次真实安装测试的硬超时（毫秒）。CI 上慢机器也别无限挂着。 */
const REAL_INSTALL_TIMEOUT_MS = Number(process.env['PCL3_REAL_INSTALL_TIMEOUT_MS'] ?? 15 * 60 * 1000);

const NETWORK_DISABLED = process.env['PCL3_SKIP_NETWORK_TESTS'] === '1';

/**
 * 真实下载测试（B 组）默认关闭。
 *
 * 背景：B 组要把整个 1.8.9（上百 MB）真下载到临时目录再逐文件核对。
 * 它是最有说服力的测试（能抓到「假成功」），但每次跑要几分钟，
 * 而且在网络抖动时会长时间等超时，让 `npm test` 看起来像卡死。
 *
 * 日常 `npm test` 只需要 A（契约）+ C（工具）两组，几秒就跑完。
 * 改过下载/安装/校验逻辑时，显式开一次真实验证：
 *   $env:PCL3_REAL_INSTALL_TEST = "1"
 *   npm test
 */
const REAL_INSTALL_ENABLED =
  process.env['PCL3_REAL_INSTALL_TEST'] === '1' && !NETWORK_DISABLED;

const CACHE_ROOT = path.resolve(process.env['PCL3_TEST_CACHE'] ?? path.join(REPO_ROOT, 'test', '.cache'));
const TEMP_PARENT = process.env['PCL3_TMP_ROOT'] ?? os.tmpdir();

// ───────────────────────────── 工具 ─────────────────────────────

function freshTempDir(tag: string): string {
  const parent = existsSync(TEMP_PARENT) ? TEMP_PARENT : os.tmpdir();
  return mkdtempSync(path.join(parent, `pcl3-integrity-${tag}-`));
}

function fileSize(p: string): number | undefined {
  try {
    const st = statSync(p);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/** 把 40 位 hash 变成 assets/objects 下的相对路径（与 install 模块同一规则） */
function assetRelPath(hash: string): string {
  return `${hash.slice(0, 2)}/${hash}`;
}

/**
 * 逐文件核对一个已经「装完」的数据目录。
 *
 * 这是本文件的核心判据：**只看磁盘**。
 * 它不理解下载器、不理解进度、也不信任任何返回值 ——
 * 这正是现有 fake 测试缺失的那一层。
 *
 * @returns 缺失清单（空数组代表真的齐了）
 */
export function verifyOnDisk(
  dataRoot: string,
  versionId: string,
  versionJson: VersionJson,
  assetIndex: AssetIndex,
  osInfo: OsInfo = WINDOWS,
): { missing: string[]; checked: number; sizeMismatch: string[] } {
  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  let checked = 0;

  const expectFile = (abs: string, size: number | undefined, label: string): void => {
    checked += 1;
    const actual = fileSize(abs);
    if (actual === undefined) {
      missing.push(label);
      return;
    }
    if (typeof size === 'number' && actual !== size) {
      sizeMismatch.push(`${label}（声明 ${String(size)}，实际 ${String(actual)}）`);
    }
  };

  // 1) asset index 的每一个对象
  for (const [name, obj] of Object.entries(assetIndex.objects ?? {})) {
    expectFile(path.join(dataRoot, 'assets', 'objects', assetRelPath(obj.hash)), obj.size, `asset ${name}`);
  }

  // 2) 每个当前平台该装的 library artifact
  for (const lib of versionJson.libraries ?? []) {
    const artifact = lib.downloads?.artifact;
    if (!artifact?.path) continue;
    // rules 过滤与安装器一致：别的平台的库本来就不该存在，不算缺失
    if (!rulesAllowForTest(lib.rules, osInfo)) continue;
    expectFile(path.join(dataRoot, 'libraries', artifact.path), artifact.size, `lib ${lib.name}`);
  }

  // 3) client jar
  const client = versionJson.downloads?.['client'];
  if (client) {
    expectFile(path.join(dataRoot, 'versions', versionId, `${versionId}.jar`), client.size, 'client jar');
  }

  return { missing, checked, sizeMismatch };
}

/** 测试自用的 rules 求值（与 install/rules.ts 同义，避免依赖内部实现细节） */
function rulesAllowForTest(rules: { action: string; os?: { name?: string; arch?: string } }[] | undefined, osInfo: OsInfo): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.os?.name !== undefined && rule.os.name !== osInfo.name) continue;
    if (rule.os?.arch !== undefined && rule.os.arch !== osInfo.arch) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

/** 跑 audit 脚本，返回 { code, stdout, stderr } */
function runAuditScript(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [AUDIT_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    // 中文输出：强制 UTF-8，避免 Windows 默认代码页把 stdout 变成乱码
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

// ───────────────────────────── 夹具 ─────────────────────────────

/**
 * 记录任务的 fake downloader。
 *
 * 与 install.test.ts 里那个不同：本文件的 fake 只如实汇报结果，
 * **不负责「假装成功」** —— 声称下载成功时真的把文件写到 dest。
 *
 * 为什么必须写盘（P0 教训）：`downloadAll` 的契约语义就是「把文件下载到 dest」。
 * 一个报告 `downloaded = tasks.length` 却一个字节都不落盘的 fake，本身就是
 * 「假成功」的形态 —— 而这正是 P0 要拦的东西。安装器现在收尾会 stat 复核，
 * 不写盘的 fake 会被正确地判定为失败。所以要测「真成功不误报」，
 * fake 必须先像个真的下载器。
 */
class ScriptedDownloader {
  readonly calls: { phase: string; tasks: DownloadTask[] }[] = [];
  private readonly fail: (task: DownloadTask) => boolean;
  /** 关掉后模拟「报告成功但不落盘」，仅用于验证磁盘复核能抓住这种假成功 */
  private readonly writeFiles: boolean;

  constructor(fail: (task: DownloadTask) => boolean = () => false, writeFiles = true) {
    this.fail = fail;
    this.writeFiles = writeFiles;
  }

  async downloadAll(tasks: DownloadTask[], onProgress?: (p: DownloadProgress) => void): Promise<DownloadResult> {
    this.calls.push({ phase: '', tasks });
    const failed: DownloadTask[] = [];
    let done = 0;
    for (const task of tasks) {
      onProgress?.({ done, total: tasks.length, current: task.dest });
      const shouldFail = this.fail(task);
      if (shouldFail) {
        failed.push(task);
      } else if (this.writeFiles) {
        // 真的落盘，让「成功」名副其实
        mkdirSync(path.dirname(task.dest), { recursive: true });
        writeFileSync(task.dest, 'x', 'utf8');
      }
      done += 1;
    }
    onProgress?.({ done, total: tasks.length, current: '' });
    return { ok: failed.length === 0, skipped: 0, downloaded: tasks.length - failed.length, failed };
  }
}

class StaticVersionRepo {
  private readonly versions: Record<string, VersionJson>;

  constructor(versions: Record<string, VersionJson>) {
    this.versions = versions;
  }
  async fetchManifest(): Promise<never> {
    throw new Error('integrity 测试不该联网拉 manifest（版本 JSON 已预置）');
  }
  async fetchVersion(id: string): Promise<VersionJson> {
    const found = this.versions[id];
    if (!found) throw new Error(`unknown version ${id}`);
    return found;
  }
  async resolveInherited(json: VersionJson): Promise<VersionJson> {
    return json;
  }
}

/** 造一个体积很小、但结构完整的版本（3 个库 + 1 个 macOS 库 + 1 个 native） */
function makeSmallVersion(assetIndex: AssetIndex): VersionJson {
  void assetIndex;
  return {
    id: 'fake-1.0',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'test',
    assetIndex: { id: 'test', sha1: 'a'.repeat(40), size: 100, totalSize: 1000, url: 'https://example.invalid/test.json' },
    downloads: {
      client: { sha1: 'b'.repeat(40), size: 4096, url: 'https://example.invalid/client.jar' },
    },
    libraries: [
      {
        name: 'com.mojang:logging:1.0',
        downloads: {
          artifact: {
            path: 'com/mojang/logging/1.0/logging-1.0.jar',
            sha1: 'c'.repeat(40),
            size: 1024,
            url: 'https://libraries.minecraft.net/com/mojang/logging/1.0/logging-1.0.jar',
          },
        },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.3',
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
            sha1: 'd'.repeat(40),
            size: 2048,
            url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
          },
          classifiers: {
            'natives-windows': {
              path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
              sha1: 'e'.repeat(40),
              size: 512,
              url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
            },
          },
        },
        natives: { windows: 'natives-windows' },
      },
      {
        // macOS 专属：Windows 下必须被 rules 过滤
        name: 'ca.weblite:java-objc-bridge:1.1',
        rules: [{ action: 'allow', os: { name: 'osx' } }],
        downloads: {
          artifact: {
            path: 'ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar',
            sha1: 'f'.repeat(40),
            size: 1024,
            url: 'https://libraries.minecraft.net/ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar',
          },
        },
      },
    ],
  };
}

function makeAssetIndex(count: number): AssetIndex {
  const objects: AssetIndex['objects'] = {};
  for (let i = 0; i < count; i += 1) {
    const prefix = (i % 256).toString(16).padStart(2, '0');
    const hash = `${prefix}${String(i).padStart(38, '0')}`;
    objects[`minecraft/test/${String(i)}.bin`] = { hash, size: 64 + i };
  }
  return { objects };
}

// ═══════════════════════════════ A. 契约级 ═══════════════════════════════

describe('A. install() 必须传播下载失败（契约级）', () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = freshTempDir('contract');
  });
  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('downloader 返回 ok:false 时 install() 抛错，且错误里带失败文件名', async () => {
    const assetIndex = makeAssetIndex(3);
    const root = path.join(tmpRoot, 'ok-false');
    mkdirSync(path.join(root, 'assets', 'indexes'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'indexes', 'test.json'), JSON.stringify(assetIndex), 'utf8');

    const downloader = new ScriptedDownloader((task) => task.dest.endsWith('lwjgl-3.3.3.jar'));
    const installer = new VanillaInstaller(
      {
        versionRepo: new StaticVersionRepo({ 'fake-1.0': makeSmallVersion(assetIndex) }) as never,
        downloader: downloader as never,
      },
      { dataRoot: root, os: WINDOWS },
    );

    await assert.rejects(
      () => installer.install('fake-1.0'),
      (err: unknown) => {
        assert.ok(err instanceof Error, '必须抛 Error');
        // 错误信息必须能定位到具体文件和阶段，否则用户拿到等于没拿到
        assert.match(err.message, /下载失败/);
        assert.match(err.message, /libraries/);
        assert.match(err.message, /lwjgl-3\.3\.3\.jar/);
        return true;
      },
    );
  });

  it('失败点在 assets 阶段时，install() 不得继续往下写「安装完成」的 done 事件', async () => {
    const assetIndex = makeAssetIndex(4);
    const root = path.join(tmpRoot, 'assets-fail');
    mkdirSync(path.join(root, 'assets', 'indexes'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'indexes', 'test.json'), JSON.stringify(assetIndex), 'utf8');

    // 只让 assets 阶段失败：dest 落在 assets/objects 下
    const failingAsset = Object.values(assetIndex.objects)[1]!;
    const downloader = new ScriptedDownloader((task) =>
      task.dest.endsWith(path.join('objects', assetRelPath(failingAsset.hash))),
    );
    const installer = new VanillaInstaller(
      {
        versionRepo: new StaticVersionRepo({ 'fake-1.0': makeSmallVersion(assetIndex) }) as never,
        downloader: downloader as never,
      },
      { dataRoot: root, os: WINDOWS },
    );

    const phases: string[] = [];
    await assert.rejects(
      () =>
        installer.install('fake-1.0', (p) => {
          if (phases.at(-1) !== p.phase) phases.push(p.phase);
        }),
      /下载失败/,
    );

    // 关键断言：没有走到 done。走到 done 就等于对上层宣布「装好了」。
    assert.ok(!phases.includes('done'), `失败时不应上报 done 阶段，实际阶段顺序：${phases.join(' → ')}`);
    assert.equal(phases.at(-1), 'assets');
  });

  it('所有下载都成功时 install() 正常返回并上报 done（防止上一个用例把契约写反）', async () => {
    const assetIndex = makeAssetIndex(2);
    const root = path.join(tmpRoot, 'all-ok');
    mkdirSync(path.join(root, 'assets', 'indexes'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'indexes', 'test.json'), JSON.stringify(assetIndex), 'utf8');

    const installer = new VanillaInstaller(
      {
        versionRepo: new StaticVersionRepo({ 'fake-1.0': makeSmallVersion(assetIndex) }) as never,
        downloader: new ScriptedDownloader() as never,
      },
      { dataRoot: root, os: WINDOWS },
    );

    const phases: string[] = [];
    await installer.install('fake-1.0', (p) => {
      if (phases.at(-1) !== p.phase) phases.push(p.phase);
    });
    assert.deepEqual(phases, ['meta', 'libraries', 'natives', 'assets', 'done']);
  });

  it('P0 防线：downloader 报告成功但没写盘 → 收尾磁盘复核必须拦下（不得假成功）', async () => {
    const assetIndex = makeAssetIndex(2);
    const root = path.join(tmpRoot, 'silent-success');
    mkdirSync(path.join(root, 'assets', 'indexes'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'indexes', 'test.json'), JSON.stringify(assetIndex), 'utf8');

    const installer = new VanillaInstaller(
      {
        versionRepo: new StaticVersionRepo({ 'fake-1.0': makeSmallVersion(assetIndex) }) as never,
        // writeFiles=false：报告 downloaded=tasks.length，但一个字节都不落盘
        downloader: new ScriptedDownloader(() => false, false) as never,
      },
      { dataRoot: root, os: WINDOWS },
    );

    const phases: string[] = [];
    await assert.rejects(
      () =>
        installer.install('fake-1.0', (p) => {
          if (phases.at(-1) !== p.phase) phases.push(p.phase);
        }),
      /收尾复核|下载失败/,
      '声称成功却没落盘，必须被磁盘复核拦下——这正是 P0 假成功的形态',
    );

    // 关键断言：不能上报 done。上报 done 就等于对用户宣布「装好了」。
    assert.ok(!phases.includes('done'), `假成功时不应上报 done，实际阶段：${phases.join(' → ')}`);
  });
});

// ═══════════════════════════ B. 真实副作用级 ═══════════════════════════

describe('B. 真实安装（真 Downloader + 真网络）后逐文件核对落盘', () => {
  let dataRoot: string;
  let versionJson: VersionJson | undefined;
  let assetIndex: AssetIndex | undefined;
  let skipReason: string | undefined;

  before(async () => {
    dataRoot = freshTempDir('real');
    // getDataRoot() 有进程内缓存，先把环境变量摆好再清缓存，避免装到用户真实目录
    process.env['PCL3_DATA_ROOT'] = dataRoot;
    resetDataRootCache();

    if (NETWORK_DISABLED) {
      skipReason = '已设置 PCL3_SKIP_NETWORK_TESTS=1，主动跳过联网测试。';
      return;
    }

    if (!REAL_INSTALL_ENABLED) {
      skipReason =
        'B 组默认关闭（要真下载整个 1.8.9，耗时数分钟）。' +
        '设 PCL3_REAL_INSTALL_TEST=1 后重跑即可开启真实验证。';
      return;
    }

    // 缓存目录：复用上一次下好的元数据与文件（Downloader 会按 sha1 跳过已就绪的文件）
    mkdirSync(CACHE_ROOT, { recursive: true });

    const repo = new VersionRepository({ dataRoot, timeoutMs: 20_000, retries: 2 });
    try {
      const raw = await repo.fetchVersion(REAL_VERSION);
      const resolved = await repo.resolveInherited(raw);
      versionJson = resolved;

      // 先落一份 asset index（install 会再次 ensure 它，这里只是让 plan 立刻能展开）
      const indexId = resolved.assetIndex?.id ?? resolved.assets;
      const indexPath = path.join(dataRoot, 'assets', 'indexes', `${indexId}.json`);
      mkdirSync(path.dirname(indexPath), { recursive: true });
      if (existsSync(indexPath)) {
        assetIndex = JSON.parse(readFileSync(indexPath, 'utf8')) as AssetIndex;
      } else if (resolved.assetIndex?.url) {
        const res = await fetch(resolved.assetIndex.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`asset index HTTP ${String(res.status)}`);
        const text = await res.text();
        writeFileSync(indexPath, text, 'utf8');
        assetIndex = JSON.parse(text) as AssetIndex;
      } else {
        throw new Error('版本 JSON 既没有本地 asset index 也没有 assetIndex.url');
      }
    } catch (err) {
      skipReason = `元数据不可达，跳过真实安装测试（${String((err as Error).message ?? err)}）。`;
      return;
    }

    // 真的装一遍
    const downloader = new Downloader({ concurrency: 8, retries: 2 });
    const installer = new VanillaInstaller({ versionRepo: repo, downloader }, { dataRoot });
    try {
      await installer.install(REAL_VERSION);
    } catch (err) {
      // 下载失败同样不算「跳过」：这正是我们要抓的失败，让用例自己红
      skipReason = undefined;
      throw err;
    }
  });

  after(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env['PCL3_DATA_ROOT'];
    resetDataRootCache();
  });

  it(`${REAL_VERSION}：asset index 里每个对象都真的落在 assets/objects/<xx>/<hash>`, (t) => {
    if (skipReason !== undefined || versionJson === undefined || assetIndex === undefined) {
      t.skip(skipReason ?? '前置步骤未产出元数据');
      return;
    }
    const objectsRoot = path.join(dataRoot, 'assets', 'objects');
    const missing: string[] = [];
    for (const [name, obj] of Object.entries(assetIndex.objects)) {
      const abs = path.join(objectsRoot, assetRelPath(obj.hash));
      const size = fileSize(abs);
      if (size === undefined) missing.push(`${name} → ${assetRelPath(obj.hash)}`);
      else assert.equal(size, obj.size, `asset ${name} 大小不符`);
    }
    assert.deepEqual(
      missing.slice(0, 10),
      [],
      `assets 缺失 ${String(missing.length)}/${String(Object.keys(assetIndex.objects).length)} 个，前 10 个：\n${missing.slice(0, 10).join('\n')}`,
    );
  });

  it(`${REAL_VERSION}：每个该装的 library artifact 与 client jar 都在，且大小一致`, (t) => {
    if (skipReason !== undefined || versionJson === undefined || assetIndex === undefined) {
      t.skip(skipReason ?? '前置步骤未产出元数据');
      return;
    }
    const result = verifyOnDisk(dataRoot, REAL_VERSION, versionJson, assetIndex, WINDOWS);
    assert.deepEqual(result.missing, [], `磁盘上缺失 ${String(result.missing.length)} 个文件：\n${result.missing.slice(0, 10).join('\n')}`);
    assert.deepEqual(result.sizeMismatch, [], `大小不符 ${String(result.sizeMismatch.length)} 个：\n${result.sizeMismatch.slice(0, 10).join('\n')}`);
    assert.ok(result.checked > 100, `核对数量异常地少（${String(result.checked)}），夹具可能没装到东西`);
  });

  it('audit 脚本对刚装好的真实目录判定为「无缺失」（退出码 0）', (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const res = runAuditScript([REAL_VERSION, '--data-root', dataRoot]);
    assert.equal(res.code, 0, `审计应以 0 退出，实际 ${String(res.code)}\n${res.stdout.slice(-2000)}\n${res.stderr.slice(-2000)}`);
    assert.match(res.stdout, /缺失率 0\.00%/);
  });
});

// ═══════════════════════════ C. 审计脚本自身 ═══════════════════════════

describe('C. audit-install.mjs：缺一个文件就必须报出来（退出码 1）', () => {
  let root: string;
  let assetIndex: AssetIndex;

  before(() => {
    root = freshTempDir('audit');
    assetIndex = makeAssetIndex(5);
    const version = { ...makeSmallVersion(assetIndex), id: 'audit-1.0' };

    mkdirSync(path.join(root, 'versions', 'audit-1.0'), { recursive: true });
    writeFileSync(
      path.join(root, 'versions', 'audit-1.0', 'audit-1.0.json'),
      JSON.stringify(version, null, 2),
      'utf8',
    );

    mkdirSync(path.join(root, 'assets', 'indexes'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'indexes', 'test.json'), JSON.stringify(assetIndex), 'utf8');

    // 把所有该有的文件都按声明大小造出来
    for (const obj of Object.values(assetIndex.objects)) {
      const abs = path.join(root, 'assets', 'objects', assetRelPath(obj.hash));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.alloc(obj.size, 1));
    }
    for (const lib of version.libraries) {
      const artifact = lib.downloads?.artifact;
      if (!artifact?.path || !rulesAllowForTest(lib.rules, WINDOWS)) continue;
      const abs = path.join(root, 'libraries', artifact.path);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.alloc(artifact.size, 2));
    }
    // natives classifier
    const nat = version.libraries[1]!.downloads!.classifiers!['natives-windows']!;
    const natAbs = path.join(root, 'libraries', nat.path!);
    mkdirSync(path.dirname(natAbs), { recursive: true });
    writeFileSync(natAbs, Buffer.alloc(nat.size, 3));

    mkdirSync(path.join(root, 'versions', 'audit-1.0', 'natives'), { recursive: true });
    writeFileSync(path.join(root, 'versions', 'audit-1.0', 'audit-1.0.jar'), Buffer.alloc(4096, 4));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('完整目录 → 退出码 0、缺失 0', () => {
    const res = runAuditScript(['audit-1.0', '--data-root', root]);
    assert.equal(res.code, 0, `应 0 退出，实际 ${String(res.code)}\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /缺失 0，缺失率 0\.00%/);
    assert.match(res.stdout, /结论：全部文件齐全/);
  });

  it('删掉一个 asset → 退出码 1、报出该 hash 且指出 assets 分组', () => {
    const victim = Object.entries(assetIndex.objects)[2]!;
    const abs = path.join(root, 'assets', 'objects', assetRelPath(victim[1].hash));
    rmSync(abs);

    const res = runAuditScript(['audit-1.0', '--data-root', root]);
    assert.equal(res.code, 1, `应 1 退出，实际 ${String(res.code)}\n${res.stdout}`);
    assert.ok(res.stdout.includes(victim[1].hash), '输出里必须出现缺失的 hash');
    assert.match(res.stdout, /assets 资源对象\s+声明\s+5\s+存在\s+4\s+缺失\s+1/);
    assert.match(res.stdout, /结论：安装不完整/);
  });

  it('文件在但大小不符 → 也算缺失（退出码 1）', () => {
    // 上面那个用例已经删了一个，先补回去，保证本用例只有一处问题是「尺寸」
    const victim = Object.entries(assetIndex.objects)[2]!;
    writeFileSync(path.join(root, 'assets', 'objects', assetRelPath(victim[1].hash)), Buffer.alloc(victim[1].size, 1));

    const trimmed = Object.entries(assetIndex.objects)[0]!;
    writeFileSync(
      path.join(root, 'assets', 'objects', assetRelPath(trimmed[1].hash)),
      Buffer.alloc(trimmed[1].size - 1, 1),
    );

    const res = runAuditScript(['audit-1.0', '--data-root', root]);
    assert.equal(res.code, 1, `应 1 退出，实际 ${String(res.code)}\n${res.stdout}`);
    assert.match(res.stdout, /尺寸不符/);
    assert.ok(res.stdout.includes(trimmed[1].hash), '输出里必须出现尺寸不符的 hash');

    // 复原，别影响后面用例
    writeFileSync(
      path.join(root, 'assets', 'objects', assetRelPath(trimmed[1].hash)),
      Buffer.alloc(trimmed[1].size, 1),
    );
  });

  it('缺 library 和 jar → 对应分组各自报 1 条', () => {
    rmSync(path.join(root, 'libraries', 'com', 'mojang', 'logging', '1.0', 'logging-1.0.jar'));
    rmSync(path.join(root, 'versions', 'audit-1.0', 'audit-1.0.jar'));

    const res = runAuditScript(['audit-1.0', '--data-root', root]);
    assert.equal(res.code, 1, `应 1 退出，实际 ${String(res.code)}\n${res.stdout}`);
    assert.match(res.stdout, /libraries 依赖库\s+声明\s+2\s+存在\s+1\s+缺失\s+1/);
    assert.match(res.stdout, /jar 客户端本体\s+声明\s+1\s+存在\s+0\s+缺失\s+1/);
    assert.match(res.stdout, /logging-1\.0\.jar/);

    // 复原
    mkdirSync(path.join(root, 'libraries', 'com', 'mojang', 'logging', '1.0'), { recursive: true });
    writeFileSync(path.join(root, 'libraries', 'com', 'mojang', 'logging', '1.0', 'logging-1.0.jar'), Buffer.alloc(1024, 2));
    writeFileSync(path.join(root, 'versions', 'audit-1.0', 'audit-1.0.jar'), Buffer.alloc(4096, 4));
  });

  it('rules 过滤掉的库（macOS 专属）缺文件不算缺失', () => {
    const res = runAuditScript(['audit-1.0', '--data-root', root]);
    assert.equal(res.code, 0, `java-objc-bridge 不该被算作缺失\n${res.stdout}`);
    assert.match(res.stdout, /跳过的库\s+：1 个/);
  });

  it('资源索引读不到 → 明确报警而不是静默判 OK', () => {
    const indexPath = path.join(root, 'assets', 'indexes', 'test.json');
    const backup = readFileSync(indexPath);
    rmSync(indexPath);
    const res = runAuditScript(['audit-1.0', '--data-root', root]);
    writeFileSync(indexPath, backup);
    assert.equal(res.code, 1, `索引缺失也要非 0，实际 ${String(res.code)}\n${res.stdout}`);
    assert.match(res.stdout, /读不到/);
  });

  it('版本 id 不存在 → 退出码 2（审计跑不起来 ≠ 文件缺失）', () => {
    const res = runAuditScript(['no-such-version', '--data-root', root]);
    assert.equal(res.code, 2, `应 2 退出，实际 ${String(res.code)}\n${res.stderr}`);
    assert.match(res.stderr, /找不到版本文件/);
  });

  it('数据目录不存在 → 退出码 2', () => {
    const res = runAuditScript(['audit-1.0', '--data-root', path.join(root, 'nope')]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /数据目录不存在/);
  });
});
