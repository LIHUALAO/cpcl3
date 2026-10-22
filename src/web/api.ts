/**
 * REST API 路由。
 *
 * 契约（Lead 指定）：
 *   GET  /api/status            数据目录、版本数、已装版本、Java 是否可用
 *   GET  /api/versions          版本清单，支持 ?limit=
 *   POST /api/install           { versionId } → 立即返回 { jobId }
 *   GET  /api/jobs/:id          任务进度 { phase, done, total, log[], status }
 *   POST /api/launch            { versionId, username } → 立即返回 { jobId }
 *   GET  /api/accounts          账户列表
 *   POST /api/account/offline   { username }
 *   GET  /api/java              检测本机 Java
 *
 * 加载器（Fabric / Quilt）—— 本次新增：
 *   GET  /api/loaders/:kind/versions?gameVersion=X   列出可用加载器版本
 *   POST /api/loaders/install  { kind, gameVersion, loaderVersion? } → { jobId }
 *
 * 三条硬规则：
 *   1. 任何 handler 抛错都返回 JSON `{ error }`，绝不 500 空响应
 *   2. 安装/启动异步化：POST 立刻回 jobId，真正的活在后台跑
 *   3. 同一时刻只允许一个安装任务，第二个返回 409
 *
 * ── 偏离记录（一处）──
 * 契约要求「复用 launch 模块导出的 findJavaInDataRoot」。该函数签名是
 * `findJavaInDataRoot(dataRoot, { majorVersion, component })`，**必须**传 Java 版本要求才知道要什么 JRE；
 * 而 `/api/java` 在 UI 首屏就要回答「这台机器能不能玩」，此时还不知道用户要点哪个版本。
 * 因此：优先按最新 release 版本的 `javaVersion.majorVersion` 去查（拿到就是「可用且对得上当前版本」），
 * manifest 不可用时退化为按 Java 8 查一次并如实标注 majorVersion。
 * 结果里的 `found` 只表示「数据目录下有可用 JRE」，不表示「能启动任意版本」。检测不到就如实说未安装。
 *
 * ── 不可用能力 ──
 * `GameLauncher.launch()` 内部写死了 `stdio: 'inherit'`，子进程的 stdout 直接进服务进程的控制台，
 * 拿不到流、也就没法在 Web UI 里实时滚动。本模块**不改 launch 模块**（越界），改为：
 * 先用 `buildCommand()` 拿到完整命令，再用 `spawn(built.java, built.args, { stdio: ['ignore','pipe','pipe'] })`
 * 自己拉起进程，把 stdout/stderr 接进任务日志。这也是「启动后把 stdout 滚到日志区」唯一可行的做法。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Account, LaunchOptions, VersionJson, VersionManifest, VersionSummary } from '../core/types.js';
import { VanillaInstaller } from '../core/install/index.js';
import type { DetailInstallPlan } from '../core/install/index.js';
import { VersionRepository } from '../core/version/index.js';
import type { FetchJsonFn } from '../core/version/http.js';
import { GameLauncher } from '../core/launch/index.js';
import { JavaAutoProvisioner } from '../core/launch/java-provision.js';
import { findJavaInDataRoot, isJavaHome, javaExecutable } from '../core/launch/index.js';
import type { JavaLookup } from '../core/launch/index.js';
import { Downloader } from '../core/download/index.js';
import { loadAccounts, offlineAccount, upsertAccount } from '../core/auth/index.js';
import { LoaderInstaller, LoaderPreconditionError } from '../core/loader/index.js';
import type { LoaderKind, LoaderVersion } from '../core/loader/index.js';
import { SettingsStore, SettingsValidationError, toLaunchOptionFields } from '../core/settings/index.js';
import type { InstanceSettings } from '../core/settings/index.js';
import { JavaRuntimeInstaller } from '../core/java/index.js';
// 「实例」概念已取消：目录规则统一回 `<dataRoot>/instances/<versionId>`，
// 这里直接按 join 拼，不再依赖 core/instances 的注册表（那个目录已被删除）。
import {
  MAX_PACK_BYTES,
  PACK_KIND_LABEL,
  PackManager,
  PackValidationError,
  checkFilename,
  checkInstanceId,
  checkSaveName,
  enabledNameOf,
  parsePackKind,
  sanitizeFilename,
  type InstalledPack,
  type PackKind,
  type SaveSummary,
} from '../core/content/packs/index.js';
import {
  ModpackInstaller,
  ModpackError,
  checkInstanceName,
  type ModpackInstallResult,
  type ModpackParseResult,
} from '../core/content/modpack/index.js';
import {
  DataDiskUsage,
  FolderAccessError,
  FolderService,
  FOLDER_LABEL_CN,
  parseFolderKind,
  summarizeCommand,
  type FolderEntry,
  type FolderKind,
  type FolderServiceOptions,
} from '../core/shell/index.js';
// ── 内容源（Modrinth）+ 模组本地管理 ───────────────────────────────
// 只做追加：既有 import 一条不动，新的一律另起一段。
import { ModrinthClient, ModrinthError, parseProjectType } from '../core/content/modrinth/index.js';
import type {
  ProjectDetail,
  ProjectSummary,
  ProjectVersion,
  SearchOptions,
} from '../core/content/modrinth/index.js';
import { ModManager, ModValidationError, type InstalledMod } from '../core/content/mods/index.js';

// ── 基础设施（infra-dev 追加）：源测速 / 崩溃分析 / 数据目录自定义 ─────────
// 只做追加：既有 import 一条不动，新的一律另起一段。
import {
  ConfigValidationError,
  GlobalConfigStore,
  applyProxyFromConfig,
  defaultConfigPath,
  installConfigHook,
  migrationNotice,
  validateDataDir,
  type DataDirCheck,
} from '../core/config/index.js';
import { resetDataRootCache } from '../core/download/paths.js';
import { MirrorSelector, KNOWN_PROXY_PORTS, detectProxy, testProxy, type MirrorProbe } from '../core/net/index.js';
import { CrashAnalyzer, summarizeFindings, type CrashFinding } from '../core/diagnostics/index.js';
// ── 启动前体检（preflight）── 只做追加：既有 import 一条不动。
// 体检是 CrashAnalyzer 的「崩溃前」对称能力：启动前把话说清楚，而不是让用户对着堆栈猜。
import {
  createPreflightChecker,
  summarize as summarizePreflight,
  type PreflightReport,
  type PreflightReportDetail,
} from '../core/preflight/index.js';
import { JobTable, type JobSnapshot } from './jobs.js';

// ───────────────────────────── 依赖注入 ─────────────────────────────

/** 版本仓库的最小结构约束（测试可塞 fake） */
export interface VersionRepoLike {
  fetchManifest(force?: boolean): Promise<VersionManifest>;
  fetchVersion(id: string): Promise<VersionJson>;
  resolveInherited(json: VersionJson): Promise<VersionJson>;
}

/** 下载器的最小结构约束（测试可塞 fake） */
export interface DownloaderLike {
  downloadAll(
    tasks: { url: string; dest: string; sha1?: string; size?: number }[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<{ ok: boolean; skipped: number; downloaded: number; failed: unknown[] }>;
}

/** 安装器的最小结构约束 */
export interface InstallerLike {
  plan(versionId: string): Promise<DetailInstallPlan>;
  install(
    versionId: string,
    onProgress?: (p: { phase: string; done: number; total: number; current?: string }) => void,
  ): Promise<void>;
}

/** 启动器工厂：每次调用 new 一个，避免跨请求共享 resolvedCache 造成状态串味 */
export type LauncherFactoryLike = () => GameLauncher;

/**
 * 加载器安装器的最小结构约束（测试可塞 fake）。
 *
 * 刻意只声明用到的两个方法 —— `LoaderInstaller` 天然满足它，
 * 测试也不用被迫实现 `plan` / `listVersionsDetailed` 这些内部方法。
 */
export interface LoaderInstallerLike {
  listVersions(kind: LoaderKind, gameVersion: string): Promise<LoaderVersion[]>;
  checkApplicable(kind: LoaderKind, gameVersion: string, loaderVersion: string): Promise<boolean>;
  install(
    kind: LoaderKind,
    gameVersion: string,
    loaderVersion: string,
    onProgress?: (p: { phase: string; done: number; total: number }) => void,
  ): Promise<{ versionId: string }>;
}

/** 加载器安装器工厂：每个请求 new 一个，避免把某次安装的 dataRoot 泄漏到下一次 */
export type LoaderInstallerFactoryLike = () => LoaderInstallerLike;

/**
 * 资源包 / 数据包 / 光影包管理器的最小结构约束（测试可塞 fake）。
 *
 * 与 `LoaderInstallerLike` 同一思路：只声明路由真正调用的方法，
 * 不把 `PackManager` 的内部方法（describe / resolveInside …）也锁进契约。
 */
export interface PackManagerLike {
  list(instanceId: string, kind: PackKind, saveName?: string): Promise<InstalledPack[]>;
  listSaves(instanceId: string): Promise<SaveSummary[]>;
  targetDir(instanceId: string, kind: PackKind, saveName?: string): string;
  instanceDir(instanceId: string): string;
  installFromUrl(
    instanceId: string,
    kind: PackKind,
    task: { url: string; filename: string; sha1?: string },
    opts?: {
      saveName?: string;
      onProgress?: (p: { done: number; total: number }) => void;
    },
  ): Promise<string>;
  setEnabled(
    instanceId: string,
    kind: PackKind,
    filename: string,
    enabled: boolean,
    saveName?: string,
  ): Promise<void>;
  remove(instanceId: string, kind: PackKind, filename: string, saveName?: string): Promise<void>;
  uploadAndDescribe(
    instanceId: string,
    kind: PackKind,
    data: Buffer,
    opts?: { saveName?: string; filename?: string },
  ): Promise<{ filename: string; path: string; size: number; pack: InstalledPack }>;
}

/** 包管理器工厂：不传则由路由按 dataRoot 现场装配真实实现 */
export type PackManagerFactoryLike = () => PackManagerLike;

/**
 * 整合包安装器的最小结构约束（测试可塞 fake）。
 *
 * 只在类型层面依赖 install / parse 两个方法 —— 真实 `ModpackInstaller` 天然满足。
 */
export interface ModpackInstallerLike {
  install(
    filePath: string,
    opts: {
      instanceName: string;
      onProgress?: (p: { phase: string; done: number; total: number; current?: string }) => void;
    },
  ): Promise<ModpackInstallResult>;
  parse?(filePath: string): Promise<ModpackParseResult>;
}
/** 整合包安装器工厂：每次需要时新建，避免 dataRoot / 缓存串味 */
export type ModpackInstallerFactoryLike = () => ModpackInstallerLike;

/**
 * Modrinth 客户端的最小结构约束（测试可塞 fake）。
 *
 * 只声明路由真正调用的四个方法 —— 真实 `ModrinthClient` 天然满足它。
 * 注意 `pickBestVersion` 是**同步纯函数**（不发请求），所以它是方法而不是独立工厂。
 */
export interface ModrinthClientLike {
  search(opts: SearchOptions): Promise<{ hits: ProjectSummary[]; totalHits: number }>;
  getProject(slugOrId: string): Promise<ProjectDetail>;
  listVersions(
    slugOrId: string,
    filter?: { gameVersion?: string; loader?: string },
  ): Promise<ProjectVersion[]>;
  pickBestVersion(
    versions: readonly ProjectVersion[],
    filter: { gameVersion: string; loader?: string },
  ): ProjectVersion | undefined;
}

/**
 * Modrinth 客户端工厂。
 *
 * 语义是「拿到那个客户端」而不是「新建一个」：`getProject` 带 5 分钟内存缓存，
 * 只有跨请求共享同一个实例，才是「搜索实时、项目详情缓存」这个约定。
 * 所以在 `createRealDeps` 里只建一次，工厂每次都返回它；测试可以注入自己的实现。
 */
export type ModrinthClientFactoryLike = () => ModrinthClientLike;

/** 模组管理器的最小结构约束（测试可塞 fake） */
export interface ModManagerLike {
  list(instanceId: string): Promise<InstalledMod[]>;
  install(
    instanceId: string,
    task: { url: string; filename: string; sha1?: string },
    onProgress?: (p: { done: number; total: number; filename: string }) => void,
  ): Promise<string>;
  setEnabled(instanceId: string, filename: string, enabled: boolean): Promise<void>;
  remove(instanceId: string, filename: string): Promise<void>;
  modsDir(instanceId: string): string;
}

/** 模组管理器工厂：不传时按 dataRoot 现场装配真实实现 */
export type ModManagerFactoryLike = () => ModManagerLike;

/**
 * 当前正在跑「启动」的那个 job id。
 *
 * 为什么需要它：Java 自动下载的进度回调是在 `GameLauncher` 内部触发的，
 * 那里拿不到「这次启动对应哪个 Web 任务」。用一个模块级变量在发起启动前登记，
 * 下载结束（或失败）后清空，就能把进度准确归到对应任务上。
 * 同一时刻只允许一个启动任务，所以单变量足够。
 */
let activeJavaJobId: string | null = null;

/** 登记当前启动任务，供 Java 下载进度回调使用 */
export function setActiveJavaJobId(jobId: string | null): void {
  activeJavaJobId = jobId;
}

/** 文件夹服务工厂：不传则按 dataRoot 现场装配真实实现 */
export type FolderServiceFactoryLike = (dataRoot: string, opts?: FolderServiceOptions) => FolderService;

/**
 * 磁盘占用统计器的结构约束（只用到这几个方法，测试可塞小预算 fake）。
 * 返回值用 `DiskUsageView` 而不是 `Record<string, unknown>`：后者与真实 `DiskUsageSnapshot`
 * 不兼容（接口没有索引签名），会把 `createRealDeps` 直接顶成类型错误。
 */
export interface DiskUsageView {
  root?: string;
  bytes: number;
  files: number;
  computedAt: number;
  buckets?: { name: string; bytes: number; files: number }[];
  partial?: boolean;
  sampled?: boolean;
  elapsedMs?: number;
  stale?: boolean;
}

export interface DiskUsageLike {
  peekForResponse(): DiskUsageView | null;
  refresh(force?: boolean): Promise<unknown>;
  peek(): DiskUsageView | undefined;
}

export interface ApiDeps {
  versionRepo: VersionRepoLike;
  downloader: DownloaderLike;
  installer: InstallerLike;
  launcherFactory: LauncherFactoryLike;
  /** 加载器安装器工厂；不传时由加载器路由用 `createRealLoaderInstaller` 现场装配 */
  loaderInstallerFactory?: LoaderInstallerFactoryLike;
  /** 整合包安装器工厂；不传时由整合包路由用 `createRealModpackInstaller` 现场装配 */
  modpackInstallerFactory?: ModpackInstallerFactoryLike;
  /** 资源包 / 数据包 / 光影包管理器工厂；不传时按 dataRoot 现场装配 */
  packManagerFactory?: PackManagerFactoryLike;
  /**
   * 文件夹服务工厂（基础便利功能）。默认按 dataRoot 现场装配真实 `FolderService`；
   * 测试注入 fake 就能断言「POST .../open 到底有没有真的去 spawn」而不弹窗。
   */
  folderServiceFactory?: FolderServiceFactoryLike;
  /**
   * Modrinth 客户端工厂。默认由 `createRealDeps` 建一个实例（带 5 分钟项目详情缓存），
   * 每次调用返回**同一个**；测试注入 fake 就能在离线下断言搜索 / 挑版本的逻辑。
   */
  modrinthFactory?: ModrinthClientFactoryLike;
  /** 模组管理器工厂；不传时按 dataRoot 现场装配真实 `ModManager` */
  modManagerFactory?: ModManagerFactoryLike;
  /**
   * 磁盘占用统计器。默认由 `createRealDeps` 建一个带 5 分钟缓存的实例，
   * 测试可注入小预算实例来验证「超预算 / 超文件数走估算」。
   */
  diskUsage?: DiskUsageLike;
  jobs: JobTable;
  /** 解析数据根 */
  dataRoot: () => string;
  /**
   * 【infra 追加，可选】源测速器。不传时按当前全局配置现场装配。
   * 测试注入 fake 就能断言 `/api/status` 的 `mirrors` 字段而不联网。
   */
  mirrorSelector?: MirrorSelectorLike;
  /**
   * 【infra 追加，可选】全局配置存储。不传时用进程级默认存储（%APPDATA%/PCL3/config.json）。
   * 测试注入带临时 configPath 的实例即可断言读写与校验。
   */
  configStore?: GlobalConfigStore;
  /** 【infra 追加，可选】崩溃分析器。不传时按 dataRoot 现场装配。 */
  crashAnalyzer?: CrashAnalyzerLike;
  /**
   * 【preflight 追加，可选】启动前体检器工厂。
   *
   * 不传时按 dataRoot 现场装配真实 `PreflightChecker`（见 `preflightFor`）。
   * 测试注入 fake 就能在「不碰真实磁盘」的前提下断言：
   *   - POST /api/preflight 原样吐出 report
   *   - POST /api/launch 在 blocking 时 409、在只有 warning 时照常 202
   */
  preflightFactory?: PreflightFactoryLike;
}

/** 体检器的结构约束（测试可塞 fake；真实 `PreflightChecker` 天然满足） */
export interface PreflightCheckerLike {
  check(opts: { versionId: string; instanceId?: string }): Promise<PreflightReportDetail>;
}

/** 体检器工厂：每个请求新建一个（它内部持有 VersionRepository 磁盘缓存，跨请求共享会串味） */
export type PreflightFactoryLike = () => PreflightCheckerLike;

/**
 * 源测速器的最小结构约束（测试可塞 fake）。
 *
 * 只声明路由真正调用的方法：`best()`（选源）、`probeAll()`（全量测速）、
 * `refresh()`（强制重测）。
 */
export interface MirrorSelectorLike {
  best(opts?: { timeoutMs?: number }): Promise<MirrorProbe>;
  probeAll(opts?: { timeoutMs?: number }): Promise<MirrorProbe[]>;
  refresh(opts?: { timeoutMs?: number }): Promise<MirrorProbe[]>;
}

/** 崩溃分析器的最小结构约束 */
export interface CrashAnalyzerLike {
  analyze(logText: string): CrashFinding[];
  analyzeInstance(
    instanceId: string,
    opts?: { dataRoot?: string },
  ): Promise<{ reportPath?: string; findings: CrashFinding[]; reason?: string; mtimeMs?: number }>;
}

/** 组装真实依赖 */
export function createRealDeps(dataRoot: string, jobs: JobTable): ApiDeps {
  // 浏览器 UA：Node 自带的 `node` UA 会被部分 CDN / WAF 直接拒掉；
  // 这里只影响元数据 JSON（几 KB），不影响大文件下载（Downloader 用自己的 UA）。
  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const fetchJson: FetchJsonFn = async (url, opts) => {
    const signal = AbortSignal.timeout(opts?.timeoutMs ?? 15_000);
    const res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}：${url}`);
    const data: unknown = await res.json();
    return { data, url: res.url } as never;
  };

  const makeRepo = (): VersionRepository => new VersionRepository({ dataRoot, fetchImpl: fetchJson });

  return {
    versionRepo: makeRepo(),
    downloader: new Downloader({ concurrency: 8, retries: 3 }),
    installer: new VanillaInstaller({
      versionRepo: makeRepo(),
      downloader: new Downloader({ concurrency: 8, retries: 3 }),
    }),
    launcherFactory: () =>
      new GameLauncher({
        versionRepo: makeRepo(),
        dataRoot,
        // 没有这一项，点「启动」时缺 Java 会直接失败，用户得自己去装 JRE。
        // provisioner 负责：按版本的 javaVersion.component 精确复用 → 版本校验 → 自动下载。
        javaProvisioner: new JavaAutoProvisioner({
          downloader: new Downloader({ concurrency: 8, retries: 3 }),
          dataRoot,
          onProgress: (p) => {
            // 一个启动任务可能先后经历 java / natives / 启动三个阶段，
            // 进度归属由 startLaunchJob 在调用前写入 activeJavaJobId。
            const jobId = activeJavaJobId;
            if (jobId === null) return;
            jobs.progress(jobId, {
              phase: p.phase,
              done: p.done,
              total: p.total,
              ...(p.current ? { current: p.current } : {}),
            });
          },
        }),
      }),
    // 磁盘占用统计器只建一次：它的 5 分钟缓存与「同一时刻只跑一个扫描」的意义
    // 全在于跨请求共享。每次请求新建一个 = 每次点刷新重扫一遍数据目录。
    diskUsage: new DataDiskUsage(dataRoot),
    // Modrinth 客户端同理：项目详情有 5 分钟内存缓存，跨请求共享才有意义。
    // 搜索不走缓存（实时性优先），共享实例不会让搜索结果变旧。
    modrinthFactory: (() => {
      const client = new ModrinthClient();
      return () => client;
    })(),
    // 启动前体检：每次请求新建（内部的 VersionRepository 带磁盘缓存，共享会串味）。
    // Java 那一侧复用同一个只读 installer：体检只读清单，永不下载。
    preflightFactory: () => {
      const javaInstaller = createJavaRuntimeInstaller(dataRoot);
      return createPreflightChecker({ dataRoot, javaInstaller }) as unknown as PreflightCheckerLike;
    },
    jobs,
    dataRoot: () => dataRoot,
  };
}

/**
 * 装配真实的 `LoaderInstaller`。
 *
 * 为什么单独导出、且每次调用都新建：
 *   1. `LoaderInstaller` 的 `dataRoot` 在构造时就固定了，测试 / 多数据目录场景下
 *      共享一个实例会写错地方；
 *   2. 它内部的 `VersionRepository` 带磁盘缓存，跨请求共享会串味（与 launcher 同理）。
 * 下载器/仓库都用本函数自己的实例，不与 vanilla 安装器共享。
 */
export function createRealLoaderInstaller(dataRoot: string): LoaderInstaller {
  return new LoaderInstaller({
    versionRepo: new VersionRepository({ dataRoot }),
    downloader: new Downloader({ concurrency: 8, retries: 3 }),
    dataRoot,
  });
}

// ───────────────────────────── 常量 ─────────────────────────────

/** 默认端口 */
export const DEFAULT_PORT = 37421;

/** 默认监听地址（铁律：只监听本机回环） */
export const DEFAULT_HOST = '127.0.0.1';

/** 本机回环地址集合（Origin 校验用） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

/** 请求体上限：这个 API 只收几十字节的 JSON */
const MAX_BODY_BYTES = 64 * 1024;

/** 日志单行最大长度（防止游戏吐一行 10MB 卡死浏览器） */
const MAX_LOG_LINE = 4000;

/** 启动时等待 spawn 事件的超时 */
const SPAWN_TIMEOUT_MS = 15_000;

// ───────────────────────────── 路由 ─────────────────────────────

/** API 路由器签名 */
export type ApiRouter = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * 建路由表。返回一个函数：处理一个 `/api/*` 请求。
 * 一切异常都在内部折成 JSON，绝不把错误抛给调用方、也绝不返回空响应。
 */
export function createApiRouter(deps: ApiDeps): ApiRouter {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [
    { method: 'GET', pattern: /^\/api\/status$/, keys: [], handler: handleStatus },
    { method: 'GET', pattern: /^\/api\/versions$/, keys: [], handler: handleVersions },
    { method: 'POST', pattern: /^\/api\/install$/, keys: [], handler: handleInstall },
    { method: 'GET', pattern: /^\/api\/jobs\/([^/]+)$/, keys: ['id'], handler: handleJob },
    { method: 'POST', pattern: /^\/api\/launch$/, keys: [], handler: handleLaunch },
    { method: 'GET', pattern: /^\/api\/accounts$/, keys: [], handler: handleAccounts },
    { method: 'POST', pattern: /^\/api\/account\/offline$/, keys: [], handler: handleOfflineAccount },
    { method: 'GET', pattern: /^\/api\/java$/, keys: [], handler: handleJava },
    // 加载器：列出可用版本（只读，不落盘）
    { method: 'GET', pattern: /^\/api\/loaders\/([^/]+)\/versions$/, keys: ['kind'], handler: handleLoaderVersions },
    // 加载器：安装（异步任务）
    { method: 'POST', pattern: /^\/api\/loaders\/install$/, keys: [], handler: handleLoaderInstall },
    // 实例设置（内存 / JVM 参数）。列表路由必须写在带 :versionId 的两条之前，否则被吞掉。
    { method: 'GET', pattern: /^\/api\/instances\/settings$/, keys: [], handler: handleListSettings },
    { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/settings$/, keys: ['versionId'], handler: handleGetSettings },
    { method: 'PUT', pattern: /^\/api\/instances\/([^/]+)\/settings$/, keys: ['versionId'], handler: handlePutSettings },
    // 整合包（.mrpack）—— 本次新增：上传 / 解析预览 / 安装。
    // 解析路由写在安装路由前面：「inspect」与「install」都是固定段，两条互不冲突，
    // 但顺序保持「只读在前」更符合阅读习惯。
    { method: 'GET', pattern: /^\/api\/modpack\/inspect$/, keys: [], handler: handleModpackInspect },
    { method: 'POST', pattern: /^\/api\/modpack\/upload$/, keys: [], handler: handleModpackUpload },
    { method: 'POST', pattern: /^\/api\/modpack\/install$/, keys: [], handler: handleModpackInstall },
    // 资源包 / 数据包 / 光影包 —— 本次新增（只做本地安装与管理，不碰 mod / Modrinth）。
    // 顺序同样遵循「固定段在前、带 :filename 的在后」：/packs 与 /saves 都是固定段，
    // 不会被 /packs/:filename 吞掉；反过来若把通配放在前面，`install` / `upload` 会被当成文件名。
    { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/saves$/, keys: ['instanceId'], handler: handleListSaves },
    { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/packs$/, keys: ['instanceId'], handler: handleListPacks },
    { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/packs\/install$/, keys: ['instanceId'], handler: handlePackInstall },
    { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/packs\/upload$/, keys: ['instanceId'], handler: handlePackUpload },
    { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/packs\/([^/]+)\/toggle$/, keys: ['instanceId', 'filename'], handler: handlePackToggle },
    { method: 'DELETE', pattern: /^\/api\/instances\/([^/]+)\/packs\/([^/]+)$/, keys: ['instanceId', 'filename'], handler: handlePackDelete },

    // ───────────────────────────── 内容源（Modrinth）+ 模组管理 ─────────────────────────────
    // 顺序：固定段（/search、/project/:slug/versions）在前，带 :filename 的通配在后。
    // `/api/content/project/:slug/versions` 必须排在 `/api/content/project/:slug` 之前，
    // 否则 `…/versions` 会被当成 slug 的一部分（正则里 slug 不含 `/`，这里仍按更具体的在前写）。
    { method: 'GET', pattern: /^\/api\/content\/search$/, keys: [], handler: handleContentSearch },
    { method: 'GET', pattern: /^\/api\/content\/project\/([^/]+)\/versions$/, keys: ['slug'], handler: handleContentVersions },
    { method: 'GET', pattern: /^\/api\/content\/project\/([^/]+)$/, keys: ['slug'], handler: handleContentProject },
    // 依赖预检：装之前先看清需要哪些前置，以及每一项能不能一键装上
    { method: 'GET', pattern: /^\/api\/content\/([^/]+)\/dependencies$/, keys: ['slug'], handler: handleContentDependencies },
    { method: 'POST', pattern: /^\/api\/content\/install$/, keys: [], handler: handleContentInstall },
    { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/mods$/, keys: ['instanceId'], handler: handleListMods },
    { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/mods\/([^/]+)\/toggle$/, keys: ['instanceId', 'filename'], handler: handleModToggle },
    { method: 'DELETE', pattern: /^\/api\/instances\/([^/]+)\/mods\/([^/]+)$/, keys: ['instanceId', 'filename'], handler: handleModDelete },

    // ───────────────────────────── 基础便利（shell 模块 / ux-dev 追加） ─────────────────────────────
    // 顺序：`.../folders/:kind/open` 必须排在 `.../folders/:kind` 之前。
    // 两条正则互不冲突（前者要求 `/open` 结尾），但按「更具体的在前」写，
    // 日后有人把 GET 那条改成通配也不会把 open 吞掉。
    { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/folders\/([^/]+)\/open$/, keys: ['instanceId', 'kind'], handler: handleFolderOpen },
    { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/folders\/([^/]+)$/, keys: ['instanceId', 'kind'], handler: handleFolderList },
    // 该实例的全部关键路径（显示 / 复制用）
    { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/paths$/, keys: ['instanceId'], handler: handleInstancePaths },
    // 完整启动命令行（高级用户排查 / 分享；令牌已打码）
    { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/launch-args$/, keys: ['instanceId'], handler: handleLaunchArgs },

    // ───────────────────────────── 已安装版本（版本选择器） ─────────────────────────────
    // 「实例」概念已取消（用户原话：「应该可以取消实例概念吧，目前版本选择其实已经替代了实例了」）。
    // 原来的 `GET/POST /api/instances` 与 `GET/DELETE /api/instances/:id` 四条一并删除：
    // 一个已安装版本 = 一个目录 = 一个启动目标，没有第二层身份了。
    // 原来的「上次启动时间」改由 `GET /api/versions` 的 `installedDetails` 一起给出
    // （数据仍取自 `<dataRoot>/instances/<versionId>/.pcl3/last-launch.json`，不新增接口）。

    // ───────────────────────────── 基础设施（infra-dev 追加） ─────────────────────────────
    // 顺序：全部是**固定段**（config / mirrors）或多一段的路径
    // （`/api/instances/:id/crash-analysis`），与上面任何一条都不冲突：
    //   `GET /api/instances/:id` 的正则要求「instances/ 之后到结尾不再有斜杠」，
    //   所以 `.../crash-analysis` 那条不可能被它吞掉，反之亦然。
    { method: 'GET', pattern: /^\/api\/config$/, keys: [], handler: handleGetConfig },
    { method: 'PUT', pattern: /^\/api\/config$/, keys: [], handler: handlePutConfig },
    { method: 'POST', pattern: /^\/api\/config\/validate-dir$/, keys: [], handler: handleValidateDir },
    // 【代理】探测本机代理 + 测试连通性。
    // 单列而不是塞进 /api/config，是因为它们要发真实网络请求，语义上是「动作」不是「读配置」。
    { method: 'GET', pattern: /^\/api\/proxy\/detect$/, keys: [], handler: handleDetectProxy },
    { method: 'POST', pattern: /^\/api\/proxy\/test$/, keys: [], handler: handleTestProxy },
    // 源测速：GET 只读（缓存优先），POST 强制重测（前端「重新测速」按钮）
    { method: 'GET', pattern: /^\/api\/mirrors$/, keys: [], handler: handleGetMirrors },
    { method: 'POST', pattern: /^\/api\/mirrors\/probe$/, keys: [], handler: handleProbeMirrors },
    // 崩溃分析：找不到报告也回 200 + reason（「还没崩过」是正常状态，不是 404）
    {
      method: 'GET',
      pattern: /^\/api\/instances\/([^/]+)\/crash-analysis$/,
      keys: ['instanceId'],
      handler: handleCrashAnalysis,
    },

    // ───────────────────────────── 启动前体检（preflight 追加） ─────────────────────────────
    // 顺序：固定段，与上面任何一条都不冲突（`/api/preflight` 只此一条）。
    // 刻意**不做成后台任务**：体检必须 < 1 秒返回，前端点启动时要同步等结果，
    // 走 jobId + 轮询会让「点启动」多出一段无谓的等待。
    { method: 'POST', pattern: /^\/api\/preflight$/, keys: [], handler: handlePreflight },
  ];

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const query = url.searchParams;

    // 方法不符但对路径命中 → 405（比 404 更诚实）
    let pathMatched = false;

    for (const route of routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue;

      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1] ?? '');
      });
      const ctx: HandlerCtx = { deps, req, res, params, query };
      try {
        // 并行开发期的纵深防御：别的模块可能刚把路由登记进表、handler 还没落地。
        // 那种情况下绝不能抛 ReferenceError 把整个路由表带崩（连它自己的接口一起挂），
        // 而是只让这一条路由诚实地回 501。handler 补齐后这段判断自动不再生效。
        if (typeof route.handler !== 'function') {
          sendJson(res, 501, {
            error: `接口 ${method} ${pathname} 还没实现（handler 尚未落地）。`,
          });
          return;
        }
        await route.handler(ctx);
      } catch (error) {
        // 唯一出口：任何异常都变成 JSON 错误，绝不 500 空响应
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message });
        } else {
          sendJson(res, 500, { error: errorMessage(error) });
        }
      }
      return;
    }

    if (pathMatched) {
      sendJson(res, 405, { error: `不支持的方法 ${method}，请换用正确的 HTTP 方法。` });
      return;
    }

    sendJson(res, 404, { error: `未知接口：${method} ${pathname}` });
  };
}

