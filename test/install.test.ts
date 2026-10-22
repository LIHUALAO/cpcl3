/**
 * install 模块测试 —— 全部使用自造的 fake 依赖，不联网、不落盘到真数据目录。
 *
 * 覆盖点（对应验收标准）：
 *   1. plan('1.21') 任务数量正确、client.jar 在列表里
 *   2. asset 路径格式为 objects/ab/abcdef...，URL 前缀走 BMCLAPI
 *   3. rules 过滤：macOS 专属库在 Windows 上不进清单
 *   4. assets 任务数量与 fake assetIndex 的 objects 数量一致
 *   5. 老版本 virtual / map_to_resources 在 plan 里被标记
 *   6. totalBytes 是全部 size 累加
 *   7. install() 按 phase 上报进度，且真的把任务交给 downloader
 *   8. mavenPath 坐标转路径
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  AssetIndex,
  DownloadResult,
  DownloadTask,
  InstallProgress,
  VersionJson,
} from '../src/core/types.js';
import { VanillaInstaller, mavenPath, type DetailInstallPlan } from '../src/core/install/index.js';
import { rulesAllow, type OsInfo } from '../src/core/install/rules.js';

// ───────────────────────────── fake 依赖 ─────────────────────────────

/** 记录 downloadAll 收到什么，并按计划返回成功 */
class FakeDownloader {
  readonly calls: DownloadTask[][] = [];
  readonly progress: { done: number; total: number; current: string }[] = [];
  private readonly failOn: (task: DownloadTask) => boolean;

  constructor(failOn: (task: DownloadTask) => boolean = () => false) {
    this.failOn = failOn;
  }

