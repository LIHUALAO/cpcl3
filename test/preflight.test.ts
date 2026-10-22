/**
 * 启动前体检（preflight）测试。
 *
 * 覆盖目标（与任务书逐条对应）：
 *   A. 每一种 issue code 至少一条用例 —— 11 个 code 全覆盖
 *   B. `canLaunch` 判定：**只有 blocking 时**为 false；warning / info 不影响
 *   C. 体检必须快：5000 个 asset 的假 index 下 < 2 秒（这条决定了不能逐个 stat）
 *   D. 体检不改任何文件：前后文件数 / mtime / 内容全不变
 *   E. Web 集成：POST /api/preflight 原样返回 report；
 *      POST /api/launch 在有不可修 blocking 时 409、只有 warning 时照常 202
 *
 * 纪律（昨晚的教训）：
 *   - 临时目录一律 `after()` 清掉，`%TEMP%` 不留残留
 *   - 设 `PCL3_NO_SHELL=1`，绝不真实拉起外部进程
 *   - 全部用 fake 依赖（fs / repo / settings / java / mods），不联网
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AssetIndex, VersionJson, VersionManifest } from '../src/core/types.js';
import {
  MEMORY_MIN_LAUNCH_MB,
  PreflightChecker,
  loaderKindOf,
  sampleAssets,
  type PreflightCheckerDeps,
  type PreflightIssue,
  type PreflightReportDetail,
} from '../src/core/preflight/index.js';
import { detectPlatform } from '../src/core/launch/rules.js';
import { SettingsStore } from '../src/core/settings/index.js';
import { createServer, type WebServerHandle } from '../src/web/server.js';

// ───────────────────────────── 纪律：绝不拉起外部进程 ─────────────────────────────

process.env['PCL3_NO_SHELL'] = '1';

// ───────────────────────────── 临时目录（统一清理） ─────────────────────────────

const tempRoots: string[] = [];

function tmpDataRoot(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-preflight-${tag}-`));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 被占用就跳过；check-hygiene 会把它列出来 */
    }
  }
});

// ───────────────────────────── fake 依赖 ─────────────────────────────

const WINDOWS = detectPlatform('win32', 'x64');

/** 只实现契约最小面的 fake 仓库；版本 JSON 由测试预置 */
class FakeVersionRepo {
  private readonly versions: Record<string, VersionJson>;

  constructor(versions: Record<string, VersionJson>) {
    this.versions = versions;
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

/** fake 设置存储：只看内存值，不落盘 */
class FakeSettings {
  private readonly memory: Record<string, number>;
  private readonly javaPath: Record<string, string>;

  constructor(memory: Record<string, number> = {}, javaPath: Record<string, string> = {}) {
    this.memory = memory;
    this.javaPath = javaPath;
  }
  resolve(versionId: string, instanceId?: string): { id: string; versionId: string; memoryMB?: number; javaPath?: string } {
    const id = instanceId ?? versionId;
    const out: { id: string; versionId: string; memoryMB?: number; javaPath?: string } = { id, versionId };
    const mem = this.memory[versionId] ?? this.memory[id];
    if (mem !== undefined) out.memoryMB = mem;
    const jp = this.javaPath[versionId] ?? this.javaPath[id];
    if (jp !== undefined) out.javaPath = jp;
    return out;
  }
}

/** fake mod 管理器 */
class FakeModManager {
  private readonly mods: Record<string, { filename: string; id?: string; size: number; enabled: boolean }[]>;

  constructor(mods: Record<string, { filename: string; id?: string; size: number; enabled: boolean }[]>) {
    this.mods = mods;
  }
  async list(instanceId: string) {
    return this.mods[instanceId] ?? [];
  }
  modsDir(instanceId: string): string {
    return `/fake/mods/${instanceId}`;
  }
}

/** fake Java 安装器：能装 / 装不了 / 清单里有 / 没有 */
class FakeJavaInstaller {
  readonly installed: Set<string>;
  readonly manifestComponents: string[] | null;
  readonly throws: boolean;

  constructor(opts: { installed?: string[]; manifestComponents?: string[] | null; throws?: boolean } = {}) {
    this.installed = new Set(opts.installed ?? []);
    this.manifestComponents = opts.manifestComponents ?? null;
    this.throws = opts.throws === true;
  }
  isInstalled(component: string): boolean {
    return this.installed.has(component);
  }
  installedExecutable(): string | undefined {
    return undefined;
  }
  async majorVersionOf(): Promise<number | null> {
    return null;
  }
  async fetchManifest(): Promise<unknown> {
    if (this.throws) throw new Error('假装断网：ENOTFOUND launchermeta.mojang.com');
    if (this.manifestComponents === null) return {};
    // 造一个真实形状：platform → component → 条目数组
    const perPlatform: Record<string, unknown[]> = {};
    for (const component of this.manifestComponents) {
      perPlatform[component] = [{ version: { name: '21.0.5' } }];
    }
    return { 'windows-x64': perPlatform };
  }
}

// ───────────────────────────── 夹具 ─────────────────────────────

/** 造一个「已装好」的数据目录：版本 JSON + jar + 库 + asset index + 部分对象 */
function seedInstalledVersion(
  dataRoot: string,
  versionId: string,
  opts: {
    assetCount?: number;
    missingAssets?: number;
    missingLibs?: number;
    skipJar?: boolean;
    javaVersion?: { component: string; majorVersion: number };
    libraries?: number;
    inheritsFrom?: string;
    /** 额外写一份「祖先版本」的 jar + json（加载器场景） */
    ancestor?: string;
  } = {},
): { version: VersionJson; assetIndex: AssetIndex } {
  const assetCount = opts.assetCount ?? 4;
  const missingAssets = opts.missingAssets ?? 0;
  const libCount = opts.libraries ?? 3;
  const missingLibs = opts.missingLibs ?? 0;

  const objects: AssetIndex['objects'] = {};
  for (let i = 0; i < assetCount; i += 1) {
    const prefix = ((i * 7) % 256).toString(16).padStart(2, '0');
    const hash = `${prefix}${String(i).padStart(38, '0')}`;
    objects[`minecraft/sample/${String(i)}.bin`] = { hash, size: 16 + i };
  }
  const assetIndex: AssetIndex = { objects };

  const libraries: VersionJson['libraries'] = [];
  for (let i = 0; i < libCount; i += 1) {
    libraries.push({
      name: `org.example:lib${String(i)}:1.0`,
      downloads: {
        artifact: {
          path: `org/example/lib${String(i)}/1.0/lib${String(i)}-1.0.jar`,
          sha1: 'a'.repeat(40),
          size: 128 + i,
          url: `https://libraries.minecraft.net/org/example/lib${String(i)}/1.0/lib${String(i)}-1.0.jar`,
        },
      },
    });
  }
  // macOS 专属库：Windows 上不该被算作「缺失」（regression：不按 rules 过滤会误报）
  libraries.push({
    name: 'ca.weblite:java-objc-bridge:1.1',
    rules: [{ action: 'allow', os: { name: 'osx' } }],
    downloads: {
      artifact: {
        path: 'ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar',
        sha1: 'b'.repeat(40),
        size: 1024,
        url: 'https://libraries.minecraft.net/ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar',
      },
    },
  });

  const version: VersionJson = {
    id: versionId,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'test',
    assetIndex: { id: 'test', sha1: 'c'.repeat(40), size: 100, totalSize: 1000, url: 'https://example.invalid/test.json' },
    downloads: { client: { sha1: 'd'.repeat(40), size: 4096, url: 'https://example.invalid/client.jar' } },
    libraries,
    ...(opts.javaVersion === undefined
      ? { javaVersion: { component: 'java-runtime-delta', majorVersion: 21 } }
      : { javaVersion: opts.javaVersion }),
    ...(opts.inheritsFrom === undefined ? {} : { inheritsFrom: opts.inheritsFrom }),
  };

  // ── 落盘 ──
  const versionDir = path.join(dataRoot, 'versions', versionId);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(version, null, 2), 'utf8');

  if (opts.skipJar !== true) {
    fs.writeFileSync(path.join(versionDir, `${versionId}.jar`), Buffer.alloc(4096, 1));
  }

  if (opts.ancestor !== undefined) {
    const ancestorDir = path.join(dataRoot, 'versions', opts.ancestor);
    fs.mkdirSync(ancestorDir, { recursive: true });
    fs.writeFileSync(
      path.join(ancestorDir, `${opts.ancestor}.json`),
      JSON.stringify({ ...version, id: opts.ancestor, inheritsFrom: undefined }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(ancestorDir, `${opts.ancestor}.jar`), Buffer.alloc(4096, 2));
  }

  const indexDir = path.join(dataRoot, 'assets', 'indexes');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, 'test.json'), JSON.stringify(assetIndex), 'utf8');

