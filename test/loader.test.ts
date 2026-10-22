/**
 * loader 模块测试（Fabric / Quilt）。
 *
 * 覆盖点（对应验收标准）：
 *   1. listVersions 真实网络（Fabric / Quilt 各一次；不可达则 SKIP 并说明）
 *   2. fetchProfile 有 inheritsFrom 与 libraries（真实网络）
 *   3. 库下载任务在「无 downloads.artifact」时仍能正确生成 —— **最关键**，
 *      这是前一位代理点名的致命坑：profile 只有 name + url + 平铺 sha1/size
 *   4. 安装后 JSON 能被 VersionRepository.fetchVersion 读回，且字段与 meta 原文一致
 *   5. 缺原版的错误是人话（含 `pcl3 install <gv>` 提示）
 *   6. install 的进度上报与下载失败传播
 *   7. mavenRelativePath 的坐标处理
 *
 * 网络测试约定：连不上就 `t.skip()` 并打印原因，不把环境问题伪装成通过或失败。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DownloadResult, DownloadTask, Library, VersionJson } from '../src/core/types.js';
import {
  LoaderInstaller,
  LoaderPreconditionError,
  librariesToTasks,
  libraryToTask,
  mavenRelativePath,
  joinMavenUrl,
  toDownloadTasks,
  profileUrl,
  isPrerelease,
  type LoaderKind,
  type LoaderInstallPlan,
} from '../src/core/loader/index.js';

// ───────────────────────────── 通用工具 ─────────────────────────────

const NODE_UA = 'PCL3-test';

/** 记录 downloadAll 收到什么，并按策略返回结果 */
class FakeDownloader {
  readonly calls: DownloadTask[][] = [];
  readonly progress: { done: number; total: number }[] = [];
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
      this.progress.push({ done, total: tasks.length });
      if (this.failOn(task)) result.failed.push(task);
      else result.downloaded += 1;
      done += 1;
    }
    onProgress?.({ done: tasks.length, total: tasks.length, current: '' });
    result.ok = result.failed.length === 0;
    return result;
  }
}

/** 只实现 fetchVersion 的假仓库（LoaderInstaller 也只用到这个） */
class FakeVersionRepo {
  private readonly versions: Record<string, VersionJson>;

  constructor(versions: Record<string, VersionJson> = {}) {
    this.versions = versions;
  }

  async fetchVersion(id: string): Promise<VersionJson> {
    const found = this.versions[id];
    if (!found) throw new Error(`unknown version ${id}`);
    return found;
  }
}

/** 建一个「原版已安装」的假数据根 */
async function makeDataRootWithVanilla(gameVersion: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pcl3-loader-'));
  const dir = path.join(root, 'versions', gameVersion);
  await fsp.mkdir(dir, { recursive: true });
  const vanilla: VersionJson = {
    id: gameVersion,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    libraries: [],
  };
  await fsp.writeFile(path.join(dir, `${gameVersion}.json`), JSON.stringify(vanilla, null, 2), 'utf8');
  await fsp.writeFile(path.join(dir, `${gameVersion}.jar`), 'fake-client-jar', 'utf8');
  return root;
}

async function rmrf(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** 轻量网络探测：决定网络类测试是跑还是 SKIP */
async function netReachable(url: string): Promise<{ ok: boolean; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal, headers: { 'user-agent': NODE_UA } });
    if (!res.ok) return { ok: false, reason: `HTTP ${String(res.status)}` };
    await res.text();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ═════════════════════════════ 1. 库任务生成（核心坑） ═════════════════════════════