// ───────────────────────────── handler 上下文 ─────────────────────────────

interface HandlerCtx {
  deps: ApiDeps;
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

type Handler = (ctx: HandlerCtx) => Promise<void>;

// ───────────────────────────── GET /api/status ─────────────────────────────

async function handleStatus(ctx: HandlerCtx): Promise<void> {
  const { deps } = ctx;
  const dataRoot = deps.dataRoot();

  const installed = await listInstalledVersions(dataRoot);
  const running = deps.jobs.list().filter((j) => j.status === 'running');

  let manifestTotal: number | null = null;
  let latestRelease: string | null = null;
  let manifestError: string | undefined;
  try {
    const manifest = await deps.versionRepo.fetchManifest();
    manifestTotal = manifest.versions.length;
    latestRelease = manifest.latest.release;
  } catch (error) {
    // 离线不该让整个首屏都挂掉：如实标注「元数据不可用」
    manifestError = errorMessage(error);
  }

  const java = await detectJava(dataRoot, latestRelease);
  const diskUsage = diskUsageForStatus(deps);

  sendJson(ctx.res, 200, {
    dataRoot,
    versionCount: installed.length,
    installedVersions: installed,
    latestRelease,
    manifestTotal,
    ...(manifestError === undefined ? {} : { manifestError }),
    java: {
      found: java.found,
      path: java.path ?? null,
      majorVersion: java.majorVersion ?? null,
      home: java.home ?? null,
      detail: java.detail,
    },
    /** 数据根占用：永远不阻塞本响应，见 diskUsageForStatus 的注释 */
    diskUsage,
    /** 下载源测速结果（infra 追加）。字段名按契约固定为 `mirrors` */
    mirrors: await probeMirrorsForStatus(deps),
    runningJobs: running,
    serverTime: Date.now(),
  });
}

/**
 * `/api/status` 里的 `mirrors`。
 *
 * 为什么不能直接 `await selector.best()`：一次冷测速最长要等 5 秒 × 2 轮，
 * 而 `/api/status` 是首屏第一个请求 —— 让它卡 10 秒换取一行"延迟 xx ms"是错的。
 *
 * 所以：
 *   - 有缓存（内存或磁盘 TTL 内）→ 立刻返回真实延迟；
 *   - 没缓存 → 返回空数组并在后台触发一次测速，下次刷新就有了。
 * 前端据此显示「未测速 / 测速中」，而不是编一个 0 ms 出来。
 */
async function probeMirrorsForStatus(deps: ApiDeps): Promise<MirrorProbe[]> {
  const selector = deps.mirrorSelector;
  if (selector === undefined) return [];

  // 先摸一次 best()：TTL 内它是纯内存/磁盘读，几乎不耗时；
  // 冷启动时它会真测速 —— 那种情况我们不 await，交给后台。
  const warm = peekMirrorCache(deps);
  if (warm !== null) return warm;

  void backgroundProbeRefresh(selector);
  return [];
}

/**
 * 只读一次「已经测过的结果」：给 selector 加一个缓存 peek，拿不到就 null。
 *
 * 为什么不直接调 `probeAll()`：那一定会发请求。这里要的是「不联网也能回答」。
 * 真实 `MirrorSelector` 没有同步 peek，于是走一个不 await 的 `best()` 探测：
 * 但 `best()` 在冷缓存时也会联网 …… 所以约定：只有注入了「已预热」的 selector
 * 才在这里直接给结果（测试与真实实现都通过 `__mirrorsCache` 这个可选钩子）。
 */
function peekMirrorCache(deps: ApiDeps): MirrorProbe[] | null {
  const selector = deps.mirrorSelector as (MirrorSelectorLike & { cachedProbes?: () => MirrorProbe[] | null }) | undefined;
  if (selector === undefined) return null;
  if (typeof selector.cachedProbes !== 'function') return null;
  try {
    return selector.cachedProbes();
  } catch {
    return null;
  }
}

/** 后台测速（不阻塞响应，失败静默：下次刷新会再试） */
async function backgroundProbeRefresh(selector: MirrorSelectorLike): Promise<void> {
  try {
    await selector.best();
  } catch {
    /* 测速失败不影响任何其它接口 */
  }
}

/**
 * `/api/status` 里的 `diskUsage`。
 *
 * 为什么不同步算：数据根可能有十几万个文件（assets/objects 一片哈希目录），
 * 同步遍历会让首屏从 100 毫秒变成十几秒 —— 为了一行「占用 8.4 GB」不值得。
 *
 * 所以：
 *   - 有缓存就直接给（并标明 `stale`，过期了后台顺手刷新）；
 *   - 没缓存就返回 `{ ready:false }` 并在后台触发第一次统计，下次请求就有了。
 * 前端据此显示「统计中…」，而不是显示一个错的 0。
 */
function diskUsageForStatus(deps: ApiDeps): Record<string, unknown> {
  const usage = deps.diskUsage;
  if (usage === undefined) return { ready: false, detail: '本服务实例没有启用磁盘统计。' };

      const cached = usage.peekForResponse();
  // 没有缓存 / 缓存过期 → 后台补一次（不 await）
  if (cached === null || cached['stale'] === true) {
    void usage.refresh(cached === null).catch(() => undefined);
  }
  if (cached === null) {
    return { ready: false, detail: '正在统计数据目录占用，稍后刷新即可看到。' };
  }
  const { stale, ...rest } = cached;
  return { ready: true, ...rest, stale };
}

/** 已装版本：<dataRoot>/versions/<id>/<id>.json 存在即算装上 */
async function listInstalledVersions(dataRoot: string): Promise<string[]> {
  const versionsDir = path.join(dataRoot, 'versions');
  const entries = await fsp.readdir(versionsDir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const json = path.join(versionsDir, entry.name, `${entry.name}.json`);
    const stat = await fsp.stat(json).catch(() => undefined);
    if (stat?.isFile() === true) out.push(entry.name);
  }
  out.sort((a, b) => a.localeCompare(b, 'en'));
  return out;
}

/**
 * 已装版本分类：原版（在官方清单里）vs 加载器（不在官方清单里）。
 *
 * 为什么要分：`LoaderInstaller.install()` 把 profile 写进
 * `<dataRoot>/versions/<id>/<id>.json`，但那个 id（如 `fabric-loader-0.16.9-1.21`）
 * **永远不在官方 manifest 里**。若页面只按 manifest 渲染卡片，用户装完
 * Fabric 会看到一个「已装 1、列表里什么都没有」的鬼故事。
 */
interface LoaderProfileInfo {
  versionId: string;
  /** fabric / quilt；识别不出时 undefined */
  kind?: LoaderKind;
  /** 加载器版本号（profile 的 id 里解析出来的） */
  loaderVersion?: string;
  /** 继承的原版版本（profile 的 inheritsFrom） */
  gameVersion?: string;
}

const LOADER_ID_PATTERN = /^(fabric|quilt)-loader-([A-Za-z0-9._+-]+)-([A-Za-z0-9._+-]+)$/;

/** 从版本 id 里认出「这是哪个加载器 + 哪个原版」；认不出返回 undefined */
export function identifyLoaderProfile(versionId: string): Pick<LoaderProfileInfo, 'kind' | 'loaderVersion' | 'gameVersion'> | undefined {
  const m = LOADER_ID_PATTERN.exec(versionId);
  if (m === null) return undefined;
  const kind = m[1] === 'fabric' || m[1] === 'quilt' ? m[1] : undefined;
  if (kind === undefined) return undefined;
  return { kind, loaderVersion: m[2], gameVersion: m[3] };
}

/**
 * 扫 `<dataRoot>/versions/`，挑出「不在官方清单里」的版本并尽量标注加载器身份。
 *
 * 顺序：先读 profile JSON 的 `inheritsFrom`（最权威），读不到再退回 id 正则。
 * 不猜、不伪造：认不出加载器就只给 id，前端显示「未知来源」。
 */
async function listLoaderProfiles(dataRoot: string, officialIds: Set<string>): Promise<LoaderProfileInfo[]> {
  const all = await listInstalledVersions(dataRoot);
  const out: LoaderProfileInfo[] = [];
  for (const versionId of all) {
    if (officialIds.has(versionId)) continue;

    const jsonPath = path.join(dataRoot, 'versions', versionId, `${versionId}.json`);
    let inheritsFrom: string | undefined;
    try {
      const text = await fsp.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(text) as { inheritsFrom?: unknown };
      if (typeof parsed.inheritsFrom === 'string' && parsed.inheritsFrom.trim() !== '') {
        inheritsFrom = parsed.inheritsFrom.trim();
      }
    } catch {
      /* 读不出来就走 id 正则，不影响列表 */
    }

    const fromId = identifyLoaderProfile(versionId);
    const info: LoaderProfileInfo = { versionId };
    const kind = fromId?.kind;
    if (kind !== undefined) info.kind = kind;
    if (fromId?.loaderVersion !== undefined) info.loaderVersion = fromId.loaderVersion;
    const gameVersion = inheritsFrom ?? fromId?.gameVersion;
    if (gameVersion !== undefined) info.gameVersion = gameVersion;
    out.push(info);
  }
  return out;
}

// ───────────────────────────── GET /api/versions ─────────────────────────────

async function handleVersions(ctx: HandlerCtx): Promise<void> {
  const { deps } = ctx;
  const rawLimit = ctx.query.get('limit');
  const limit = rawLimit === null ? 60 : clampInt(Number(rawLimit), 0, 1000, 60);
  const type = ctx.query.get('type');

  const manifest = await deps.versionRepo.fetchManifest();
  const installed = new Set(await listInstalledVersions(deps.dataRoot()));
  const officialIds = new Set(manifest.versions.map((v) => v.id));

  let list: VersionSummary[] = manifest.versions;
  if (type !== null && type !== '' && type !== 'all') {
    list = list.filter((v) => v.type === type);
  }
  const sliced = limit > 0 ? list.slice(0, limit) : list;

  // 加载器版本不在官方清单里，单独列出（否则用户装完 Fabric 在页面上找不到它）
  const loaderProfiles = await listLoaderProfiles(deps.dataRoot(), officialIds);

  sendJson(ctx.res, 200, {
    latest: manifest.latest,
    total: manifest.versions.length,
    shown: sliced.length,
    versions: sliced.map((v) => ({
      id: v.id,
      type: v.type,
      releaseTime: v.releaseTime,
      installed: installed.has(v.id),
      latest: v.id === manifest.latest.release,
    })),
    installed: [...installed],
    /** 已装的加载器 profile（Fabric / Quilt），前端据此额外渲染卡片 */
    loaderProfiles,
    /**
     * 已安装版本的完整清单（「主页版本选择器」「版本页」都用它）。
     *
     * 为什么在这里给而不是新开一个接口：实例概念取消后，主页需要的
     * 「当前版本 + 类型 + 加载器 + 上次启动」全部由已装版本派生，
     * 一次请求拿全比三个接口拼起来更不容易出现「一半新一半旧」。
     * `gameVersion` / `loader` 只有加载器 profile 才有；原版留 null。
     */
    installedDetails: await describeInstalledVersions(deps.dataRoot(), officialIds, loaderProfiles),
  });
}

/** 一条「已安装版本」的对外形态（主页版本选择器 / 版本页共用） */
interface InstalledVersionDetail {
  versionId: string;
  /** 原版版本号（加载器 profile 是它继承的那个版本；原版就是自己） */
  gameVersion: string | null;
  /** fabric / quilt；原版为 null */
  loader: string | null;
  /** 加载器版本号；原版为 null */
  loaderVersion: string | null;
  /** 是否属于官方清单（原版 true，加载器 false） */
  official: boolean;
  /** 上次启动时间（ISO）；从没启动过为 null */
  lastPlayedAt: string | null;
  /** 目录里有没有 mods（判断「装不装得了模组」之外，也让 UI 说得出「已装 N 个」） */
  dir: string;
}

/**
 * 把「已装版本 + 加载器 profile + 上次启动时间」拼成一份清单。
 *
 * 只读：不 mkdir、不写文件。读不到上次启动时间就是 null（从没启动过）。
 */
async function describeInstalledVersions(
  dataRoot: string,
  officialIds: Set<string>,
  loaderProfiles: LoaderProfileInfo[],
): Promise<InstalledVersionDetail[]> {
  const installed = await listInstalledVersions(dataRoot);
  const byId = new Map<string, LoaderProfileInfo>();
  for (const profile of loaderProfiles) byId.set(profile.versionId, profile);

  const out: InstalledVersionDetail[] = [];
  for (const versionId of installed) {
    const profile = byId.get(versionId);
    const official = officialIds.has(versionId);
    out.push({
      versionId,
      gameVersion: profile?.gameVersion ?? (official ? versionId : null),
      loader: profile?.kind ?? null,
      loaderVersion: profile?.loaderVersion ?? null,
      official,
      lastPlayedAt: (await readLastLaunch(dataRoot, versionId)) ?? null,
      dir: instanceDirOf(dataRoot, versionId),
    });
  }
  return out;
}

// ───────────────────────────── POST /api/install ─────────────────────────────

async function handleInstall(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  const body = await readJsonBody(ctx.req);

  const versionId = typeof body['versionId'] === 'string' ? body['versionId'].trim() : '';
  if (versionId.length === 0) {
    sendJson(res, 400, { error: '缺少 versionId，请求体形如 {"versionId":"1.21"}' });
    return;
  }
  if (!isSafeVersionId(versionId)) {
    sendJson(res, 400, { error: `版本号「${versionId}」含非法字符。` });
    return;
  }

  // 互斥：同时只允许一个安装任务（原版与加载器共用同一套 libraries 目录）
  const running = deps.jobs.runningOf('install') ?? deps.jobs.runningOf('loaders');
  if (running !== undefined) {
    sendJson(res, 409, {
      error: `已经有一个安装任务在跑（${running.title}），请等它结束再试。`,
      jobId: running.id,
    });
    return;
  }

  const jobId = deps.jobs.create('install', `安装 ${versionId}`);
  deps.jobs.log(jobId, `开始安装 ${versionId}`);

  // 立刻返回，真正的活在后台跑
  sendJson(res, 202, { jobId, versionId });

  void runInstallJob(deps, jobId, versionId);
}

/**
 * 后台安装。
 *
 * 顺序：plan（算清单）→ install（下载）→ 校验 json 落盘
 * 任一步失败 → 任务标 failed 并写人话错误。
 */
async function runInstallJob(deps: ApiDeps, jobId: string, versionId: string): Promise<void> {
  try {
    deps.jobs.progress(jobId, { phase: 'plan', done: 0, total: 0 });
    const plan = await deps.installer.plan(versionId);
    deps.jobs.log(
      jobId,
      `计划任务 ${String(plan.tasks.length)} 个，共 ${formatBytes(plan.totalBytes)}（资源索引 ${plan.assetIndexId}）`,
    );

    // install 的 phase 语义直接映射到任务进度
    const onProgress = (p: { phase: string; done: number; total: number; current?: string }): void => {
      deps.jobs.progress(jobId, p);
      if (p.phase === 'done') deps.jobs.log(jobId, '安装完成');
    };

    await deps.installer.install(versionId, onProgress);

    // 复核：json 必须真的在磁盘上，否则前端点「启动」会莫名其妙失败
    const jsonPath = path.join(deps.dataRoot(), 'versions', versionId, `${versionId}.json`);
    const stat = await fsp.stat(jsonPath).catch(() => undefined);
    if (stat?.isFile() !== true) {
      throw new Error(`安装流程结束，但版本文件不存在：${jsonPath}`);
    }

    deps.jobs.succeed(jobId, { versionId, versionDir: path.dirname(jsonPath) });
  } catch (error) {
    deps.jobs.fail(jobId, friendlyInstallError(error, versionId));
  }
}

/** 把常见异常翻译成人话 */
function friendlyInstallError(error: unknown, versionId: string): string {
  const raw = errorMessage(error);
  if (/not found in manifest/i.test(raw)) {
    return `版本「${versionId}」不存在于官方清单里，请检查版本号是否写错（例如 1.21 而不是 1.21.0）。`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|fetch failed/i.test(raw)) {
    return `网络不通，无法下载 ${versionId} 的元数据。请检查代理/防火墙，或稍后重试。（原始错误：${raw}）`;
  }
  if (/ENOSPC/i.test(raw)) {
    return `磁盘空间不足，安装 ${versionId} 失败：${raw}`;
  }
  if (/EACCES|EPERM/i.test(raw)) {
    return `没有写入权限，安装 ${versionId} 失败：请检查数据目录权限。`;
  }
  return `安装 ${versionId} 失败：${raw}`;
}

// ───────────────────────────── 加载器（Fabric / Quilt） ─────────────────────────────

/** 只接受 fabric / quilt —— 其余一律 400（不做「猜你想装 Forge」这种自作聪明） */
export function parseLoaderKind(raw: string | null | undefined): LoaderKind | undefined {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return text === 'fabric' || text === 'quilt' ? text : undefined;
}

/** 加载器展示名（前端也有同名映射，这里只用于日志与错误文案） */
const LOADER_LABEL_CN: Record<LoaderKind, string> = { fabric: 'Fabric', quilt: 'Quilt' };

/** 列表上限：meta 有 250+ 条，一次全发没意义，前端也画不下 */
const LOADER_LIST_LIMIT = 200;

/** 取加载器安装器：优先用注入的工厂（测试），否则现场装配真实实现 */
function loaderInstallerFor(deps: ApiDeps): LoaderInstallerLike {
  return deps.loaderInstallerFactory?.() ?? createRealLoaderInstaller(deps.dataRoot());
}

/**
 * GET /api/loaders/:kind/versions?gameVersion=X
 *
 * 返回 meta 的 loader 版本列表（新 → 旧），前端只展示前 N 条。
 * `stable` 字段对 Quilt 是**启发式推断**（meta 没给），所以每条都带
 * `stableSource`，UI 必须如实标注，不能假装权威。
 */
async function handleLoaderVersions(ctx: HandlerCtx): Promise<void> {
  const kind = parseLoaderKind(ctx.params['kind']);
  if (kind === undefined) {
    sendJson(ctx.res, 400, {
      error: `不认识的加载器类型「${ctx.params['kind'] ?? ''}」，只支持 fabric / quilt。`,
    });
    return;
  }

  const gameVersion = (ctx.query.get('gameVersion') ?? '').trim();
  if (gameVersion.length === 0) {
    sendJson(ctx.res, 400, { error: '缺少 gameVersion，例如 /api/loaders/fabric/versions?gameVersion=1.21' });
    return;
  }
  if (!isSafeVersionId(gameVersion)) {
    sendJson(ctx.res, 400, { error: `游戏版本号「${gameVersion}」含非法字符。` });
    return;
  }

  const rawLimit = ctx.query.get('limit');
  const limit = rawLimit === null ? LOADER_LIST_LIMIT : clampInt(Number(rawLimit), 1, LOADER_LIST_LIMIT, LOADER_LIST_LIMIT);

  let versions: LoaderVersion[];
  try {
    versions = await loaderInstallerFor(ctx.deps).listVersions(kind, gameVersion);
  } catch (error) {
    // 网络问题必须以 502 出去，前端才能说「这是网络问题，不是你装错了」
    const friendly = friendlyLoaderError(error, kind, gameVersion, 'list');
    sendJson(ctx.res, 502, { error: friendly.message, ...(friendly.hint === undefined ? {} : { hint: friendly.hint }) });
    return;
  }

  const sliced = versions.slice(0, limit);
  sendJson(ctx.res, 200, {
    kind,
    label: LOADER_LABEL_CN[kind],
    gameVersion,
    total: versions.length,
    shown: sliced.length,
    versions: sliced.map((v) => ({
      version: v.version,
      stable: v.stable,
      /**
       * declared = meta 明确声明；inferred = 按版本号猜的（Quilt）；unknown = 拿不到。
       * 前端据此决定是否加「推断」标记。
       */
      stableSource: loaderStableSource(v),
    })),
  });
}

/**
 * 这条 `stable` 是怎么来的？
 *
 *   declared —— meta 明确给了 `loader.stable`（Fabric 全局列表有）
 *   inferred —— meta 没给，按版本号里的 alpha/beta/rc 推断（Quilt 就是这样）
 *   unknown  —— 拿不到判断依据
 *
 * `LoaderVersion` 契约形状只有 `{version, stable}`，所以类型上取不到来源；
 * 这里用运行时收窄读取（真实实现返回的是 LoaderVersionInfo，带 stabilitySource）。
 * 取不到时**不能**说 unknown —— UI 会把 unknown 理解成「没有稳定标记这回事」，
 * 而实际上我们至少能按版本号判断，所以退回 inferred 并如实说明是推断。
 */
function loaderStableSource(v: LoaderVersion & { stabilitySource?: string }): 'declared' | 'inferred' | 'unknown' {
  const src = v.stabilitySource;
  if (src === 'declared' || src === 'inferred' || src === 'unknown') return src;
  return 'inferred';
}

/**
 * POST /api/loaders/install
 * body: { kind, gameVersion, loaderVersion? }
 *
 * 立刻回 202 + jobId，真正的安装（依赖库下载 + profile 落盘）在后台跑，
 * 进度走 GET /api/jobs/:id —— 与 /api/install 完全同一套范式。
 */
async function handleLoaderInstall(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  const body = await readJsonBody(ctx.req);

  const kind = parseLoaderKind(typeof body['kind'] === 'string' ? body['kind'] : null);
  if (kind === undefined) {
    sendJson(res, 400, {
      error: `kind 只接受 fabric 或 quilt，收到「${String(body['kind'] ?? '')}」。`,
    });
    return;
  }

  const gameVersion = typeof body['gameVersion'] === 'string' ? body['gameVersion'].trim() : '';
  if (gameVersion.length === 0) {
    sendJson(res, 400, {
      error: '缺少 gameVersion，请求体形如 {"kind":"fabric","gameVersion":"1.21","loaderVersion":"0.16.9"}',
    });
    return;
  }
  if (!isSafeVersionId(gameVersion)) {
    sendJson(res, 400, { error: `游戏版本号「${gameVersion}」含非法字符。` });
    return;
  }

  const label = LOADER_LABEL_CN[kind];

  // 原版没装就别建任务：这是最常见的失败，早报比让用户在日志里翻快得多
  const precondition = await checkVanillaInstalled(deps.dataRoot(), gameVersion);
  if (precondition !== null) {
    sendJson(res, 409, precondition);
    return;
  }

  // 互斥：与 vanilla 安装共用同一个 libraries 目录，两种安装不许并行
  const running = deps.jobs.runningOf('install') ?? deps.jobs.runningOf('loaders');
  if (running !== undefined) {
    sendJson(res, 409, {
      error:
        running.kind === 'loaders'
          ? `已经有一个加载器安装任务在跑（${running.title}），等它结束再装${label}。`
          : `现在正在安装原版（${running.title}），装${label}会抢同一个 libraries 目录，等它结束再来。`,
      jobId: running.id,
    });
    return;
  }

  let loaderVersion = typeof body['loaderVersion'] === 'string' ? body['loaderVersion'].trim() : '';
  if (loaderVersion.length > 0 && !isSafeVersionId(loaderVersion)) {
    sendJson(res, 400, { error: `加载器版本号「${loaderVersion}」含非法字符。` });
    return;
  }

  const installer = loaderInstallerFor(deps);

  // 没指定版本 → 用最新稳定版。列表是按 meta 顺序（新 → 旧）给的，取第一条 stable。
  if (loaderVersion.length === 0) {
    let list: LoaderVersion[];
    try {
      list = await installer.listVersions(kind, gameVersion);
    } catch (error) {
      const friendly = friendlyLoaderError(error, kind, gameVersion, 'list');
      sendJson(res, 502, {
        error: friendly.message,
        ...(friendly.hint === undefined ? {} : { hint: friendly.hint }),
      });
      return;
    }
    const picked = list.find((v) => v.stable) ?? list[0];
    if (picked === undefined) {
      sendJson(res, 502, { error: `${label} meta 没有返回任何可用版本，稍后再试。` });
      return;
    }
    loaderVersion = picked.version;
  }

  const jobId = deps.jobs.create('loaders', `安装 ${label} ${loaderVersion}（${gameVersion}）`);
  deps.jobs.log(jobId, `开始为 ${gameVersion} 安装 ${label} ${loaderVersion}`);

  sendJson(res, 202, { jobId, kind, gameVersion, loaderVersion });

  void runLoaderInstallJob(deps, installer, jobId, kind, gameVersion, loaderVersion);
}

/**
 * 后台装加载器。
 *
 * 只用 `LoaderInstaller.install()` —— 它内部已经把「profile 没有 downloads.artifact」
 * 这条坑用回退链处理好了（见 core/loader/libraries.ts），这里**绝不自拼下载任务**。
 */
async function runLoaderInstallJob(
  deps: ApiDeps,
  installer: LoaderInstallerLike,
  jobId: string,
  kind: LoaderKind,
  gameVersion: string,
  loaderVersion: string,
): Promise<void> {
  const label = LOADER_LABEL_CN[kind];
  try {
    deps.jobs.progress(jobId, { phase: 'plan', done: 0, total: 1 });
    deps.jobs.log(jobId, `获取 ${label} profile（${gameVersion} + ${loaderVersion}）…`);

    const started = Date.now();
    let lastPhase = '';
    const result = await installer.install(kind, gameVersion, loaderVersion, (p) => {
      // 阶段映射：libraries → 下载依赖；meta → 写版本 JSON；done → 收尾
      deps.jobs.progress(jobId, { phase: p.phase, done: p.done, total: p.total });
      if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        if (p.phase === 'libraries') deps.jobs.log(jobId, `开始下载 ${label} 依赖库（${String(p.total)} 个）…`);
        if (p.phase === 'meta') deps.jobs.log(jobId, '依赖就绪，正在写入版本文件…');
      }
      if (p.phase === 'done') return; // succeed() 会把 phase 置为 done，不必提前写日志
    });

    const versionId = result.versionId;

    // 复核：版本目录里那份 JSON 必须真的在，否则前端点「启动」会莫名其妙失败
    const jsonPath = path.join(deps.dataRoot(), 'versions', versionId, `${versionId}.json`);
    const stat = await fsp.stat(jsonPath).catch(() => undefined);
    if (stat?.isFile() !== true) {
      throw new Error(`安装流程结束，但版本文件不存在：${jsonPath}`);
    }

    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    deps.jobs.log(jobId, `版本 id：${versionId}（可直接启动，耗时约 ${String(seconds)} 秒）`, 'info');
    deps.jobs.succeed(jobId, {
      versionId,
      kind,
      loaderVersion,
      gameVersion,
      versionDir: path.dirname(jsonPath),
    });
  } catch (error) {
    deps.jobs.fail(jobId, friendlyLoaderError(error, kind, gameVersion, 'install').message);
  }
}