  const objectsRoot = path.join(dataRoot, 'assets', 'objects');
  const assetEntries = Object.values(assetIndex.objects);
  for (let i = 0; i < assetEntries.length - missingAssets; i += 1) {
    const obj = assetEntries[i] as { hash: string; size: number };
    const abs = path.join(objectsRoot, obj.hash.slice(0, 2), obj.hash);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(obj.size, 3));
  }

  const librariesRoot = path.join(dataRoot, 'libraries');
  // 只把「真的该装」的库当候选（objc-bridge 是 macOS 专属，本来就不写）
  const libs = libraries.filter(
    (l) => l.downloads?.artifact?.path !== undefined && !l.downloads.artifact.path.includes('objc-bridge'),
  );
  // 从**末尾**留缺失：这样前几个库一定在，报告里能点名到具体是哪一个缺了
  const toWrite = missingLibs > 0 ? libs.slice(0, Math.max(0, libs.length - missingLibs)) : libs;
  for (const lib of toWrite) {
    const rel = lib.downloads?.artifact?.path;
    if (rel === undefined) continue;
    const abs = path.join(librariesRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(lib.downloads?.artifact?.size ?? 128, 4));
  }

  return { version, assetIndex };
}

/** 造一个 checker（默认平台固定 windows，避免在 mac/linux 上跑出不同结论） */
function makeChecker(
  dataRoot: string,
  versions: Record<string, VersionJson>,
  extra: Partial<PreflightCheckerDeps> = {},
): PreflightChecker {
  return new PreflightChecker({
    dataRoot,
    versionRepo: new FakeVersionRepo(versions),
    settings: new FakeSettings() as unknown as SettingsStore,
    modManager: new FakeModManager({}),
    platform: WINDOWS,
    totalMemoryMB: 16384,
    ...extra,
  });
}

/** 便捷：取某个 code 的 issue */
function issueWith(report: PreflightReportDetail, code: string): PreflightIssue | undefined {
  return [...report.blocking, ...report.warnings, ...report.infos].find((i) => i.code === code);
}

function codesOf(report: PreflightReportDetail): string[] {
  return [...report.blocking, ...report.warnings, ...report.infos].map((i) => i.code);
}

// ═══════════════════════════════ A. 每种 issue code ═══════════════════════════════

