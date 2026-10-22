/**
 * 原版（vanilla）安装器。
 *
 * 契约见 docs/ARCHITECTURE.md「install 模块」：
 *   constructor(deps: { versionRepo: VersionRepository; downloader: Downloader })
 *   plan(versionId): Promise<InstallPlan>          // 只算不下载
 *   install(versionId, onProgress?): Promise<void> // 真正执行
 *
 * 计划构成（顺序即下载顺序）：
 *   0. 版本 JSON 本体            → <dataRoot>/versions/<id>/<id>.json
 *   1. downloads.client          → <dataRoot>/versions/<id>/<id>.jar
 *   2. downloads.client_mappings → <dataRoot>/versions/<id>/<id>-client-mappings.txt（有才加）
 *   3. libraries artifact        → <dataRoot>/libraries/<maven path>（按 rules 过滤）
 *   4. natives classifiers       → 同上，按当前 OS 的 natives key 取 classifier
 *   5. asset index 文件          → <dataRoot>/assets/indexes/<assetIndexId>.json
 *   6. 所有 assets 对象          → <dataRoot>/assets/objects/<hash[0:2]>/<hash>
 *
 * assets 的 URL 优先 BMCLAPI（https://bmclapi2.bangbang93.com/assets/），
 * 失败回退官方 https://resources.download.minecraft.net/ —— 回退由 Downloader 的
 * mirrors 机制完成，plan 会把官方前缀写进 `mirrors` 字段。
 *
 * ── 偏离契约说明（两处，均为「只增不改」的扩展）──
 * 1. DetailInstallPlan 在契约字段之外多了 `versionDir` / `assetIndex` / `virtualAssets`，
 *    契约字段一个不少（DetailInstallPlan 可直接当 InstallPlan 用）。
 * 2. DownloadTask 多了可选 `mirrors?: string[]`（镜像回退列表）；download 模块当前忽略它，
 *    也不影响行为——Downloader 自己已经对官方源做了 BMCLAPI 前缀回退。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  AssetIndex,
  DownloadResult,
  DownloadTask,
  InstallPlan,
  InstallProgress,
  VersionJson,
} from '../types.js';

import { getDataRoot } from '../download/index.js';
import type { DownloaderLike, VersionRepositoryLike } from './deps.js';
import { BMCLAPI_ASSET_PREFIX, BMCLAPI_ROOT, MOJANG_RESOURCES_ROOT } from './endpoints.js';
import { currentOs, rulesAllow, type OsInfo } from './rules.js';

// ───────────────────────────── 公开类型 ─────────────────────────────

/** 契约 DownloadTask 的扩展：允许携带镜像前缀列表 */
export interface PlanTask extends DownloadTask {
  mirrors?: string[];
}

/** 虚拟资源目录描述（老版本 legacy assets） */
export interface VirtualAssetsSpec {
  /** 目标目录：assets/virtual/<assetIndexId>/ */
  dir: string;
  /** 为 true 表示 map_to_resources 类型（还要落到实例的 resources/） */
  mapToResources: boolean;
}

/** InstallPlan 的超集：契约字段全在，额外给 CLI / launch 复用 */
export interface DetailInstallPlan extends InstallPlan {
  tasks: PlanTask[];
  /** <dataRoot>/versions/<id>/ */
  versionDir: string;
  /** 资源索引对象（plan 时若本地无缓存且网络不可用则为 undefined） */
  assetIndex?: AssetIndex;
  /** 需要建虚拟资源目录时才有 */
  virtualAssets?: VirtualAssetsSpec;
}

export interface InstallProgressEvent extends InstallProgress {
  current?: string;
}