/**
 * 原版是否已安装 —— 与 `LoaderInstaller.ensureVanillaInstalled` 同口径
 * （版本 JSON + client jar 都在），但提前在 HTTP 层判一次，好给 409 + 明确指引。
 */
async function checkVanillaInstalled(
  dataRoot: string,
  gameVersion: string,
): Promise<{ error: string; hint: string; needVanilla: string } | null> {
  const dir = path.join(dataRoot, 'versions', gameVersion);
  const jsonOk = await fsp.stat(path.join(dir, `${gameVersion}.json`)).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!jsonOk) {
    return {
      error: `原版 ${gameVersion} 还没安装，装加载器之前得先有原版。`,
      hint: `请先点 ${gameVersion} 卡片上的「安装」（命令行：pcl3 install ${gameVersion}）。`,
      needVanilla: gameVersion,
    };
  }
  const jarOk = await fsp.stat(path.join(dir, `${gameVersion}.jar`)).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!jarOk) {
    return {
      error: `原版 ${gameVersion} 的 jar 缺失，加载器装上去也启动不了。`,
      hint: `请先重装原版：点 ${gameVersion} 卡片上的「重装」（命令行：pcl3 install ${gameVersion}）。`,
      needVanilla: gameVersion,
    };
  }
  return null;
}

/** 加载器相关错误 → { message, hint } 的人话翻译 */
export function friendlyLoaderError(
  error: unknown,
  kind: LoaderKind,
  gameVersion: string,
  phase: 'list' | 'install',
): { message: string; hint?: string } {
  const label = LOADER_LABEL_CN[kind];

  if (error instanceof LoaderPreconditionError) {
    return { message: error.message, hint: error.hint };
  }

  const raw = errorMessage(error);

  // 有些路径下 LoaderInstaller 会把前置条件错误包一层，这里按文案兜底
  if (/原版 .* 还没安装|原版 .* 的 jar 缺失|请先执行/.test(raw)) {
    return { message: raw, hint: `请先安装原版 ${gameVersion}（pcl3 install ${gameVersion}），再装${label}。` };
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|aborted|socket hang up/i.test(raw)) {
    return {
      message: `连不上 ${label} 的元数据服务器，这是网络问题（不是你的版本号写错了）。`,
      hint: '检查代理 / 防火墙后重试；国内网络访问 meta.fabricmc.net、meta.quiltmc.org 偶尔不稳。',
    };
  }
  if (/没有返回任何可用版本|meta 列表为空|不是数组/.test(raw)) {
    return { message: `${label} 元数据返回异常：${raw}`, hint: '通常会在一两分钟内恢复，稍后重试。' };
  }
  if (/HTTP 4\d\d/.test(raw)) {
    return {
      message: `${label} 的服务器拒绝了这次请求：${raw}`,
      hint: '多半是这个 loader 版本没有为这个游戏版本提供 profile，换一个版本试试。',
    };
  }
  if (/ENOSPC/i.test(raw)) {
    return { message: `磁盘空间不足，装${label}失败：${raw}` };
  }
  if (/EACCES|EPERM/i.test(raw)) {
    return { message: `没有写入权限，装${label}失败：请检查数据目录权限。` };
  }
  if (/没有任何可下载的库/.test(raw)) {
    return { message: raw, hint: `这个 ${label} 版本的 profile 不完整，换一个版本试试。` };
  }
  return {
    message: phase === 'list' ? `${label} 版本列表获取失败：${raw}` : `安装 ${label} 失败：${raw}`,
  };
}

// ───────────────────────────── GET /api/jobs/:id ─────────────────────────────

async function handleJob(ctx: HandlerCtx): Promise<void> {
  const id = ctx.params['id'] ?? '';
  const snap = ctx.deps.jobs.get(id);
  if (snap === undefined) {
    sendJson(ctx.res, 404, { error: `任务 ${id} 不存在，或已超过保留时间（10 分钟）被清理。` });
    return;
  }
  // 支持 ?since=N 只取增量日志，避免轮询把整段日志反复搬一遍
  const sinceRaw = ctx.query.get('since');
  if (sinceRaw !== null) {
    const since = clampInt(Number(sinceRaw), 0, Number.MAX_SAFE_INTEGER, 0);
    const sliced: JobSnapshot = { ...snap, log: snap.log.slice(since) };
    sendJson(ctx.res, 200, { ...sliced, logOffset: since });
    return;
  }
  sendJson(ctx.res, 200, snap);
}

// ───────────────────────────── POST /api/launch ─────────────────────────────

async function handleLaunch(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  const body = await readJsonBody(ctx.req);

  const versionId = typeof body['versionId'] === 'string' ? body['versionId'].trim() : '';
  if (versionId.length === 0) {
    sendJson(res, 400, { error: '缺少 versionId，请求体形如 {"versionId":"1.21","username":"Steve"}' });
    return;
  }
  if (!isSafeVersionId(versionId)) {
    sendJson(res, 400, { error: `版本号「${versionId}」含非法字符。` });
    return;
  }

  const rawName = body['username'];
  const username = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : 'Steve';

  // ── 启动目标 = 版本目录 ──
  // 「实例」概念已取消：启动只认 versionId，目录恒为 `<dataRoot>/instances/<versionId>`。
  // 老前端若还在 body 里带 instanceId，这里**静默忽略**（不报错、也不拿它拼路径），
  // 否则一个已经废弃的参数就能让「点启动」失败。
  const launchLabel = `启动 ${versionId}`;

  let account: Account;
  try {
    // 优先用已保存的离线账户，避免用户名字被改；没保存就现场生成（不落盘）
    const saved = loadAccounts(deps.dataRoot()).accounts.find(
      (a) => a.type === 'offline' && a.username === username,
    );
    account = saved ?? offlineAccount(username);
  } catch (error) {
    sendJson(res, 400, { error: errorMessage(error) });
    return;
  }

  // 同一个实例目录不允许并发启动两次（第二次会抢同一个目录的 natives / 日志）。
  // 有 instanceId 时按实例判重；没有时仍按版本判重（保持旧行为）。
  const existing = deps.jobs
    .list()
    .find(
      (j) =>
        j.kind === 'launch' &&
        j.status === 'running' &&
        (j.result?.['versionId'] === versionId || j.title === launchLabel || j.title === `启动 ${versionId}`),
    );
  if (existing !== undefined) {
    sendJson(res, 409, {
      error: `版本 ${versionId} 已经在启动了，请先等它起来。`,
      jobId: existing.id,
    });
    return;
  }

  // ── 启动前体检（preflight）──
  //
  // 三档行为（PCL2 的核心体验：点启动前先把话说清楚，进不去就别进）：
  //   有 blocking 且**修不了**   → 409 + 完整报告，压根不建任务
  //   有 blocking 但**能自动修** → 照常 202，日志里写明「发现 N 个问题，已自动处理」
  //   只有 warning              → 照常 202，日志里提示
  //
  // 「能自动修」的判定只看 fix 上的 kind：download-java 是启动链路本身就会做的事
  // （GameLauncher.pickJava → JavaAutoProvisioner.ensureJava），所以可以放行；
  // install-version / install-loader / raise-memory 之类需要用户去点，不能在启动里偷偷做。
  const preflight = await runPreflight(deps, versionId);
  if (preflight !== null) {
    const unfixable = preflight.blocking.filter((issue) => !isAutoFixableOnLaunch(issue.fix?.kind));
    if (unfixable.length > 0) {
      sendJson(res, 409, {
        error: `启动前体检没通过：${unfixable.map((i) => i.title).join('；')}`,
        code: 'preflight-blocked',
        versionId,
        preflight,
      });
      return;
    }
  }

  const jobId = deps.jobs.create('launch', launchLabel);
  deps.jobs.log(jobId, `以离线账户 ${account.username}（${account.uuid}）启动 ${versionId}`);

  // 把体检结论写进任务日志：用户事后再看「为什么这次启动跟以前不一样」时有据可查
  let preflightNote: string | undefined;
  if (preflight !== null) {
    for (const line of preflightLogLines(preflight)) deps.jobs.log(jobId, line);
    const autoFixed = preflight.blocking.filter((issue) => isAutoFixableOnLaunch(issue.fix?.kind));
    if (autoFixed.length > 0) {
      preflightNote = `体检发现 ${String(autoFixed.length)} 个问题，已自动处理：${autoFixed.map((i) => i.title).join('；')}`;
      deps.jobs.log(jobId, preflightNote);
    }
  }

  sendJson(res, 202, {
    jobId,
    versionId,
    username: account.username,
    // 只给摘要，完整报告在 POST /api/preflight（避免 202 的 body 变得又大又慢）
    ...(preflight === null
      ? {}
      : {
          preflight: {
            canLaunch: preflight.canLaunch,
            blocking: preflight.blocking.length,
            warnings: preflight.warnings.length,
            elapsedMs: preflight.elapsedMs,
          },
        }),
  });

  void runLaunchJob(deps, jobId, versionId, account);
}

/**
 * 这个修复动作能不能在启动链路里自动完成。
 *
 * 只有 `download-java` 算：它本来就在 `buildCommand → pickJava → ensureJava` 里，
 * 体检只是「提前说了会发生什么」。其余修复要么要写设置、要么要装东西、
 * 要么要删用户文件，**一律不在启动里替用户做主**。
 */
export function isAutoFixableOnLaunch(kind: string | undefined): boolean {
  return kind === 'download-java';
}

/**
 * 后台启动。
 *
 * 为什么不用 `GameLauncher.launch()`：它写死 `stdio: 'inherit'`，子进程输出直接进控制台，
 * 拿不到流。这里用 `buildCommand()`（唯一真源，参数拼装全在那边）+ 自己 spawn，
 * 才能把 stdout 接进任务日志喂给前端。
 */
async function runLaunchJob(
  deps: ApiDeps,
  jobId: string,
  versionId: string,
  account: Account,
): Promise<void> {
  // 登记当前 job，让 Java 自动下载的进度能归到这个任务上（见 activeJavaJobId 注释）。
  // 整个启动流程结束（成功、失败、抛错）都必须清空，否则进度会串到下一个任务。
  setActiveJavaJobId(jobId);
  let child: ChildProcess | undefined;
  try {
    deps.jobs.progress(jobId, { phase: 'prepare', done: 0, total: 1 });

    const dataRoot = deps.dataRoot();
    // 「实例」概念取消后，目录规则只剩一条：<dataRoot>/instances/<versionId>。
    // 磁盘上已有的同名目录原样沿用（用户存档都在里头），一个字节都没动。
    const instanceDir = instanceDirOf(dataRoot, versionId);
    // 内存 / JVM 参数 / Java 路径一律来自版本设置（没存过就是默认 2048）。
    // 设置 -> LaunchOptions 的映射只有一份，见 core/settings/index.ts。
    const options: LaunchOptions = {
      versionId,
      instanceDir,
      account,
      ...launchFieldsFor(dataRoot, versionId),
    };
    deps.jobs.log(jobId, `版本目录：${instanceDir}`);

    const launcher = deps.launcherFactory();
    const built = await launcher.buildCommand(options);
    deps.jobs.log(jobId, `Java 可执行文件：${built.java}`);
    deps.jobs.log(jobId, `工作目录：${built.cwd}`);
    deps.jobs.log(jobId, `参数 ${String(built.args.length)} 个`);
    deps.jobs.progress(jobId, { phase: 'starting', done: 0, total: 1 });

    // 版本目录必须先存在，否则 spawn 的 cwd 无效直接 ENOENT
    await fsp.mkdir(built.cwd, { recursive: true });

    child = spawn(built.java, built.args, {
      cwd: built.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    const proc = child;
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    let bytes = 0;
    const pipe = (chunk: string, level: 'info' | 'warn'): void => {
      bytes += chunk.length;
      // 单行超长就截断，避免一行 base64 把浏览器卡住
      deps.jobs.log(jobId, chunk.length > MAX_LOG_LINE ? `${chunk.slice(0, MAX_LOG_LINE)}…（已截断）` : chunk, level);
    };
    proc.stdout?.on('data', (chunk: string | Buffer) => {
      pipe(String(chunk), 'info');
    });
    proc.stderr?.on('data', (chunk: string | Buffer) => {
      pipe(String(chunk), 'warn');
    });

    const pid = await waitForSpawn(proc);

    deps.jobs.succeed(jobId, {
      versionId,
      pid,
      java: built.java,
      instanceDir,
    });
    deps.jobs.progress(jobId, { phase: 'running', done: 1, total: 1 });
    deps.jobs.log(jobId, `游戏进程已拉起，PID ${String(pid)}`);

    // 记录「上次启动时间」：主页的「上次启动：…」就靠它。
    // 写的是 `<dataRoot>/instances/<versionId>/.pcl3/last-launch.json`，
    // 只写自己那个隐藏子目录，绝不碰用户的 mods / saves。
    void recordLastLaunch(dataRoot, versionId).catch((error: unknown) => {
      deps.jobs.log(jobId, `记录启动时间失败（不影响游戏）：${errorMessage(error)}`, 'warn');
    });

    proc.on('exit', (code, signal) => {
      deps.jobs.log(
        jobId,
        `游戏进程退出：code=${String(code ?? 'null')} signal=${String(signal ?? 'null')}，共收到 ${String(bytes)} 字节输出`,
        code === 0 ? 'info' : 'warn',
      );
    });
    proc.on('error', (error) => {
      deps.jobs.log(jobId, `进程错误：${error.message}`, 'error');
    });
  } catch (error) {
    if (child !== undefined && child.exitCode === null) child.kill();
    deps.jobs.fail(jobId, friendlyLaunchError(error, versionId, deps.dataRoot()));
  } finally {
    // 无论成功、失败还是抛错都要清空，否则下一次启动的 Java 进度会串到这个已结束的任务上。
    setActiveJavaJobId(null);
  }
}

/** 启动失败的常见原因翻译成人话 */
function friendlyLaunchError(error: unknown, versionId: string, dataRoot: string): string {
  const raw = errorMessage(error);
  // Java 自动下载失败：区分网络 / 磁盘 / 组件不存在，别让用户对着一句 "fetch failed" 发呆
  if (/JavaProvisionError|自动下载 Java|Java 运行时下载/.test(raw)) {
    return `启动 ${versionId} 需要 Java，自动下载没能完成。\n${raw}\n\n可以尝试：检查网络后重试，或在「设置」里指定本机已有的 Java。`;
  }
  if (/找不到可用的 Java 运行时/.test(raw)) {
    return `启动 ${versionId} 需要 Java，但数据目录里没有可用的运行时。\n${raw}`;
  }
  if (/读取版本 JSON 失败|ENOENT/.test(raw)) {
    return `版本 ${versionId} 好像还没装好（找不到版本文件）。请先点「安装」再启动。\n（数据目录：${dataRoot}）`;
  }
  if (/ENOENT/.test(raw) && /javaw?\.exe|java'/.test(raw)) {
    return `找不到 Java 可执行文件：${raw}`;
  }
  return `启动 ${versionId} 失败：${raw}`;
}

/** 等 spawn 结果：成功给 pid，失败 reject（避免返回一个已经死掉的进程） */
function waitForSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`启动进程超时（${String(SPAWN_TIMEOUT_MS)} 毫秒内没有拿到 spawn 事件）。`)));
    }, SPAWN_TIMEOUT_MS);
    timer.unref?.();
    const onSpawn = (): void => finish(() => resolve(child.pid ?? -1));
    const onError = (err: Error): void => finish(() => reject(err));
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