describe('libraries: 无 downloads.artifact 时的回退链', () => {
  it('mavenRelativePath：标准坐标与 @ext / classifier', () => {
    assert.equal(
      mavenRelativePath('org.ow2.asm:asm:9.7.1'),
      'org/ow2/asm/asm/9.7.1/asm-9.7.1.jar',
    );
    assert.equal(
      mavenRelativePath('net.fabricmc:sponge-mixin:0.15.4+mixin.0.8.7'),
      'net/fabricmc/sponge-mixin/0.15.4+mixin.0.8.7/sponge-mixin-0.15.4+mixin.0.8.7.jar',
    );
    assert.equal(
      mavenRelativePath('net.fabricmc:intermediary:1.21'),
      'net/fabricmc/intermediary/1.21/intermediary-1.21.jar',
    );
    assert.equal(
      mavenRelativePath('org.quiltmc:quilt-loader:0.26.0-beta.1'),
      'org/quiltmc/quilt-loader/0.26.0-beta.1/quilt-loader-0.26.0-beta.1.jar',
    );
    // classifier 与 @ext
    assert.equal(
      mavenRelativePath('com.example:lib:1.0:natives-windows'),
      'com/example/lib/1.0/lib-1.0-natives-windows.jar',
    );
    assert.equal(mavenRelativePath('com.example:lib:1.0@zip'), 'com/example/lib/1.0/lib-1.0.zip');
    // 非法坐标返回 null（不 throw）
    assert.equal(mavenRelativePath('only:two'), null);
    assert.equal(mavenRelativePath(''), null);
  });

  it('joinMavenUrl：容忍根缺结尾斜杠', () => {
    assert.equal(
      joinMavenUrl('https://maven.fabricmc.net', 'org/ow2/asm/asm/9.7.1/asm-9.7.1.jar'),
      'https://maven.fabricmc.net/org/ow2/asm/asm/9.7.1/asm-9.7.1.jar',
    );
    assert.equal(
      joinMavenUrl('https://maven.quiltmc.org/repository/release/', 'a/b/1/b-1.jar'),
      'https://maven.quiltmc.org/repository/release/a/b/1/b-1.jar',
    );
  });

  it('只有 name + url + 平铺 sha1/size 的库 → 生成任务并保留校验信息', () => {
    const lib: Library = {
      name: 'org.ow2.asm:asm:9.7.1',
      url: 'https://maven.fabricmc.net/',
    };
    // profile 里平铺的 sha1/size 不在共享类型的 Library 上，用断言模拟真实形状
    Object.assign(lib, { sha1: 'f0ed132a49244b042cd0e15702ab9f2ce3cc8436', size: 126093 });

    const task = libraryToTask(lib, 'https://fallback.invalid/', path.join('X:', 'libraries'));
    assert.ok(task, '必须生成任务（不能因为缺 downloads.artifact 就返回 undefined）');
    assert.equal(task.url, 'https://maven.fabricmc.net/org/ow2/asm/asm/9.7.1/asm-9.7.1.jar');
    assert.equal(task.sha1, 'f0ed132a49244b042cd0e15702ab9f2ce3cc8436');
    assert.equal(task.size, 126093);
    assert.equal(task.integrity, 'library-sha1');
    assert.ok(task.dest.endsWith(path.join('org', 'ow2', 'asm', 'asm', '9.7.1', 'asm-9.7.1.jar')));
  });

  it('完全没有 sha1/size 的库（intermediary / fabric-loader）→ 裸下载但任务仍然存在', () => {
    const libs: Library[] = [
      { name: 'net.fabricmc:intermediary:1.21', url: 'https://maven.fabricmc.net/' },
      { name: 'net.fabricmc:fabric-loader:0.16.9', url: 'https://maven.fabricmc.net/' },
    ];
    const { tasks, skipped } = librariesToTasks(libs, {
      kind: 'fabric',
      fallbackMavenRoot: 'https://maven.fabricmc.net/',
      librariesRoot: path.join('C:', 'data', 'libraries'),
    });

    assert.equal(skipped.length, 0);
    assert.equal(tasks.length, 2, '两条都必须生成任务（这是「启动必崩」的防线）');
    assert.equal(tasks[0]?.url, 'https://maven.fabricmc.net/net/fabricmc/intermediary/1.21/intermediary-1.21.jar');
    assert.equal(tasks[1]?.url, 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar');
    for (const t of tasks) {
      assert.equal(t.integrity, 'none');
      assert.equal(t.sha1, undefined);
      assert.equal(t.size, undefined);
    }
  });

  it('lib.url 缺失时用 kind 的默认 Maven 根兜底', () => {
    const task = libraryToTask(
      { name: 'org.quiltmc:quilt-loader:0.26.0-beta.1' },
      'https://maven.quiltmc.org/repository/release/',
      path.join('C:', 'data', 'libraries'),
    );
    assert.ok(task);
    assert.equal(
      task.url,
      'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/0.26.0-beta.1/quilt-loader-0.26.0-beta.1.jar',
    );
  });

  it('downloads.artifact 存在时优先用它（回退链第 1 级）', () => {
    const lib: Library = {
      name: 'com.example:thing:1.0',
      url: 'https://ignored.example/',
      downloads: {
        artifact: {
          path: 'com/example/thing/1.0/thing-1.0.jar',
          url: 'https://cdn.example/thing-1.0.jar',
          sha1: 'a'.repeat(40),
          size: 4242,
        },
      },
    };
    const task = libraryToTask(lib, 'https://fallback.invalid/', path.join('C:', 'data', 'libraries'));
    assert.ok(task);
    assert.equal(task.url, 'https://cdn.example/thing-1.0.jar');
    assert.equal(task.integrity, 'artifact');
    assert.equal(task.size, 4242);
  });

  it('toDownloadTasks 剥掉附加字段，只留契约 DownloadTask', () => {
    const { tasks } = librariesToTasks(
      [{ name: 'net.fabricmc:intermediary:1.21', url: 'https://maven.fabricmc.net/' }],
      { kind: 'fabric', fallbackMavenRoot: 'https://maven.fabricmc.net/', librariesRoot: path.join('C:', 'libs') },
    );
    const plain = toDownloadTasks(tasks);
    assert.equal(plain.length, 1);
    const keys = Object.keys(plain[0] as object).sort();
    assert.deepEqual(keys, ['dest', 'url']);
  });

  it('同目标路径的重复库只保留一条', () => {
    const libs: Library[] = [
      { name: 'org.ow2.asm:asm:9.7.1', url: 'https://maven.fabricmc.net/' },
      { name: 'org.ow2.asm:asm:9.7.1', url: 'https://maven.fabricmc.net/' },
    ];
    const { tasks, skipped } = librariesToTasks(libs, {
      kind: 'fabric',
      fallbackMavenRoot: 'https://maven.fabricmc.net/',
      librariesRoot: path.join('C:', 'libs'),
    });
    assert.equal(tasks.length, 1);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]?.reason ?? '', /重复/);
  });
});

