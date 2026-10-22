/**
 * LoaderInstaller —— Fabric / Quilt 加载器安装。
 *
 * 契约（Lead 交付要求）：
 *   constructor(deps: { versionRepo: VersionRepository; downloader: Downloader; dataRoot?: string })
 *   listVersions(kind, gameVersion): Promise<LoaderVersion[]>
 *   fetchProfile(kind, gameVersion, loaderVersion): Promise<VersionJson>
 *   install(kind, gameVersion, loaderVersion, onProgress?): Promise<{ versionId: string }>
 *
 * 设计要点：
 *   1. **profile 原样保存**，一个字段都不重写。id / inheritsFrom / mainClass / arguments / libraries
 *      全是 meta 给的原文，落盘后再读回来的对象与网络拿到的逐字段相等（测试里断言）。
 *   2. **不重复实现继承链合并**。原版库文件由 `pcl3 install <gv>` 负责，启动时
 *      GameLauncher 自己会走 `resolveInherited` 把 loader profile 与原版合并。
 *      本模块只保证：loader profile 存在、依赖库存在、原版已就位。
 *   3. **库下载任务的回退链**见 `libraries.ts`（profile 没有 downloads.artifact，这是致命坑）。
 *   4. 原版未安装时给人话错误，提示先跑 `pcl3 install <gv>`。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDataRoot } from '../download/index.js';
import type { DownloadResult, DownloadTask, VersionJson } from '../types.js';
import type { VersionRepository } from '../version/index.js';

import { DEFAULT_MAVEN_ROOT, LOADER_LABEL } from './endpoints.js';
import { librariesToTasks, toDownloadTasks } from './libraries.js';
import {
  fetchLoaderVersions,
  fetchLoaderVersionsForGame,
  fetchProfileJson,
  probeApplicable,
  type LoaderVersionInfo,
} from './meta.js';
import type { LoaderDownloadTask, LoaderInstallPlan, LoaderKind, LoaderProgress, LoaderVersion } from './types.js';

// ───────────────────────────── 依赖类型 ─────────────────────────────

/** 只用到 Downloader 的 downloadAll（测试可塞 fake） */
export interface LoaderDownloaderLike {
  downloadAll(
    tasks: DownloadTask[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<DownloadResult>;
}

/** 只用到 VersionRepository 的 fetchVersion（测试可塞 fake） */
export interface LoaderVersionRepoLike {
  fetchVersion(id: string): Promise<VersionJson>;
}

export interface LoaderInstallerDeps {
  versionRepo: VersionRepository | LoaderVersionRepoLike;
  downloader: LoaderDownloaderLike;
  /** 覆盖数据根；不传则用 download 模块的 getDataRoot() */
  dataRoot?: string;
  /** 覆盖日志（默认 console.warn） */
  logger?: { warn(message: string, ...args: unknown[]): void };
}

export interface LoaderInstallerOptions {
  /**
   * listVersions 是否对每个版本做 profile 探测以标注 `applicable`。
   * 默认 false（255/307 条 × 网络请求不现实）；单条可用性请用 `checkApplicable()`。
   */
  probeApplicable?: boolean;
  /** 探测时的最大条数上限，防止误开导致长时间卡住 */
  probeLimit?: number;
}

// ───────────────────────────── 错误 ─────────────────────────────

/** loader 安装的前置条件不满足（人话错误） */
export class LoaderPreconditionError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'LoaderPreconditionError';
    this.hint = hint;
  }
}

// ───────────────────────────── 实现 ─────────────────────────────

const consoleLogger = {
  warn: (message: string, ...args: unknown[]): void => console.warn(message, ...args),
};

/** 版本 id 安全检查（防目录穿越，与 version 模块同口径） */
function assertSafeId(id: string, what: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`${what} 不能为空`);
  }
  if (/[\\/:*?"<>|]/.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new Error(`${what} 含非法字符：${id}`);
  }
}

export class LoaderInstaller {
  private readonly versionRepo: LoaderVersionRepoLike;
  private readonly downloader: LoaderDownloaderLike;
  private readonly dataRootOverride: string | undefined;
  private readonly logger: { warn(message: string, ...args: unknown[]): void };
  private readonly options: Required<LoaderInstallerOptions>;

  constructor(deps: LoaderInstallerDeps, options: LoaderInstallerOptions = {}) {
    this.versionRepo = deps.versionRepo;
    this.downloader = deps.downloader;
    this.dataRootOverride = deps.dataRoot;
    this.logger = deps.logger ?? consoleLogger;
    this.options = {
      probeApplicable: options.probeApplicable ?? false,
      probeLimit: options.probeLimit ?? 8,
    };
  }

  // ── 列表 ────────────────────────────────────────────────────────