describe('A. 版本未安装（version-not-installed）', () => {
  it('版本目录根本不存在 → blocking + install-version 修复', async () => {
    const root = tmpDataRoot('not-installed');
    const checker = makeChecker(root, {});
    const report = await checker.check({ versionId: '1.21' });

    assert.equal(report.canLaunch, false);
    const issue = issueWith(report, 'version-not-installed');
    assert.ok(issue, '必须报 version-not-installed');
    assert.equal(issue.severity, 'blocking');
    assert.equal(issue.fix?.kind, 'install-version');
    assert.equal(issue.fix?.args?.['versionId'], '1.21');
    assert.match(issue.title, /还没装/);
  });

  it('版本 JSON 存在但内容是坏 JSON → 同样 blocking（不静默放行）', async () => {
    const root = tmpDataRoot('bad-json');
    const dir = path.join(root, 'versions', '1.21');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.21.json'), '{ this is not json', 'utf8');

    const checker = makeChecker(root, {});
    const report = await checker.check({ versionId: '1.21' });
    assert.equal(report.canLaunch, false);
    const issue = issueWith(report, 'version-not-installed');
    assert.ok(issue);
    assert.match(issue.title, /损坏/);
  });

  it('非法版本 id（带 .. ）→ blocking，且绝不拼进路径', async () => {
    const root = tmpDataRoot('bad-id');
    const checker = makeChecker(root, {});
    const report = await checker.check({ versionId: '../etc' });
    assert.equal(report.canLaunch, false);
    const issue = issueWith(report, 'version-not-installed');
    assert.ok(issue);
    assert.match(issue.title, /不合法|没有指定/);
  });
});

describe('A. Java（java-missing / java-version / java-downloadable）', () => {
  it('清单里有该组件、本地没装 → java-downloadable（warning，可自动修）', async () => {
    const root = tmpDataRoot('java-dl');
    const { version } = seedInstalledVersion(root, '1.21');
    const installer = new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta', 'java-runtime-gamma'] });

    const checker = makeChecker(root, { '1.21': version }, { javaProvisioner: installer });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'java-downloadable');
    assert.ok(issue, '应报 java-downloadable');
    assert.equal(issue.severity, 'warning', '能自动下载 → 不阻断启动');
    assert.equal(issue.fix?.kind, 'download-java');
    assert.equal(issue.fix?.args?.['component'], 'java-runtime-delta');
    assert.equal(report.canLaunch, true, '只有 warning 时必须允许启动');
  });

  it('清单里没有该组件 → java-missing（blocking，且不给假按钮）', async () => {
    const root = tmpDataRoot('java-missing');
    const { version } = seedInstalledVersion(root, '1.21');
    const installer = new FakeJavaInstaller({ manifestComponents: ['java-runtime-gamma'] });

    const checker = makeChecker(root, { '1.21': version }, { javaProvisioner: installer });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'java-missing');
    assert.ok(issue, '应报 java-missing');
    assert.equal(issue.severity, 'blocking');
    assert.equal(issue.fix, undefined, '清单里没有组件 = 自动下载也没用，不给按钮');
    assert.equal(report.canLaunch, false);
  });

  it('版本 JSON 没声明 component → 无法自动下载 → java-missing blocking', async () => {
    const root = tmpDataRoot('java-nocomponent');
    const { version } = seedInstalledVersion(root, '1.8.9', {
      javaVersion: undefined as never,
    });
    delete (version as { javaVersion?: unknown }).javaVersion;

    const checker = makeChecker(root, { '1.8.9': version }, { javaProvisioner: new FakeJavaInstaller() });
    const report = await checker.check({ versionId: '1.8.9' });

    const issue = issueWith(report, 'java-missing');
    assert.ok(issue);
    assert.equal(issue.severity, 'blocking');
    assert.match(issue.detail, /没声明 Java 组件名/);
  });

  it('本地同名组件主版本偏低 → java-version（blocking，拿错版本会崩）', async () => {
    const root = tmpDataRoot('java-mismatch');
    const { version } = seedInstalledVersion(root, '1.21');
    // 装一个 java-runtime-delta 目录，但目录名里是 17 → 与声明 21 不符
    const home = path.join(root, 'java', 'java-runtime-delta', '17', 'bin');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, process.platform === 'win32' ? 'java.exe' : 'java'), '');

    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'java-version');
    assert.ok(issue, '应报 java-version');
    assert.equal(issue.severity, 'blocking');
    assert.match(issue.detail, /Java 17|Java 21/);
  });

  it('设置里指定的 javaPath 失效 → java-missing blocking，且不给「自动下载」按钮', async () => {
    const root = tmpDataRoot('java-explicit');
    const { version } = seedInstalledVersion(root, '1.21');
    const settings = new FakeSettings({}, { '1.21': path.join(root, 'nowhere', 'java.exe') });

    const checker = makeChecker(root, { '1.21': version }, {
      settings: settings as unknown as SettingsStore,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'java-missing');
    assert.ok(issue);
    assert.equal(issue.severity, 'blocking');
    assert.equal(issue.fix, undefined, '手动指定的路径不会被自动下载覆盖，所以不给按钮');
  });

  it('本地已装满足要求的 Java → 不报任何 java 问题', async () => {
    const root = tmpDataRoot('java-ok');
    const { version } = seedInstalledVersion(root, '1.21');
    // 目录名带 21 → findJavaInDataRoot 能识别
    const home = path.join(root, 'java', 'java-runtime-delta', '21.0.5', 'bin');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, process.platform === 'win32' ? 'java.exe' : 'java'), '');

    const checker = makeChecker(root, { '1.21': version }, { javaProvisioner: new FakeJavaInstaller() });
    const report = await checker.check({ versionId: '1.21' });

    assert.deepEqual(
      codesOf(report).filter((c) => c.startsWith('java-')),
      [],
      `不该有 java 相关问题，实际：${codesOf(report).join(', ')}`,
    );
    assert.equal(report.canLaunch, true);
  });
});