// ═════════════════════════════ 2. plan：原版前置 + 非空任务 ═════════════════════════════

describe('plan: 原版前置检查与人话报错', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pcl3-loader-empty-'));
  });

  afterEach(async () => {
    await rmrf(dataRoot);
  });

  it('原版未安装时抛出 LoaderPreconditionError，且提示 pcl3 install', async () => {
    const installer = new LoaderInstaller({
      versionRepo: new FakeVersionRepo(),
      downloader: new FakeDownloader(),
      dataRoot,
      logger: { warn: () => undefined },
    });

    await assert.rejects(
      () => installer.plan('fabric', '1.21', '0.16.9'),
      (err: unknown) => {
        assert.ok(err instanceof LoaderPreconditionError, '必须是 LoaderPreconditionError');
        assert.match(err.message, /原版 1\.21 还没安装/);
        assert.match(err.hint, /pcl3 install 1\.21/);
        return true;
      },
    );
  });

  it('只有版本 JSON 没有 jar 时也报人话错误', async () => {
    const dir = path.join(dataRoot, 'versions', '1.20.1');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '1.20.1.json'), '{"id":"1.20.1"}', 'utf8');

    const installer = new LoaderInstaller({
      versionRepo: new FakeVersionRepo(),
      downloader: new FakeDownloader(),
      dataRoot,
      logger: { warn: () => undefined },
    });

    await assert.rejects(
      () => installer.plan('fabric', '1.20.1', '0.16.9'),
      (err: unknown) => {
        assert.ok(err instanceof LoaderPreconditionError);
        assert.match(err.message, /jar 缺失/);
        assert.match(err.hint, /pcl3 install 1\.20\.1/);
        return true;
      },
    );
  });

  it('未知 kind 直接拒绝', async () => {
    const installer = new LoaderInstaller({
      versionRepo: new FakeVersionRepo(),
      downloader: new FakeDownloader(),
      dataRoot,
      logger: { warn: () => undefined },
    });
    await assert.rejects(
      () => installer.listVersions('forge' as LoaderKind, '1.21'),
      /未知的加载器类型/,
    );
  });
});