  /**
   * 列出某游戏版本可用的 loader 版本。
   *
   * Fabric：全局 `/v2/versions/loader`（`stable` 来自 meta，可信）。
   *         它的 `/v2/versions/loader/<gv>` 实测返回全量 255 条且与全局列表逐项相同，
   *         **不按游戏版本过滤**，所以这里不用它当数据源，只用它补 stable 声明。
   * Quilt ：全局 `/v3/versions/loader` 没有 `stable` 字段 → 按版本号启发式推断，
   *         `stabilitySource: 'inferred'` 如实标注。它的 `<gv>` 端点同样返回全量数据
   *         （且换成了嵌套形状），一样不可信。
   *
   * 返回顺序即 meta 的顺序（新 → 旧）；排序交给调用方，本方法不擅自重排。
   */
  async listVersions(kind: LoaderKind, gameVersion: string): Promise<LoaderVersion[]> {
    const detailed = await this.listVersionsDetailed(kind, gameVersion);
    return detailed.map((v) => ({ version: v.version, stable: v.stable }));
  }

  /** listVersions 的详细版：多带 stable 来源、预发布标记与可用性 */
  async listVersionsDetailed(kind: LoaderKind, gameVersion: string): Promise<LoaderVersionInfo[]> {
    this.assertKind(kind);
    assertSafeId(gameVersion, '游戏版本');

    const global = await fetchLoaderVersions(kind);

    // 补一次按 gv 的端点：形状不同（嵌套），但它带的 stable 声明更权威，
    // 而且能顺手记录「meta 认为这个 gv 有哪些 loader」——即使数据是假的也留个记号。
    let perGame: LoaderVersionInfo[] = [];
    try {
      perGame = await fetchLoaderVersionsForGame(kind, gameVersion);
    } catch (err) {
      this.logger.warn(
        `[loader] ${LOADER_LABEL[kind]} 按游戏版本查询失败（不影响列表，继续用全局列表）：${(err as Error).message}`,
      );
    }
    const declaredStable = new Map<string, boolean>();
    for (const item of perGame) {
      if (item.stabilitySource === 'declared') declaredStable.set(item.version, item.stable);
    }

    const merged: LoaderVersionInfo[] = global.map((item) => {
      const out: LoaderVersionInfo = { ...item };
      const declared = declaredStable.get(item.version);
      if (declared !== undefined) {
        out.stable = declared;
        out.stabilitySource = 'declared';
      }
      return out;
    });

    if (this.options.probeApplicable) {
      const limit = Math.max(0, this.options.probeLimit);
      const head = merged.slice(0, limit);
      await Promise.all(
        head.map(async (item) => {
          item.applicable = await probeApplicable(kind, gameVersion, item.version);
        }),
      );
    }

    return merged;
  }

  /** 单条：这个 loader 版本对某个游戏版本是否真的可用（以 profile 端点为准） */
  async checkApplicable(kind: LoaderKind, gameVersion: string, loaderVersion: string): Promise<boolean> {
    this.assertKind(kind);
    assertSafeId(gameVersion, '游戏版本');
    assertSafeId(loaderVersion, 'loader 版本');
    return probeApplicable(kind, gameVersion, loaderVersion);
  }

  // ── profile ────────────────────────────────────────────────────

  /**
   * 拉 profile JSON（原样返回，不重写任何字段）。
   * 调用方可以用它做「预览」而不装。
   */
  async fetchProfile(kind: LoaderKind, gameVersion: string, loaderVersion: string): Promise<VersionJson> {
    this.assertKind(kind);
    assertSafeId(gameVersion, '游戏版本');
    assertSafeId(loaderVersion, 'loader 版本');

    const raw = await fetchProfileJson(kind, gameVersion, loaderVersion);
    return this.validateProfile(raw, kind, gameVersion, loaderVersion);
  }