describe('A. 内存（memory-too-low / memory-too-high）', () => {
  it('内存 < 1024 → memory-too-low（warning）+ raise-memory', async () => {
    const root = tmpDataRoot('mem-low');
    const { version } = seedInstalledVersion(root, '1.21');
    const settings = new FakeSettings({ '1.21': 512 });

    const checker = makeChecker(root, { '1.21': version }, {
      settings: settings as unknown as SettingsStore,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'memory-too-low');
    assert.ok(issue, '应报 memory-too-low');
    assert.equal(issue.severity, 'warning');
    assert.equal(issue.fix?.kind, 'raise-memory');
    // 夹具没有 arguments（按老版本判定）→ 建议值取 1024 这一档；关键是「比当前值大」
    const suggested = issue.fix?.args?.['memoryMB'];
    assert.equal(typeof suggested, 'number');
    assert.ok(Number(suggested) >= MEMORY_MIN_LAUNCH_MB, `建议值不能低于 ${String(MEMORY_MIN_LAUNCH_MB)}`);
    assert.ok(Number(suggested) > 512, '建议值必须比当前值 512 大');
    assert.equal(report.canLaunch, true, '内存小是警告，不是硬阻断');
  });

  it('新版元数据（带 arguments）建议 2048', async () => {
    const root = tmpDataRoot('mem-suggest');
    const { version } = seedInstalledVersion(root, '1.21');
    // 真实 1.21 的元数据带 arguments.game / arguments.jvm
    (version as { arguments?: unknown }).arguments = { game: ['--username', '${auth_player_name}'], jvm: ['-cp', '${classpath}'] };
    const settings = new FakeSettings({ '1.21': 512 });

    const checker = makeChecker(root, { '1.21': version }, {
      settings: settings as unknown as SettingsStore,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });
    const issue = issueWith(report, 'memory-too-low');
    assert.ok(issue);
    assert.equal(issue.fix?.args?.['memoryMB'], 2048, '1.13+ 的建议值是 2048');
  });

  it('内存超过物理内存 90% → memory-too-high（warning）', async () => {
    const root = tmpDataRoot('mem-high');
    const { version } = seedInstalledVersion(root, '1.21');
    const settings = new FakeSettings({ '1.21': 16000 });

    const checker = makeChecker(root, { '1.21': version }, {
      settings: settings as unknown as SettingsStore,
      totalMemoryMB: 8192,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'memory-too-high');
    assert.ok(issue, '应报 memory-too-high');
    assert.equal(issue.severity, 'warning');
    assert.equal(issue.fix?.kind, 'raise-memory');
    // 建议值 = min(suggestedMemory, max(1024, floor(8192*0.9))) = min(1024, 7372) = 1024
    // 夹具是 makeLegacy 结构（有 minecraftArguments → 判定为老版本），所以建议 1024
    const suggested = issue.fix?.args?.['memoryMB'];
    assert.ok(typeof suggested === 'number' && suggested <= 7372, `建议值应落在物理内存可承受范围内，实际 ${String(suggested)}`);
    assert.ok(Number(suggested) < 16000, '建议值必须比当前值小');
  });

  it('内存正常（2048）→ 不报内存问题', async () => {
    const root = tmpDataRoot('mem-ok');
    const { version } = seedInstalledVersion(root, '1.21');
    const checker = makeChecker(root, { '1.21': version }, {
      settings: new FakeSettings({ '1.21': 2048 }) as unknown as SettingsStore,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });
    assert.equal(issueWith(report, 'memory-too-low'), undefined);
    assert.equal(issueWith(report, 'memory-too-high'), undefined);
  });

  it('阈值就是 1024：1023 报、1024 不报', async () => {
    const root = tmpDataRoot('mem-bound');
    const { version } = seedInstalledVersion(root, '1.21');
    const base = { '1.21': version };

    const low = makeChecker(root, base, {
      settings: new FakeSettings({ '1.21': MEMORY_MIN_LAUNCH_MB - 1 }) as unknown as SettingsStore,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    assert.ok(issueWith(await low.check({ versionId: '1.21' }), 'memory-too-low'));

    const ok = makeChecker(root, base, {
      settings: new FakeSettings({ '1.21': MEMORY_MIN_LAUNCH_MB }) as unknown as SettingsStore,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    assert.equal(issueWith(await ok.check({ versionId: '1.21' }), 'memory-too-low'), undefined);
  });
});

describe('A. 文件完整性（files-missing）', () => {
  it('缺 client jar → files-missing blocking + rescan-files', async () => {
    const root = tmpDataRoot('files-jar');
    const { version } = seedInstalledVersion(root, '1.21', { skipJar: true });
    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'files-missing');
    assert.ok(issue);
    assert.equal(issue.severity, 'blocking');
    assert.equal(issue.fix?.kind, 'rescan-files');
    assert.match(issue.detail, /1\.21\.jar/);
    assert.equal(report.canLaunch, false);
  });

  it('缺库 → files-missing blocking，且报出具体是哪个库', async () => {
    const root = tmpDataRoot('files-lib');
    const { version } = seedInstalledVersion(root, '1.21', { missingLibs: 1 });
    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'files-missing');
    assert.ok(issue);
    assert.match(issue.detail, /org\.example:lib/);
  });

  it('缺 asset index 文件 → files-missing', async () => {
    const root = tmpDataRoot('files-index');
    const { version } = seedInstalledVersion(root, '1.21');
    fs.rmSync(path.join(root, 'assets', 'indexes', 'test.json'));

    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });
    const issue = issueWith(report, 'files-missing');
    assert.ok(issue);
    assert.match(issue.detail, /资源索引/);
  });

  it('缺 asset 对象（抽样命中）→ files-missing', async () => {
    const root = tmpDataRoot('files-asset');
    const { version } = seedInstalledVersion(root, '1.21', { assetCount: 8, missingAssets: 8 });
    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });
    const issue = issueWith(report, 'files-missing');
    assert.ok(issue, '一个 asset 对象都没有时必须报出来');
    assert.match(issue.detail, /assets\/objects/);
  });

  it('macOS 专属库缺文件不算缺失（rules 过滤回归）', async () => {
    const root = tmpDataRoot('files-rules');
    // seed 时就不写 objc-bridge（它是 macOS 专属）
    const { version } = seedInstalledVersion(root, '1.21');
    assert.equal(
      fs.existsSync(path.join(root, 'libraries', 'ca', 'weblite', 'java-objc-bridge', '1.1', 'java-objc-bridge-1.1.jar')),
      false,
      '夹具本身就不该有 objc-bridge',
    );
    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });
    // 不能是 blocking 的 files-missing；齐全时只可能是 info 的「核对通过」
    const fileIssue = issueWith(report, 'files-missing');
    if (fileIssue !== undefined) {
      assert.equal(fileIssue.severity, 'info', `Windows 上不装 macOS 库，不该报缺失，实际：${fileIssue.title}`);
    }
    assert.equal(report.canLaunch, true);
  });

  it('加载器版本自己没有 jar，但祖先有 → 不算缺失（P0 回归）', async () => {
    const root = tmpDataRoot('files-loader');
    // fabric-loader-… 目录里只有 json，jar 属于 1.21
    const { version } = seedInstalledVersion(root, 'fabric-loader-0.19.5-1.21', {
      ancestor: '1.21',
      inheritsFrom: '1.21',
      skipJar: true,
    });
    const checker = makeChecker(root, { 'fabric-loader-0.19.5-1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: 'fabric-loader-0.19.5-1.21' });
    // 关键：不能是「缺失」。全部齐全时 files-missing 只会以 info 出现（「核对通过」）
    const fileIssue = issueWith(report, 'files-missing');
    if (fileIssue !== undefined) {
      assert.equal(fileIssue.severity, 'info', `沿 inheritsFrom 找到祖先 jar 就算齐，实际报了：${fileIssue.title}`);
    }
    assert.equal(report.canLaunch, true);
  });
});