  async downloadAll(
    tasks: DownloadTask[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<DownloadResult> {
    this.calls.push(tasks);
    const result: DownloadResult = { ok: true, skipped: 0, downloaded: 0, failed: [] };
    let done = 0;
    for (const task of tasks) {
      onProgress?.({ done, total: tasks.length, current: task.url });
      this.progress.push({ done, total: tasks.length, current: task.url });
      if (this.failOn(task)) {
        result.failed.push(task);
      } else {
        result.downloaded += 1;
      }
      done += 1;
    }
    onProgress?.({ done, total: tasks.length, current: '' });
    result.ok = result.failed.length === 0;
    return result;
  }
}

/**
 * 真写盘版 fake：会真的往 dest 写文件，这样 install() 的磁盘复核才有意义。
 *
 * - `failOn` 决定哪些任务「报告失败且不写盘」
 * - `dropSilently` 模拟 P0 bug 的形态：downloader **谎报成功**（不写盘也不进 failed），
 *   历史 bug 里 worker 抛异常正是这个效果
 * - `preexisting` 里的 dest 视为已存在（用于测「重跑只补缺失」）
 */
class WritingFakeDownloader {
  readonly calls: DownloadTask[][] = [];
  private readonly failOn: (task: DownloadTask) => boolean;
  private readonly dropSilently: (task: DownloadTask) => boolean;
  private readonly preexisting: Set<string>;

  constructor(opts: {
    failOn?: (task: DownloadTask) => boolean;
    dropSilently?: (task: DownloadTask) => boolean;
    preexisting?: Set<string>;
  } = {}) {
    this.failOn = opts.failOn ?? (() => false);
    this.dropSilently = opts.dropSilently ?? (() => false);
    this.preexisting = opts.preexisting ?? new Set();
  }

  /** 本次真正尝试（且非 preexisting）的任务 */
  get attempted(): DownloadTask[] {
    return this.calls.flat().filter((t) => !this.preexisting.has(t.dest));
  }

  async downloadAll(
    tasks: DownloadTask[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<DownloadResult> {
    this.calls.push(tasks);
    const result: DownloadResult = { ok: true, skipped: 0, downloaded: 0, failed: [] };
    let done = 0;
    for (const task of tasks) {
      onProgress?.({ done, total: tasks.length, current: task.dest });
      if (this.preexisting.has(task.dest)) {
        result.skipped += 1;
        done += 1;
        continue;
      }
      if (this.failOn(task)) {
        result.failed.push(task);
      } else if (this.dropSilently(task)) {
        // 谎报成功：既不写盘，也不进 failed —— 这就是 P0 bug 的形态
        result.downloaded += 1;
      } else {
        fs.mkdirSync(path.dirname(task.dest), { recursive: true });
        fs.writeFileSync(task.dest, `content:${path.basename(task.dest)}`, 'utf8');
        result.downloaded += 1;
      }
      done += 1;
    }
    onProgress?.({ done, total: tasks.length, current: '' });
    result.ok = result.failed.length === 0;
    return result;
  }
}

class FakeVersionRepository {
  private readonly versions: Record<string, VersionJson>;

  constructor(versions: Record<string, VersionJson>) {
    this.versions = versions;
  }
  async fetchManifest(): Promise<never> {
    throw new Error('not used in install tests');
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

// ───────────────────────────── 测试夹具 ─────────────────────────────

const WINDOWS: OsInfo = { name: 'windows', arch: 'x86_64', version: '10.0.19045' };

/** 与真实 1.21 结构一致的裁剪版：3 个普通库 + 1 个 macOS 专属库 + 1 个 native 库 */
function makeVersion121(assetIndex: AssetIndex): VersionJson {
  const objects = Object.keys(assetIndex.objects).length;
  void objects;
  return {
    id: '1.21',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    assetIndex: {
      id: '17',
      sha1: 'a'.repeat(40),
      size: 449557,
      totalSize: 826050937,
      url: 'https://piston-meta.mojang.com/v1/packages/aaa/17.json',
    },
    downloads: {
      client: {
        sha1: '0e9a07b9bb3390602f977073aa12884a4ce12431',
        size: 26836080,
        url: 'https://piston-data.mojang.com/v1/objects/0e9a07b9/client.jar',
      },
      client_mappings: {
        sha1: 'b'.repeat(40),
        size: 9000000,
        url: 'https://piston-data.mojang.com/v1/objects/bbbb/client.txt',
      },
    },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
    libraries: [
      {
        name: 'com.mojang:logging:1.2.7',
        downloads: {
          artifact: {
            path: 'com/mojang/logging/1.2.7/logging-1.2.7.jar',
            sha1: 'c'.repeat(40),
            size: 15343,
            url: 'https://libraries.minecraft.net/com/mojang/logging/1.2.7/logging-1.2.7.jar',
          },
        },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.3',
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
            sha1: 'd'.repeat(40),
            size: 800000,
            url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
          },
          classifiers: {
            'natives-windows': {
              path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
              sha1: 'e'.repeat(40),
              size: 200000,
              url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
            },
            'natives-macos': {
              path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-macos.jar',
              sha1: 'f'.repeat(40),
              size: 210000,
              url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-macos.jar',
            },
          },
        },
        natives: { windows: 'natives-windows', osx: 'natives-macos' },
      },
      {
        name: 'com.google.guava:guava:32.1.2-jre',
        downloads: {
          artifact: {
            path: 'com/google/guava/guava/32.1.2-jre/guava-32.1.2-jre.jar',
            sha1: '1'.repeat(40),
            size: 3000000,
            url: 'https://libraries.minecraft.net/com/google/guava/guava/32.1.2-jre/guava-32.1.2-jre.jar',
          },
        },
      },
      {
        // macOS 专属：Windows 上必须被 rules 过滤掉
        name: 'ca.weblite:java-objc-bridge:1.1',
        rules: [{ action: 'allow', os: { name: 'osx' } }],
        downloads: {
          artifact: {
            path: 'ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar',
            sha1: '2'.repeat(40),
            size: 1330045,
            url: 'https://libraries.minecraft.net/ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar',
          },
        },
      },
    ],
  };
}

/** 造一个 N 个对象的 asset index */
function makeAssetIndex(count: number): AssetIndex {
  const objects: AssetIndex['objects'] = {};
  for (let i = 0; i < count; i += 1) {
    // 每项 hash 前缀不同，覆盖多种分桶
    const prefix = i.toString(16).padStart(2, '0');
    const hash = `${prefix}${String(i).padStart(38, '0')}`;
    objects[`minecraft/sounds/${String(i)}.ogg`] = { hash, size: 100 + i };
  }
  return { objects };
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('VanillaInstaller.plan', () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-install-'));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('1.21：任务数量、client.jar、asset 路径格式都正确', async () => {
    const assetIndex = makeAssetIndex(12);
    const assetCount = Object.keys(assetIndex.objects).length;

    // 预写 asset index 到磁盘，模拟「索引已存在」，避免 plan 去联网
    const indexesDir = path.join(tmpRoot, 'assets', 'indexes');
    fs.mkdirSync(indexesDir, { recursive: true });
    fs.writeFileSync(path.join(indexesDir, '17.json'), JSON.stringify(assetIndex), 'utf8');

    const version = makeVersion121(assetIndex);
    const downloader = new FakeDownloader();
    const installer = new VanillaInstaller(
      {
        versionRepo: new FakeVersionRepository({ '1.21': version }) as never,
        downloader: downloader as never,
      },
      { dataRoot: tmpRoot, os: WINDOWS },
    );

    const plan: DetailInstallPlan = await installer.plan('1.21');

    // ── 任务构成 ──
    // meta(1) + client(1) + client_mappings(1) + 3 个受支持库 + 1 个 native + index(1) + N assets
    const expectedLibs = 3; // logging / lwjgl / guava，objc-bridge 被 rules 过滤
    const expectedNatives = 1; // lwjgl natives-windows
    const expectedTotal = 1 + 1 + 1 + expectedLibs + expectedNatives + 1 + assetCount;
    assert.equal(plan.tasks.length, expectedTotal, `任务数应为 ${String(expectedTotal)}`);

    // ── client.jar 在列表里 ──
    const clientTask = plan.tasks.find((t) => t.dest === path.join(tmpRoot, 'versions', '1.21', '1.21.jar'));
    assert.ok(clientTask, 'client.jar 任务必须存在');
    assert.equal(clientTask.sha1, '0e9a07b9bb3390602f977073aa12884a4ce12431');

    // ── asset 路径格式：objects/ab/abcdef... ──
    const assetTasks = plan.tasks.filter((t) =>
      t.dest.includes(`${path.sep}assets${path.sep}objects${path.sep}`),
    );
    assert.equal(assetTasks.length, assetCount, 'assets 任务数应等于 index 里 objects 数');
    for (const task of assetTasks) {
      // dest 形如 <root>/assets/objects/ab/abcdef...
      const rel = path.relative(path.join(tmpRoot, 'assets', 'objects'), task.dest).replace(/\\/g, '/');
      assert.match(rel, /^[0-9a-f]{2}\/[0-9a-f]{40}$/, `asset 路径格式错误: ${rel}`);
      assert.equal(rel.split('/')[0], rel.slice(3, 5), '子目录必须是 hash 前两位');
    }

    // ── asset URL：官方直链主用，BMCLAPI 作为镜像候选 ──
    // 说明：BMCLAPI 的 /assets/ 现在会 302 到轮换的第三方节点，而 download 模块
    // 的 transport 不跟随重定向，所以不能把 BMCLAPI 当主链（否则整体失败）。
    for (const task of assetTasks) {
      assert.ok(
        task.url.startsWith('https://resources.download.minecraft.net/'),
        `asset 主链应是官方源: ${task.url}`,
      );
      const mirrors = (task as { mirrors?: string[] }).mirrors ?? [];
      assert.ok(
        mirrors.some((m) => m.includes('bmclapi2.bangbang93.com')),
        `BMCLAPI 必须作为镜像候选: ${JSON.stringify(mirrors)}`,
      );
    }

    // ── totalBytes 是累加 ──
    const sum = plan.tasks.reduce((acc, t) => acc + (t.size ?? 0), 0);
    assert.equal(plan.totalBytes, sum);
    assert.ok(plan.totalBytes > 26836080, '至少包含 client.jar 的 26MB');
  });

  it('rules 过滤：macOS 专属库在 Windows 上不进任务清单', async () => {
    const assetIndex = makeAssetIndex(1);
    const indexesDir = path.join(tmpRoot, 'assets', 'indexes');
    fs.mkdirSync(indexesDir, { recursive: true });
    fs.writeFileSync(path.join(indexesDir, '17.json'), JSON.stringify(assetIndex), 'utf8');

    const installer = new VanillaInstaller(
      {
        versionRepo: new FakeVersionRepository({ '1.21': makeVersion121(assetIndex) }) as never,
        downloader: new FakeDownloader() as never,
      },
      { dataRoot: tmpRoot, os: WINDOWS },
    );

    const plan = await installer.plan('1.21');
    const names = plan.tasks.map((t) => t.dest);

    assert.ok(
      !names.some((d) => d.includes('java-objc-bridge')),
      'java-objc-bridge 是 macOS 专属，Windows 上不应出现',
    );
    assert.ok(names.some((d) => d.includes('logging-1.2.7.jar')), '通用库必须在清单里');
    assert.ok(
      !names.some((d) => d.includes('natives-macos')),
      'macOS classifier 不应出现在 Windows 计划里',
    );

    // 换成 osx，objc-bridge 与 macos classifier 都应出现
    const macInstaller = new VanillaInstaller(
      {
        versionRepo: new FakeVersionRepository({ '1.21': makeVersion121(assetIndex) }) as never,
        downloader: new FakeDownloader() as never,
      },
      { dataRoot: tmpRoot, os: { name: 'osx', arch: 'arm64', version: '14.0' } },
    );
    const macPlan = await macInstaller.plan('1.21');
    const macNames = macPlan.tasks.map((t) => t.dest);
    assert.ok(macNames.some((d) => d.includes('java-objc-bridge')), 'macOS 上 objc-bridge 应出现');
    assert.ok(macNames.some((d) => d.includes('natives-macos')), 'macOS 上应选 natives-macos');
  });

  it('assets 任务数量与 fake assetIndex 的 objects 数量一致（多组数量）', async () => {
    for (const count of [0, 1, 7, 50]) {
      const assetIndex = makeAssetIndex(count);
      const indexesDir = path.join(tmpRoot, 'assets', 'indexes');
      fs.mkdirSync(indexesDir, { recursive: true });
      fs.writeFileSync(path.join(indexesDir, '17.json'), JSON.stringify(assetIndex), 'utf8');

      const installer = new VanillaInstaller(
        {
          versionRepo: new FakeVersionRepository({ '1.21': makeVersion121(assetIndex) }) as never,
          downloader: new FakeDownloader() as never,
        },
        { dataRoot: tmpRoot, os: WINDOWS },
      );
      const plan = await installer.plan('1.21');
      const assetTasks = plan.tasks.filter((t) => t.dest.includes(path.join('assets', 'objects')));
      assert.equal(assetTasks.length, count, `objects=${String(count)} 时 assets 任务数应一致`);
    }
  });

  it('natives 摘要给出 jarPath / extractTo / exclude', async () => {
    const assetIndex = makeAssetIndex(1);
    fs.mkdirSync(path.join(tmpRoot, 'assets', 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'assets', 'indexes', '17.json'), JSON.stringify(assetIndex), 'utf8');

    const installer = new VanillaInstaller(
      {
        versionRepo: new FakeVersionRepository({ '1.21': makeVersion121(assetIndex) }) as never,
        downloader: new FakeDownloader() as never,
      },
      { dataRoot: tmpRoot, os: WINDOWS },
    );
    const plan = await installer.plan('1.21');

    assert.equal(plan.natives.length, 1);
    const native = plan.natives[0]!;
    assert.ok(native.jarPath.endsWith('lwjgl-3.3.3-natives-windows.jar'));
    assert.equal(native.extractTo, path.join(tmpRoot, 'versions', '1.21', 'natives'));
    assert.deepEqual(native.exclude, ['META-INF/']);
  });

  it('老版本 virtual / map_to_resources 在 plan 里被标记', async () => {
    const legacyIndex: AssetIndex = {
      objects: {
        'icons/icon_16x16.png': { hash: `${'ab'}${'0'.repeat(38)}`, size: 3665 },
      },
      virtual: true,
    };
    fs.mkdirSync(path.join(tmpRoot, 'assets', 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'assets', 'indexes', 'legacy.json'), JSON.stringify(legacyIndex), 'utf8');

    const legacyJson: VersionJson = {
      id: '1.6.4',
      type: 'release',
      mainClass: 'net.minecraft.client.Minecraft',
      assets: 'legacy',
      assetIndex: {
        id: 'legacy',
        sha1: '3'.repeat(40),
        size: 109634,
        totalSize: 153475165,
        url: 'https://launchermeta.mojang.com/v1/packages/333/legacy.json',
      },
      downloads: {
        client: {
          sha1: '4'.repeat(40),
          size: 5000000,
          url: 'https://piston-data.mojang.com/v1/objects/4444/client.jar',
        },
      },
      libraries: [],
    };

    const installer = new VanillaInstaller(
      {
        versionRepo: new FakeVersionRepository({ '1.6.4': legacyJson }) as never,
        downloader: new FakeDownloader() as never,
      },
      { dataRoot: tmpRoot, os: WINDOWS },
    );

    const plan = await installer.plan('1.6.4');
    assert.ok(plan.virtualAssets, 'virtual index 必须标记虚拟资源目录');
    assert.equal(plan.virtualAssets?.dir, path.join(tmpRoot, 'assets', 'virtual', 'legacy'));
    assert.equal(plan.virtualAssets?.mapToResources, false);
  });

  it('没有 downloads.client 的怪版本不会崩，只是少一条任务', async () => {
    // 独立数据根，避免受前面用例写下的 asset index 影响
    const ownRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-install-weird-'));
    try {
      const json: VersionJson = {
        id: 'weird',
        type: 'release',
        mainClass: 'X',
        assets: 'legacy',
        libraries: [],
      };
      const installer = new VanillaInstaller(
        {
          versionRepo: new FakeVersionRepository({ weird: json }) as never,
          downloader: new FakeDownloader() as never,
        },
        { dataRoot: ownRoot, os: WINDOWS },
      );
      const plan = await installer.plan('weird');
      assert.equal(plan.tasks.some((t) => t.dest.endsWith('.jar')), false);
      assert.equal(plan.totalBytes, 0);
      assert.equal(plan.assetIndex, undefined, '没有 assetIndex 时不展开资产');
    } finally {
      fs.rmSync(ownRoot, { recursive: true, force: true });
    }
  });
});

describe('VanillaInstaller.install', () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-install-run-'));
  });
  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('按 phase 上报进度，并把任务交给 downloader', async () => {
    const assetIndex = makeAssetIndex(5);
    fs.mkdirSync(path.join(tmpRoot, 'assets', 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'assets', 'indexes', '17.json'), JSON.stringify(assetIndex), 'utf8');

    // 必须用会真写盘的 fake：install() 现在做磁盘复核，
    // 只「记账不写盘」的 fake 会被正确判定为 downloader 谎报（这正是 P0  defenses 生效的证明）
    const downloader = new WritingFakeDownloader();
    const installer = new VanillaInstaller(
      {
        versionRepo: new FakeVersionRepository({ '1.21': makeVersion121(assetIndex) }) as never,
        downloader: downloader as never,
      },
      { dataRoot: tmpRoot, os: WINDOWS },
    );

    const phases: string[] = [];
    const events: InstallProgress[] = [];
    await installer.install('1.21', (p) => {
      events.push(p);
      if (phases.at(-1) !== p.phase) phases.push(p.phase);
    });

    assert.deepEqual(phases, ['meta', 'libraries', 'natives', 'assets', 'done']);
    assert.ok(events.some((e) => e.phase === 'meta' && e.total > 0));
    assert.ok(events.some((e) => e.phase === 'assets' && e.total === 5 + 1), 'assets 阶段含索引文件');

    // downloader 至少被调三次（meta / libraries / assets）
    assert.ok(downloader.calls.length >= 3, `downloadAll 调用次数 = ${String(downloader.calls.length)}`);
    const all = downloader.calls.flat();
    assert.ok(all.some((t) => t.dest.endsWith('1.21.jar')), 'client.jar 应被下载');

    // 版本目录里应落一份 resolve 后的 json
    const written = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'versions', '1.21', '1.21.json'), 'utf8'),
    ) as VersionJson;
    assert.equal(written.id, '1.21');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'versions', '1.21', 'natives')), 'natives 目录应被创建');
  });

  it('下载失败时抛错并列出失败文件', async () => {
    const assetIndex = makeAssetIndex(1);
    fs.mkdirSync(path.join(tmpRoot, 'assets', 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'assets', 'indexes', '17.json'), JSON.stringify(assetIndex), 'utf8');

    const downloader = new FakeDownloader((task) => task.dest.endsWith('1.21.jar'));
    const installer = new VanillaInstaller(
      {
        versionRepo: new FakeVersionRepository({ '1.21': makeVersion121(assetIndex) }) as never,
        downloader: downloader as never,
      },
      { dataRoot: tmpRoot, os: WINDOWS },
    );

    await assert.rejects(() => installer.install('1.21'), /未落地|下载失败/);
  });
});