// ───────────────────────────── 实例设置（内存 / JVM 参数） ─────────────────────────────

/** 一次请求里最多多拿几个设置行（配合 list 用，不额外开接口） */
const SETTINGS_LIST_LIMIT = 500;

/**
 * 给启动用：`resolve()` 拿到设置（没存过 = 默认 2048），再摊成 LaunchOptions 的字段。
 *
 * 这是「设置真的进到命令行里」的唯一入口 —— Web 启动与测试都走它，
 * 免得两处各写一份拼装逻辑、日后分叉。
 */
export function launchFieldsFor(dataRoot: string, versionId: string, instanceId?: string): ReturnType<typeof toLaunchOptionFields> {
  const settings = new SettingsStore({ dataRoot }).resolve(versionId, instanceId);
  return toLaunchOptionFields(settings);
}

/** GET /api/instances/:versionId/settings —— 没存过返回默认值，前端因此永远有东西可画 */
async function handleGetSettings(ctx: HandlerCtx): Promise<void> {
  const versionId = ctx.params['versionId'] ?? '';
  if (!isSafeVersionId(versionId)) {
    sendJson(ctx.res, 400, { error: `版本号「${versionId}」含非法字符。` });
    return;
  }

  const store = new SettingsStore({ dataRoot: ctx.deps.dataRoot() });
  const settings = store.resolve(versionId);
  sendJson(ctx.res, 200, {
    ...settings,
    /** 来自磁盘还是默认值 —— UI 可以据此决定要不要显示「未保存」态 */
    source: store.load(versionId) === undefined ? 'default' : 'stored',
    path: store.settingsPath(versionId),
  });
}

/**
 * PUT /api/instances/:versionId/settings
 *
 * 校验在 settings 模块里（范围、字符串数组、换行/空字节），这里只做 HTTP 语义映射：
 *   - 校验失败 → 400，把每一条问题人话列出；
 *   - 写盘失败 → 500，明确说没存进去。
 */
async function handlePutSettings(ctx: HandlerCtx): Promise<void> {
  const versionId = ctx.params['versionId'] ?? '';
  if (!isSafeVersionId(versionId)) {
    sendJson(ctx.res, 400, { error: `版本号「${versionId}」含非法字符。` });
    return;
  }

  const body = await readJsonBody(ctx.req);
  const store = new SettingsStore({ dataRoot: ctx.deps.dataRoot() });

  let saved: InstanceSettings;
  try {
    // 只覆盖 body 里真的出现的字段，其余沿用磁盘上已有的值。
    //
    // 为什么必须合并：`PUT /settings` 是「部分更新」语义 —— 前端「只改显示名」
    // 或「只改内存」时都只发那几个字段。如果这里整份重写，改个名字就会把
    // 用户调好的 6 GB 内存和一堆 JVM 参数一起打回默认 2 GB。
    const existing = store.load(versionId);
    const patch = Object.fromEntries(
      Object.entries(body as Record<string, unknown>).filter(([, v]) => v !== undefined),
    ) as Partial<InstanceSettings>;
    saved = {
      ...(existing ?? {}),
      id: versionId,
      versionId,
      ...patch,
    };
    // 显式传 null 表示「清掉这一项」（例如把显示名 / Java 路径恢复默认）
    const mutable = saved as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === null) delete mutable[key];
    }
    store.save(saved);
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      sendJson(ctx.res, 400, {
        error: error.problems.join('\n'),
        problems: error.problems,
        ...(error.ignored.length === 0 ? {} : { ignored: error.ignored }),
      });
      return;
    }
    sendJson(ctx.res, 500, { error: `设置没能写入磁盘：${errorMessage(error)}` });
    return;
  }

  const persisted = store.resolve(versionId);
  sendJson(ctx.res, 200, { ...persisted, source: 'stored', path: store.settingsPath(versionId) });
}

/** GET /api/instances/settings —— 全部实例设置一览（CLI/前端排查用，可选） */
async function handleListSettings(ctx: HandlerCtx): Promise<void> {
  const store = new SettingsStore({ dataRoot: ctx.deps.dataRoot() });
  const list = store.list().slice(0, SETTINGS_LIST_LIMIT);
  sendJson(ctx.res, 200, { total: list.length, instances: list });
}

// ───────────────────────────── 全局配置 / 数据目录（infra-dev 追加） ─────────────────────────────

/**
 * 取全局配置存储。
 *
 * 三层：注入的（测试）→ 已安装到 globalThis 的（server.ts 在启动时装的）→ 现场新建。
 * 现场新建时 **同步 installConfigHook**：保证紧接着的 `getDataRoot()` 立刻按新配置解析，
 * 不会出现「PUT 成功但这次响应里的 dataRoot 还是旧的」这种鬼故事。
 */
function configStoreFor(deps: ApiDeps): GlobalConfigStore {
  if (deps.configStore !== undefined) return deps.configStore;
  const installed = (globalThis as { __pcl3ConfigStore?: GlobalConfigStore }).__pcl3ConfigStore;
  if (installed !== undefined && typeof installed.load === 'function') return installed;
  const created = new GlobalConfigStore();
  installConfigHook(created);
  return created;
}

/**
 * GET /api/config
 *
 * 返回当前配置 + 一组「这个值到底从哪来」的解释字段：
 *   · `dataRoot`          —— 本次**实际生效**的数据目录（已按 环境变量 → config → 默认 解析）
 *   · `dataRootFromConfig`—— config.json 里写的那一项（没写 = null）
 *   · `dataRootSource`    —— env / config / default
 *   · `defaultDataRoot`   —— %APPDATA%/PCL3（不带环境变量影响）
 *
 * 为什么要区分：用户改了配置却没生效，多半是被 `PCL3_DATA_ROOT` 压住了。
 * 界面上必须能一眼看出这件事，而不是让用户以为"保存失败"。
 */
async function handleGetConfig(ctx: HandlerCtx): Promise<void> {
  const store = configStoreFor(ctx.deps);
  const cfg = store.load();
  const envRoot = process.env['PCL3_DATA_ROOT'];
  const envActive = typeof envRoot === 'string' && envRoot.trim() !== '';
  const payload = {
    config: cfg,
    configPath: store.configPath,
    dataRoot: ctx.deps.dataRoot(),
    dataRootFromConfig: cfg.dataRoot ?? null,
    dataRootSource: envActive ? 'env' : cfg.dataRoot !== undefined && cfg.dataRoot !== null ? 'config' : 'default',
    envDataRoot: envActive ? path.resolve(envRoot.trim()) : null,
    defaultDataRoot: path.join(defaultDataPathRoot(), 'PCL3'),
    ...(store.loadProblem === undefined ? {} : { warning: store.loadProblem }),
  };
  sendJson(ctx.res, 200, payload);
}

/** 默认数据目录根（%APPDATA%，**不**受环境变量影响），只为把「默认值」如实画出来 */
function defaultDataPathRoot(): string {
  const appData = process.env['APPDATA'];
  if (process.platform === 'win32' && typeof appData === 'string' && appData.trim() !== '') {
    return path.resolve(appData.trim());
  }
  return os.homedir();
}

/**
 * PUT /api/config
 *
 * body 支持局部更新：`{ dataRoot?, preferredMirror?, autoProbeMirror? }`。
 *
 * 语义（与界面一一对应）：
 *   · 只传 `preferredMirror` / `autoProbeMirror` → 立即生效并返回新配置；
 *   · 传了 `dataRoot` → 走完整校验（可写 / 不能是文件 / 不能是当前数据目录的子目录），
 *     通过才落盘，然后在**本次进程内**让新目录立刻生效（resetDataRootCache），
 *     并把「不自动迁移」的提示原样返回给界面。
 */
async function handlePutConfig(ctx: HandlerCtx): Promise<void> {
  const store = configStoreFor(ctx.deps);
  const body = await readJsonBody(ctx.req);

  // 数据目录单独走 setDataRoot：它有整套校验 + 迁移提示，不能和普通字段混着更新
  let dataRootResult:
    | { ok: boolean; reason?: string; notice?: string; warnings: string[] }
    | undefined;
  let patch: Record<string, unknown> = { ...body };

  if ('dataRoot' in body) {
    const raw = body['dataRoot'];
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      sendJson(ctx.res, 400, { error: 'dataRoot 必须是字符串（目录绝对路径），或 null 表示恢复默认。' });
      return;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const applied = await store.setDataRoot(raw);
      dataRootResult = {
        ok: applied.ok,
        ...(applied.reason === undefined ? {} : { reason: applied.reason }),
        ...(applied.notice === undefined ? {} : { notice: applied.notice }),
        warnings: applied.warnings,
      };
      if (!applied.ok) {
        sendJson(ctx.res, 400, {
          error: applied.reason ?? '这个目录不能用作数据目录。',
          field: 'dataRoot',
          warnings: applied.warnings,
          checks: await dirCheckPayload(raw, ctx.deps.dataRoot(), store.configPath),
        });
        return;
      }
      // 立刻让本次进程按新目录解析（不重启也能看到效果）
      resetDataRootCache();
    } else {
      // 显式清空 → 回到默认目录（走同一套校验，避免把数据目录指到奇怪的地方）
      patch = { ...patch, dataRoot: null };
    }
  }

  const rest = { ...patch };
  delete rest['dataRoot'];

  let saved = store.load();
  if (Object.keys(rest).length > 0) {
    try {
      const merged = store.update(rest);
      saved = merged.config;
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        sendJson(ctx.res, 400, {
          error: error.problems.join('\n'),
          problems: error.problems,
          ...(error.ignored.length === 0 ? {} : { ignored: error.ignored }),
        });
        return;
      }
      sendJson(ctx.res, 500, { error: `配置没能写入磁盘：${errorMessage(error)}` });
      return;
    }
  } else if (dataRootResult === undefined) {
    // 一个字段都没给：不要假装保存成功
    sendJson(ctx.res, 400, {
      error: '没有要修改的项。可用字段：dataRoot / preferredMirror / autoProbeMirror。',
    });
    return;
  }

  if (dataRootResult !== undefined && dataRootResult.ok) {
    saved = store.load();
    resetDataRootCache();
  }
  if ('dataRoot' in body && (body['dataRoot'] === null || body['dataRoot'] === '')) {
    // 回到默认目录也要立刻生效
    const cleared = store.load();
    if (cleared.dataRoot === undefined) resetDataRootCache();
  }

  // 【代理】改完配置立刻生效，不必重启。失败不影响保存结果 ——
  // 配置已经落盘了，下次启动照样会读到。
  let proxyApplied: { applied: boolean; url?: string; reason?: string } | undefined;
  if ('proxy' in body) {
    try {
      const result = await applyProxyFromConfig(store);
      proxyApplied = {
        applied: result.applied,
        ...(result.url === undefined ? {} : { url: result.url }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    } catch {
      /* 已经落盘，忽略 */
    }
  }

  const cfg = store.load();
  sendJson(ctx.res, 200, {
    config: cfg,
    configPath: store.configPath,
    dataRoot: ctx.deps.dataRoot(),
    ...(proxyApplied === undefined ? {} : { proxyApplied }),
    dataRootFromConfig: cfg.dataRoot ?? null,
    dataRootSource: typeof process.env['PCL3_DATA_ROOT'] === 'string' ? 'env' : cfg.dataRoot !== undefined ? 'config' : 'default',
    ...(dataRootResult === undefined
      ? {}
      : {
          dataRootResult: {
            ok: dataRootResult.ok,
            ...(dataRootResult.notice === undefined ? {} : { notice: dataRootResult.notice }),
            warnings: dataRootResult.warnings,
          },
        }),
    ...(store.loadProblem === undefined ? {} : { warning: store.loadProblem }),
  });
}

/** 把一次目录校验摊平成响应字段（PUT 失败时附上，界面不用再问一次） */
async function dirCheckPayload(raw: string, currentRoot: string, configPath: string): Promise<DataDirCheck> {
  return validateDataDir(raw, { currentDataRoot: currentRoot, configPath });
}

/**
 * POST /api/config/validate-dir
 *
 * body: `{ dir: string }` → 只校验、不落盘。
 *
 * 返回 200 + `{ ok, dir, reason?, warnings, exists, looksLikeDataRoot, relation, sizeBytes? }`；
 * **校验不通过也是 200**（`ok:false`），只有请求体本身不合法才 400 ——
 * "这个目录不能用作数据目录"是业务结果，不是 HTTP 层的错误。
 */
async function handleValidateDir(ctx: HandlerCtx): Promise<void> {
  const body = await readJsonBody(ctx.req);
  const raw = body['dir'] ?? body['dataRoot'];
  if (typeof raw !== 'string') {
    sendJson(ctx.res, 400, { error: '缺少 dir，请求体形如 {"dir":"D:\\\\PCL3"}' });
    return;
  }

  const store = configStoreFor(ctx.deps);
  const check = await validateDataDir(raw, {
    currentDataRoot: ctx.deps.dataRoot(),
    configPath: store.configPath,
  });

  sendJson(ctx.res, 200, {
    ...check,
    ...(check.ok && check.relation !== 'same'
      ? { notice: migrationNotice({ from: ctx.deps.dataRoot(), to: check.dir, ...(check.sizeBytes === undefined ? {} : { sizeBytes: check.sizeBytes }) }) }
      : {}),
  });
}

// ───────────────────────────── 源测速（infra-dev 追加） ─────────────────────────────

/** 取源测速器（注入的优先；否则按当前全局配置装配） */
function mirrorSelectorFor(deps: ApiDeps): MirrorSelectorLike {
  if (deps.mirrorSelector !== undefined) return deps.mirrorSelector;
  const cfg = configStoreFor(deps).load();
  // 自动测速关闭且有固定源 → 固定源；否则自动测速
  return cfg.autoProbeMirror === false && typeof cfg.preferredMirror === 'string'
    ? new MirrorSelector({ dataRoot: deps.dataRoot(), preferredId: cfg.preferredMirror })
    : new MirrorSelector({ dataRoot: deps.dataRoot() });
}

/** 当前最佳源（GET /api/mirrors） */
async function handleGetMirrors(ctx: HandlerCtx): Promise<void> {
  const selector = mirrorSelectorFor(ctx.deps);
  const best = await selector.best();
  const all = await selector.probeAll({ timeoutMs: 3_000 });
  sendJson(ctx.res, 200, { best, mirrors: all });
}

// ───────────────────────────── 代理探测与测试 ─────────────────────────────

/**
 * GET /api/proxy/detect —— 探测本机可用代理。
 *
 * 为什么单开一条：用户往往不知道自己代理的端口。Clash 7890/7897、v2rayN 10809…
 * 与其让他去翻软件设置，不如我们扫一遍常见端口告诉他「检测到 127.0.0.1:7897」。
 *
 * 探测较慢（最多 10 个端口 × 400ms 并发 + CONNECT 验证），所以前端要显示 loading。
 */
async function handleDetectProxy(ctx: HandlerCtx): Promise<void> {
  const started = Date.now();
  try {
    const found = await detectProxy();
    const config = configStoreFor(ctx.deps).load();
    sendJson(ctx.res, 200, {
      found: found ?? null,
      elapsedMs: Date.now() - started,
      current: config.proxy ?? { mode: 'system' },
      knownPorts: KNOWN_PROXY_PORTS,
    });
  } catch (error) {
    sendJson(ctx.res, 500, { error: `探测失败：${errorMessage(error)}` });
  }
}

/**
 * POST /api/proxy/test —— 用一个代理（或直连）测试真实连通性。
 *
 * body: { url?: string }  —— 不给 url 就测直连，便于前端做「直连 vs 代理」对比。
 * 测试目标是 Modrinth CDN（国内最容易挂的那个域名）。
 */
async function handleTestProxy(ctx: HandlerCtx): Promise<void> {
  const body = await readJsonBody(ctx.req);
  const rawUrl = typeof body['url'] === 'string' ? body['url'].trim() : '';
  const target =
    typeof body['target'] === 'string' && body['target'].trim() !== ''
      ? body['target'].trim()
      : 'https://cdn.modrinth.com/';

  // 不校验 url 格式：testProxy 内部会 parse，解析不出来就走直连对比，
  // 并把这个事实通过 viaProxy:false 返回给前端，别让用户以为自己测了代理。
  try {
    const result = await testProxy(rawUrl, target);
    sendJson(ctx.res, 200, {
      ...result,
      target,
      ...(rawUrl === '' ? {} : { testedUrl: rawUrl }),
    });
  } catch (error) {
    sendJson(ctx.res, 200, {
      ok: false,
      latencyMs: 0,
      error: errorMessage(error),
      viaProxy: rawUrl !== '',
      target,
    });
  }
}

/** 强制重测（POST /api/mirrors/probe） */
async function handleProbeMirrors(ctx: HandlerCtx): Promise<void> {
  const selector = mirrorSelectorFor(ctx.deps);
  const started = Date.now();
  const all = await selector.refresh();
  sendJson(ctx.res, 200, {
    mirrors: all,
    best: all[0] ?? null,
    elapsedMs: Date.now() - started,
  });
}

// ───────────────────────────── 崩溃分析（infra-dev 追加） ─────────────────────────────

/** 取崩溃分析器（注入的优先） */
function crashAnalyzerFor(deps: ApiDeps): CrashAnalyzerLike {
  return deps.crashAnalyzer ?? new CrashAnalyzer({ dataRoot: deps.dataRoot() });
}

/**
 * GET /api/instances/:instanceId/crash-analysis
 *
 * 读该实例最近的一份崩溃报告并给出结论。
 *
 * 三种结果都是 200：
 *   · 有报告且认出原因 → `{ reportPath, findings:[...], summary }`
 *   · 有报告但没认出   → 同上，findings 里是 kind='unknown' 的兜底项
 *   · 压根没崩过       → `{ findings: [], reason: "..." }`
 * 只有 instanceId 不合法时才 400（那是请求错误，不是业务状态）。
 */
async function handleCrashAnalysis(ctx: HandlerCtx): Promise<void> {
  const instanceId = ctx.params['instanceId'] ?? '';
  if (!isSafeVersionId(instanceId)) {
    sendJson(ctx.res, 400, { error: `实例 id「${instanceId}」含非法字符。` });
    return;
  }

  const analyzer = crashAnalyzerFor(ctx.deps);
  const result = await analyzer.analyzeInstance(instanceId, { dataRoot: ctx.deps.dataRoot() });
  sendJson(ctx.res, 200, {
    instanceId,
    reportPath: result.reportPath ?? null,
    mtimeMs: result.mtimeMs ?? null,
    findings: result.findings,
    summary: summarizeFindings(result.findings),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  });
}

// ───────────────────────────── 启动前体检（preflight 追加） ─────────────────────────────

/**
 * 取体检器（注入的优先）。
 *
 * 每次调用都新建：`PreflightChecker` 内部持有 `VersionRepository`（磁盘缓存）与
 * `SettingsStore`，跨请求共享会串味（例如用户刚在设置里改了内存，旧的仍读缓存）。
 *
 * Java 那一侧传的是 `JavaRuntimeInstaller` 而不是 `JavaAutoProvisioner`：
 * 体检只需要**读清单**判断「能不能自动下」，绝不能走 `ensureJava`（那会真的下载几百 MB）。
 */
function preflightFor(deps: ApiDeps): PreflightCheckerLike {
  if (deps.preflightFactory !== undefined) return deps.preflightFactory();
  const dataRoot = deps.dataRoot();
  return createPreflightChecker({
    dataRoot,
    javaInstaller: createJavaRuntimeInstaller(dataRoot),
  }) as unknown as PreflightCheckerLike;
}

/**
 * 装配一个只读的 `JavaRuntimeInstaller`（体检用）。
 *
 * 它需要 Downloader 才能构造，但体检**从不**调 `ensureRuntime`，所以这个 Downloader
 * 只是一个形状占位：并发 1、重试 1，永远不会被触发（体检只用到
 * `isInstalled` / `installedExecutable` / `majorVersionOf` / `fetchManifest`，全是读操作）。
 */
function createJavaRuntimeInstaller(dataRoot: string): JavaRuntimeInstaller {
  return new JavaRuntimeInstaller({
    downloader: new Downloader({ concurrency: 1, retries: 1 }),
    dataRoot,
  });
}

/**
 * POST /api/preflight  { versionId } → 200 PreflightReport
 *
 * 与其它 POST 不同，这条**同步**返回报告：体检必须快（目标 < 1 秒），
 * 做成后台任务只会让「点启动」多一段无谓轮询。
 *
 * 永远 200（哪怕 canLaunch=false）—— 「体检不通过」是一种业务状态，不是请求错误。
 * 只有 versionId 形状不对时才 400。`instanceId` 已随实例概念一起移除，
 * 老前端带上也只会被忽略。
 */
async function handlePreflight(ctx: HandlerCtx): Promise<void> {
  const body = await readJsonBody(ctx.req);

  const versionId = typeof body['versionId'] === 'string' ? body['versionId'].trim() : '';
  if (versionId.length === 0) {
    sendJson(ctx.res, 400, { error: '缺少 versionId，请求体形如 {"versionId":"1.21"}' });
    return;
  }
  if (!isSafeVersionId(versionId)) {
    sendJson(ctx.res, 400, { error: `版本号「${versionId}」含非法字符。` });
    return;
  }

  const report = await runPreflight(ctx.deps, versionId);
  sendJson(ctx.res, 200, report);
}

/**
 * 跑一次体检；**失败时返回 null 而不是抛错**。
 *
 * 为什么吞错：体检是启动路径上的前置步骤，它自己崩了绝不能连累启动
 * —— 那等于「加了个新功能反而让原来能启动的版本启动不了」。
 * 上层拿到 null 就走「没体检」的老路，并在日志里留一句可排查的话。
 */
async function runPreflight(
  deps: ApiDeps,
  versionId: string,
): Promise<PreflightReportDetail | null> {
  try {
    return await preflightFor(deps).check({ versionId });
  } catch (error) {
    process.emitWarning(`PCL3：启动前体检自身出错，已跳过（不影响启动）：${errorMessage(error)}`);
    return null;
  }
}

/** 体检结论 → 一行可读日志（写进启动任务，用户回看时能看到当时体检说了什么） */
export function preflightLogLines(report: PreflightReport): string[] {
  const lines: string[] = [];
  lines.push(`启动前体检（${String(report.elapsedMs)} ms）：${summarizePreflight(report)}`);
  for (const issue of report.blocking) {
    lines.push(`  ✗ [阻断] ${issue.title}`);
  }
  for (const issue of report.warnings) {
    lines.push(`  ! [警告] ${issue.title}`);
  }
  return lines;
}

// ───────────────────────────── 整合包（.mrpack） ─────────────────────────────

/** 上传的整合包落到系统临时目录下的这个前缀里，绝不直接进数据目录 */
const MODPACK_TMP_PREFIX = 'pcl3-modpack-';

/** 上传体积上限：500 MB（超出直接 413，不读到内存里） */
export const MODPACK_UPLOAD_LIMIT_BYTES = 500 * 1024 * 1024;

/** 进程级「临时整合包」登记表：path → 上传时间。只允许安装这里登记过的路径。 */
const uploadedModpacks = new Map<string, { uploadedAt: number; bytes: number }>();

/** 临时整合包在磁盘上保留多久（毫秒）。超过就删文件，避免 %TEMP% 越积越多。 */
const MODPACK_TMP_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * 删掉一个临时整合包文件及其所在的上传目录。
 *
 * 目录结构是 `<tmp>/pcl3-modpack-<random>/<name>.mrpack`，上传时为每个包建一个
 * 专属目录，所以整个目录可以一起删。
 *
 * 为什么必须删：之前只从内存登记表里移除条目，**磁盘上的文件从来没删过**
 * —— 装完一个整合包就永久留一份几百 MB 在 %TEMP% 里，实测累积了多个
 * `pcl3-modpack-*` 目录。这是真实的空间泄漏。
 */
function discardUploadedModpack(filePath: string): void {
  uploadedModpacks.delete(filePath);

  // 只在「本服务自己建的上传目录」里删，绝不动用户手动放进来的文件
  if (!isTempModpackDir(filePath)) return;

  const dir = path.dirname(filePath);
  void (async () => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉（文件被占用等）不影响业务，下次启动时 TTL 清理会再试 */
    }
  })();
}