  /**
   * 校验并原样转成 VersionJson。
   *
   * 「原样」的含义：只做**存在性检查**与「类型字段补默认」这类不改语义的收尾，
   * 其余一个字节都不动。特别是 `libraries[]` 里的条目原样保留（包括平铺的 sha1/size），
   * 绝不搬进 `downloads.artifact` —— 一旦重写，落盘 JSON 就不再是 meta 的原文，
   * 排错时会误导后来的人。
   */
  private validateProfile(
    raw: Record<string, unknown>,
    kind: LoaderKind,
    gameVersion: string,
    loaderVersion: string,
  ): VersionJson {
    const label = LOADER_LABEL[kind];

    const id = raw['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${label} profile 缺少 id（${gameVersion} + ${loaderVersion}）`);
    }
    const mainClass = raw['mainClass'];
    if (typeof mainClass !== 'string' || mainClass.trim() === '') {
      throw new Error(`${label} profile 缺少 mainClass（${id}），这个组合不可用`);
    }
    const inheritsFrom = raw['inheritsFrom'];
    if (typeof inheritsFrom !== 'string' || inheritsFrom.trim() === '') {
      throw new Error(
        `${label} profile 缺少 inheritsFrom（${id}）。没有继承关系的 profile 无法与原版合并，拒绝安装。`,
      );
    }
    if (!Array.isArray(raw['libraries'])) {
      throw new Error(`${label} profile 的 libraries 不是数组（${id}）`);
    }

    // loader profile 不带 assets（从继承链拿）；只保证类型是字符串，不伪造内容
    if (typeof raw['assets'] !== 'string') {
      raw['assets'] = '';
    }
    if (typeof raw['type'] !== 'string') {
      raw['type'] = 'release';
    }
    return raw as unknown as VersionJson;
  }

  // ── 计划 ──────────────────────────────────────────────────────

  /**
   * 生成安装计划（不下载）。
   *
   * 任务构成：
   *   - loader profile 自身的 libraries（回退链生成，见 libraries.ts），
   *     其中就包含 `net.fabricmc:fabric-loader:<ver>` / `org.quiltmc:quilt-loader:<ver>` 本体
   *   - **不含**原版文件 —— 原版由 `pcl3 install <gv>` 负责，重复下载是浪费
   *
   * 但计划开头会检查原版是否已安装，缺了直接抛人话错误。
   */
  async plan(kind: LoaderKind, gameVersion: string, loaderVersion: string): Promise<LoaderInstallPlan> {
    this.assertKind(kind);
    assertSafeId(gameVersion, '游戏版本');
    assertSafeId(loaderVersion, 'loader 版本');

    await this.ensureVanillaInstalled(gameVersion);

    const profile = await this.fetchProfile(kind, gameVersion, loaderVersion);
    const versionId = profile.id;
    assertSafeId(versionId, 'loader 版本 id');

    const dataRoot = this.dataRoot();
    const librariesRoot = path.join(dataRoot, 'libraries');
    const fallback = DEFAULT_MAVEN_ROOT[kind];

    const { tasks, skipped } = librariesToTasks(profile.libraries ?? [], {
      kind,
      fallbackMavenRoot: fallback,
      librariesRoot,
    });

    for (const item of skipped) {
      this.logger.warn(`[loader] 跳过库 ${item.name}：${item.reason}`);
    }

    if (tasks.length === 0) {
      // 这条就是「表面装成功、依赖全缺」的预警线：宁可直接报错
      throw new Error(
        `[loader] ${LOADER_LABEL[kind]} profile（${versionId}）没有任何可下载的库。` +
          `这通常意味着 libraries 既没有 downloads.artifact 也没有 url —— 安装下去必然启动失败，已中止。`,
      );
    }

    const unverified = tasks.filter((t) => t.integrity === 'none').length;
    const totalBytes = tasks.reduce((sum, t) => sum + (t.size ?? 0), 0);

    return {
      versionId,
      kind,
      gameVersion,
      loaderVersion,
      tasks,
      unverified,
      totalBytes,
      versionJsonPath: path.join(dataRoot, 'versions', versionId, `${versionId}.json`),
    };
  }

  // ── 安装 ──────────────────────────────────────────────────────

  /**
   * 执行安装：libraries → meta → done。
   *
   * 落盘的 JSON 是 **meta 的原文**（`JSON.stringify(profile, null, 2)`），
   * 不带本模块注入的任何字段；GameLauncher 启动时自己走 resolveInherited 合并原版。
   */
  async install(
    kind: LoaderKind,
    gameVersion: string,
    loaderVersion: string,
    onProgress?: (p: LoaderProgress) => void,
  ): Promise<{ versionId: string }> {
    const installPlan = await this.plan(kind, gameVersion, loaderVersion);
    const { versionId, tasks, versionJsonPath } = installPlan;

    // 1) 库
    onProgress?.({ phase: 'libraries', done: 0, total: tasks.length });
    if (installPlan.unverified > 0) {
      this.logger.warn(
        `[loader] ${LOADER_LABEL[kind]} 有 ${String(installPlan.unverified)}/${String(tasks.length)} 个库` +
          `没有 sha1（intermediary / loader 本体等），这些只能裸下载不校验。`,
      );
    }

    const downloadTasks = toDownloadTasks(tasks);
    const result = await this.downloader.downloadAll(downloadTasks, (p) => {
      onProgress?.({ phase: 'libraries', done: p.done, total: p.total });
    });
    onProgress?.({ phase: 'libraries', done: tasks.length, total: tasks.length });

    if (result.failed.length > 0) {
      const sample = result.failed
        .slice(0, 3)
        .map((t) => path.basename(t.dest))
        .join(', ');
      throw new Error(
        `[loader] ${LOADER_LABEL[kind]} 库下载失败 ${String(result.failed.length)}/${String(tasks.length)}：${sample}` +
          (result.failed.length > 3 ? ' …' : ''),
      );
    }

    // 2) 版本 JSON（原样落盘）
    const profile = await this.fetchProfile(kind, gameVersion, loaderVersion);
    onProgress?.({ phase: 'meta', done: 0, total: 1 });
    await this.writeProfile(profile, versionJsonPath);
    onProgress?.({ phase: 'meta', done: 1, total: 1 });

    onProgress?.({ phase: 'done', done: 1, total: 1 });
    return { versionId };
  }