// ─────────────────── P0：安装失败绝不能被判成成功 ───────────────────

describe('install 失败传播与磁盘复核（P0 回归）', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-p0-'));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** 每个用例独立数据根，避免相互污染 */
  function freshRoot(label: string): string {
    const dir = path.join(root, label);
    fs.mkdirSync(path.join(dir, 'assets', 'indexes'), { recursive: true });
    return dir;
  }

  function makeInstaller(dir: string, downloader: unknown, assetIndex: AssetIndex) {
    fs.writeFileSync(path.join(dir, 'assets', 'indexes', '17.json'), JSON.stringify(assetIndex), 'utf8');
    return new VanillaInstaller(
      {
        versionRepo: new FakeVersionRepository({ '1.21': makeVersion121(assetIndex) }) as never,
        downloader: downloader as never,
      },
      { dataRoot: dir, os: WINDOWS },
    );
  }

  it('downloader 返回 ok:false 且 failed 非空 → install 必须抛错', async () => {
    const dir = freshRoot('fail-loud');
    const assetIndex = makeAssetIndex(3);
    const dl = new WritingFakeDownloader({ failOn: (t) => t.dest.includes('assets') });
    const installer = makeInstaller(dir, dl, assetIndex);

    await assert.rejects(
      () => installer.install('1.21'),
      (err: Error) => {
        assert.match(err.message, /下载失败/, '错误信息必须点明「下载失败」');
        assert.match(err.message, /assets/, '错误信息应指明阶段');
        return true;
      },
    );
  });

  it('downloader 谎报成功（不写盘也不进 failed）→ 磁盘复核必须抛错', async () => {
    const dir = freshRoot('lie');
    const assetIndex = makeAssetIndex(4);
    // 只静默丢弃 1 个 asset 任务（其余正常写盘）：整盘只剩这一个缺失，
    // 正是旧 bug 中「个别 worker 抛异常、任务凭空蒸发」的真实形态
    let dropped = false;
    const dl = new WritingFakeDownloader({
      dropSilently: (t) => {
        if (dropped) return false;
        if (!t.dest.includes(`${path.sep}assets${path.sep}objects${path.sep}`)) return false;
        dropped = true;
        return true;
      },
    });
    const installer = makeInstaller(dir, dl, assetIndex);

    await assert.rejects(
      () => installer.install('1.21'),
      (err: Error) => {
        assert.match(err.message, /下载失败/);
        assert.match(err.message, /复核/, '应由收尾磁盘复核发现');
        return true;
      },
    );
    assert.equal(dropped, true, '必须真的触发过静默丢弃');
  });

  it('失败时不得上报 done 事件', async () => {
    const dir = freshRoot('no-done');
    const assetIndex = makeAssetIndex(3);
    const phases: string[] = [];
    const dl = new WritingFakeDownloader({ failOn: (t) => t.dest.includes('assets') });
    const installer = makeInstaller(dir, dl, assetIndex);
    await assert.rejects(() =>
      installer.install('1.21', (p) => {
        phases.push(p.phase);
      }),
    );
    assert.ok(!phases.includes('done'), `失败时不得上报 done，实际：${phases.join(' → ')}`);
  });

  it('ok:false 但 failed 为空（downloader 自相矛盾）→ 也必须抛错', async () => {
    const dir = freshRoot('inconsistent');
    const assetIndex = makeAssetIndex(1);
    const lying = {
      async downloadAll(tasks: DownloadTask[]): Promise<DownloadResult> {
        // 写盘成功，却报告 ok:false
        for (const t of tasks) {
          fs.mkdirSync(path.dirname(t.dest), { recursive: true });
          fs.writeFileSync(t.dest, 'x', 'utf8');
        }
        return { ok: false, skipped: 0, downloaded: tasks.length, failed: [] };
      },
    };
    const installer = makeInstaller(dir, lying, assetIndex);
    await assert.rejects(() => installer.install('1.21'), /ok=false/);
  });

  it('部分已存在 + 部分缺失 → 重跑只补缺失的，已存在的计入 skipped', async () => {
    const dir = freshRoot('resume');
    const assetIndex = makeAssetIndex(6);

    // 第一遍：全量装成功
    const first = new WritingFakeDownloader();
    await makeInstaller(dir, first, assetIndex).install('1.21');
    const firstAttempted = first.attempted.length;
    assert.ok(firstAttempted > 0, '第一遍应当有任务被下载');

    // 删掉 2 个 asset 文件，模拟上次中断/漏下
    const objectDirs = fs.readdirSync(path.join(dir, 'assets', 'objects'));
    const removed: string[] = [];
    for (const sub of objectDirs) {
      for (const f of fs.readdirSync(path.join(dir, 'assets', 'objects', sub))) {
        if (removed.length < 2) {
          const full = path.join(dir, 'assets', 'objects', sub, f);
          fs.rmSync(full);
          removed.push(full);
        }
      }
    }
    assert.equal(removed.length, 2, '应成功删掉 2 个文件');

    // 第二遍：所有已存在的 dest 视为 preexisting（模拟 downloader 的跳过逻辑）
    const existing = new Set<string>();
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else existing.add(p);
      }
    };
    walk(path.join(dir, 'assets', 'objects'));
    walk(path.join(dir, 'libraries'));
    walk(path.join(dir, 'versions'));

    const second = new WritingFakeDownloader({ preexisting: existing });
    await makeInstaller(dir, second, assetIndex).install('1.21');

    // 第二遍真正尝试下载的，应当只有被删的那 2 个 asset。
    // 排除两个「天然会重试」的项：
    //   - 版本 JSON 本体（install() 末尾总会重写合并后的 <id>.json）
    //   - asset index 文件（install 阶段会重新拉一次索引，确保与远端一致）
    const alwaysRetried = new Set(['1.21.json', '17.json']);
    const attemptedExceptJson = second.attempted.filter(
      (t) => !alwaysRetried.has(path.basename(t.dest)),
    );
    assert.equal(
      attemptedExceptJson.length,
      2,
      `重跑应只补 2 个缺失 asset，实际尝试 ${String(attemptedExceptJson.length)} 个：` +
        attemptedExceptJson.map((t) => path.basename(t.dest)).join(', '),
    );
    for (const p of removed) {
      assert.ok(fs.existsSync(p), `缺失文件应被补回：${p}`);
    }

    // 全量复核：所有任务目标都在
    const plan = await makeInstaller(dir, new WritingFakeDownloader(), assetIndex).plan('1.21');
    for (const t of plan.tasks) {
      assert.ok(fs.existsSync(t.dest), `重跑后仍缺失：${t.dest}`);
    }
  });

  it('全部成功时，done 事件才发一次', async () => {
    const dir = freshRoot('success');
    const assetIndex = makeAssetIndex(2);
    const phases: string[] = [];
    const installer = makeInstaller(dir, new WritingFakeDownloader(), assetIndex);
    await installer.install('1.21', (p) => {
      if (phases.at(-1) !== p.phase) phases.push(p.phase);
    });
    assert.deepEqual(phases, ['meta', 'libraries', 'natives', 'assets', 'done']);
  });
});