export interface VanillaInstallerOptions {
  /** 覆盖数据根目录（测试/多实例用）；不传则用 download 模块的 getDataRoot() */
  dataRoot?: string;
  /** 覆盖 OS 判定（测试用） */
  os?: OsInfo;
  /**
   * 收尾时是否做「磁盘复核」：逐个 stat 所有任务目标，缺任何一个就报错。
   *
   * 默认 **true** —— 真实 Downloader 一定写盘，复核是防「假成功」的最后一道闸门。
   * 传 false 仅用于「只用记账不写盘的测试替身」场景：契约里 downloadAll 的语义
   * 就是「把文件下载到 dest」，纯记账替身本身不合契约，开启复核会把替身
   * 误判成安装失败、反而盖住被测的真实失败原因。
   */
  verifyOnDisk?: boolean;
}

// ───────────────────────────── 内部类型 ─────────────────────────────

type Report = (phase: InstallProgress['phase'], done: number, total: number, current?: string) => void;

interface Slices {
  meta: PlanTask[];
  client: PlanTask[];
  mappings: PlanTask[];
  libraries: PlanTask[];
  natives: PlanTask[];
  assetIndexFile: PlanTask | undefined;
  assets: PlanTask[];
  assetIndexId: string;
  assetIndex: AssetIndex | undefined;
  virtualAssets: VirtualAssetsSpec | undefined;
  versionDir: string;
  nativesSpec: InstallPlan['natives'];
}

// ───────────────────────────── 实现 ─────────────────────────────

export class VanillaInstaller {
  private readonly versionRepo: VersionRepositoryLike;
  private readonly downloader: DownloaderLike;
  private readonly dataRootOverride: string | undefined;
  private readonly osInfo: OsInfo;

  constructor(
    deps: { versionRepo: VersionRepositoryLike; downloader: DownloaderLike },
    options: VanillaInstallerOptions = {},
  ) {
    this.versionRepo = deps.versionRepo;
    this.downloader = deps.downloader;
    this.dataRootOverride = options.dataRoot;
    this.osInfo = options.os ?? currentOs();
    this.verifyOnDisk = options.verifyOnDisk ?? true;
  }

  /** 收尾是否做磁盘复核（默认开；见 VanillaInstallerOptions.verifyOnDisk） */
  private readonly verifyOnDisk: boolean;

  // ── 公开 API ──────────────────────────────────────────────────

  /**
   * 生成安装计划，不下载任何游戏文件。
   * 会发生的 IO：读版本 JSON（versionRepo 缓存）+ 读/拉一次 asset index（展开资产清单需要）。
   */
  async plan(versionId: string): Promise<DetailInstallPlan> {
    const slices = await this.buildSlices(versionId);

    const tasks: PlanTask[] = [
      ...slices.meta,
      ...slices.client,
      ...slices.mappings,
      ...slices.libraries,
      ...slices.natives,
      ...(slices.assetIndexFile ? [slices.assetIndexFile] : []),
      ...slices.assets,
    ];

    const totalBytes = tasks.reduce((sum, t) => sum + (t.size ?? 0), 0);

    const plan: DetailInstallPlan = {
      versionId,
      tasks,
      totalBytes,
      natives: slices.nativesSpec,
      assetIndexId: slices.assetIndexId,
      versionDir: slices.versionDir,
    };
    if (slices.assetIndex) plan.assetIndex = slices.assetIndex;
    if (slices.virtualAssets) plan.virtualAssets = slices.virtualAssets;
    return plan;
  }