describe('A. mod 与加载器（mods-without-loader / mods-duplicate / mod-requires-larger-heap）', () => {
  it('原版 + mods/ 有 jar → mods-without-loader（warning）+ install-loader', async () => {
    const root = tmpDataRoot('mods-noloader');
    const { version } = seedInstalledVersion(root, '1.21');
    const mods = new FakeModManager({
      '1.21': [{ filename: 'jei-1.21.jar', id: 'jei', size: 1_500_000, enabled: true }],
    });

    const checker = makeChecker(root, { '1.21': version }, {
      modManager: mods,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'mods-without-loader');
    assert.ok(issue, '应报 mods-without-loader');
    assert.equal(issue.severity, 'warning', '游戏能开，只是 mod 不生效');
    assert.equal(issue.fix?.kind, 'install-loader');
    assert.equal(report.canLaunch, true, 'warning 不阻断启动');
  });

  it('加载器版本 + mods → 不报 mods-without-loader', async () => {
    const root = tmpDataRoot('mods-withloader');
    const { version } = seedInstalledVersion(root, 'fabric-loader-0.19.5-1.21', {
      ancestor: '1.21',
      inheritsFrom: '1.21',
      skipJar: true,
    });
    const mods = new FakeModManager({
      'fabric-loader-0.19.5-1.21': [{ filename: 'jei.jar', id: 'jei', size: 1_000_000, enabled: true }],
    });
    const checker = makeChecker(root, { 'fabric-loader-0.19.5-1.21': version }, {
      modManager: mods,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: 'fabric-loader-0.19.5-1.21' });
    assert.equal(issueWith(report, 'mods-without-loader'), undefined);
  });

  it('同一 mod id 装了多份 → mods-duplicate（warning）+ remove-duplicate-mod', async () => {
    const root = tmpDataRoot('mods-dup');
    const { version } = seedInstalledVersion(root, 'fabric-loader-0.19.5-1.21', {
      ancestor: '1.21',
      inheritsFrom: '1.21',
      skipJar: true,
    });
    const mods = new FakeModManager({
      'fabric-loader-0.19.5-1.21': [
        { filename: 'jei-1.21-19.0.jar', id: 'jei', size: 2_000_000, enabled: true },
        { filename: 'jei-1.21-18.0.jar', id: 'jei', size: 1_500_000, enabled: true },
        { filename: 'sodium.jar', id: 'sodium', size: 900_000, enabled: true },
      ],
    });

    const checker = makeChecker(root, { 'fabric-loader-0.19.5-1.21': version }, {
      modManager: mods,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: 'fabric-loader-0.19.5-1.21' });

    const issue = issueWith(report, 'mods-duplicate');
    assert.ok(issue, '应报 mods-duplicate');
    assert.equal(issue.severity, 'warning');
    assert.equal(issue.fix?.kind, 'remove-duplicate-mod');
    assert.equal(issue.fix?.args?.['keep'], 'jei-1.21-19.0.jar', '保留最大（最完整）的那份');
    assert.equal(issue.fix?.args?.['modId'], 'jei');
    assert.match(String(issue.fix?.args?.['remove']), /jei-1\.21-18\.0\.jar/);
  });

  it('mod 很多 + 内存只给 2048 → mod-requires-larger-heap（warning）', async () => {
    const root = tmpDataRoot('mods-heap');
    const { version } = seedInstalledVersion(root, 'fabric-loader-0.19.5-1.21', {
      ancestor: '1.21',
      inheritsFrom: '1.21',
      skipJar: true,
    });
    const many = [];
    for (let i = 0; i < 32; i += 1) {
      many.push({ filename: `mod-${String(i)}.jar`, id: `mod-${String(i)}`, size: 20_000_000, enabled: true });
    }
    const checker = makeChecker(root, { 'fabric-loader-0.19.5-1.21': version }, {
      modManager: new FakeModManager({ 'fabric-loader-0.19.5-1.21': many }),
      settings: new FakeSettings({ 'fabric-loader-0.19.5-1.21': 2048 }) as unknown as SettingsStore,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: 'fabric-loader-0.19.5-1.21' });

    const issue = issueWith(report, 'mod-requires-larger-heap');
    assert.ok(issue, '应报 mod-requires-larger-heap');
    assert.equal(issue.severity, 'warning');
    assert.equal(issue.fix?.kind, 'raise-memory');
    assert.equal(issue.fix?.args?.['memoryMB'], 4096);
  });
});

describe('A. 实例目录（instance-missing）', () => {
  it('实例目录不存在但能创建 → 自动建好再删干净，不报问题', async () => {
    const root = tmpDataRoot('inst-create');
    const { version } = seedInstalledVersion(root, '1.21');
    const instanceDir = path.join(root, 'instances', '1.21');
    assert.equal(fs.existsSync(instanceDir), false);

    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    // 「可用」时允许出现 info 级 instance-missing（前端展示路径用），但绝不能是 blocking
    const issue = issueWith(report, 'instance-missing');
    if (issue !== undefined) {
      assert.equal(issue.severity, 'info', `能建出来就不该报问题，实际：${issue.title}`);
    }
    assert.equal(fs.existsSync(instanceDir), false, '探针必须把建出来的目录删干净（体检不改现场）');
  });

  it('实例目录建不出来 → instance-missing blocking', async () => {
    const root = tmpDataRoot('inst-fail');
    const { version } = seedInstalledVersion(root, '1.21');

    const checker = makeChecker(root, { '1.21': version }, {
      // 注入一个「永远建不出来」的目录探针（模拟只读盘 / 权限不足）
      fs: {
        isFile: (p: string) => isFileReal(p),
        isDir: () => false,
        sizeOf: (p: string) => {
          try {
            return fs.statSync(p).size;
          } catch {
            return undefined;
          }
        },
        readJson: <T,>(p: string): T | undefined => {
          try {
            return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
          } catch {
            return undefined;
          }
        },
        listDir: () => [],
        ensureDirWritable: async () => false,
      },
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    const issue = issueWith(report, 'instance-missing');
    assert.ok(issue, '应报 instance-missing');
    assert.equal(issue.severity, 'blocking');
    assert.equal(report.canLaunch, false);
  });

  it('实例 id 带路径分隔符 → blocking，绝不拼进路径', async () => {
    const root = tmpDataRoot('inst-badid');
    const { version } = seedInstalledVersion(root, '1.21');
    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21', instanceId: '../escape' });

    const issue = issueWith(report, 'instance-missing');
    assert.ok(issue);
    assert.equal(issue.severity, 'blocking');
    assert.match(issue.title, /不合法/);
  });
});

// ═══════════════════════════════ B. canLaunch 判定 ═══════════════════════════════

describe('B. canLaunch 判定：只有 blocking 时为 false', () => {
  it('全绿 → canLaunch true，三类数组都空', async () => {
    const root = tmpDataRoot('can-ok');
    const { version } = seedInstalledVersion(root, '1.21');
    const home = path.join(root, 'java', 'java-runtime-delta', '21.0.5', 'bin');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, process.platform === 'win32' ? 'java.exe' : 'java'), '');

    const checker = makeChecker(root, { '1.21': version }, { javaProvisioner: new FakeJavaInstaller() });
    const report = await checker.check({ versionId: '1.21' });

    assert.equal(report.canLaunch, true);
    assert.equal(report.blocking.length, 0);
    assert.ok(report.infos.length > 0, '应该给出「核对通过」的 info');
  });

  it('只有 warning → canLaunch 仍为 true（能启动，只是建议处理）', async () => {
    const root = tmpDataRoot('can-warn');
    const { version } = seedInstalledVersion(root, '1.21');
    const checker = makeChecker(root, { '1.21': version }, {
      settings: new FakeSettings({ '1.21': 512 }) as unknown as SettingsStore,
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });

    assert.ok(report.warnings.length > 0, '应有 warning（内存过低 / java-downloadable）');
    assert.equal(report.blocking.length, 0);
    assert.equal(report.canLaunch, true);
  });

  it('任一 blocking → canLaunch false（版本没装）', async () => {
    const root = tmpDataRoot('can-block');
    const report = await makeChecker(root, {}).check({ versionId: '9.9.9' });
    assert.equal(report.canLaunch, false);
    assert.ok(report.blocking.length > 0);
  });

  it('elapsedMs 是真实数字（非负）', async () => {
    const root = tmpDataRoot('can-elapsed');
    const { version } = seedInstalledVersion(root, '1.21');
    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const report = await checker.check({ versionId: '1.21' });
    assert.equal(typeof report.elapsedMs, 'number');
    assert.ok(report.elapsedMs >= 0);
  });
});

// ═══════════════════════════════ C. 性能（不能逐个 stat） ═══════════════════════════════

describe('C. 性能：5000 个 asset 的假 index 下体检 < 2 秒', () => {
  it('5147 个对象的索引，只抽查一小撮，整体 < 2000ms', async () => {
    const root = tmpDataRoot('perf');
    const assetCount = 5147;
    // 夹具落盘本身就要几秒（写 5000 多个小文件），**不计入**体检耗时
    const { version } = seedInstalledVersion(root, '1.21', { assetCount, libraries: 40 });

    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const started = Date.now();
    const report = await checker.check({ versionId: '1.21' });
    const wall = Date.now() - started;

    assert.ok(wall < 2000, `体检耗时 ${String(wall)}ms，超过 2000ms 上限（说明在逐个 stat）`);
    assert.ok(report.elapsedMs < 2000, `report.elapsedMs=${String(report.elapsedMs)}ms 也应 < 2000ms`);
    assert.equal(report.canLaunch, true);

    // 顺带确认没有逐个查：info 里应写明「抽查」
    const info = report.infos.find((i) => i.code === 'files-missing');
    assert.ok(info, '应有「核对通过」的 info');
    assert.match(info.detail, /抽查/);
  });

  it('sampleAssets 取样跨分桶且数量受限', () => {
    const entries: [string, { hash: string; size: number }][] = [];
    for (let i = 0; i < 5000; i += 1) {
      entries.push([`obj/${String(i)}`, { hash: `${String(i % 256).padStart(2, '0')}${'0'.repeat(38)}`, size: i }]);
    }
    const picked = sampleAssets(entries, 16);
    assert.equal(picked.length, 16);
    // 取样应跨越整个列表，而不是只看开头 16 个
    const lastIndex = entries.findIndex((e) => e[0] === picked[picked.length - 1]?.[0]);
    assert.ok(lastIndex > entries.length / 2, `取样应跨越列表，最后一项在第 ${String(lastIndex)} 位`);

    // 少于限额时全取
    assert.equal(sampleAssets(entries.slice(0, 3), 16).length, 3);
  });
});

// ═══════════════════════════════ D. 只读：不改任何文件 ═══════════════════════════════

describe('D. 体检是只读的：前后目录内容完全一致', () => {
  /** 递归快照：相对路径 → { size, mtimeMs } */
  function snapshot(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (abs: string, rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childAbs = path.join(abs, entry.name);
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          out.set(`${childRel}/`, 'dir');
          walk(childAbs, childRel);
        } else {
          const st = fs.statSync(childAbs);
          out.set(childRel, `${String(st.size)}@${String(st.mtimeMs)}`);
        }
      }
    };
    walk(dir, '');
    return out;
  }

  it('跑一次体检后文件数、大小、mtime 全部不变', async () => {
    const root = tmpDataRoot('readonly');
    const { version } = seedInstalledVersion(root, '1.21', { assetCount: 12, libraries: 6 });

    const before = snapshot(root);
    const checker = makeChecker(root, { '1.21': version }, {
      settings: new FakeSettings({ '1.21': 512 }) as unknown as SettingsStore,
      modManager: new FakeModManager({
        '1.21': [
          { filename: 'a.jar', id: 'a', size: 1_000_000, enabled: true },
          { filename: 'a-2.jar', id: 'a', size: 900_000, enabled: true },
        ],
      }),
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    await checker.check({ versionId: '1.21' });
    const after = snapshot(root);

    assert.equal(after.size, before.size, `文件数变了：${String(before.size)} → ${String(after.size)}`);
    for (const [key, value] of before) {
      assert.equal(after.get(key), value, `${key} 被改动了`);
    }
    // 反向：不该多出任何文件
    for (const key of after.keys()) {
      assert.ok(before.has(key), `多了文件：${key}`);
    }
  });

  it('体检跑两次结论一致（无副作用累积）', async () => {
    const root = tmpDataRoot('idempotent');
    const { version } = seedInstalledVersion(root, '1.21');
    const checker = makeChecker(root, { '1.21': version }, {
      javaProvisioner: new FakeJavaInstaller({ manifestComponents: ['java-runtime-delta'] }),
    });
    const first = await checker.check({ versionId: '1.21' });
    const second = await checker.check({ versionId: '1.21' });

    assert.deepEqual(
      codesOf(second).sort(),
      codesOf(first).sort(),
      '两次体检的 issue 集合必须一致',
    );
    assert.equal(second.canLaunch, first.canLaunch);
  });
});

// ═══════════════════════════════ E. Web 集成 ═══════════════════════════════

const FAKE_MANIFEST: VersionManifest = {
  latest: { release: '1.21', snapshot: '24w45a' },
  versions: [
    { id: '1.21', type: 'release', url: 'https://example.invalid/1.21.json', time: 't', releaseTime: '2024-06-13T00:00:00+00:00' },
  ],
};

class WebVersionRepo {
  async fetchManifest(): Promise<VersionManifest> {
    return FAKE_MANIFEST;
  }
  async fetchVersion(id: string): Promise<VersionJson> {
    return {
      id,
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      assets: 'test',
      libraries: [],
    } as VersionJson;
  }
  async resolveInherited(json: VersionJson): Promise<VersionJson> {
    return json;
  }
}

/** 永不真的启动游戏的启动器：buildCommand 返回一个不存在的 java，spawn 必失败 */
class ThrowingLauncher {
  async buildCommand(): Promise<never> {
    throw new Error('测试里不真的启动游戏');
  }
}

/** 可编排的 fake 体检器：按注入的报告原样返回 */
class ScriptedPreflight {
  readonly calls: { versionId: string; instanceId?: string }[] = [];
  private readonly report: PreflightReportDetail;

  constructor(report: PreflightReportDetail) {
    this.report = report;
  }
  async check(opts: { versionId: string; instanceId?: string }): Promise<PreflightReportDetail> {
    this.calls.push(opts);
    return { ...this.report, versionId: opts.versionId };
  }
}

function makeReport(
  versionId: string,
  parts: { blocking?: PreflightIssue[]; warnings?: PreflightIssue[]; infos?: PreflightIssue[] } = {},
): PreflightReportDetail {
  return {
    canLaunch: (parts.blocking ?? []).length === 0,
    blocking: parts.blocking ?? [],
    warnings: parts.warnings ?? [],
    infos: parts.infos ?? [],
    elapsedMs: 7,
    versionId,
    instanceDir: `/fake/instances/${versionId}`,
    dataRoot: '/fake',
  };
}

function blockingIssue(fixKind?: 'download-java' | 'install-version' | 'install-loader'): PreflightIssue {
  return {
    code: 'version-not-installed',
    severity: 'blocking',
    title: '版本未安装',
    detail: '测试用',
    ...(fixKind === undefined ? {} : { fix: { kind: fixKind, label: '修复' } }),
  };
}

describe('E. Web 集成：POST /api/preflight', () => {
  let dataRoot: string;
  /** 本 describe 里起过的所有服务，统一 after 关闭（漏一个就会挂住整个测试进程） */
  const servers: WebServerHandle[] = [];

  before(() => {
    dataRoot = tmpDataRoot('web');
  });

  after(async () => {
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* 关不掉也别把结论盖掉 */
      }
    }
  });

  async function startWith(report: PreflightReportDetail): Promise<{ base: string; preflight: ScriptedPreflight }> {
    const preflight = new ScriptedPreflight(report);
    const server = await createServer({
      port: 0,
      dataRoot,
      versionRepo: new WebVersionRepo() as never,
      downloader: { downloadAll: async () => ({ ok: true, skipped: 0, downloaded: 0, failed: [] }) } as never,
      installer: {
        plan: async () => ({ versionId: '1.21', tasks: [], totalBytes: 0, natives: [], assetIndexId: 'test' }),
        install: async () => undefined,
      } as never,
      launcherFactory: (() => new ThrowingLauncher()) as never,
      preflightFactory: () => preflight as never,
    });
    servers.push(server);
    return { base: server.url, preflight };
  }

  async function post(base: string, pathname: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(new URL(pathname, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text) as any };
  }

  it('缺 versionId → 400', async () => {
    const { base } = await startWith(makeReport('1.21'));
    const r = await post(base, '/api/preflight', {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /versionId/);
  });

  it('非法 versionId → 400', async () => {
    const { base } = await startWith(makeReport('1.21'));
    const r = await post(base, '/api/preflight', { versionId: '../evil' });
    assert.equal(r.status, 400);
  });

  it('老前端多带的 instanceId 被安静忽略（实例概念已取消，不再是 400）', async () => {
    const { base, preflight } = await startWith(makeReport('1.21'));
    const r = await post(base, '/api/preflight', { versionId: '1.21', instanceId: '../evil' });
    assert.equal(r.status, 200, '实例已取消，这个参数不再参与任何校验，也不该让请求失败');
    assert.deepEqual(preflight.calls, [{ versionId: '1.21' }], '体检器只收 versionId');
  });

  it('正常请求 → 200 + 完整报告（canLaunch=false 也是 200）', async () => {
    const report = makeReport('1.21', { blocking: [blockingIssue('install-version')] });
    const { base, preflight } = await startWith(report);

    const r = await post(base, '/api/preflight', { versionId: '1.21' });
    assert.equal(r.status, 200, '「体检不通过」是业务状态，不是 HTTP 错误');
    assert.equal(r.json.canLaunch, false);
    assert.equal(r.json.blocking.length, 1);
    assert.equal(r.json.blocking[0].code, 'version-not-installed');
    assert.equal(typeof r.json.elapsedMs, 'number');
    assert.deepEqual(preflight.calls, [{ versionId: '1.21' }]);
  });

  it('体检请求只按 versionId 走：不再透传 instanceId', async () => {
    const { base, preflight } = await startWith(makeReport('1.21'));
    const r = await post(base, '/api/preflight', { versionId: '1.21', instanceId: '生存' });
    assert.equal(r.status, 200);
    assert.deepEqual(
      preflight.calls,
      [{ versionId: '1.21' }],
      '实例概念取消后，体检只看 versionId（目录也由它唯一决定）',
    );
  });
});