describe('rules 求值', () => {
  it('无 rules → 允许', () => {
    assert.equal(rulesAllow(undefined, WINDOWS), true);
    assert.equal(rulesAllow([], WINDOWS), true);
  });

  it('allow + os 限定 → 只在匹配平台允许', () => {
    const rules = [{ action: 'allow' as const, os: { name: 'osx' } }];
    assert.equal(rulesAllow(rules, WINDOWS), false);
    assert.equal(rulesAllow(rules, { name: 'osx', arch: 'arm64' }), true);
  });

  it('disallow 在 allow 之后生效', () => {
    const rules = [
      { action: 'allow' as const },
      { action: 'disallow' as const, os: { name: 'osx' } },
    ];
    assert.equal(rulesAllow(rules, WINDOWS), true);
    assert.equal(rulesAllow(rules, { name: 'osx', arch: 'arm64' }), false);
  });

  it('os.version 正则匹配（1.6.4 的 lwjgl disallow）', () => {
    const rules = [
      { action: 'allow' as const },
      { action: 'disallow' as const, os: { name: 'osx', version: '^10\\.5\\.\\d$' } },
    ];
    assert.equal(rulesAllow(rules, { name: 'osx', arch: 'x86_64', version: '10.5.8' }), false);
    assert.equal(rulesAllow(rules, { name: 'osx', arch: 'x86_64', version: '10.14.6' }), true);
  });
});

describe('mavenPath', () => {
  it('把坐标转成仓库相对路径', () => {
    assert.equal(
      mavenPath('com.mojang:logging:1.2.7'),
      'com/mojang/logging/1.2.7/logging-1.2.7.jar',
    );
    assert.equal(
      mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'),
      'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
    );
  });

  it('非法坐标抛错', () => {
    assert.throws(() => mavenPath('bad'), /非法 Maven 坐标/);
  });
});