// ═════════════════════════════ 3. 真实网络：listVersions / fetchProfile / install ═════════════════════════════

describe('真实网络：Fabric', () => {
  const GAME = '1.21';
  const URL_LIST = 'https://meta.fabricmc.net/v2/versions/loader';

  it('listVersions 拉取全局列表', async (t) => {
    const probe = await netReachable(URL_LIST);
    if (!probe.ok) {
      t.skip(`SKIP：meta.fabricmc.net 不可达（${probe.reason ?? '未知'}），跳过真实网络用例`);
      return;
    }

    const installer = new LoaderInstaller({
      versionRepo: new FakeVersionRepo(),
      downloader: new FakeDownloader(),
      logger: { warn: () => undefined },
    });
    const list = await installer.listVersions('fabric', GAME);

    assert.ok(list.length > 50, `应拿到数十条以上，实际 ${String(list.length)}`);
    // 形状：{version, stable} 两个字段，且顺序与 meta 一致（新 → 旧）
    const first = list[0];
    assert.ok(first);
    assert.equal(typeof first.version, 'string');
    assert.equal(typeof first.stable, 'boolean');
    assert.deepEqual(Object.keys(first).sort(), ['stable', 'version']);

    // 至少有一条被 meta 显式标为 stable
    const stableOnes = list.filter((v) => v.stable);
    assert.ok(stableOnes.length >= 1, 'meta 里应至少有一个 stable 版本');

    console.log(
      `      [fabric] 共 ${String(list.length)} 条，stable ${String(stableOnes.length)} 条，首条 ${first.version}（stable=${String(first.stable)}）`,
    );
  });

  it('listVersionsDetailed 如实标注 Quilt 的 stable 来源', async (t) => {
    const probe = await netReachable('https://meta.quiltmc.org/v3/versions/loader');
    if (!probe.ok) {
      t.skip(`SKIP：meta.quiltmc.org 不可达（${probe.reason ?? '未知'}）`);
      return;
    }
    const installer = new LoaderInstaller({
      versionRepo: new FakeVersionRepo(),
      downloader: new FakeDownloader(),
      logger: { warn: () => undefined },
    });
    const list = await installer.listVersionsDetailed('quilt', GAME);
    assert.ok(list.length > 50);

    const inferred = list.filter((v) => v.stabilitySource !== 'declared');
    assert.equal(inferred.length, list.length, 'Quilt 全局列表无 stable 字段，全部应为推断');
    // 推断口径：带 beta/alpha 的一定不是 stable
    for (const item of list) {
      if (item.prerelease) assert.equal(item.stable, false, `${item.version} 是预发布，不应标 stable`);
    }
    assert.ok(list.some((v) => !v.prerelease), '应同时存在非预发布版本');
    console.log(`      [quilt] 共 ${String(list.length)} 条，稳定(推断) ${String(list.filter((v) => v.stable).length)} 条`);
  });

  it('fetchProfile 有 inheritsFrom / mainClass / libraries，且 libraries 无 downloads.artifact', async (t) => {
    const probe = await netReachable(URL_LIST);
    if (!probe.ok) {
      t.skip(`SKIP：meta.fabricmc.net 不可达（${probe.reason ?? '未知'}）`);
      return;
    }

    const installer = new LoaderInstaller({
      versionRepo: new FakeVersionRepo(),
      downloader: new FakeDownloader(),
      logger: { warn: () => undefined },
    });
    const profile = await installer.fetchProfile('fabric', GAME, '0.16.9');

    assert.equal(profile.id, `fabric-loader-0.16.9-${GAME}`);
    assert.equal(profile.inheritsFrom, GAME);
    assert.match(String(profile.mainClass), /net\.fabricmc\.loader/);
    assert.ok(Array.isArray(profile.libraries) && profile.libraries.length > 0);

    // 关键断言：这正是「照抄原版安装器会拿到空列表」的现场证据
    const withArtifact = profile.libraries.filter((l) => l.downloads?.artifact !== undefined);
    const withUrl = profile.libraries.filter((l) => typeof l.url === 'string' && l.url !== '');
    console.log(
      `      [fabric] libraries=${String(profile.libraries.length)}，带 downloads.artifact 的 ${String(withArtifact.length)} 条，带 url 的 ${String(withUrl.length)} 条`,
    );
    assert.equal(withArtifact.length, 0, 'Fabric profile 目前不带 downloads.artifact —— 回退链是必需的');
    assert.ok(withUrl.length > 0, '必须有带 url 的库，回退链才有料可拼');
  });

  it('install 端到端：库任务非空 + JSON 原样落盘 + fetchVersion 能读回', async (t) => {
    const probe = await netReachable(URL_LIST);
    if (!probe.ok) {
      t.skip(`SKIP：meta.fabricmc.net 不可达（${probe.reason ?? '未知'}）`);
      return;
    }

    const dataRoot = await makeDataRootWithVanilla(GAME);
    try {
      const downloader = new FakeDownloader();
      const installer = new LoaderInstaller({
        versionRepo: new FakeVersionRepo(),
        downloader,
        dataRoot,
        logger: { warn: () => undefined },
      });

      const expected = await installer.fetchProfile('fabric', GAME, '0.16.9');

      const plan = await installer.plan('fabric', GAME, '0.16.9');
      assert.equal(plan.versionId, expected.id);
      assert.ok(plan.tasks.length > 0, '计划里必须有下载任务');
      assert.equal(plan.tasks.length, expected.libraries.length, '每条库都应生成任务');
      assert.equal(plan.unverified, 2, 'intermediary 与 fabric-loader 两条无 sha1');
      for (const task of plan.tasks) {
        assert.ok(task.url.startsWith('https://maven.fabricmc.net/'), `URL 应指向 fabric maven：${task.url}`);
        assert.ok(task.dest.startsWith(path.join(dataRoot, 'libraries')));
      }
      // loaders 本体真的在计划里
      assert.ok(
        plan.tasks.some((t) => t.library === 'net.fabricmc:fabric-loader:0.16.9'),
        'fabric-loader 本体必须在下载任务里',
      );

      const progress: string[] = [];
      const { versionId } = await installer.install('fabric', GAME, '0.16.9', (p) => {
        progress.push(`${p.phase}:${String(p.done)}/${String(p.total)}`);
      });
      assert.equal(versionId, expected.id);

      // 进度阶段齐备
      assert.ok(progress.includes('done:1/1'), `进度里应有 done 阶段：${progress.join(', ')}`);
      assert.ok(
        progress.some((p) => p.startsWith('libraries:')),
        '应有 libraries 阶段',
      );

      // 下载器真的被喂了非空任务（致命坑的收口断言）
      assert.equal(downloader.calls.length, 1);
      const fed = downloader.calls[0] ?? [];
      assert.ok(fed.length > 0, '传给 downloadAll 的任务列表不能为空');
      assert.equal(fed.length, plan.tasks.length);

      // 落盘 JSON 能被 VersionRepository.fetchVersion 读回
      const jsonPath = path.join(dataRoot, 'versions', versionId, `${versionId}.json`);
      assert.ok(fs.existsSync(jsonPath), `版本 JSON 应存在于 ${jsonPath}`);

      const { VersionRepository } = await import('../src/core/version/index.js');
      const repo = new VersionRepository({ dataRoot, logger: { warn: () => undefined } });
      // ① 版本目录里那份（启动器 / install 的约定路径）
      const fromDir = JSON.parse(await fsp.readFile(jsonPath, 'utf8')) as VersionJson;
      assert.deepEqual(fromDir, JSON.parse(JSON.stringify(expected)), '版本目录 JSON 必须与 meta 原文逐字段相等');
      // ② VersionRepository.fetchVersion —— GameLauncher 走的就是这条（它只认 <dataRoot>/meta/<id>.json）
      const readBack = await repo.fetchVersion(versionId);
      assert.deepEqual(readBack, JSON.parse(JSON.stringify(expected)), 'fetchVersion 读回的 JSON 必须与 meta 原文逐字段相等');
      assert.equal(repo.readCachedVersion(versionId)?.id, versionId);

      // ③ 继承链能被 resolveInherited 处理（原版已在同一 dataRoot 里）
      const merged = await repo.resolveInherited(readBack);
      assert.equal(merged.inheritsFrom, undefined, '合并后不应再有 inheritsFrom');
      assert.equal(merged.mainClass, expected.mainClass, '合并后 mainClass 应保留 loader 的 KnotClient');
      assert.ok(
        (merged.libraries?.length ?? 0) >= expected.libraries.length,
        '合并后库数量不应少于 loader 自己的库',
      );

      console.log(
        `      [fabric] 下载任务 ${String(plan.tasks.length)} 条（其中无 sha1 的 ${String(plan.unverified)} 条），` +
          `JSON=${String(JSON.stringify(expected).length)}B，fetchVersion 读回一致，resolveInherited 合并后 ${String(merged.libraries?.length ?? 0)} 个库`,
      );
    } finally {
      await rmrf(dataRoot);
    }
  });

  it('Quilt 端到端：库任务非空 + 两个 maven 源都被用到', async (t) => {
    const probe = await netReachable('https://meta.quiltmc.org/v3/versions/loader');
    if (!probe.ok) {
      t.skip(`SKIP：meta.quiltmc.org 不可达（${probe.reason ?? '未知'}）`);
      return;
    }

    const dataRoot = await makeDataRootWithVanilla(GAME);
    try {
      const downloader = new FakeDownloader();
      const installer = new LoaderInstaller({
        versionRepo: new FakeVersionRepo(),
        downloader,
        dataRoot,
        logger: { warn: () => undefined },
      });

      // Quilt 的版本号用 0.26.0-beta.1（前一位代理实测可用）
      const expected = await installer.fetchProfile('quilt', GAME, '0.26.0-beta.1');
      assert.equal(expected.id, `quilt-loader-0.26.0-beta.1-${GAME}`);
      assert.equal(expected.inheritsFrom, GAME);
      assert.match(String(expected.mainClass), /quiltmc/);

      const plan = await installer.plan('quilt', GAME, '0.26.0-beta.1');
      assert.ok(plan.tasks.length > 0, 'Quilt 计划必须有下载任务');
      assert.equal(plan.tasks.length, expected.libraries.length);

      const hosts = new Set(plan.tasks.map((x) => new URL(x.url).host));
      assert.ok(hosts.has('maven.fabricmc.net'), 'Quilt 也用 fabric maven 上的库');
      assert.ok(hosts.has('maven.quiltmc.org'), 'Quilt 自己的 maven 也要用到');

      // Quilt profile 全部条目都没有 sha1/size → 全部裸下载
      assert.equal(plan.unverified, plan.tasks.length, 'Quilt 的库全都没有校验信息');

      const { versionId } = await installer.install('quilt', GAME, '0.26.0-beta.1');
      const fed = downloader.calls[0] ?? [];
      assert.ok(fed.length > 0, '传给 downloadAll 的任务列表不能为空');

      const { VersionRepository } = await import('../src/core/version/index.js');
      const repo = new VersionRepository({ dataRoot, logger: { warn: () => undefined } });
      const readBack = await repo.fetchVersion(versionId);
      assert.deepEqual(readBack, JSON.parse(JSON.stringify(expected)));
      const fromDir = JSON.parse(
        await fsp.readFile(path.join(dataRoot, 'versions', versionId, `${versionId}.json`), 'utf8'),
      ) as VersionJson;
      assert.deepEqual(fromDir, JSON.parse(JSON.stringify(expected)));

      const merged = await repo.resolveInherited(readBack);
      assert.equal(merged.inheritsFrom, undefined);
      assert.match(String(merged.mainClass), /quiltmc/);

      console.log(
        `      [quilt] 下载任务 ${String(plan.tasks.length)} 条（全部无 sha1），` +
          `来源 ${[...hosts].join(' + ')}`,
      );
    } finally {
      await rmrf(dataRoot);
    }
  });

  it('profile 端点是可用性判据：不存在的组合会抛错', async (t) => {
    const probe = await netReachable(URL_LIST);
    if (!probe.ok) {
      t.skip(`SKIP：meta.fabricmc.net 不可达（${probe.reason ?? '未知'}）`);
      return;
    }
    const installer = new LoaderInstaller({
      versionRepo: new FakeVersionRepo(),
      downloader: new FakeDownloader(),
      logger: { warn: () => undefined },
    });
    // 实测：不存在的 loader 版本返回 400 + "no loader version found for ..."
    await assert.rejects(
      () => installer.fetchProfile('fabric', '1.21', '0.0.0-does-not-exist'),
      /HTTP 40[04]|no loader version found|无法访问/,
    );
  });

  it('profileUrl 的形状符合 meta 端点', () => {
    assert.equal(
      profileUrl('fabric', '1.21', '0.16.9'),
      'https://meta.fabricmc.net/v2/versions/loader/1.21/0.16.9/profile/json',
    );
    assert.equal(
      profileUrl('quilt', '1.21', '0.26.0-beta.1'),
      'https://meta.quiltmc.org/v3/versions/loader/1.21/0.26.0-beta.1/profile/json',
    );
  });

  it('isPrerelease 判定', () => {
    assert.equal(isPrerelease('0.26.0-beta.1'), true);
    assert.equal(isPrerelease('0.31.0-beta.4'), true);
    assert.equal(isPrerelease('1.0.0-alpha.3'), true);
    assert.equal(isPrerelease('0.16.9'), false);
    assert.equal(isPrerelease('0.19.5'), false);
  });
});