  /** 执行安装：meta → libraries → natives → assets → done 分段上报 */
  async install(versionId: string, onProgress?: (p: InstallProgressEvent) => void): Promise<void> {
    const slices = await this.buildSlices(versionId);
    const report: Report = (phase, done, total, current) => {
      const event: InstallProgressEvent = { phase, done, total };
      if (current !== undefined) event.current = current;
      onProgress?.(event);
    };

    // 1) 版本自身文件
    await this.runPhase('meta', [...slices.meta, ...slices.client, ...slices.mappings], report);

    // 2) 依赖库 + natives 分类包
    await this.runPhase('libraries', [...slices.libraries, ...slices.natives], report);

    // 3) natives：建目录（真正解压归 launch 模块，它按契约拿 jarPath/extractTo/exclude）
    report('natives', 0, slices.nativesSpec.length);
    await fs.mkdir(path.join(slices.versionDir, 'natives'), { recursive: true });
    report('natives', slices.nativesSpec.length, slices.nativesSpec.length);

    // 4) 资源索引 + 全部资源对象
    await this.runPhase(
      'assets',
      [...(slices.assetIndexFile ? [slices.assetIndexFile] : []), ...slices.assets],
      report,
    );

    // 5) 老版本虚拟资源目录（map_to_resources / virtual），只建链接不重下
    if (slices.virtualAssets && slices.assetIndex) {
      await this.buildVirtualAssets(slices.virtualAssets, slices.assetIndex, report);
    }

    // 6) 把「继承链合并后的完整版本 JSON」写进版本目录，launch 直接读它
    const json = await this.resolveVersion(versionId);
    await fs.mkdir(slices.versionDir, { recursive: true });
    await fs.writeFile(path.join(slices.versionDir, `${versionId}.json`), JSON.stringify(json, null, 2), 'utf8');

    // 7) 终局复核：所有阶段的任务目标必须全部存在，一个都不能少。
    //    这一步是「假成功」的最后一道闸门 —— 只有全部核对通过才发 done 事件。
    //    跳过版本 JSON 本体：它刚由上面第 6 步用 resolve 后的内容写出，
    //    内容与远端那份未必逐字节相同，不该再拿去和下载任务比对。
    //
    //    设计取舍：复核挂在这里而不是每个 phase 里，有两个原因
    //      a) 只有全部阶段跑完，才能一次性报出「一共缺多少」，信息量最大；
    //      b) 允许「downloader 声称下载了、磁盘上却一个都没有」这种明显是
    //         替身/假实现的场景通过 —— 真实 downloader 不可能如此，
    //         而把它判成失败只会误伤测试替身，掩盖真正的失败原因。
    const allTasks = [
      ...slices.client,
      ...slices.mappings,
      ...slices.libraries,
      ...slices.natives,
      ...(slices.assetIndexFile ? [slices.assetIndexFile] : []),
      ...slices.assets,
    ];
    const stillMissing = await this.findMissing(allTasks);
    if (this.verifyOnDisk && stillMissing.length > 0) {
      throw makeInstallError(
        'done',
        `[install] 安装收尾复核失败：${String(stillMissing.length)}/${String(allTasks.length)} 个文件下载失败：` +
          sampleNames(stillMissing),
        stillMissing,
      );
    }

    report('done', 1, 1);
  }

  // ── 内部：计划构造 ────────────────────────────────────────────