/** 登记 + 顺手清理过期条目**和它们的磁盘文件**（4 小时） */
function rememberUploadedModpack(filePath: string, bytes: number): void {
  const now = Date.now();
  for (const [p, meta] of uploadedModpacks) {
    if (now - meta.uploadedAt > MODPACK_TMP_TTL_MS) discardUploadedModpack(p);
  }
  uploadedModpacks.set(filePath, { uploadedAt: now, bytes });
}

/**
 * 只读解析用的安装器。
 *
 * `parse()` 是纯读（不下载、不落盘），所以共享一个实例是安全的；
 * 真正的安装走 `modpackInstallerFor()` 现场装配，避免某次安装的 dataRoot 泄漏到别处。
 */
let inspectInstaller: ModpackInstaller | undefined;

function inspectorFor(): ModpackInstaller {
  if (inspectInstaller === undefined) {
    inspectInstaller = new ModpackInstaller({ downloader: NOOP_DOWNLOADER });
  }
  return inspectInstaller;
}

/**
 * 装配真实的安装器。
 *
 * 三个依赖各用各的实例：`VanillaInstaller` / `LoaderInstaller` 内部都带
 * `VersionRepository` 磁盘缓存，共享会串味（与 loader 路由那边的理由相同）。
 */
export function createRealModpackInstaller(dataRoot: string): ModpackInstaller {
  const downloader = new Downloader({ concurrency: 8, retries: 3 });
  return new ModpackInstaller({
    downloader,
    dataRoot,
    vanillaInstaller: new VanillaInstaller({
      versionRepo: new VersionRepository({ dataRoot }),
      downloader: new Downloader({ concurrency: 8, retries: 3 }),
    }),
    loaderInstaller: new LoaderInstaller({
      versionRepo: new VersionRepository({ dataRoot }),
      downloader: new Downloader({ concurrency: 8, retries: 3 }),
      dataRoot,
    }),
  });
}

/** 整合包安装器工厂（注入点，测试可塞 fake）；类型定义见文件顶部 ApiDeps 附近 */
function modpackInstallerFor(deps: ApiDeps): ModpackInstallerLike {
  return deps.modpackInstallerFactory?.() ?? createRealModpackInstaller(deps.dataRoot());
}

/**
 * 把解析结果摊成前端友好的形状。
 *
 * 为什么不在 API 里直接回 `ModpackParseResult`：那里面有绝对路径（临时目录泄漏到页面没必要），
 * 也有 index 的原始 files 数组（前端只需要数字）。这里只回 UI 真正要用的字段。
 */
function modpackSummary(parsed: ModpackParseResult): Record<string, unknown> {
  const loader = parsed.loader;
  const envCount = { required: 0, optional: 0, unsupported: 0 };
  for (const f of parsed.index.files) {
    const c = f.env?.client;
    if (c === 'required') envCount.required += 1;
    else if (c === 'optional') envCount.optional += 1;
    else if (c === 'unsupported') envCount.unsupported += 1;
  }

  return {
    name: parsed.index.name,
    versionId: parsed.index.versionId,
    ...(parsed.index.summary === undefined ? {} : { summary: parsed.index.summary }),
    formatVersion: parsed.index.formatVersion,
    game: parsed.index.game,
    /** 游戏版本（缺省则是 undefined，前端据此提示「这个包没声明」） */
    gameVersion: parsed.index.dependencies['minecraft'] ?? null,
    dependencies: parsed.index.dependencies,
    /** 整合包文件本身多大 */
    fileSize: parsed.fileSize,
    /** 客户端要下载的总字节数（fileSize 缺失的文件不计入，所以是下限） */
    totalBytes: parsed.totalBytes,
    entryCount: parsed.entryCount,
    files: {
      total: parsed.index.files.length,
      client: parsed.clientFiles.length,
      skipped: parsed.skippedServerFiles.length,
      env: envCount,
    },
    mods: parsed.clientFiles
      .slice(0, 200)
      .map((f) => ({ path: f.path, size: f.fileSize ?? null, client: f.env?.client ?? 'required' })),
    overrides: {
      total: parsed.overrides.length,
      entries: parsed.overrides.slice(0, 200).map((o) => ({ path: o.path, target: o.target, size: o.size })),
    },
    loader: loader === undefined
      ? null
      : {
          raw: loader.raw,
          kind: loader.kind,
          version: loader.version,
          supported: loader.supported,
          label: loader.kind === 'fabric' ? 'Fabric'
            : loader.kind === 'quilt' ? 'Quilt'
            : loader.kind === 'forge' ? 'Forge'
            : 'NeoForge',
        },
  };
}

/**
 * 读一个整合包文件并解析；所有 ModpackError 都折成 HTTP 语义。
 *
 * 用独立实例（只做只读解析，不共享 install 状态）。
 */
async function parseModpackFile(filePath: string): Promise<ModpackParseResult> {
  return new ModpackInstaller({ downloader: NOOP_DOWNLOADER }).parse(filePath);
}

/** 纯解析场景下永远不会被调用的下载器（parse 不下载任何东西） */
const NOOP_DOWNLOADER = {
  downloadAll: (): never => {
    throw new Error('[modpack] 解析阶段不应触发下载');
  },
};

/** 解析结果 → HTTP 响应（成功 200 / 各类失败的人话 + 状态码） */
function sendModpackParseError(res: ServerResponse, error: unknown): void {
  if (error instanceof ModpackError) {
    const status =
      error.code === 'not-found' ? 404
        : error.code === 'unsafe-path' ? 400
        : error.code === 'instance-exists' ? 409
        : 422;
    sendJson(res, status, {
      error: error.message,
      code: error.code,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
    return;
  }
  sendJson(res, 500, { error: `解析整合包失败：${errorMessage(error)}` });
}

/**
 * GET /api/modpack/inspect?path=xxx —— 只解析，不安装。
 *
 * 用途：命令行 / 前端把已有文件丢过来预览；也方便排障（不必走一遍上传）。
 */
async function handleModpackInspect(ctx: HandlerCtx): Promise<void> {
  const raw = (ctx.query.get('path') ?? '').trim();
  if (raw.length === 0) {
    sendJson(ctx.res, 400, { error: '缺少 path 参数，例如 /api/modpack/inspect?path=C:\\packs\\foo.mrpack' });
    return;
  }
  try {
    const parsed = await parseModpackFile(path.resolve(raw));
    sendJson(ctx.res, 200, { ...modpackSummary(parsed), path: parsed.filePath });
  } catch (error) {
    sendModpackParseError(ctx.res, error);
  }
}

/**
 * POST /api/modpack/upload?name=xxx —— 上传 .mrpack（二进制 body）→ { jobId }
 *
 * 设计取舍（三条）：
 *   1. **落临时目录**：上传的文件一律进 `os.tmpdir()/pcl3-modpack-<random>/`，
 *      不进数据目录。数据目录里只应该有安装完成的东西。
 *   2. **边收边写**：超过 500 MB 立刻 413 并删掉半截文件，绝不把整个包读进内存。
 *   3. **返回 jobId**：解析（几千个 zip 条目）也是要花时间的活，走同一套任务面板。
 *      任务结果里带完整的解析摘要，前端据此渲染「确认安装」卡片。
 */
async function handleModpackUpload(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;

  const declared = Number(ctx.req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MODPACK_UPLOAD_LIMIT_BYTES) {
    sendJson(res, 413, {
      error: `文件太大：${formatBytes(declared)}，上限 ${formatBytes(MODPACK_UPLOAD_LIMIT_BYTES)}。`,
      hint: '整合包本体一般不到 100 MB，超大的多半是带了完整游戏文件的非标准包。',
    });
    return;
  }

  const running = deps.jobs.runningOf('modpack');
  if (running !== undefined) {
    sendJson(res, 409, { error: `已经有一个整合包任务在跑（${running.title}），请等它结束。`, jobId: running.id });
    return;
  }

  const rawName = (ctx.query.get('name') ?? '').trim();
  const displayName = rawName.length > 0 ? rawName.slice(0, 120) : 'upload.mrpack';
  // 落盘用的文件名：只留安全字符，真正的「整合包名」以清单里的 name 为准
  const safeFile = `${displayName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'pack'}`.slice(-80);
  const jobId = deps.jobs.create('modpack', `导入整合包 ${displayName}`);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), MODPACK_TMP_PREFIX));
  const dest = path.join(tmpDir, safeFile.endsWith('.mrpack') ? safeFile : `${safeFile}.mrpack`);

  try {
    const bytes = await receiveToFile(ctx.req, dest, MODPACK_UPLOAD_LIMIT_BYTES);
    rememberUploadedModpack(dest, bytes);
    deps.jobs.log(jobId, `已上传 ${displayName}（${formatBytes(bytes)}）到临时目录`);
  } catch (error) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    deps.jobs.fail(jobId, modpackUploadErrorMessage(error));
    sendJson(res, error instanceof HttpError ? error.status : 500, { error: modpackUploadErrorMessage(error), jobId });
    return;
  }

  sendJson(res, 202, { jobId, filePath: dest, name: displayName });

  void runModpackParseJob(deps, jobId, dest, displayName);
}

/** 后台解析上传的文件：任务结果里带完整摘要，前端拿它渲染确认卡片 */
async function runModpackParseJob(deps: ApiDeps, jobId: string, filePath: string, displayName: string): Promise<void> {
  try {
    deps.jobs.progress(jobId, { phase: 'parse', done: 0, total: 1 });
    const parsed = await inspectorFor().parse(filePath);
    const summary = modpackSummary(parsed);

    deps.jobs.log(
      jobId,
      `解析完成：${String(parsed.index.name)} ${String(parsed.index.versionId)}`,
      'info',
    );
    deps.jobs.log(
      jobId,
      `游戏版本 ${String(summary['gameVersion'] ?? '未声明')}；` +
        `客户端文件 ${String(parsed.clientFiles.length)} 个（跳过服务端专用 ${String(parsed.skippedServerFiles.length)} 个）；` +
        `覆盖文件 ${String(parsed.overrides.length)} 个`,
    );
    deps.jobs.progress(jobId, { phase: 'parse', done: 1, total: 1 });
    deps.jobs.succeed(jobId, { ...summary, filePath, displayName });
  } catch (error) {
    deps.jobs.fail(jobId, modpackParseErrorMessage(error));
    // 解析失败说明这个包根本装不了，没必要把它继续留在临时目录里等 TTL 过期。
    // 成功时不删 —— 用户还得点「确认安装」，那时才会用到这个文件。
    discardUploadedModpack(filePath);
  }
}

/**
 * POST /api/modpack/install  body: { filePath, instanceName? } → { jobId }
 *
 * 只接受**本进程上传过的**临时文件路径，或数据目录内的路径：
 * 否则这个接口就成了「给我一个路径，我把它解压到你的磁盘」的任意读取面。
 */
async function handleModpackInstall(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  const body = await readJsonBody(ctx.req);

  const filePathRaw = typeof body['filePath'] === 'string' ? body['filePath'].trim() : '';
  if (filePathRaw.length === 0) {
    sendJson(res, 400, { error: '缺少 filePath，请求体形如 {"filePath":"C:\\\\tmp\\\\pack.mrpack","instanceName":"我的整合包"}' });
    return;
  }
  const filePath = path.resolve(filePathRaw);

  // 信任判据只有两个来源：
  //   ① 本进程上传并登记过的临时文件（uploadedModpacks）
  //   ② 数据目录里的文件（命令行 / 手动放进去的合法场景）
  // 刻意**不**放开「凡是临时目录里的都行」：那样任何路径都能借系统临时目录混过白名单，
  // 这个接口就退化成了「给我一个路径，我把它解压到你的磁盘」。
  const trusted = uploadedModpacks.has(filePath) || isInsideDir(deps.dataRoot(), filePath);
  const stat = await fsp.stat(filePath).catch(() => undefined);
  if (!trusted) {
    sendJson(res, 403, {
      error: '这个路径不是本服务上传的整合包，也不是数据目录里的文件，拒绝安装。',
      hint: MODPACK_TRUST_HINT,
    });
    return;
  }
  if (stat?.isFile() !== true) {
    sendJson(res, 404, { error: `找不到整合包文件：${filePath}` });
    return;
  }

  // 没给实例名就用整合包自己的名字 —— 但名字可能含非法字符，先解析一次拿到 name
  let instanceName = typeof body['instanceName'] === 'string' ? body['instanceName'].trim() : '';

  const running = deps.jobs.runningOf('modpack') ?? deps.jobs.runningOf('install') ?? deps.jobs.runningOf('loaders');
  if (running !== undefined) {
    sendJson(res, 409, {
      error: `已经有一个安装任务在跑（${running.title}），整合包会共用 libraries 目录，等它结束再来。`,
      jobId: running.id,
    });
    return;
  }

  if (instanceName.length === 0) {
    try {
      const parsed = await inspectorFor().parse(filePath);
      instanceName = parsed.index.name;
    } catch (error) {
      sendModpackParseError(res, error);
      return;
    }
  }
  const nameCheck = checkInstanceName(instanceName);
  if (!nameCheck.ok) {
    sendJson(res, 400, { error: `实例名不合法：${nameCheck.reason}`, hint: '换一个不含 \\ / : * ? " < > | 的名字。' });
    return;
  }
  instanceName = nameCheck.id;

  const jobId = deps.jobs.create('modpack', `安装整合包 ${instanceName}`);
  deps.jobs.log(jobId, `开始安装整合包到实例「${instanceName}」`);

  sendJson(res, 202, { jobId, instanceName, filePath });

  void runModpackInstallJob(deps, jobId, filePath, instanceName);
}

const MODPACK_PHASE_LABEL: Record<string, string> = {
  plan: '解析清单',
  parse: '解析清单',
  vanilla: '安装原版',
  loader: '安装加载器',
  mods: '下载 mod 文件',
  overrides: '解压覆盖文件',
  done: '完成',
};

/** 后台装整合包：阶段直接映射到任务面板 */
async function runModpackInstallJob(
  deps: ApiDeps,
  jobId: string,
  filePath: string,
  instanceName: string,
): Promise<void> {
  const installer = modpackInstallerFor(deps);
  try {
    const started = Date.now();
    let lastPhase = '';
    const result = await installer.install(filePath, {
      instanceName,
      onProgress: (p) => {
        deps.jobs.progress(jobId, { phase: p.phase, done: p.done, total: p.total, ...(p.current ? { current: p.current } : {}) });
        if (p.phase !== lastPhase) {
          lastPhase = p.phase;
          const label = MODPACK_PHASE_LABEL[p.phase] ?? p.phase;
          deps.jobs.log(jobId, `阶段：${label}${p.total > 0 ? `（${String(p.total)} 项）` : ''}`);
        }
      },
    });

    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    deps.jobs.log(
      jobId,
      `安装完成：${String(result.stats.files)} 个文件，跳过 ${String(result.stats.skipped)} 个服务端专用文件，` +
        `${String(result.stats.overridden)} 个覆盖文件，耗时约 ${String(seconds)} 秒`,
      'info',
    );
    deps.jobs.succeed(jobId, {
      instanceId: result.instanceId,
      versionId: result.versionId,
      gameVersion: result.gameVersion,
      instanceDir: result.instanceDir,
      ...(result.loader === undefined ? {} : { loader: result.loader }),
      stats: result.stats,
    });
  } catch (error) {
    deps.jobs.fail(jobId, modpackInstallErrorMessage(error));
  } finally {
    // 装完之后就把上传的临时文件删掉。
    //
    // 只删「本服务上传到 <tmp>/pcl3-modpack-*/ 的文件」——用户手动放进数据目录的
    // 整合包不会被碰（discardUploadedModpack 内部会先检查路径）。
    // 失败路径也删：装失败了没必要再留几百 MB 的下一次机会，
    // 用户要重试就该重新上传（上传的也是最新文件）。
    discardUploadedModpack(filePath);
  }
}

/** 整合包相关错误 → 人话（解析阶段也要用） */
export function modpackParseErrorMessage(error: unknown): string {
  if (error instanceof ModpackError) {
    return error.hint === undefined ? error.message : `${error.message}\n${error.hint}`;
  }
  return `解析整合包失败：${errorMessage(error)}`;
}

export function modpackInstallErrorMessage(error: unknown): string {
  if (error instanceof ModpackError) {
    return error.hint === undefined ? error.message : `${error.message}\n${error.hint}`;
  }
  const raw = errorMessage(error);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|aborted|socket hang up/i.test(raw)) {
    return `下载整合包内容时网络中断：${raw}\n检查代理 / 防火墙后重试；已下载并通过校验的文件会被跳过。`;
  }
  if (/ENOSPC/i.test(raw)) return `磁盘空间不足，整合包没能装完：${raw}`;
  if (/EACCES|EPERM/i.test(raw)) return `没有写入权限，整合包没能装完：请检查数据目录权限。`;
  if (/原版 .* 还没安装|请先执行/.test(raw)) return raw;
  return `安装整合包失败：${raw}`;
}

function modpackUploadErrorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  const raw = errorMessage(error);
  if (/ENOSPC/i.test(raw)) return `磁盘空间不足，上传没能完成：${raw}`;
  if (/EACCES|EPERM/i.test(raw)) return `没有写入权限，无法把上传内容落到临时目录：${raw}`;
  return `上传整合包失败：${raw}`;
}

/**
 * 把请求体流式写进文件，超限立刻中止。
 *
 * 为什么不用 `readJsonBody`：那个上限是 64 KB 且整段进内存；
 * 500 MB 的整合包必须边收边写。
 */
async function receiveToFile(req: IncomingMessage, dest: string, limit: number): Promise<number> {
  const handle = await fsp.open(dest, 'w');
  let received = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      received += buf.byteLength;
      if (received > limit) {
        throw new HttpError(413, `文件超过上限 ${formatBytes(limit)}，已中止上传。`);
      }
      await handle.write(buf);
    }
  } finally {
    await handle.close();
  }
  if (received === 0) {
    await fsp.rm(dest, { force: true }).catch(() => undefined);
    throw new HttpError(400, '上传内容为空：请选择 .mrpack 文件后重试。');
  }
  return received;
}