// ═════════════════════════════ 4. 安装失败传播 ═════════════════════════════

describe('install: 下载失败必须抛出而非静默成功', () => {
  it('任一库下载失败 → 抛错并带上文件名', async (t) => {
    const probe = await netReachable('https://meta.fabricmc.net/v2/versions/loader/1.21');
    if (!probe.ok) {
      t.skip(`SKIP：meta.fabricmc.net 不可达（${probe.reason ?? '未知'}）`);
      return;
    }

    const dataRoot = await makeDataRootWithVanilla('1.21');
    try {
      const downloader = new FakeDownloader((task) => task.url.includes('intermediary'));
      const installer = new LoaderInstaller({
        versionRepo: new FakeVersionRepo(),
        downloader,
        dataRoot,
        logger: { warn: () => undefined },
      });
      await assert.rejects(
        () => installer.install('fabric', '1.21', '0.16.9'),
        /库下载失败 1\/\d+：intermediary-1\.21\.jar/,
      );
      // 失败时不应落盘版本 JSON
      assert.ok(!fs.existsSync(path.join(dataRoot, 'versions', 'fabric-loader-0.16.9-1.21')));
    } finally {
      await rmrf(dataRoot);
    }
  });
});

// ═════════════════════════════ 5. 计划结构 ═════════════════════════════

describe('LoaderInstallPlan 结构', () => {
  it('字段齐全且可直接当 DownloadTask[] 用', () => {
    const versionId = 'fabric-loader-0.16.9-1.21';
    const plan: LoaderInstallPlan = {
      versionId,
      kind: 'fabric',
      gameVersion: '1.21',
      loaderVersion: '0.16.9',
      tasks: [
        {
          url: 'https://maven.fabricmc.net/a/b/1/b-1.jar',
          dest: path.join('C:', 'libs', 'a', 'b', '1', 'b-1.jar'),
          library: 'a:b:1',
          integrity: 'none',
        },
      ],
      unverified: 1,
      totalBytes: 0,
      versionJsonPath: path.join('C:', 'versions', versionId, `${versionId}.json`),
    };
    const tasks = toDownloadTasks(plan.tasks);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.url, plan.tasks[0]?.url);
  });
});