describe('E. Web 集成：POST /api/launch 的体检闸门', () => {
  let dataRoot: string;
  /** 本 describe 里起过的所有服务，统一 after 关闭 */
  const servers: WebServerHandle[] = [];

  before(() => {
    dataRoot = tmpDataRoot('web-launch');
  });

  after(async () => {
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* 关不掉也别把结论盖掉 */
      }
    }
  });

  async function startWith(report: PreflightReportDetail): Promise<{ base: string; server: WebServerHandle }> {
    const preflight = new ScriptedPreflight(report);
    const server = await createServer({
      port: 0,
      dataRoot,
      versionRepo: new WebVersionRepo() as never,
      downloader: { downloadAll: async () => ({ ok: true, skipped: 0, downloaded: 0, failed: [] }) } as never,
      installer: {
        plan: async () => ({ versionId: '1.21', tasks: [], totalBytes: 0, natives: [], assetIndexId: 'test' }),
        install: async () => undefined,
      } as never,
      launcherFactory: (() => new ThrowingLauncher()) as never,
      preflightFactory: () => preflight as never,
    });
    servers.push(server);
    return { base: server.url, server };
  }

  async function post(base: string, pathname: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(new URL(pathname, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text) as any };
  }

  it('有不可修的 blocking（install-version）→ 409 + 完整报告，不建任务', async () => {
    const report = makeReport('1.21', { blocking: [blockingIssue('install-version')] });
    const { base, server } = await startWith(report);

    const r = await post(base, '/api/launch', { versionId: '1.21', username: 'Steve' });
    assert.equal(r.status, 409, '不可修复的阻断项必须挡住启动');
    assert.equal(r.json.code, 'preflight-blocked');
    assert.ok(r.json.preflight, '409 的 body 里要带完整报告，前端才能画修复按钮');
    assert.equal(r.json.preflight.blocking.length, 1);
    assert.equal(server.jobs.list().length, 0, '被挡住时不该创建任何任务');
  });

  it('没有 fix 的 blocking → 同样 409', async () => {
    const report = makeReport('1.21', { blocking: [blockingIssue(undefined)] });
    const { base } = await startWith(report);
    const r = await post(base, '/api/launch', { versionId: '1.21', username: 'Steve' });
    assert.equal(r.status, 409);
  });

  it('blocking 但能自动修（download-java）→ 仍 202，日志里写明已自动处理', async () => {
    const javaIssue: PreflightIssue = {
      code: 'java-missing',
      severity: 'blocking',
      title: '需要 Java 21',
      detail: '测试用',
      fix: { kind: 'download-java', label: '下载 Java 21' },
    };
    const report = makeReport('1.21', { blocking: [javaIssue] });
    const { base, server } = await startWith(report);

    const r = await post(base, '/api/launch', { versionId: '1.21', username: 'Steve' });
    assert.equal(r.status, 202, '能自动修就不该挡');
    assert.ok(typeof r.json.jobId === 'string');
    assert.equal(r.json.preflight.blocking, 1, '202 里给摘要');

    // 等后台任务把日志写出来（它会因为 ThrowingLauncher 失败，但日志已经在了）
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snap = server.jobs.get(r.json.jobId);
    assert.ok(snap, '任务应存在');
    const text = snap.log.map((l) => l.text).join('\n');
    assert.match(text, /启动前体检/);
    assert.match(text, /已自动处理/);
  });

  it('只有 warning → 202，日志里提示体检结论', async () => {
    const warn: PreflightIssue = {
      code: 'memory-too-low',
      severity: 'warning',
      title: '分配的内存只有 512 MB',
      detail: '测试用',
      fix: { kind: 'raise-memory', label: '调到 2048' },
    };
    const report = makeReport('1.21', { warnings: [warn] });
    const { base, server } = await startWith(report);

    const r = await post(base, '/api/launch', { versionId: '1.21', username: 'Steve' });
    assert.equal(r.status, 202);
    assert.equal(r.json.preflight.warnings, 1);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const snap = server.jobs.get(r.json.jobId);
    const text = snap?.log.map((l) => l.text).join('\n') ?? '';
    assert.match(text, /启动前体检/);
    assert.match(text, /\[警告\]/);
  });

  it('体检完全通过 → 202，日志说「体检通过」', async () => {
    const report = makeReport('1.21');
    const { base, server } = await startWith(report);

    const r = await post(base, '/api/launch', { versionId: '1.21', username: 'Steve' });
    assert.equal(r.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const snap = server.jobs.get(r.json.jobId);
    const text = snap?.log.map((l) => l.text).join('\n') ?? '';
    assert.match(text, /体检通过/);
  });

  it('体检器自己抛错 → 不连累启动（依然 202）', async () => {
    const server = await createServer({
      port: 0,
      dataRoot,
      versionRepo: new WebVersionRepo() as never,
      downloader: { downloadAll: async () => ({ ok: true, skipped: 0, downloaded: 0, failed: [] }) } as never,
      installer: {
        plan: async () => ({ versionId: '1.21', tasks: [], totalBytes: 0, natives: [], assetIndexId: 'test' }),
        install: async () => undefined,
      } as never,
      launcherFactory: (() => new ThrowingLauncher()) as never,
      preflightFactory: () => ({
        check: async () => {
          throw new Error('体检器内部炸了');
        },
      }) as never,
    });
    servers.push(server);

    const r = await post(server.url, '/api/launch', { versionId: '1.21', username: 'Steve' });
    assert.equal(r.status, 202, '体检崩溃绝不能变成「启动被挡」');
  });
});

// ═══════════════════════════════ 辅助 ═══════════════════════════════

/** 真实 isFile（给「注入 fake fs 但只改 ensureDirWritable」的用例用） */
function isFileReal(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

describe('loaderKindOf：从版本 id 认加载器', () => {
  it('认得 fabric / quilt / forge / neoforge', () => {
    assert.equal(loaderKindOf('fabric-loader-0.19.5-1.21'), 'fabric');
    assert.equal(loaderKindOf('quilt-loader-0.27.0-1.21'), 'quilt');
    assert.equal(loaderKindOf('forge-47.2.0'), 'forge');
    assert.equal(loaderKindOf('neoforge-21.1.0'), 'neoforge');
  });

  it('原版 id 返回 undefined', () => {
    assert.equal(loaderKindOf('1.21'), undefined);
    assert.equal(loaderKindOf('26.3'), undefined);
    assert.equal(loaderKindOf('24w45a'), undefined);
  });
});