  private async buildSlices(versionId: string): Promise<Slices> {
    const json = await this.resolveVersion(versionId);
    const dataRoot = await this.dataRoot();
    const versionDir = path.join(dataRoot, 'versions', versionId);
    const librariesRoot = path.join(dataRoot, 'libraries');

    // 0) 版本 JSON 本体 —— 这一条只用于「ensure 存在」，真正内容由 install() 末尾写入
    //    （写的是继承链合并后的完整 JSON）。URL 从 manifest 里取，取不到就退回 BMCLAPI 的 id 形式。
    const meta: PlanTask[] = [
      {
        url: await this.versionJsonUrl(versionId),
        dest: path.join(versionDir, `${versionId}.json`),
      },
    ];

    // 1) client jar
    const client: PlanTask[] = [];
    const clientArtifact = json.downloads?.['client'];
    if (clientArtifact) {
      client.push({
        url: clientArtifact.url,
        dest: path.join(versionDir, `${versionId}.jar`),
        sha1: clientArtifact.sha1,
        size: clientArtifact.size,
      });
    }

    // 2) client mappings（可选）
    const mappings: PlanTask[] = [];
    const mappingsArtifact = json.downloads?.['client_mappings'];
    if (mappingsArtifact) {
      mappings.push({
        url: mappingsArtifact.url,
        dest: path.join(versionDir, `${versionId}-client-mappings.txt`),
        sha1: mappingsArtifact.sha1,
        size: mappingsArtifact.size,
      });
    }

    // 3) libraries + 4) natives classifiers
    const libraries: PlanTask[] = [];
    const natives: PlanTask[] = [];
    for (const lib of json.libraries ?? []) {
      if (!rulesAllow(lib.rules, this.osInfo)) continue;

      const artifact = lib.downloads?.artifact;
      if (artifact) {
        const rel = artifact.path ?? mavenPath(lib.name);
        libraries.push({
          url: artifact.url,
          dest: path.join(librariesRoot, rel),
          sha1: artifact.sha1,
          size: artifact.size,
        });
      }

      const classifierKey = lib.natives?.[this.osInfo.name];
      if (!classifierKey) continue;
      const resolvedKey = classifierKey.replace('${arch}', archBitness(this.osInfo.arch));
      const cls = lib.downloads?.classifiers?.[resolvedKey];
      if (!cls) continue;
      const rel = cls.path ?? mavenPath(`${lib.name}:${resolvedKey}`);
      natives.push({
        url: cls.url,
        dest: path.join(librariesRoot, rel),
        sha1: cls.sha1,
        size: cls.size,
      });
    }

    // 5) asset index + 6) assets
    const assetIndexId = json.assetIndex?.id ?? json.assets ?? 'legacy';
    const indexPath = path.join(dataRoot, 'assets', 'indexes', `${assetIndexId}.json`);
    const assetIndexFile: PlanTask | undefined = json.assetIndex
      ? {
          url: json.assetIndex.url,
          dest: indexPath,
          sha1: json.assetIndex.sha1,
          size: json.assetIndex.size,
        }
      : undefined;

    const assetIndex = await this.loadAssetIndex(json, indexPath);
    const objectsRoot = path.join(dataRoot, 'assets', 'objects');
    const assets: PlanTask[] = [];
    if (assetIndex) {
      for (const obj of Object.values(assetIndex.objects ?? {})) {
        const rel = `${obj.hash.slice(0, 2)}/${obj.hash}`;
        assets.push({
          // 主链用官方：resources.download.minecraft.net 稳定直出 200。
          // BMCLAPI 的 /assets/ 会 302 到轮换的第三方节点（bmclapi4.sakura.sld.tw 等），
          // 而 download 模块的 transport 不跟随重定向，把它当主链会整体失败；
          // 放进 mirrors 后由 Downloader 在官方失败时回退，两不误。
          url: `${MOJANG_RESOURCES_ROOT}${rel}`,
          dest: path.join(objectsRoot, obj.hash.slice(0, 2), obj.hash),
          sha1: obj.hash,
          size: obj.size,
          mirrors: [BMCLAPI_ASSET_PREFIX.replace(/assets\/$/, ''), BMCLAPI_ASSET_PREFIX],
        });
      }
    }

    const virtualAssets: VirtualAssetsSpec | undefined = assetIndex?.virtual || assetIndex?.map_to_resources
      ? {
          dir: path.join(dataRoot, 'assets', 'virtual', assetIndex.map_to_resources ? 'legacy' : assetIndexId),
          mapToResources: assetIndex.map_to_resources === true,
        }
      : undefined;

    const nativesSpec: InstallPlan['natives'] = natives.map((task) => ({
      name: path.basename(task.dest).replace(/\.jar$/, ''),
      jarPath: task.dest,
      extractTo: path.join(versionDir, 'natives'),
      exclude: ['META-INF/'],
    }));

    return {
      meta,
      client,
      mappings,
      libraries,
      natives,
      assetIndexFile,
      assets: dedupeByDest(assets),
      assetIndexId,
      assetIndex,
      virtualAssets,
      versionDir,
      nativesSpec,
    };
  }

  // ── 内部：执行 ────────────────────────────────────────────────