  // ── 内部 ──────────────────────────────────────────────────────

  /**
   * 落盘 profile：**两处都写**，因为下游有两套读取路径。
   *
   *   1. `<dataRoot>/versions/<id>/<id>.json` —— 启动器 / install 的版本目录约定
   *   2. `<dataRoot>/meta/<id>.json`          —— VersionRepository 的磁盘缓存
   *      （`fetchVersion(id)` 只认这里；GameLauncher 走的就是 `fetchVersion`）
   *
   * 只写 (1) 会导致「装好了但启动器说找不到版本」，所以 (2) 是必需的集成补齐。
   * 两处写的是同一个对象、同一份格式化输出，内容与 meta 原文一致。
   *
   * meta 旁挂文件 `<id>.meta.json` 也写一份（fetchedAt=现在），
   * 让缓存在 TTL 内被视为新鲜，不触网重拉。
   */
  private async writeProfile(profile: VersionJson, versionJsonPath: string): Promise<void> {
    const text = JSON.stringify(profile, null, 2);
    await fs.mkdir(path.dirname(versionJsonPath), { recursive: true });
    await fs.writeFile(versionJsonPath, text, 'utf8');

    const dataRoot = this.dataRoot();
    const metaDir = path.join(dataRoot, 'meta');
    try {
      await fs.mkdir(metaDir, { recursive: true });
      const metaFile = path.join(metaDir, `${profile.id}.json`);
      const metaSidecar = path.join(metaDir, `${profile.id}.meta.json`);
      await fs.writeFile(metaFile, text, 'utf8');
      await fs.writeFile(
        metaSidecar,
        JSON.stringify({ fetchedAt: Date.now(), url: 'loader-profile', mirror: false }, null, 2),
        'utf8',
      );
    } catch (err) {
      // 缓存写失败不影响安装本体（版本目录里那份仍可用于启动），但要让人看见
      this.logger.warn(
        `[loader] 写入 meta 缓存失败（版本目录内的 JSON 已就位）：${(err as Error).message}`,
      );
    }
  }

  private dataRoot(): string {
    return this.dataRootOverride ?? path.resolve(getDataRoot());
  }

  /**
   * 原版必须已安装（版本 JSON + client jar 都在）。
   *
   * 判定刻意用本地文件而不是 versionRepo：后者在缺缓存时会触网拉元数据，
   * 而这里要回答的是「本地有没有装过」，不是「meta 上有没有这个版本」。
   */
  private async ensureVanillaInstalled(gameVersion: string): Promise<void> {
    const dataRoot = this.dataRoot();
    const versionDir = path.join(dataRoot, 'versions', gameVersion);
    const jsonPath = path.join(versionDir, `${gameVersion}.json`);
    const jarPath = path.join(versionDir, `${gameVersion}.jar`);

    const jsonExists = await fs.stat(jsonPath).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!jsonExists) {
      throw new LoaderPreconditionError(
        `原版 ${gameVersion} 还没安装（找不到 ${jsonPath}），无法安装加载器。`,
        `请先执行：pcl3 install ${gameVersion}`,
      );
    }
    const jarExists = await fs.stat(jarPath).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!jarExists) {
      throw new LoaderPreconditionError(
        `原版 ${gameVersion} 的 jar 缺失（找不到 ${jarPath}），加载器装上去也启动不了。`,
        `请先执行：pcl3 install ${gameVersion}`,
      );
    }
  }

  private assertKind(kind: string): asserts kind is LoaderKind {
    if (kind !== 'fabric' && kind !== 'quilt') {
      throw new Error(`未知的加载器类型：${kind}（只支持 fabric / quilt）`);
    }
  }
}

/** 便利函数：把 plan 里的任务转成契约 DownloadTask（给 CLI 复用） */
export function planToDownloadTasks(plan: LoaderInstallPlan): DownloadTask[] {
  return toDownloadTasks(plan.tasks);
}

export type { LoaderDownloadTask };