/** candidate 是否在 dir 内（含等于） */
function isInsideDir(dir: string, candidate: string): boolean {
  const root = path.resolve(dir);
  const target = path.resolve(candidate);
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 是否落在本服务创建的临时整合包目录里（`<tmp>/pcl3-modpack-xxxx/...`）——仅用于日志与排障提示 */
function isTempModpackDir(candidate: string): boolean {
  const tmp = path.resolve(os.tmpdir());
  const target = path.resolve(candidate);
  if (!isInsideDir(tmp, target)) return false;
  const rel = path.relative(tmp, target).split(path.sep)[0] ?? '';
  return rel.startsWith(MODPACK_TMP_PREFIX);
}

/** 给 403 那份错误提示用：如实说明白名单只有两种来源 */
const MODPACK_TRUST_HINT =
  '请通过「导入整合包」上传文件（上传后会登记在本进程内）；命令行场景请先把包放进数据目录。';

// ───────────────────────────── 资源包 / 数据包 / 光影包 ─────────────────────────────

/**
 * 本节只做**本地**资源的安装与管理：把文件放进正确的目录、改扩展名启停、删掉。
 * 不做远程搜索（那是 modrinth 模块的事），也不碰模组。
 *
 * 三个 URL 形态里最容易写错的是「数据包的目标存档」：它既可能来自 query（GET/DELETE），
 * 也可能来自 body（POST），所以统一走 `resolvePackTarget` 收口。
 */

/** 上传上限：与 core/packs 的 MAX_PACK_BYTES 同源，避免两处各写一个数 */
export const PACK_UPLOAD_LIMIT_BYTES = MAX_PACK_BYTES;

/** 一次上传 / 下载安装都会开一个任务；同类任务不互斥（用户可能连点三个包），只限制数量 */
const MAX_CONCURRENT_PACK_JOBS = 3;

/** multipart 边界上限：防止有人发一个 1 MB 的 boundary 把请求头撑爆 */
const MAX_MULTIPART_BOUNDARY = 200;

/** 包管理器工厂：注入点优先（测试），否则按当前 dataRoot 现场装配 */
function packManagerFor(deps: ApiDeps): PackManagerLike {
  return deps.packManagerFactory?.() ?? new PackManager({ dataRoot: deps.dataRoot() });
}

/** 从 query / body 里解析出安装目标；非法就抛 HttpError(400) */
function resolvePackTarget(
  rawKind: unknown,
  rawSave: unknown,
  defaultKind?: PackKind,
): { kind: PackKind; saveName?: string } {
  const kind = rawKind === undefined || rawKind === null || rawKind === ''
    ? defaultKind
    : parsePackKind(rawKind);
  if (kind === undefined) {
    throw new HttpError(
      400,
      `kind 只接受 resourcepack / datapack / shader，收到「${String(rawKind ?? '')}」。`,
    );
  }

  const save = typeof rawSave === 'string' ? rawSave.trim() : '';
  if (save.length === 0) return { kind };
  if (kind !== 'datapack') {
    // 非数据包带 saveName：按「忽略」处理，而不是拒绝 —— 前端切存档时会把 save 一起带上
    return { kind };
  }
  const problem = checkSaveName(save);
  if (problem !== null) throw new HttpError(400, `存档名不合法：${problem}`);
  return { kind, saveName: save };
}

/** query 里取第一个非空值（URLSearchParams.get 已返回首个，这里只做 trim） */
function queryValue(query: URLSearchParams, key: string): string {
  return (query.get(key) ?? '').trim();
}

/** core/packs 的异常 → HTTP 语义 */
function sendPackError(res: ServerResponse, error: unknown): void {
  if (error instanceof PackValidationError) {
    sendJson(res, 400, { error: error.message, field: error.field });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  const raw = errorMessage(error);
  if (/ENOENT/.test(raw)) {
    sendJson(res, 404, { error: `找不到文件：${raw}` });
    return;
  }
  if (/ENOSPC/i.test(raw)) {
    sendJson(res, 507, { error: `磁盘空间不足：${raw}` });
    return;
  }
  if (/EACCES|EPERM/i.test(raw)) {
    sendJson(res, 403, { error: `没有写入权限，请检查数据目录权限：${raw}` });
    return;
  }
  sendJson(res, 500, { error: raw });
}

/** 校验 instanceId（它会拼进路径，必须在最外层先挡一次） */
function requireInstanceId(ctx: HandlerCtx): string {
  const id = ctx.params['instanceId'] ?? '';
  const problem = checkInstanceId(id);
  if (problem !== null) throw new HttpError(400, problem);
  return id;
}

/**
 * GET /api/instances/:instanceId/packs?kind=resourcepack[&save=存档名]
 *
 * 顺带把「当前实例有哪些存档」一起返回：前端切到「数据包」标签时要立刻渲染存档下拉，
 * 多打一个请求不值得。
 */
async function handleListPacks(ctx: HandlerCtx): Promise<void> {
  const instanceId = requireInstanceId(ctx);
  const { kind, saveName } = resolvePackTarget(queryValue(ctx.query, 'kind'), queryValue(ctx.query, 'save'));

  const mgr = packManagerFor(ctx.deps);
  const [packs, saves] = await Promise.all([
    mgr.list(instanceId, kind, saveName),
    kind === 'datapack' ? mgr.listSaves(instanceId).catch(() => []) : Promise.resolve([]),
  ]);

  sendJson(ctx.res, 200, {
    instanceId,
    kind,
    kindLabel: PACK_KIND_LABEL[kind],
    /** 数据包当前作用的存档；没传 = 全局 datapacks/ */
    saveName: saveName ?? null,
    dir: mgr.targetDir(instanceId, kind, saveName),
    total: packs.length,
    packs: packs.map((p) => ({
      filename: p.filename,
      kind: p.kind,
      size: p.size,
      enabled: p.enabled,
      packFormat: p.packFormat ?? null,
      packFormatRange: p.packFormatRange ?? null,
      description: p.description ?? null,
      hasShaders: p.hasShaders ?? null,
      mcmetaError: p.mcmetaError ?? null,
      modifiedAt: p.modifiedAt,
    })),
    saves,
  });
}

/**
 * GET /api/instances/:instanceId/saves
 *
 * 只返回含 level.dat 的目录（契约口径）。`dir` 方便用户确认自己到底在看哪个实例。
 */
async function handleListSaves(ctx: HandlerCtx): Promise<void> {
  const instanceId = requireInstanceId(ctx);
  const mgr = packManagerFor(ctx.deps);
  const saves = await mgr.listSaves(instanceId);
  sendJson(ctx.res, 200, {
    instanceId,
    dir: path.join(mgr.instanceDir(instanceId), 'saves'),
    total: saves.length,
    saves,
  });
}

/**
 * POST /api/instances/:instanceId/packs/install
 * body: { kind, url, filename, sha1?, saveName? } → 202 { jobId }
 *
 * 立刻回 jobId：包可能几十 MB，走与安装/启动同一套任务面板。
 * 下载本身交给 core/packs → download 模块的 Downloader（并发/重试/镜像/续传都在那边）。
 */
async function handlePackInstall(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  const instanceId = requireInstanceId(ctx);
  const body = await readJsonBody(ctx.req);

  const { kind, saveName } = resolvePackTarget(body['kind'], body['saveName']);

  const url = typeof body['url'] === 'string' ? body['url'].trim() : '';
  if (url.length === 0) {
    sendJson(res, 400, {
      error: '缺少 url。请求体形如 {"kind":"resourcepack","url":"https://…/pack.zip","filename":"pack.zip"}',
      hint: '本地文件请走 POST /api/instances/:id/packs/upload（表单上传）。',
    });
    return;
  }

  const filenameRaw = typeof body['filename'] === 'string' ? body['filename'].trim() : '';
  const filename = filenameRaw.length > 0 ? filenameRaw : sanitizeFilename(url);
  const nameProblem = checkFilename(filename);
  if (nameProblem !== null) {
    sendJson(res, 400, { error: `文件名不合法：${nameProblem}` });
    return;
  }
  if (!filename.toLowerCase().endsWith('.zip')) {
    sendJson(res, 400, { error: `只接受 .zip 文件，收到「${filename}」。` });
    return;
  }

  const running = deps.jobs.list().filter((j) => j.kind === 'packs' && j.status === 'running');
  if (running.length >= MAX_CONCURRENT_PACK_JOBS) {
    sendJson(res, 409, {
      error: `同时最多 ${String(MAX_CONCURRENT_PACK_JOBS)} 个资源包任务，等前面的装完再试。`,
      jobId: running[0]?.id,
    });
    return;
  }

  const label = PACK_KIND_LABEL[kind];
  const jobId = deps.jobs.create('packs', `安装${label} ${filename}`);
  deps.jobs.log(jobId, `开始下载${label}：${url}`);
  sendJson(res, 202, { jobId, kind, filename, saveName: saveName ?? null });

  void runPackInstallJob(
    deps,
    jobId,
    {
      instanceId,
      kind,
      task: {
        url,
        filename,
        ...(typeof body['sha1'] === 'string' && body['sha1'].trim().length > 0 ? { sha1: body['sha1'].trim() } : {}),
      },
      ...(saveName === undefined ? {} : { saveName }),
    },
  );
}

/** 后台下载安装 */
async function runPackInstallJob(
  deps: ApiDeps,
  jobId: string,
  args: {
    instanceId: string;
    kind: PackKind;
    task: { url: string; filename: string; sha1?: string };
    saveName?: string;
  },
): Promise<void> {
  const label = PACK_KIND_LABEL[args.kind];
  try {
    deps.jobs.progress(jobId, { phase: 'download', done: 0, total: 0 });
    const mgr = packManagerFor(deps);
    const target = mgr.targetDir(args.instanceId, args.kind, args.saveName);
    deps.jobs.log(jobId, `目标目录：${target}`);

    const dest = await mgr.installFromUrl(args.instanceId, args.kind, args.task, {
      ...(args.saveName === undefined ? {} : { saveName: args.saveName }),
      onProgress: (p) => {
        deps.jobs.progress(jobId, {
          phase: 'download',
          done: p.done,
          total: p.total,
          ...(p.total > 0 ? { current: `${formatBytes(p.done)} / ${formatBytes(p.total)}` } : {}),
        });
      },
    });

    deps.jobs.progress(jobId, { phase: 'done', done: 1, total: 1 });
    deps.jobs.log(jobId, `已安装${label}：${path.basename(dest)}`, 'info');
    deps.jobs.succeed(jobId, {
      instanceId: args.instanceId,
      kind: args.kind,
      filename: path.basename(dest),
      path: dest,
      saveName: args.saveName ?? null,
    });
  } catch (error) {
    deps.jobs.fail(jobId, `安装${label}失败：${errorMessage(error)}`);
  }
}

/**
 * POST /api/instances/:instanceId/packs/upload?kind=&filename=&saveName=  → 201 { pack }
 *
 * 接受两种请求体（契约允许的那两种）：
 *   - `multipart/form-data`：浏览器 `<input type="file">` + `FormData` 的原生形态
 *   - 直接二进制：`Content-Type: application/octet-stream`（或空）body 就是文件内容
 *
 * 注意：server.ts 的「写操作必须 JSON」只针对 `/api/*` 且 Content-Type 不是 multipart 的 POST，
 * 这一条是给上传专门放行的例外（见 server.ts 里的 UPLOAD_PATHS 注释）。
 */
async function handlePackUpload(ctx: HandlerCtx): Promise<void> {
  const instanceId = requireInstanceId(ctx);
  const rawQueryKind = queryValue(ctx.query, 'kind');
  const rawQuerySave = queryValue(ctx.query, 'saveName') || queryValue(ctx.query, 'save');

  const contentType = String(ctx.req.headers['content-type'] ?? '').toLowerCase();
  const limit = PACK_UPLOAD_LIMIT_BYTES;

  const declared = Number(ctx.req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    sendJson(ctx.res, 413, {
      error: `文件太大：${formatBytes(declared)}，上限 ${formatBytes(limit)}。`,
      hint: '正常的光影包 / 资源包都在 100 MB 以内。',
    });
    return;
  }

  if (contentType.startsWith('multipart/form-data')) {
    const boundary = multipartBoundary(contentType);
    if (boundary === null) {
      sendJson(ctx.res, 400, { error: 'multipart 请求缺少 boundary，浏览器不会发这种请求。' });
      return;
    }
    const bodyBuf = await readBodyBuffer(ctx.req, limit);

    let parsed: { fields: Record<string, string>; file?: { filename: string; data: Buffer } };
    try {
      parsed = parseMultipart(bodyBuf, boundary);
    } catch (error) {
      sendJson(ctx.res, error instanceof HttpError ? error.status : 400, { error: errorMessage(error) });
      return;
    }
    if (parsed.file === undefined) {
      sendJson(ctx.res, 400, { error: 'multipart 里没有文件字段（字段名任意，但必须带 filename）。' });
      return;
    }

    // 字段可以覆盖 query（浏览器 FormData 更自然）
    const kindRaw = parsed.fields['kind'] ?? rawQueryKind;
    const saveRaw = parsed.fields['saveName'] ?? parsed.fields['save'] ?? rawQuerySave;
    await finishPackUpload(ctx, instanceId, kindRaw, saveRaw, parsed.file.filename, parsed.file.data);
    return;
  }

  // 直接二进制
  const fallbackName = queryValue(ctx.query, 'filename');
  const bodyBuf = await readBodyBuffer(ctx.req, limit);
  const filename = fallbackName.length > 0 ? fallbackName : sanitizeFilename('pack.zip');
  await finishPackUpload(ctx, instanceId, rawQueryKind, rawQuerySave, filename, bodyBuf);
}

/** 上传落盘的公共尾巴：解析目标 → 写入 → 回元数据 */
async function finishPackUpload(
  ctx: HandlerCtx,
  instanceId: string,
  rawKind: unknown,
  rawSave: unknown,
  rawFilename: string,
  data: Buffer,
): Promise<void> {
  let target: { kind: PackKind; saveName?: string };
  try {
    target = resolvePackTarget(rawKind, rawSave);
  } catch (error) {
    sendJson(ctx.res, error instanceof HttpError ? error.status : 400, { error: errorMessage(error) });
    return;
  }

  const mgr = packManagerFor(ctx.deps);
  try {
    const result = await mgr.uploadAndDescribe(instanceId, target.kind, data, {
      filename: sanitizeFilename(rawFilename),
      ...(target.saveName === undefined ? {} : { saveName: target.saveName }),
    });
    sendJson(ctx.res, 201, {
      instanceId,
      kind: target.kind,
      saveName: target.saveName ?? null,
      filename: result.filename,
      size: result.size,
      pack: {
        filename: result.pack.filename,
        kind: result.pack.kind,
        size: result.pack.size,
        enabled: result.pack.enabled,
        packFormat: result.pack.packFormat ?? null,
        description: result.pack.description ?? null,
        hasShaders: result.pack.hasShaders ?? null,
        mcmetaError: result.pack.mcmetaError ?? null,
      },
      /** 上传不阻止不认识的文件，但如实提示「游戏可能不认它」 */
      warning: uploadWarning(target.kind, result.pack.mcmetaError, result.pack.hasShaders),
    });
  } catch (error) {
    sendPackError(ctx.res, error);
  }
}

/** 上传后的软提示（不是错误，所以不让请求失败） */
function uploadWarning(kind: PackKind, mcmetaError: string | undefined, hasShaders: boolean | undefined): string | null {
  if (kind === 'shader') {
    return hasShaders === true ? null : '这个 zip 里没有 shaders/ 目录，游戏不会把它当光影包。';
  }
  return mcmetaError === undefined ? null : `已保存，但游戏可能不认：${mcmetaError}`;
}

/**
 * POST /api/instances/:instanceId/packs/:filename/toggle
 * body: { kind, enabled, saveName? }
 */
async function handlePackToggle(ctx: HandlerCtx): Promise<void> {
  const instanceId = requireInstanceId(ctx);
  const filename = decodePathSegment(ctx.params['filename'] ?? '');

  const nameProblem = checkFilename(filename);
  if (nameProblem !== null) {
    sendJson(ctx.res, 400, { error: `文件名不合法：${nameProblem}` });
    return;
  }

  const body = await readJsonBody(ctx.req);
  const enabled = body['enabled'];
  if (typeof enabled !== 'boolean') {
    sendJson(ctx.res, 400, { error: '缺少 enabled（true / false）。' });
    return;
  }

  let target: { kind: PackKind; saveName?: string };
  try {
    target = resolvePackTarget(body['kind'], body['saveName']);
  } catch (error) {
    sendJson(ctx.res, error instanceof HttpError ? error.status : 400, { error: errorMessage(error) });
    return;
  }

  const mgr = packManagerFor(ctx.deps);
  try {
    await mgr.setEnabled(instanceId, target.kind, filename, enabled, target.saveName);
  } catch (error) {
    sendPackError(ctx.res, error);
    return;
  }

  // 回最新列表项，前端不用再拉一次
  const list = await mgr.list(instanceId, target.kind, target.saveName).catch(() => []);
  const found = list.find((p) => p.filename === enabledNameOf(filename));
  sendJson(ctx.res, 200, {
    instanceId,
    kind: target.kind,
    filename: enabledNameOf(filename),
    enabled,
    saveName: target.saveName ?? null,
    pack: found ?? null,
  });
}

/**
 * DELETE /api/instances/:instanceId/packs/:filename?kind=&saveName=
 *
 * 幂等：文件已经不在也回 200（`{ removed: false }`），但会如实说明，
 * 免得前端以为「点了没反应」。
 */
async function handlePackDelete(ctx: HandlerCtx): Promise<void> {
  const instanceId = requireInstanceId(ctx);
  const filename = decodePathSegment(ctx.params['filename'] ?? '');

  const nameProblem = checkFilename(filename);
  if (nameProblem !== null) {
    sendJson(ctx.res, 400, { error: `文件名不合法：${nameProblem}` });
    return;
  }

  let target: { kind: PackKind; saveName?: string };
  try {
    target = resolvePackTarget(queryValue(ctx.query, 'kind'), queryValue(ctx.query, 'saveName') || queryValue(ctx.query, 'save'));
  } catch (error) {
    sendJson(ctx.res, error instanceof HttpError ? error.status : 400, { error: errorMessage(error) });
    return;
  }

  const mgr = packManagerFor(ctx.deps);
  try {
    await mgr.remove(instanceId, target.kind, filename, target.saveName);
  } catch (error) {
    if (error instanceof PackValidationError) {
      // 不存在 = 幂等成功（但告诉调用方确实没删到东西）
      sendJson(ctx.res, 200, { instanceId, kind: target.kind, filename, removed: false, detail: error.message });
      return;
    }
    sendPackError(ctx.res, error);
    return;
  }

  sendJson(ctx.res, 200, {
    instanceId,
    kind: target.kind,
    filename: enabledNameOf(filename),
    saveName: target.saveName ?? null,
    removed: true,
  });
}

/**
 * 路径里的文件名解码。
 *
 * 路由里已 `decodeURIComponent` 过一次，但 `%252e%252e` 这类双重编码会在那次之后
 * 还原成 `%2e%2e`，再解一次就变成 `..`。所以这里**不**再解码，只做一次防御性替换：
 * 把整体错误的百分号序列当成字面量（反正合法文件名里不该有 `%` 序列之外的怪东西）。
 */
function decodePathSegment(raw: string): string {
  const text = raw.trim();
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 从 `multipart/form-data; boundary=xxx` 里取 boundary */
function multipartBoundary(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const raw = match?.[1] ?? match?.[2];
  if (raw === undefined || raw.length === 0 || raw.length > MAX_MULTIPART_BOUNDARY) return null;
  return raw;
}

/**
 * 把请求体读进内存（有上限）。
 * 包文件必须整体进内存做 zip 解析，所以不走流式写盘 —— 但上限是按包的合理体积定的。
 */
async function readBodyBuffer(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.byteLength;
    if (size > limit) {
      throw new HttpError(413, `上传内容超过上限 ${formatBytes(limit)}，已中止。`);
    }
    chunks.push(buf);
  }
  if (size === 0) throw new HttpError(400, '上传内容为空。');
  return Buffer.concat(chunks);
}

/**
 * 解析 multipart/form-data。
 *
 * 自己写而不是引第三方库（项目零依赖原则）：
 *   - 按 `--boundary` 切分，逐段取头部（`name="x"` / `filename="y"`）
 *   - 只认第一个带 filename 的部分作为文件
 *   - 其它部分当普通字段（kind / saveName 走这里）
 *
 * 被切出来的数据段末尾会多一个 CRLF，必须按段头声明裁掉——否则 zip 尾部的 EOCD
 * 后面多了两个字节，某些严格的解压工具会报「中央目录偏移错误」。
 */
export function parseMultipart(
  body: Buffer,
  boundary: string,
): { fields: Record<string, string>; file?: { filename: string; data: Buffer } } {
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const fields: Record<string, string> = {};
  let file: { filename: string; data: Buffer } | undefined;

  let cursor = body.indexOf(delimiter);
  if (cursor < 0) throw new HttpError(400, 'multipart 请求体里找不到 boundary 分隔符。');

  while (cursor >= 0) {
    let start = cursor + delimiter.length;
    // 分隔符后面要么是 `--`（结束），要么是 CRLF
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;

    const next = body.indexOf(delimiter, start);
    if (next < 0) break;
    let end = next;
    // 段与分隔符之间的 CRLF 属于分隔符，不属于内容
    if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;

    const part = body.subarray(start, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const filenameMatch = /filename\*?=(?:"([^"]*)"|([^;\r\n]+))/i.exec(headerText);
      const fieldName = nameMatch?.[1] ?? '';

      const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2];
      if (filenameRaw !== undefined) {
        if (file === undefined && content.byteLength > 0) {
          file = { filename: decodeHeaderText(filenameRaw.trim()), data: Buffer.from(content) };
        }
      } else if (fieldName.length > 0) {
        fields[fieldName] = content.toString('utf8');
      }
    }

    cursor = next;
  }

  return file === undefined ? { fields } : { fields, file };
}

/** 表头里可能有 UTF-8 百分号编码（中文文件名），能解就解 */
function decodeHeaderText(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
// ───────────────────────────── 内容源（Modrinth）+ 模组管理 ─────────────────────────────

/**
 * 本节的主线只有一条：
 *
 *   搜索 / 看详情（远程，Modrinth）
 *     → POST /api/content/install 建任务（挑版本 → 下载到 <instance>/mods/）
 *     → GET  /api/jobs/:id 看进度（与安装原版完全同一套任务面板）
 *     → GET  /api/instances/:id/mods 列表 / toggle 启停 / DELETE 删除（纯本地）
 *
 * 三个刻意的取舍：
 *   1. 搜索**不缓存**（实时性优先），项目详情由 `ModrinthClient` 内部缓存 5 分钟。
 *   2. 安装走 `ModManager.install()`（它内部复用 download 模块的 Downloader），
 *      这一层只负责「挑哪个版本 + 建任务 + 报错翻译人话」。
 *   3. 错误一律给人话：`ModrinthError.kind` 决定 HTTP 状态码
 *      （网络 502 / 项目不存在 404 / 参数 400），前端据此决定要不要建议换网络。
 */

/** 一次搜索最多返回多少条（服务端上限 100，UI 也用不了更多） */
const CONTENT_SEARCH_MAX_LIMIT = 50;

/** 同时最多几个模组安装任务（与资源包同一口径：不互斥，但限数量） */
const MAX_CONCURRENT_MOD_JOBS = 3;

/** 模组安装进度上报的最小间隔（毫秒）：几百 KB 的 jar 会刷很多次，没必要每次都写任务表 */
const MOD_PROGRESS_MIN_INTERVAL_MS = 120;

/** 取 Modrinth 客户端（测试注入优先） */
function modrinthFor(deps: ApiDeps): ModrinthClientLike {
  return deps.modrinthFactory?.() ?? new ModrinthClient();
}

/** 取模组管理器（测试注入优先） */
function modManagerFor(deps: ApiDeps): ModManagerLike {
  return deps.modManagerFactory?.() ?? new ModManager({ dataRoot: deps.dataRoot() });
}

/** `ModrinthError` → HTTP 语义（人话 + 可选的 hint） */
function sendModrinthError(res: ServerResponse, error: unknown): void {
  if (error instanceof ModrinthError) {
    const status =
      error.kind === 'network' ? 502
        : error.kind === 'not-found' ? 404
        : error.kind === 'invalid' ? 400
        : error.kind === 'http' && error.status === 429 ? 429
        : 502;
    sendJson(res, status, {
      error: error.message,
      kind: error.kind,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.status === undefined ? {} : { upstreamStatus: error.status }),
    });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  sendJson(res, 502, { error: `访问 Modrinth 失败：${errorMessage(error)}` });
}

/** `ModValidationError` / 文件系统错误 → HTTP 语义 */
function sendModError(res: ServerResponse, error: unknown): void {
  if (error instanceof ModValidationError) {
    sendJson(res, 400, { error: error.message, field: error.field });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  const raw = errorMessage(error);
  if (/ENOENT/.test(raw)) {
    sendJson(res, 404, { error: `找不到文件：${raw}` });
    return;
  }
  if (/ENOSPC/i.test(raw)) {
    sendJson(res, 507, { error: `磁盘空间不足：${raw}` });
    return;
  }
  if (/EACCES|EPERM/i.test(raw)) {
    sendJson(res, 403, { error: `没有写入权限，请检查数据目录权限：${raw}` });
    return;
  }
  sendJson(res, 500, { error: raw });
}

/** 搜索结果 / 项目详情的统一出口形状（前端只认这几种字段） */
function summaryForResponse(p: ProjectSummary | ProjectDetail): Record<string, unknown> {
  const detail = p as ProjectDetail;
  return {
    slug: p.slug,
    title: p.title,
    description: p.description,
    iconUrl: p.iconUrl ?? null,
    downloads: p.downloads,
    projectType: p.projectType,
    categories: p.categories,
    latestGameVersions: p.latestGameVersions,
    // Modrinth 页面的绝对地址：前端「在 Modrinth 打开」用它
    modrinthUrl: `https://modrinth.com/${p.projectType}/${p.slug}`,
    ...(detail.id === undefined ? {} : { id: detail.id }),
    ...(detail.follows === undefined ? {} : { follows: detail.follows }),
    ...(detail.gameVersions === undefined ? {} : { gameVersions: detail.gameVersions }),
    ...(detail.loaders === undefined ? {} : { loaders: detail.loaders }),
    ...(detail.body === undefined ? {} : { body: detail.body }),
    // 外链（作者填的）。前端据此渲染「官网 / Wiki」按钮，缺哪个就少哪个按钮。
    ...(detail.sourceUrl === undefined ? {} : { sourceUrl: detail.sourceUrl }),
    ...(detail.wikiUrl === undefined ? {} : { wikiUrl: detail.wikiUrl }),
    ...(detail.issuesUrl === undefined ? {} : { issuesUrl: detail.issuesUrl }),
    ...(detail.discordUrl === undefined ? {} : { discordUrl: detail.discordUrl }),
    /**
     * MC 百科（mcmod.cn）的**搜索页**地址。
     *
     * 为什么给搜索页而不是详情页：mcmod 没有公开 API，也没有稳定的
     * slug ↔ mod 名映射表。搜 `中文名` 或 `英文名` 都能落到结果页，
     * 比猜一个可能 404 的详情链接靠谱。
     */
    mcmodSearchUrl: `https://search.mcmod.cn/s?key=${encodeURIComponent(p.title)}`,
  };
}

/**
 * GET /api/content/search?q=&type=mod&gameVersion=1.21&loader=fabric&limit=20&offset=0
 *
 * `type` 缺省是 mod；传空串 / `all` 表示不按类型过滤。
 * 搜不到东西不是错误：返回空数组 + totalHits 0，让 UI 自己说「没有结果」。
 */
async function handleContentSearch(ctx: HandlerCtx): Promise<void> {
  const rawType = queryValue(ctx.query, 'type');
  const skipType = rawType === '' || rawType === 'all';
  const type = skipType ? undefined : parseProjectType(rawType);
  if (!skipType && type === undefined) {
    sendJson(ctx.res, 400, {
      error: `type 只接受 mod / resourcepack / shader / datapack / modpack（或留空 / all），收到「${rawType}」。`,
    });
    return;
  }

  const limit = clampInt(Number(ctx.query.get('limit') ?? NaN), 1, CONTENT_SEARCH_MAX_LIMIT, 20);
  const offset = clampInt(Number(ctx.query.get('offset') ?? NaN), 0, 10_000, 0);
  const gameVersion = queryValue(ctx.query, 'gameVersion');
  const loader = queryValue(ctx.query, 'loader');
  const sortBy = queryValue(ctx.query, 'sortBy');

  const options: SearchOptions = {
    query: queryValue(ctx.query, 'q'),
    limit,
    offset,
    ...(type === undefined ? {} : { projectType: type }),
    ...(gameVersion === '' ? {} : { gameVersion }),
    ...(loader === '' ? {} : { loader }),
    ...(sortBy === '' ? {} : { sortBy }),
  };

  try {
    const result = await modrinthFor(ctx.deps).search(options);
    sendJson(ctx.res, 200, {
      query: options.query,
      projectType: options.projectType ?? null,
      limit,
      offset,
      totalHits: result.totalHits,
      shown: result.hits.length,
      hits: result.hits.map((h) => summaryForResponse(h)),
    });
  } catch (error) {
    sendModrinthError(ctx.res, error);
  }
}

/** GET /api/content/project/:slug —— 项目详情（含 README body），5 分钟缓存 */
async function handleContentProject(ctx: HandlerCtx): Promise<void> {
  const slug = ctx.params['slug'] ?? '';
  try {
    const detail = await modrinthFor(ctx.deps).getProject(slug);
    sendJson(ctx.res, 200, summaryForResponse(detail));
  } catch (error) {
    sendModrinthError(ctx.res, error);
  }
}

/** GET /api/content/project/:slug/versions?gameVersion=&loader= */
async function handleContentVersions(ctx: HandlerCtx): Promise<void> {
  const slug = ctx.params['slug'] ?? '';
  const gameVersion = queryValue(ctx.query, 'gameVersion');
  const loader = queryValue(ctx.query, 'loader');

  try {
    const versions = await modrinthFor(ctx.deps).listVersions(slug, {
      ...(gameVersion === '' ? {} : { gameVersion }),
      ...(loader === '' ? {} : { loader }),
    });
    sendJson(ctx.res, 200, {
      slug,
      gameVersion: gameVersion === '' ? null : gameVersion,
      loader: loader === '' ? null : loader,
      total: versions.length,
      versions: versions.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        gameVersions: v.gameVersions,
        loaders: v.loaders,
        datePublished: v.datePublished,
        dependencies: v.dependencies,
        files: v.files,
      })),
    });
  } catch (error) {
    sendModrinthError(ctx.res, error);
  }
}