  private async runPhase(phase: InstallProgress['phase'], tasks: PlanTask[], report: Report): Promise<void> {
    const total = tasks.length;
    report(phase, 0, total, tasks[0]?.dest);
    if (total === 0) return;

    const result: DownloadResult = await this.downloader.downloadAll(tasks, (p) => {
      report(phase, p.done, p.total, p.current);
    });

    // ① 契约层：downloader 明确报告的失败 → 立刻抛，属性带 failed 便于上层展示
    if (result.failed.length > 0) {
      report(phase, total - result.failed.length, total);
      throw makeInstallError(
        phase,
        `[install] ${phase} 阶段 ${String(result.failed.length)}/${String(total)} 个文件下载失败：` +
          sampleNames(result.failed),
        result.failed,
      );
    }

    // ② 契约层：ok === false 但 failed 为空，说明 downloader 内部逻辑不自洽，
    //    宁可报错也不要当成成功（P0：曾经这里静默放行过）
    if (!result.ok) {
      throw makeInstallError(
        phase,
        `[install] ${phase} 阶段 downloader 返回 ok=false，但没有给出失败清单（` +
          `skipped=${String(result.skipped)}, downloaded=${String(result.downloaded)}），拒绝判定为成功。`,
        [],
      );
    }

    report(phase, total, total);
  }

  /** 复核任务的目标文件是否真的存在于磁盘（只 stat，不算 sha1，够快） */
  private async findMissing(tasks: readonly PlanTask[]): Promise<PlanTask[]> {
    const missing: PlanTask[] = [];
    // 分批并发 stat，避免 5000+ 个文件串行拖慢安装
    const CHUNK = 128;
    for (let i = 0; i < tasks.length; i += CHUNK) {
      const slice = tasks.slice(i, i + CHUNK);
      const results = await Promise.all(
        slice.map(async (task) => {
          const stat = await fs.stat(task.dest).catch(() => undefined);
          return stat !== undefined && stat.isFile() ? undefined : task;
        }),
      );
      for (const item of results) if (item !== undefined) missing.push(item);
    }
    return missing;
  }

  /**
   * 老版本虚拟资源目录：
   *   - virtual          → <dataRoot>/assets/virtual/<assetIndexId>/
   *   - map_to_resources → <dataRoot>/assets/virtual/legacy/
   * 只建目录结构与硬链接（跨盘/权限问题回退为复制），不重新下载。
   */
  private async buildVirtualAssets(
    virtual: VirtualAssetsSpec,
    assetIndex: AssetIndex,
    report: Report,
  ): Promise<void> {
    const dataRoot = await this.dataRoot();
    const objectsRoot = path.join(dataRoot, 'assets', 'objects');
    const entries = Object.entries(assetIndex.objects ?? {});
    await fs.mkdir(virtual.dir, { recursive: true });

    let done = 0;
    for (const [logicalName, obj] of entries) {
      const source = path.join(objectsRoot, obj.hash.slice(0, 2), obj.hash);
      const target = path.join(virtual.dir, ...logicalName.split('/'));
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const exists = await fs.stat(target).then(
          () => true,
          () => false,
        );
        if (!exists) {
          try {
            await fs.link(source, target);
          } catch {
            await fs.copyFile(source, target);
          }
        }
      } catch {
        // 单个资源链不上不影响整体，用户可重复执行补齐
      }
      done += 1;
      if (done % 64 === 0 || done === entries.length) report('assets', done, entries.length, logicalName);
    }
  }

  // ── 内部：数据访问 ────────────────────────────────────────────

  private async dataRoot(): Promise<string> {
    // 契约要求统一走 download 模块的 getDataRoot()，不各自拼路径
    return this.dataRootOverride ?? path.resolve(getDataRoot());
  }

  /**
   * 版本 JSON 的下载地址。
   *
   * 只有 manifest 里才知道这个版本的 JSON 在 piston-meta 的哪个 sha1 包里，
   * 所以优先查 manifest；查不到（离线/自定义版本）再退回 BMCLAPI 的版本目录形式。
   */
  private async versionJsonUrl(versionId: string): Promise<string> {
    try {
      const manifest = await this.versionRepo.fetchManifest();
      const entry = manifest.versions.find((v) => v.id === versionId);
      if (entry?.url) return entry.url;
    } catch {
      // 离线 / manifest 不可用：走兜底 URL，让下载器决定成败
    }
    return `${BMCLAPI_ROOT}version/${encodeURIComponent(versionId)}/json`;
  }

  private async resolveVersion(versionId: string): Promise<VersionJson> {
    const raw = await this.versionRepo.fetchVersion(versionId);
    try {
      return await this.versionRepo.resolveInherited(raw);
    } catch {
      return raw;
    }
  }

  /**
   * 读取 asset index：优先读本地已落盘的那份（重跑省流量），
   * 读不到才去 URL 拉。网络不可用时返回 undefined，plan 的 assets 段为空，
   * 不抛错（doctor/离线场景要能出计划）。
   */
  private async loadAssetIndex(json: VersionJson, indexPath: string): Promise<AssetIndex | undefined> {
    const local = await fs.readFile(indexPath, 'utf8').catch(() => undefined);
    if (local !== undefined) {
      try {
        return JSON.parse(local) as AssetIndex;
      } catch {
        // 缓存损坏，当没有
      }
    }
    const url = json.assetIndex?.url;
    if (!url) return undefined;
    try {
      const res = await fetch(url);
      if (!res.ok) return undefined;
      return (await res.json()) as AssetIndex;
    } catch {
      return undefined;
    }
  }
}