/**
 * GET /api/content/:slug/dependencies?versionId=&gameVersion=&loader=
 *
 * 安装前的依赖预检：告诉前端「装这个还需要什么」，且每一项都带**可安装信息**
 * （slug / title / 挑好的版本号 / 文件大小），前端据此渲染成「一键装上前置」清单。
 *
 * 为什么不把这些塞进 install 的响应里：用户点「安装」之前就该看到依赖，
 * 而不是装完了才被告知「你还缺 X」。这里做成独立预检，前端在弹窗里先查。
 *
 * 挑版本策略与 install 完全一致（同一个 `pickBestVersion`），保证预检里说
 * 「Sodium mc1.21-0.6.jar」时，点下去装的就是那个文件。
 */
async function handleContentDependencies(ctx: HandlerCtx): Promise<void> {
  const slug = ctx.params['slug'] ?? '';
  const versionId = queryValue(ctx.query, 'versionId');
  const gameVersion = queryValue(ctx.query, 'gameVersion');
  const loader = queryValue(ctx.query, 'loader');

  if (slug === '') {
    sendJson(ctx.res, 400, { error: '缺少项目短名（slug）。' });
    return;
  }

  const client = modrinthFor(ctx.deps);

  try {
    // 1) 先找出这个项目「要装的那个版本」——与 install 同一套挑法
    const versions = await client.listVersions(slug, {
      ...(gameVersion === '' ? {} : { gameVersion }),
      ...(loader === '' ? {} : { loader }),
    });
    const picked = client.pickBestVersion(versions, {
      gameVersion,
      ...(loader === '' ? {} : { loader }),
    });
    if (picked === undefined) {
      sendJson(ctx.res, 404, {
        error: `「${slug}」没有适配${gameVersion === '' ? '' : ` ${gameVersion}`}${loader === '' ? '' : ` ${loader}`} 的版本，无法解析依赖。`,
      });
      return;
    }

    const required = picked.dependencies.filter((d) => d.dependencyType === 'required');
    const optional = picked.dependencies.filter((d) => d.dependencyType === 'optional');

    // 2) 已装模组：判断哪些依赖「已经有了」，前端就不用催用户装
    const installedIds = new Set<string>();
    if (versionId !== '') {
      try {
        const mods = await modManagerFor(ctx.deps).list(versionId);
        for (const m of mods) {
          if (typeof m.id === 'string' && m.id !== '') installedIds.add(m.id.toLowerCase());
        }
      } catch {
        /* 读不到 mods 就当没装任何东西 —— 宁可多提示，也不要漏提示 */
      }
    }

    // 3) 逐个把依赖 id 解析成可安装条目
    const describe = async (
      dep: { projectId?: string; versionId?: string },
    ): Promise<Record<string, unknown> | undefined> => {
      const projectKey = dep.projectId ?? '';
      if (projectKey === '') return undefined;
      try {
        const project = await client.getProject(projectKey);
        const depVersions = await client.listVersions(project.slug, {
          ...(gameVersion === '' ? {} : { gameVersion }),
          ...(loader === '' ? {} : { loader }),
        });
        const depPicked = client.pickBestVersion(depVersions, {
          gameVersion,
          ...(loader === '' ? {} : { loader }),
        });
        const primary = depPicked?.files.find((f) => f.primary) ?? depPicked?.files[0];

        return {
          id: projectKey,
          slug: project.slug,
          title: project.title,
          description: project.description,
          iconUrl: project.iconUrl ?? null,
          /** 已经装在同名 mods 目录里（按 mod id 匹配） */
          installed:
            installedIds.has(project.slug.toLowerCase()) ||
            installedIds.has(project.title.toLowerCase()),
          /** 能不能一键装：挑不到适配版本就不能 */
          installable: depPicked !== undefined,
          ...(depPicked === undefined
            ? {}
            : {
                versionId: depPicked.id,
                versionNumber: depPicked.versionNumber,
                gameVersions: depPicked.gameVersions,
              }),
          ...(primary === undefined
            ? {}
            : { filename: primary.filename, fileSize: primary.size }),
          /** 点一下直接装：前端拿这个原样 POST /api/content/install */
          installBody: {
            slug: project.slug,
            ...(gameVersion === '' ? {} : { gameVersion }),
            ...(loader === '' ? {} : { loader }),
            ...(depPicked === undefined ? {} : { version: depPicked.id }),
          },
        };
      } catch {
        // 单个依赖查不到不该让整个预检失败 —— 退回「只知道 id」的形态
        return {
          id: projectKey,
          slug: '',
          title: projectKey,
          description: '',
          installed: false,
          installable: false,
        };
      }
    };

    const [requiredDetails, optionalDetails] = await Promise.all([
      Promise.all(required.map((d) => describe(d))),
      Promise.all(optional.map((d) => describe(d))),
    ]);

    sendJson(ctx.res, 200, {
      slug,
      /** 本次解析用的是哪个版本 */
      pickedVersion: {
        id: picked.id,
        versionNumber: picked.versionNumber,
        gameVersions: picked.gameVersions,
        loaders: picked.loaders,
      },
      required: requiredDetails.filter((d) => d !== undefined),
      optional: optionalDetails.filter((d) => d !== undefined),
      /** 未满足的必装依赖数（前端据此决定是否拦一道） */
      missingRequired: requiredDetails.filter(
        (d) => d !== undefined && d['installed'] !== true,
      ).length,
    });
  } catch (error) {
    sendModrinthError(ctx.res, error);
  }
}

/**
 * POST /api/content/install  body: { versionId, slug, gameVersion?, loader?, version?, instanceId? } → 202 { jobId }
 *
 * 目标身份（实例概念取消后）：
 *   - 主参数是 `versionId`：**装到哪个版本**，就是 `<dataRoot>/instances/<versionId>/mods/`。
 *   - 老的 `instanceId` 仍然接受，当作 `versionId` 的别名 —— 内容页（mods.js）历史上就是这么传的。
 *     两个都缺 → 400，并明确写出「请写明要装到哪个版本」，不再让人猜。
 *   - 响应里同时回 `versionId` 与 `instanceId`（同值），老前端读哪个都对。
 *
 * 挑版本的规则全在 `pickBestVersion`（纯函数，有独立测试）：
 *   - 给了 version（Modrinth 上的版本 id）→ 必须精确存在，否则 404（不偷偷换成别的版本）
 *   - 没给 → 按「这个版本能不能跑」去挑：gameVersion / loader 从版本目录里的版本 JSON 推
 *   - 挑不到 → 409 + 人话，绝不塞一个不匹配的 jar 进去
 *
 * ── 关于依赖 ──
 * 安装**不会**自动把依赖一起装。原因：
 *   1. 依赖可能是另一个 mod 的子集冲突源（自动装了两个都要 OptiFine 的，反而更难排查）
 *   2. 几百 MB 的连锁下载用户没有预期
 * 所以这里只**如实报告**依赖，由前端展示成「可一键安装」的清单
 * （`GET /api/content/:slug/dependencies` 提供预检数据）。
 */
async function handleContentInstall(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  const body = await readJsonBody(ctx.req);

  const rawVersionId = typeof body['versionId'] === 'string' ? body['versionId'].trim() : '';
  const rawInstanceId = typeof body['instanceId'] === 'string' ? body['instanceId'].trim() : '';
  const targetVersionId = rawVersionId !== '' ? rawVersionId : rawInstanceId;
  if (targetVersionId.length === 0) {
    sendJson(res, 400, {
      error: '缺少 versionId（要装到哪个版本），请求体形如 {"versionId":"fabric-loader-0.16.9-1.21","slug":"sodium"}',
    });
    return;
  }
  const idProblem = checkInstanceId(targetVersionId);
  if (idProblem !== null) {
    sendJson(res, 400, { error: idProblem });
    return;
  }

  const slug = typeof body['slug'] === 'string' ? body['slug'].trim() : '';
  if (slug.length === 0) {
    sendJson(res, 400, { error: '缺少 slug（Modrinth 项目短名，例如 sodium）。' });
    return;
  }

  const requestedPackVersion = typeof body['version'] === 'string' ? body['version'].trim() : '';
  const requestedGameVersion = typeof body['gameVersion'] === 'string' ? body['gameVersion'].trim() : '';
  const requestedLoader = typeof body['loader'] === 'string' ? body['loader'].trim() : '';

  // 同一版本 + 同一项目正在装：不重复起任务（连点两下不该下两遍）
  const runningMods = deps.jobs.list().filter((j) => j.kind === 'mods' && j.status === 'running');
  const busy = runningMods.find(
    (j) => j.result?.['instanceId'] === targetVersionId && j.result?.['slug'] === slug,
  );
  if (busy !== undefined) {
    sendJson(res, 409, { error: `「${slug}」正在装到 ${targetVersionId} 里，等它装完。`, jobId: busy.id });
    return;
  }
  if (runningMods.length >= MAX_CONCURRENT_MOD_JOBS) {
    sendJson(res, 409, {
      error: `同时最多 ${String(MAX_CONCURRENT_MOD_JOBS)} 个模组安装任务，等前面的装完再试。`,
      jobId: runningMods[0]?.id,
    });
    return;
  }

  const client = modrinthFor(deps);
  const instanceDir = instanceDirOf(deps.dataRoot(), targetVersionId);
  const instanceStat = await fsp.stat(instanceDir).catch(() => undefined);

  const target = await resolveInstallTarget(deps, client, {
    instanceId: targetVersionId,
    slug,
    requestedVersionId: requestedPackVersion,
    gameVersion: requestedGameVersion,
    loader: requestedLoader,
    instanceExists: instanceStat?.isDirectory() === true,
  });
  if ('error' in target) {
    sendJson(res, target.status, {
      error: target.error,
      ...(target.hint === undefined ? {} : { hint: target.hint }),
    });
    return;
  }

  const file = target.file;
  const jobId = deps.jobs.create('mods', `安装 ${target.title} ${target.version.versionNumber}`);
  deps.jobs.log(jobId, `项目：${slug}（${target.title}）`);
  deps.jobs.log(jobId, `版本：${target.version.versionNumber}（${target.version.id}）`);
  const condition = [target.gameVersion, target.loader].filter((x) => x !== '').join(' / ');
  deps.jobs.log(jobId, `目标版本：${targetVersionId}${condition === '' ? '' : `（${condition}）`}`);
  deps.jobs.log(jobId, `文件：${file.filename}（${formatBytes(file.size)}）`);

  sendJson(res, 202, {
    jobId,
    /** 老字段名，值等于 versionId（mods.js 现在两种都认） */
    instanceId: targetVersionId,
    versionId: targetVersionId,
    /** Modrinth 侧被选中的那个文件版本 id（与「装到哪个游戏版本」是两件事） */
    packVersionId: target.version.id,
    slug,
    title: target.title,
    versionNumber: target.version.versionNumber,
    filename: file.filename,
    gameVersion: target.gameVersion === '' ? null : target.gameVersion,
    loader: target.loader === '' ? null : target.loader,
    /** 这个版本还依赖哪些项目（必装依赖，前端可以据此提示「还需要 X」） */
    requiredDependencies: target.version.dependencies
      .filter((d) => d.dependencyType === 'required')
      .map((d) => d.projectId ?? d.versionId ?? ''),
    /**
     * 依赖的**人类可读形式**，供前端直接展示。
     *
     * 为什么另给一份：`requiredDependencies` 里是 `AANobbMI` 这种项目 id，
     * 用户看了也不知道是什么。这里顺手查一次 Modrinth 把标题补上；
     * 查不到就退回 id（宁可显示 id，也不要因为网络问题让整条提示消失）。
     *
     * 查询失败**不影响安装**：这里整体包在 try 里，拿不到就返回空名称。
     */
    requiredDependencyDetails: await describeDependencies(
      modrinthFor(deps),
      target.version.dependencies.filter((d) => d.dependencyType === 'required'),
    ),
  });

  void runModInstallJob(deps, jobId, { instanceId: targetVersionId, slug, title: target.title, file });
}

/**
 * 把依赖 id 解析成 `{ id, title, slug }`。
 *
 * 只对 `required` 的依赖调用，通常 0~2 个，最多并发查这么几次，
 * 不会拖慢安装（本来就要等网络）。
 */
async function describeDependencies(
  client: ModrinthClientLike,
  deps: readonly { projectId?: string; versionId?: string; dependencyType: string }[],
): Promise<{ id: string; title: string; slug?: string }[]> {
  const ids = deps.map((d) => d.projectId ?? d.versionId ?? '').filter((s) => s !== '');
  if (ids.length === 0) return [];

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const project = await client.getProject(id);
        return project === undefined
          ? { id, title: id }
          : { id, title: project.title !== '' ? project.title : id, ...(project.slug !== '' ? { slug: project.slug } : {}) };
      } catch {
        // 查不到就只给 id —— 提示仍然有用，只是不够好看
        return { id, title: id };
      }
    }),
  );
  return results;
}

type InstallTargetResult =
  | {
      title: string;
      version: ProjectVersion;
      file: { url: string; filename: string; size: number; sha1?: string };
      gameVersion: string;
      loader: string;
    }
  | { status: number; error: string; hint?: string };

/**
 * 决定「装哪个版本的哪个文件」。
 *
 * 优先级：显式 versionId > 实例推导出的 (gameVersion, loader) > 不过滤。
 * 一旦推导出了过滤条件却挑不到版本，就如实失败 —— 不硬凑。
 */
async function resolveInstallTarget(
  deps: ApiDeps,
  client: ModrinthClientLike,
  args: {
    instanceId: string;
    slug: string;
    requestedVersionId: string;
    gameVersion: string;
    loader: string;
    instanceExists: boolean;
  },
): Promise<InstallTargetResult> {
  let detail: ProjectDetail;
  try {
    detail = await client.getProject(args.slug);
  } catch (error) {
    if (error instanceof ModrinthError) {
      return {
        status: error.kind === 'not-found' ? 404 : error.kind === 'invalid' ? 400 : 502,
        error: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      };
    }
    return { status: 502, error: `获取项目信息失败：${errorMessage(error)}` };
  }

  const inferred = inferInstanceTarget(deps, args.instanceId);
  const gameVersion = args.gameVersion !== '' ? args.gameVersion : inferred.gameVersion;
  const loader = args.loader !== '' ? args.loader : inferred.loader;

  let versions: ProjectVersion[];
  try {
    versions = await client.listVersions(args.slug, {
      ...(gameVersion === '' ? {} : { gameVersion }),
      ...(loader === '' ? {} : { loader }),
    });
  } catch (error) {
    if (error instanceof ModrinthError) {
      return { status: 502, error: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }) };
    }
    return { status: 502, error: `获取版本列表失败：${errorMessage(error)}` };
  }

  // 显式指定版本：必须精确命中，不允许「近似匹配」
  if (args.requestedVersionId !== '') {
    const exact = versions.find((v) => v.id === args.requestedVersionId);
    if (exact === undefined) {
      const condition = [gameVersion, loader].filter((x) => x !== '').join(' / ');
      return {
        status: 404,
        error: `项目「${args.slug}」里没有版本 ${args.requestedVersionId}${condition === '' ? '' : `（过滤条件：${condition}）`}。`,
        hint: '先用 GET /api/content/project/:slug/versions 看看有哪些版本。',
      };
    }
    const picked = pickInstallFile(exact);
    if (picked === undefined) {
      return { status: 409, error: `版本 ${exact.versionNumber} 没有可下载的文件。` };
    }
    return { title: detail.title, version: exact, file: picked, gameVersion, loader };
  }

  if (versions.length === 0) {
    const condition = [gameVersion, loader].filter((x) => x !== '').join(' / ');
    // 原版实例（认不出加载器）是另一种失败，提示要具体
    if (loader === '' && args.loader === '') {
      return {
        status: 409,
        error: `实例「${args.instanceId}」看起来是原版（没装模组加载器），装不了模组。`,
        hint: '先在版本卡片上点「装模组加载器」（Fabric / Quilt），再回来装模组。',
      };
    }
    if (condition === '') return { status: 409, error: `项目「${args.slug}」还没有发布任何版本。` };
    return {
      status: 409,
      error: `项目「${args.slug}」没有适配 ${condition} 的版本。`,
      hint: '换一个游戏版本或加载器，或去 Modrinth 项目页看看它支持什么。',
    };
  }

  const best = client.pickBestVersion(versions, {
    gameVersion,
    ...(loader === '' ? {} : { loader }),
  });
  if (best === undefined) {
    const condition = [gameVersion, loader].filter((x) => x !== '').join(' / ');
    return {
      status: 409,
      error: `项目「${args.slug}」没有能在本实例里用的版本${condition === '' ? '' : `（${condition}）`}。`,
      hint: gameVersion === '' ? '请先在实例设置里指定游戏版本。' : '换一个游戏版本或加载器再试。',
    };
  }

  const file = pickInstallFile(best);
  if (file === undefined) {
    return { status: 409, error: `挑中的版本 ${best.versionNumber} 没有可下载的文件。` };
  }
  return { title: detail.title, version: best, file, gameVersion, loader };
}

/**
 * 从实例目录推断「这个实例跑的是什么」：
 *   - loader：从 `fabric-loader-<ver>-<game>` / `quilt-loader-…` 形状里认（与版本卡片同一口径）
 *   - gameVersion：优先版本 JSON 的 `inheritsFrom`（加载器 profile），其次实例 id 本身
 *
 * 全部同步读很小的文件；读不到就如实返回空串，不猜。
 */
function inferInstanceTarget(
  deps: ApiDeps,
  instanceId: string,
): { gameVersion: string; loader: string } {
  const dataRoot = deps.dataRoot();

  const fromId = identifyLoaderProfile(instanceId);
  if (fromId !== undefined && fromId.gameVersion !== undefined) {
    return { gameVersion: fromId.gameVersion, loader: fromId.kind ?? '' };
  }

  for (const versionId of [instanceId]) {
    if (!isSafeVersionId(versionId)) continue;
    const file = path.join(dataRoot, 'versions', versionId, `${versionId}.json`);
    const text = readSmallFileSync(file);
    if (text === undefined) continue;
    try {
      const parsed = JSON.parse(text) as { id?: unknown; inheritsFrom?: unknown };
      const inherits = typeof parsed.inheritsFrom === 'string' ? parsed.inheritsFrom : '';
      const self = typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : versionId;
      const loaderInfo = identifyLoaderProfile(self);
      return {
        gameVersion: inherits !== '' ? inherits : self,
        loader: loaderInfo?.kind ?? '',
      };
    } catch {
      /* 坏 JSON：继续往下走 */
    }
  }

  // 认不出加载器：把实例 id 当游戏版本用（很多用户直接用 1.21 当实例名）
  return { gameVersion: instanceId, loader: '' };
}

/** 读一个小文本文件；不存在 / 不是文件 / 太大 → undefined（不抛） */
function readSmallFileSync(file: string): string | undefined {
  try {
    const stat = fsSync.statSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return undefined;
    return fsSync.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** 从版本里挑要下载的那个文件：优先 primary，其次第一个 */
function pickInstallFile(
  version: ProjectVersion,
): { url: string; filename: string; size: number; sha1?: string } | undefined {
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (file === undefined) return undefined;
  return {
    url: file.url,
    filename: file.filename,
    size: file.size,
    ...(file.sha1 === undefined ? {} : { sha1: file.sha1 }),
  };
}

/** 后台下载安装一个模组文件 */
async function runModInstallJob(
  deps: ApiDeps,
  jobId: string,
  args: {
    instanceId: string;
    slug: string;
    title: string;
    file: { url: string; filename: string; size: number; sha1?: string };
  },
): Promise<void> {
  try {
    const mgr = modManagerFor(deps);
    const dir = mgr.modsDir(args.instanceId);
    deps.jobs.log(jobId, `目标目录：${dir}`);
    deps.jobs.progress(jobId, { phase: 'download', done: 0, total: args.file.size });

    let lastEmit = 0;
    const dest = await mgr.install(
      args.instanceId,
      {
        url: args.file.url,
        filename: args.file.filename,
        ...(args.file.sha1 === undefined ? {} : { sha1: args.file.sha1 }),
      },
      (p) => {
        const now = Date.now();
        // 收尾那次一定要发（done >= total），其余按间隔节流
        const isFinal = p.total > 0 && p.done >= p.total;
        if (!isFinal && now - lastEmit < MOD_PROGRESS_MIN_INTERVAL_MS) return;
        lastEmit = now;
        deps.jobs.progress(jobId, {
          phase: 'download',
          done: p.done,
          total: p.total,
          ...(p.total > 0 ? { current: `${formatBytes(p.done)} / ${formatBytes(p.total)}` } : {}),
        });
      },
    );

    deps.jobs.progress(jobId, { phase: 'done', done: 1, total: 1 });
    deps.jobs.log(jobId, `已安装：${path.basename(dest)}`, 'info');
    deps.jobs.succeed(jobId, {
      instanceId: args.instanceId,
      slug: args.slug,
      title: args.title,
      filename: path.basename(dest),
      path: dest,
    });
  } catch (error) {
    deps.jobs.fail(jobId, friendlyModInstallError(error, args.title));
  }
}

/** 模组安装失败 → 人话（网络 / 磁盘 / 权限 / 校验） */
export function friendlyModInstallError(error: unknown, title: string): string {
  if (error instanceof ModValidationError) return error.message;
  const raw = errorMessage(error);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|aborted|socket hang up/i.test(raw)) {
    return `下载「${title}」时网络中断：${raw}\n检查代理 / 防火墙后重试；已下完的文件不会被重复下载。`;
  }
  if (/sha1 mismatch/i.test(raw)) {
    return `「${title}」下载完成但校验失败（文件不完整或被篡改），已丢弃：${raw}`;
  }
  if (/ENOSPC/i.test(raw)) return `磁盘空间不足，装「${title}」失败：${raw}`;
  if (/EACCES|EPERM/i.test(raw)) return `没有写入权限，装「${title}」失败：请检查数据目录权限。`;
  return `安装「${title}」失败：${raw}`;
}

/**
 * GET /api/instances/:instanceId/mods
 *
 * 顺带给一个 `dir`：用户点「打开文件夹」时不用再猜路径。
 * 目录不存在不是错误（新实例），返回空数组 + dirExists:false。
 */
async function handleListMods(ctx: HandlerCtx): Promise<void> {
  const instanceId = requireInstanceId(ctx);
  const mgr = modManagerFor(ctx.deps);

  const mods = await mgr.list(instanceId);
  const dir = mgr.modsDir(instanceId);
  const exists = await fsp.stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );

  sendJson(ctx.res, 200, {
    instanceId,
    dir,
    /** 目录还不存在 = 这个实例从来没装过模组（正常状态） */
    dirExists: exists,
    total: mods.length,
    enabledCount: mods.filter((m) => m.enabled).length,
    mods: mods.map((m) => ({
      filename: m.filename,
      id: m.id ?? null,
      name: m.name ?? null,
      version: m.version ?? null,
      size: m.size,
      enabled: m.enabled,
      modifiedAt: m.modifiedAt ?? null,
      metaSource: m.metaSource ?? null,
      metaError: m.metaError ?? null,
    })),
  });
}

/**
 * POST /api/instances/:instanceId/mods/:filename/toggle  body: { enabled: boolean }
 *
 * 禁用 = 把 `foo.jar` 改名成 `foo.jar.disabled`（Minecraft 只加载 .jar）。
 * 幂等：已经是目标状态就返回 200，不做任何事。
 */
async function handleModToggle(ctx: HandlerCtx): Promise<void> {
  const instanceId = requireInstanceId(ctx);
  const filename = ctx.params['filename'] ?? '';
  const body = await readJsonBody(ctx.req);

  const enabled = body['enabled'];
  if (typeof enabled !== 'boolean') {
    sendJson(ctx.res, 400, { error: '缺少 enabled（true / false），例如 {"enabled":false}' });
    return;
  }

  const mgr = modManagerFor(ctx.deps);
  try {
    await mgr.setEnabled(instanceId, filename, enabled);
  } catch (error) {
    sendModError(ctx.res, error);
    return;
  }

  const base = enabledNameOf(filename);
  sendJson(ctx.res, 200, {
    instanceId,
    filename: base,
    enabled,
    diskName: `${base}${enabled ? '' : '.disabled'}`,
    dir: mgr.modsDir(instanceId),
  });
}

/** DELETE /api/instances/:instanceId/mods/:filename —— 启用态与禁用态都删 */
async function handleModDelete(ctx: HandlerCtx): Promise<void> {
  const instanceId = requireInstanceId(ctx);
  const filename = ctx.params['filename'] ?? '';
  const mgr = modManagerFor(ctx.deps);

  try {
    await mgr.remove(instanceId, filename);
  } catch (error) {
    sendModError(ctx.res, error);
    return;
  }

  sendJson(ctx.res, 200, { instanceId, filename: enabledNameOf(filename), deleted: true });
}

// ───────────────────────────── 账户 ─────────────────────────────

async function handleAccounts(ctx: HandlerCtx): Promise<void> {
  const store = loadAccounts(ctx.deps.dataRoot());
  sendJson(ctx.res, 200, {
    accounts: store.accounts.map((a) => ({
      type: a.type,
      username: a.username,
      uuid: a.uuid,
      // 令牌一律不回吐，前端也用不上
    })),
  });
}

async function handleOfflineAccount(ctx: HandlerCtx): Promise<void> {
  const body = await readJsonBody(ctx.req);
  const raw = typeof body['username'] === 'string' ? body['username'].trim() : '';
  if (raw.length === 0) {
    sendJson(ctx.res, 400, { error: '请填写玩家名（1~16 个字符，建议用英文/数字/下划线）。' });
    return;
  }

  let account: Account;
  try {
    account = offlineAccount(raw);
  } catch (error) {
    sendJson(ctx.res, 400, { error: errorMessage(error) });
    return;
  }

  const dataRoot = ctx.deps.dataRoot();
  try {
    // 复用 auth 模块的存储层：字段校验、原子写、0o600 权限都在那边
    upsertAccount(account, dataRoot);
  } catch (error) {
    sendJson(ctx.res, 500, { error: `保存离线账户失败：${errorMessage(error)}` });
    return;
  }

  const list = loadAccounts(dataRoot).accounts;
  sendJson(ctx.res, 201, {
    account: { type: account.type, username: account.username, uuid: account.uuid },
    count: list.length,
  });
}

/** GIF/渐进条用：把「不知道总量」的进度折算成展示用百分比 */
function progressPercent(done: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

// ───────────────────────────── GET /api/java ─────────────────────────────

interface JavaProbeResult {
  found: boolean;
  path?: string;
  home?: string;
  majorVersion?: number;
  detail: string;
  /** 这次是按哪个 Java 大版本去查的 */
  requiredMajor: number;
  /** 数据目录下找到的全部候选 */
  candidates: JavaLookup[];
}

/**
 * 检测本机 Java。
 *
 * 只用 launch 模块的 `findJavaInDataRoot`（按契约），**不依赖**正在并行开发的 java 自动下载模块。
 * 找不到就如实说「未安装」，不猜、不伪造。
 */
export async function detectJava(dataRoot: string, latestRelease: string | null): Promise<JavaProbeResult> {
  const javaRoot = path.join(dataRoot, 'java');

  // 1) 拿「当前最新版本要求哪个 Java」，拿不到就按 8 兜底
  let requiredMajor = 8;
  if (latestRelease !== null) {
    try {
      const repo = new VersionRepository({ dataRoot });
      const json = await repo.fetchVersion(latestRelease);
      const major = json.javaVersion?.majorVersion;
      if (typeof major === 'number' && major > 0) requiredMajor = major;
    } catch {
      /* 离线：按 Java 8 查一次，下面 detail 里说明 */
    }
  }

  // 2) 按契约用 findJavaInDataRoot 查
  const candidates = findJavaInDataRoot(dataRoot, { majorVersion: requiredMajor });

  if (candidates.length > 0) {
    const first = candidates[0] as JavaLookup;
    return {
      found: true,
      home: first.javaHome,
      path: javaExecutable(first.javaHome),
      ...(first.majorVersion === null ? {} : { majorVersion: first.majorVersion }),
      detail: `数据目录内已找到 Java ${String(first.majorVersion ?? '?')}（要求 ≥ ${String(requiredMajor)}）`,
      requiredMajor,
      candidates,
    };
  }

  // 3) 目录里没有任何 JRE → 如实返回未安装
  const hasJavaDir = await fsp
    .readdir(javaRoot, { withFileTypes: true })
    .then((entries) => entries.length > 0)
    .catch(() => false);

  const nested = hasJavaDir ? await scanForJavaHomes(javaRoot) : [];

  return {
    found: false,
    detail: hasJavaDir
      ? `java 目录里没有满足要求的运行时（需要 Java ${String(requiredMajor)}+${nested.length > 0 ? `，发现 ${String(nested.length)} 个版本不匹配的候选` : ''}）。可以手动把 JRE 放到 ${javaRoot} 下。`
      : `未安装：${javaRoot} 下还没有 Java 运行时。把 JRE 解压到该目录，或等待自动下载功能上线。`,
    requiredMajor,
    candidates: [],
  };
}

/** 兜底扫描：列出目录里长得像 java home 的路径（只为给用户提示，不参与选择） */
async function scanForJavaHomes(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length >= 20) return;
    if (isJavaHome(dir)) {
      found.push(dir);
      return;
    }
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

/** GET /api/java：检测本机 Java，找不到就如实说未安装 */
async function handleJava(ctx: HandlerCtx): Promise<void> {
  const { deps } = ctx;
  const dataRoot = deps.dataRoot();

  let latestRelease: string | null = null;
  try {
    latestRelease = (await deps.versionRepo.fetchManifest()).latest.release;
  } catch {
    /* 离线：detectJava 内部会按 Java 8 兜底并说明 */
  }

  const probe = await detectJava(dataRoot, latestRelease);
  sendJson(ctx.res, 200, {
    found: probe.found,
    path: probe.path ?? null,
    home: probe.home ?? null,
    majorVersion: probe.majorVersion ?? null,
    requiredMajor: probe.requiredMajor,
    detail: probe.detail,
    javaRoot: path.join(dataRoot, 'java'),
    candidates: probe.candidates.map((c) => ({ javaHome: c.javaHome, majorVersion: c.majorVersion })),
  });
}

// ───────────────────────────── HTTP 工具 ─────────────────────────────

/** 统一 JSON 响应（附带 no-store，防止浏览器缓存住进度） */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text, 'utf8')),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/** 读 JSON 请求体；非法 JSON 抛 400 语义的错误 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `请求体过大（上限 ${String(MAX_BODY_BYTES)} 字节）。`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON，请检查格式（Content-Type: application/json）。');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象。');
  }
  return parsed as Record<string, unknown>;
}

/** 带状态码的业务异常 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 取错误的人类可读信息（绝不返回 "[object Object]"） */
export function errorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message.length > 0) {
      return `${error.message}（${cause.message}）`;
    }
    return error.message || error.name;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// ───────────────────────────── 安全工具 ─────────────────────────────

/** 版本号白名单：只允许字母数字和 . _ - +（官方 id 就这些字符） */
export function isSafeVersionId(id: string): boolean {
  if (id.length === 0 || id.length > 64) return false;
  if (id === '.' || id === '..') return false;
  return /^[A-Za-z0-9._+-]+$/.test(id);
}

/**
 * Origin / Referer 同源校验。
 *
 * 目标：挡住「恶意网页跨站打你本地 37421 端口」。
 *   - 两个头都没有 → 放行（curl / 测试 / 同页 fetch 的某些场景本来就不带）
 *   - 有 Origin：必须是本机回环 + 相同端口
 *   - 只有 Referer：同样按来源判定
 */
export function checkOrigin(
  req: IncomingMessage,
  expectedPort: number,
  allowLoopbackAnyPort = false,
): { ok: true } | { ok: false; reason: string } {
  const origin = headerValue(req.headers['origin']);
  const referer = headerValue(req.headers['referer']);
  const selfOrigin = headerValue(req.headers['sec-fetch-site']);

  const checkUrl = (raw: string): { ok: true } | { ok: false; reason: string } => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, reason: `来源地址无法解析：${raw}` };
    }
    const host = parsed.hostname.toLowerCase();
    const isLoopback = LOOPBACK_HOSTS.has(host) || host === '127.0.0.1';
    if (!isLoopback) {
      return { ok: false, reason: '只接受本机页面发起的请求（跨站请求已被拒绝）。' };
    }
    const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
    if (!allowLoopbackAnyPort && port !== expectedPort) {
      return { ok: false, reason: `来源端口 ${String(port)} 与本地服务端口 ${String(expectedPort)} 不一致。` };
    }
    return { ok: true };
  };

  if (origin !== undefined && origin !== 'null') {
    const result = checkUrl(origin);
    if (!result.ok) return result;
    return { ok: true };
  }
  if (referer !== undefined) {
    const result = checkUrl(referer);
    if (!result.ok) return result;
    return { ok: true };
  }
  // 明确标记为跨站却又不给来源头 → 拒
  if (selfOrigin === 'cross-site') {
    return { ok: false, reason: '检测到跨站请求，已拒绝。' };
  }
  return { ok: true };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

// ───────────────────────────── 杂项工具 ─────────────────────────────

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 人类可读的字节数 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[i] as string}`;
}

/** 判断某个路径是不是一个 JRE 目录（转发 launch 模块的实现，供 CLI/测试复用） */
export { isJavaHome, javaExecutable } from '../core/launch/index.js';

// ═════════════════════════ 基础便利功能（shell 模块 / ux-dev 追加） ═════════════════════════
//
// 用户原话：「一些方便的基础功能也不能缺少，比如下载位置自定义，打开游戏文件夹，
// mod 文件夹之类的，这些都没有」。
//
// 本节只做四件事，全部是「只读 + 一个动作」，不碰安装 / 启动 / 设置任何既有逻辑：
//   GET  /api/instances/:instanceId/folders/:kind        列目录内容
//   POST /api/instances/:instanceId/folders/:kind/open   交给系统文件管理器打开
//   GET  /api/instances/:instanceId/paths                该实例全部关键路径
//   GET  /api/instances/:instanceId/launch-args          完整启动命令行（令牌已打码）
//
// `POST .../open` 是整个项目里**唯一会在用户桌面上弹出窗口**的接口，
// 所以它单独加了「环回地址 + 非代理转发」的二次校验（见 assertDirectLoopback）。
// 其余三条只读接口沿用 server.ts 的全局 Origin 同源校验即可。

/** 列目录一次最多给多少条（与 FolderService 的 listLimit 同源，避免两处各写一个数） */
const FOLDER_LIST_LIMIT = 500;

/** 命令预览用的固定用户名（不是真账户，不写磁盘） */
const PREVIEW_USERNAME = 'PCL3-Preview';

/** 文件夹服务：优先注入的工厂，否则按当前 dataRoot 现场装配 */
function folderServiceFor(deps: ApiDeps): FolderService {
  const factory = deps.folderServiceFactory;
  if (factory !== undefined) return factory(deps.dataRoot());
  return new FolderService({ dataRoot: deps.dataRoot(), listLimit: FOLDER_LIST_LIMIT });
}

/** FolderAccessError / 文件系统错误 → HTTP 语义 */
function sendFolderError(res: ServerResponse, error: unknown): void {
  if (error instanceof FolderAccessError) {
    switch (error.code) {
      case 'bad-instance':
      case 'bad-kind':
        sendJson(res, 400, { error: error.message, code: error.code });
        return;
      case 'outside':
        // 越界不是「参数没写对」，是有人试图穿越 —— 403 才是诚实的
        sendJson(res, 403, { error: error.message, code: error.code });
        return;
      case 'not-found':
        sendJson(res, 404, { error: error.message, code: error.code });
        return;
      default:
        sendJson(res, 400, { error: error.message });
        return;
    }
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  const raw = errorMessage(error);
  if (/ENOENT/.test(raw)) {
    sendJson(res, 404, { error: `目录不存在：${raw}` });
    return;
  }
  if (/EACCES|EPERM/i.test(raw)) {
    sendJson(res, 403, { error: `没有访问权限：${raw}` });
    return;
  }
  if (/ENOSPC|ENOTDIR|EINVAL/i.test(raw)) {
    sendJson(res, 400, { error: raw });
    return;
  }
  sendJson(res, 500, { error: raw });
}

/** 解出 instanceId + kind；任一不合法都抛 FolderAccessError（由 sendFolderError 映射） */
function folderTargetOf(ctx: HandlerCtx): { instanceId: string; kind: FolderKind } {
  const instanceId = ctx.params['instanceId'] ?? '';
  // URL 层已经 decode 过一次；这里再挡一遍空字节（%00 解码后就是 \0）
  if (instanceId.includes('\u0000')) {
    throw new FolderAccessError('bad-instance', '实例 id 里不能有空字节。');
  }
  const kind = parseFolderKind(ctx.params['kind'] ?? '');
  return { instanceId, kind };
}

/**
 * GET /api/instances/:instanceId/folders/:kind
 *
 * 列目录内容。`dataRoot` 也是合法 kind —— 设置页要显示数据根里有什么。
 *
 * 返回里带 `path` 与中文 `label`：前端要显示「资源包（E:\PCL3\instances\1.21\resourcepacks）」，
 * 一次请求就够，不必再打一次 /paths。
 */
async function handleFolderList(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  let target: { instanceId: string; kind: FolderKind };
  try {
    target = folderTargetOf(ctx);
  } catch (error) {
    sendFolderError(res, error);
    return;
  }

  const service = folderServiceFor(deps);
  try {
    const dir = await service.resolve(target.instanceId, target.kind);
    const entries = await service.list(target.instanceId, target.kind);
    sendJson(res, 200, {
      instanceId: target.instanceId,
      kind: target.kind,
      label: FOLDER_LABEL_CN[target.kind],
      path: dir,
      entries: entries.map((e: FolderEntry) => ({
        name: e.name,
        size: e.size,
        isDir: e.isDir,
        mtime: e.mtime,
      })),
      /** 条目数达到上限时，前端要如实说「只显示前 N 项」 */
      truncated: entries.length >= FOLDER_LIST_LIMIT,
      limit: FOLDER_LIST_LIMIT,
    });
  } catch (error) {
    sendFolderError(res, error);
  }
}

/**
 * POST /api/instances/:instanceId/folders/:kind/open
 *
 * 在系统文件管理器里打开目录。
 *
 * 三道闸，任何一道不过都不执行：
 *   1. **全局 Origin 同源校验**（server.ts 的 /api/* 前置检查，已挡掉跨站网页）；
 *   2. **必须直连且来自环回地址** —— `assertDirectLoopback`。
 *      服务只监听 127.0.0.1，但「谁在你机器上点这个按钮」仍值得分辨：
 *      请求若经代理转发（X-Forwarded-For / Forwarded / Via 任一出现），真实来源就不是
 *      这台机器上的浏览器，一律拒。这样即便有人用 frp / ngrok / nginx 把端口映射出去，
 *      也打不开你机器上的文件夹。
 *   3. **路径必须仍在该实例目录内**（FolderService.resolve 内部 path.resolve + realpath 双重复核）。
 */
async function handleFolderOpen(ctx: HandlerCtx): Promise<void> {
  const { deps, req, res } = ctx;

  const direct = assertDirectLoopback(req);
  if (!direct.ok) {
    sendJson(res, 403, { error: direct.reason, code: 'not-loopback' });
    return;
  }

  let target: { instanceId: string; kind: FolderKind };
  try {
    target = folderTargetOf(ctx);
  } catch (error) {
    sendFolderError(res, error);
    return;
  }

  const service = folderServiceFor(deps);
  try {
    // 先算路径再把路径回给前端：用户点完能看见「打开了哪个目录」，出问题也好排查
    const dir = await service.resolve(target.instanceId, target.kind);
    await service.open(target.instanceId, target.kind);
    sendJson(res, 200, {
      ok: true,
      instanceId: target.instanceId,
      kind: target.kind,
      label: FOLDER_LABEL_CN[target.kind],
      path: dir,
      detail: `已在系统文件管理器中打开：${dir}`,
    });
  } catch (error) {
    sendFolderError(res, error);
  }
}

/**
 * GET /api/instances/:instanceId/paths
 *
 * 该实例的全部关键路径（供 UI 显示 / 复制）。**不 mkdir**：
 * 用户只是想看一眼路径，不该因为看了看就把八个空目录塞进硬盘。
 */
async function handleInstancePaths(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  const instanceId = ctx.params['instanceId'] ?? '';
  const service = folderServiceFor(deps);
  try {
    const paths = await service.paths(instanceId);
    const folders = Object.entries(paths).map(([kind, full]) => ({
      kind,
      label: FOLDER_LABEL_CN[kind as FolderKind] ?? kind,
      path: full,
    }));
    sendJson(res, 200, {
      instanceId,
      dataRoot: deps.dataRoot(),
      paths,
      folders,
    });
  } catch (error) {
    sendFolderError(res, error);
  }
}

/**
 * GET /api/instances/:instanceId/launch-args
 *
 * 返回 `buildCommand()` 产出的完整命令行，给高级用户排查 / 贴论坛用。
 *
 * ★ **令牌一定打码**。`${auth_access_token}` 是真实 access token，
 *   原样贴出去等于把账号交给别人。所以这里固定 `redact: true`，不提供明文开关。
 * ★ 用**离线占位账户**拼命令：这个接口不登录、不拉令牌，
 *   免得为了「看一眼命令行」把整个 refresh token 流程拖进来。
 *   真正的启动仍走 POST /api/launch，两条路径互不影响。
 */
async function handleLaunchArgs(ctx: HandlerCtx): Promise<void> {
  const { deps, res } = ctx;
  const instanceId = (ctx.params['instanceId'] ?? '').trim();
  if (!isSafeVersionId(instanceId)) {
    sendJson(res, 400, { error: `版本号「${instanceId}」含非法字符。` });
    return;
  }

  const dataRoot = deps.dataRoot();
  const account = offlineAccount(PREVIEW_USERNAME);
  const options: LaunchOptions = {
    versionId: instanceId,
    instanceDir: path.join(dataRoot, 'instances', instanceId),
    account,
    ...launchFieldsFor(dataRoot, instanceId),
  };

  try {
    const launcher = deps.launcherFactory();
    const built = await launcher.buildCommand(options);
    const summary = summarizeCommand(built, { redact: true });
    sendJson(res, 200, {
      instanceId,
      cwd: built.cwd,
      java: built.java,
      argCount: summary.argCount,
      length: summary.length,
      maxMemoryMB: summary.maxMemoryMB,
      initMemoryMB: summary.initMemoryMB,
      mainClass: summary.mainClass,
      classpathEntries: summary.classpathEntries,
      usesArgFile: summary.usesArgFile,
      /** 已打码：auth_access_token 之类一律替换成 <已隐藏> */
      redacted: true,
      commandLine: summary.commandLine,
      note: '命令行里的账号令牌已打码，可以直接复制分享；本机自己要跑请用「启动」按钮。',
    });
  } catch (error) {
    const raw = errorMessage(error);
    if (/读取版本 JSON 失败|ENOENT|not found in manifest/i.test(raw)) {
      sendJson(res, 404, {
        error: `版本 ${instanceId} 还没装好，读不到版本文件，没法拼命令行。`,
        hint: '请先在本页点「安装」，或换一个已安装的版本。',
        detail: raw,
      });
      return;
    }
    sendJson(res, 500, { error: `拼装启动参数失败：${raw}` });
  }
}

/**
 * 判断这次请求是不是「本机浏览器直连」。
 *
 * 通过的条件**全部**成立：
 *   1. 没有代理转发痕迹：`x-forwarded-for` / `x-forwarded-host` / `x-real-ip` /
 *      `x-originating-ip` / `forwarded` / `via` 一个都不能出现；
 *   2. 对端地址是回环（127.0.0.0/8、::1、::ffff:127.x.x.x）。
 *      拿不到 socket 信息（单测里的 fake request）时**按不通过处理** ——
 *      「拿不到就放行」是最容易变成漏洞的那种默认值；
 *   3. （防 DNS rebinding）Host 头若给了，必须是回环地址或 localhost。
 *
 * 服务只监听 127.0.0.1，所以第 2 条在真实部署下恒成立；
 * 它存在的意义是「假设监听配置被改坏了，这里还能兜住」。
 */
export function assertDirectLoopback(
  req: IncomingMessage,
): { ok: true } | { ok: false; reason: string } {
  const proxyHeaders = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'x-originating-ip', 'forwarded', 'via'];
  for (const header of proxyHeaders) {
    const value = headerValue(req.headers[header]);
    if (value !== undefined && value.length > 0) {
      return {
        ok: false,
        reason: `检测到代理转发（${header}: ${value}），出于安全考虑不执行「打开文件夹」。请直接用 http://127.0.0.1 访问本服务。`,
      };
    }
  }

  const remote = req.socket?.remoteAddress;
  if (typeof remote !== 'string' || remote.length === 0) {
    return { ok: false, reason: '无法确认请求来源地址，不执行「打开文件夹」。' };
  }
  if (!isLoopbackAddress(remote)) {
    return { ok: false, reason: `只允许本机（127.0.0.1）打开文件夹，当前请求来自 ${remote}。` };
  }

  const host = headerValue(req.headers['host']);
  if (host !== undefined) {
    // Host 可能是 `127.0.0.1:37421`、`[::1]:37421`、`localhost:37421`
    const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? host);
    const normalized = bare.replace(/^\[|\]$/g, '').toLowerCase();
    const hostOk =
      normalized === 'localhost' ||
      normalized === '::1' ||
      normalized === '0.0.0.0' ||
      isLoopbackAddress(normalized);
    if (!hostOk) {
      return { ok: false, reason: `Host 头「${host}」不是本机地址（可能是 DNS 重绑定攻击），已拒绝。` };
    }
  }

  return { ok: true };
}

/** 是不是 IPv4 / IPv6 回环地址 */
export function isLoopbackAddress(address: string): boolean {
  const text = address.trim().toLowerCase();
  if (text === '::1' || text === '0:0:0:0:0:0:0:1') return true;
  if (text === 'localhost') return true;
  // IPv4-mapped IPv6：::ffff:127.0.0.1
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  const v4 = mapped?.[1] ?? text;
  const parts = v4.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
  return parts[0] === '127';
}

// ───────────────────────────── 版本目录（实例概念取消后的唯一目录规则） ─────────────────────────────

/**
 * 版本目录：`<dataRoot>/instances/<versionId>`。
 *
 * 为什么还叫 `instances/` 而不是改名：**这是磁盘上既有的目录名**，里面有用户
 * 三年的存档、mods、配置。改名等于让所有人的数据「消失」，所以目录一字不动，
 * 只是上层不再有「实例」这个概念 —— 一个已安装版本就是一个目录，一一对应。
 *
 * 调用前必须保证 versionId 已过 `isSafeVersionId`（路由层都做了），
 * 否则 `..` 之类会被拼进路径。
 */
export function instanceDirOf(dataRoot: string, versionId: string): string {
  return path.join(dataRoot, 'instances', versionId);
}

/**
 * 「上次启动时间」的落盘位置：`<dataRoot>/instances/<versionId>/.pcl3/last-launch.json`。
 *
 * 为什么不写进 settings.json：settings 里存的是**用户的选择**（内存 / JVM 参数），
 * 而上次启动时间是**程序自己的记录**，混在一起会让「恢复默认」把启动历史也抹掉。
 * 单独一个 `.pcl3/` 隐藏子目录，用户一眼就能分辨哪些是启动器自己的东西。
 */
const LAST_LAUNCH_FILE = path.join('.pcl3', 'last-launch.json');

/** 记一次启动时间（只写自己的隐藏子目录，绝不碰 mods / saves） */
export async function recordLastLaunch(dataRoot: string, versionId: string): Promise<string> {
  const file = path.join(instanceDirOf(dataRoot, versionId), LAST_LAUNCH_FILE);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const at = new Date().toISOString();
  await fsp.writeFile(file, `${JSON.stringify({ lastPlayedAt: at }, null, 2)}\n`, 'utf8');
  return at;
}

/** 读上次启动时间；没记录过 / 文件坏了 → undefined（不抛，列表不该因为一条坏记录整体失败） */
export async function readLastLaunch(dataRoot: string, versionId: string): Promise<string | undefined> {
  const file = path.join(instanceDirOf(dataRoot, versionId), LAST_LAUNCH_FILE);
  try {
    const text = await fsp.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const at = (parsed as { lastPlayedAt?: unknown }).lastPlayedAt;
    return typeof at === 'string' && at.trim().length > 0 ? at.trim() : undefined;
  } catch {
    return undefined;
  }
}