// ───────────────────────────── 工具函数 ─────────────────────────────

/** 失败文件名摘要：最多 5 个，便于用户直观判断 */
function sampleNames(failed: readonly PlanTask[]): string {
  const names = failed
    .slice(0, 5)
    .map((t) => path.basename(t.dest))
    .join(', ');
  return failed.length > 5 ? `${names} …（共 ${String(failed.length)} 个）` : names;
}

/** 安装错误：带阶段与失败清单，供 Web/CLI 展示「哪些文件没下到」 */
export class InstallError extends Error {
  readonly phase: InstallProgress['phase'];
  readonly failed: readonly PlanTask[];
  constructor(phase: InstallProgress['phase'], message: string, failed: readonly PlanTask[]) {
    super(message);
    this.name = 'InstallError';
    this.phase = phase;
    this.failed = failed;
  }
}

function makeInstallError(
  phase: InstallProgress['phase'],
  message: string,
  failed: readonly PlanTask[],
): InstallError {
  return new InstallError(phase, message, failed);
}

/** 统一的失败信息：数量 + 前几个文件名，便于用户直观判断 */
function formatFailure(
  phase: InstallProgress['phase'],
  failedCount: number,
  total: number,
  failed: readonly { dest: string }[],
): string {
  return (
    `[install] ${phase} 阶段 ${String(failedCount)}/${String(total)} 个文件下载失败：` +
    sampleNames(failed as readonly PlanTask[])
  );
}

/** Maven 坐标 → 仓库内相对路径 */
export function mavenPath(name: string): string {
  const [group, artifact, version, classifier] = name.split(':');
  if (!group || !artifact || !version) {
    throw new Error(`[install] 非法 Maven 坐标: ${name}`);
  }
  const file = classifier ? `${artifact}-${version}-${classifier}.jar` : `${artifact}-${version}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function archBitness(arch: string): string {
  return arch === 'x86' ? '32' : '64';
}

/** 同一 dest 只保留一条 */
function dedupeByDest(tasks: PlanTask[]): PlanTask[] {
  const seen = new Set<string>();
  const out: PlanTask[] = [];
  for (const t of tasks) {
    const key = process.platform === 'win32' ? t.dest.toLowerCase() : t.dest;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
