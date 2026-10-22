/**
 * ModpackInstaller —— `.mrpack` 的解析与安装。
 *
 * 安装流程（与 UI 的四个阶段一一对应）：
 *   1. `vanilla`   按 `dependencies.minecraft` 装原版（复用 `VanillaInstaller`）
 *   2. `loader`    按 `fabric-loader` / `quilt-loader` / … 装加载器（复用 `LoaderInstaller`）
 *   3. `mods`      下载 `files` 里 `env.client !== 'unsupported'` 的文件到实例目录（复用 `Downloader`）
 *   4. `overrides` 解压 `overrides/` + `client-overrides/` 到实例目录（防 zip-slip）
 *
 * 三条硬规则：
 *   1. **实例隔离**：一切落盘都在 `<dataRoot>/instances/<instanceId>/` 里。
 *      原版与加载器的库仍进共享的 `libraries/`、`assets/`（那是版本级公共资源，
 *      每个实例存一份会浪费几个 GB），但游戏目录、mods、config 一律隔离。
 *   2. **服务端专用 mod 不装**：`env.client === 'unsupported'` 的文件跳过。
 *   3. **宁可失败也不假成功**：下载失败、覆盖解压失败都抛错，并把「装到一半」的
 *      实例目录留在原处供排查（不自动删，里面可能已有用户放进来的东西）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { DownloadTask } from '../../types.js';
import { getDataRoot } from '../../download/index.js';
import { openZip, type ZipArchive } from '../../launch/zip.js';
import type { LoaderKind } from '../../loader/index.js';

import { listOverrides, openModpack, readIndex } from './mrpack.js';
import { checkInstanceName, isInside, resolveInside } from './safe-path.js';
import {
  ModpackError,
  type ModpackFile,
  type ModpackIndex,
  type ModpackInstallOptions,
  type ModpackInstallResult,
  type ModpackLoaderDependency,
  type ModpackLoaderKind,
  type ModpackParseResult,
  type ModpackProgress,
} from './types.js';

// ───────────────────────────── 依赖（结构化，便于测试替身） ─────────────────────────────

/** 只用到 Downloader 的 downloadAll —— 真实 `Downloader` 天然满足 */
export interface ModpackDownloaderLike {
  downloadAll(
    tasks: DownloadTask[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<{ ok: boolean; skipped: number; downloaded: number; failed: DownloadTask[] }>;
}

/** 只用到 VanillaInstaller 的 install */
export interface ModpackVanillaInstallerLike {
  install(versionId: string, onProgress?: (p: { phase: string; done: number; total: number }) => void): Promise<void>;
}

/**
 * 只用到 LoaderInstaller 的 install。
 *
 * 刻意**只声明 install**：契约就是 `install(kind, gameVersion, loaderVersion)`，
 * 测试用替身可以直接断言这三个参数是什么，不必实现 plan / listVersions。
 */
export interface ModpackLoaderInstallerLike {
  install(
    kind: LoaderKind,
    gameVersion: string,
    loaderVersion: string,
    onProgress?: (p: { phase: string; done: number; total: number }) => void,
  ): Promise<{ versionId: string }>;
}

export interface ModpackInstallerDeps {
  /** 契约要求的 downloader；其余两个不传时对应阶段会给明确的人话错误 */
  downloader: ModpackDownloaderLike;
  /** 覆盖数据根；不传则用 download 模块的 getDataRoot() */
  dataRoot?: string;
  /** 装原版的安装器；纯原版依赖的整合包必须提供 */
  vanillaInstaller?: ModpackVanillaInstallerLike;
  /** 装加载器的安装器；带加载器依赖的整合包必须提供 */
  loaderInstaller?: ModpackLoaderInstallerLike;
  /** 覆盖解压时单条目大小上限（默认 512 MB） */
  maxOverrideBytes?: number;
}

/** overrides 单个条目上限：超过就当成异常，避免一个超大条目把磁盘写满 */
export const MAX_OVERRIDE_BYTES = 512 * 1024 * 1024;

/** 进度阶段名（前端按它显示中文标签） */
export const MODPACK_PHASES = ['plan', 'vanilla', 'loader', 'mods', 'overrides', 'done'] as const;

// ───────────────────────────── 加载器依赖映射 ─────────────────────────────

/**
 * dependencies 的 key → 加载器。
 *
 * Modrinth 规范用的 key：`fabric-loader` / `quilt-loader` / `forge` / `neoforge`。
 * 少数打包器会写 `fabric` / `quilt` / `neo-forge`，这里一并认；
 * 认不出就返回 undefined，由调用方按错误处理 —— 不做「猜你想装」。
 */
const LOADER_KEYS: { pattern: RegExp; kind: ModpackLoaderKind }[] = [
  { pattern: /^fabric-loader$/, kind: 'fabric' },
  { pattern: /^fabric$/, kind: 'fabric' },
  { pattern: /^quilt-loader$/, kind: 'quilt' },
  { pattern: /^quilt$/, kind: 'quilt' },
  { pattern: /^forge$/, kind: 'forge' },
  { pattern: /^neoforge$/, kind: 'neoforge' },
  { pattern: /^neo-forge$/, kind: 'neoforge' },
];

/** LoaderInstaller 当前支持的加载器（forge / neoforge 尚未支持） */
const SUPPORTED_LOADERS: readonly ModpackLoaderKind[] = ['fabric', 'quilt'];

/**
 * 从 `dependencies` 里挑出加载器。
 *
 * 多个加载器同时出现时按 `forge > neoforge > quilt > fabric` 的确定性顺序取第一个，
 * 并在返回值的 raw 里留下来源 key —— 不静默忽略冲突（上层可以据此提示）。
 */
export function resolveLoaderDependency(
  dependencies: Record<string, string>,
): ModpackLoaderDependency | undefined {
  const hits: ModpackLoaderDependency[] = [];
  for (const [key, value] of Object.entries(dependencies)) {
    const matched = LOADER_KEYS.find((l) => l.pattern.test(key.toLowerCase()));
    if (matched === undefined) continue;
    hits.push({
      raw: key,
      kind: matched.kind,
      version: value,
      supported: SUPPORTED_LOADERS.includes(matched.kind),
    });
  }
  if (hits.length === 0) return undefined;
  const order: ModpackLoaderKind[] = ['forge', 'neoforge', 'quilt', 'fabric'];
  hits.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return hits[0];
}

/** 该文件是否要为客户端下载（`env.client === 'unsupported'` 的跳过） */
export function isClientFile(file: ModpackFile): boolean {
  const client = file.env?.client;
  if (typeof client !== 'string') return true; // 没写 env = 双端通用，要装
  return client !== 'unsupported';
}

// ───────────────────────────── 实现 ─────────────────────────────

export class ModpackInstaller {
  private readonly downloader: ModpackDownloaderLike;
  private readonly dataRootOverride: string | undefined;
  private readonly vanillaInstaller: ModpackVanillaInstallerLike | undefined;
  private readonly loaderInstaller: ModpackLoaderInstallerLike | undefined;
  private readonly maxOverrideBytes: number;

  constructor(deps: ModpackInstallerDeps) {
    this.downloader = deps.downloader;
    this.dataRootOverride = deps.dataRoot;
    this.vanillaInstaller = deps.vanillaInstaller;
    this.loaderInstaller = deps.loaderInstaller;
    this.maxOverrideBytes = deps.maxOverrideBytes ?? MAX_OVERRIDE_BYTES;
  }

  // ── 解析 ──────────────────────────────────────────────────────

  /** 解析 `.mrpack`，不下载、不落盘 */
  async parse(filePath: string): Promise<ModpackParseResult> {
    const abs = path.resolve(filePath);
    const opened = await openModpack(abs);
    const index = readIndex(opened);
    const overrides = listOverrides(opened.archive);

    const clientFiles = index.files.filter(isClientFile);
    const skippedServerFiles = index.files.filter((f) => !isClientFile(f));
    const totalBytes = clientFiles.reduce((sum, f) => sum + (f.fileSize ?? 0), 0);
    const loader = resolveLoaderDependency(index.dependencies);

    const result: ModpackParseResult = {
      index,
      overrides,
      entryCount: opened.archive.entries.length,
      filePath: abs,
      fileSize: opened.fileSize,
      clientFiles,
      skippedServerFiles,
      totalBytes,
    };
    if (loader !== undefined) result.loader = loader;
    return result;
  }

  // ── 安装 ──────────────────────────────────────────────────────

  async install(filePath: string, opts: ModpackInstallOptions): Promise<ModpackInstallResult> {
    const report = makeReporter(opts.onProgress);

    // 0) 先把「不下载就能发现的问题」全查完：实例名 / 清单 / 依赖 / 加载器支持度。
    //    宁可在这里失败，也不要在下载了几百 MB 之后才发现实例名非法。
    report('plan', 0, 1);
    const nameCheck = checkInstanceName(opts.instanceName);
    if (!nameCheck.ok) {
      throw new ModpackError('bad-instance-name', `实例名不合法：${nameCheck.reason}`);
    }
    const instanceId = nameCheck.id;

    const parsed = await this.parse(filePath);
    const index = parsed.index;
    const absFilePath = parsed.filePath;

    const gameVersion = index.dependencies['minecraft'];
    if (typeof gameVersion !== 'string' || gameVersion.trim() === '') {
      throw new ModpackError(
        'missing-minecraft',
        `整合包「${index.name}」没有声明 minecraft 依赖，不知道该装哪个游戏版本。`,
        '正常 .mrpack 的 dependencies 里必有 "minecraft": "1.21" 这类条目；换一个来源重新下载。',
      );
    }
    if (!isSafeVersionToken(gameVersion)) {
      throw new ModpackError('bad-index', `整合包声明的游戏版本号不合法：${gameVersion}`);
    }

    const loader = parsed.loader;
    if (loader !== undefined && !loader.supported) {
      throw new ModpackError(
        'unsupported-loader',
        `这个整合包需要 ${loaderLabel(loader.kind)} ${loader.version}，但本启动器目前只支持 Fabric / Quilt 加载器。`,
        `换一个 Fabric / Quilt 的整合包；${loaderLabel(loader.kind)} 支持还在开发中。`,
      );
    }

    const dataRoot = this.dataRoot();
    const instanceDir = path.join(dataRoot, 'instances', instanceId);
    await assertInstanceDirUsable(instanceDir, instanceId);
    report('plan', 1, 1);

    // 1) 原版
    if (this.vanillaInstaller === undefined) {
      throw new ModpackError(
        'io',
        '没有可用的原版安装器，无法安装整合包依赖的原版。',
        '这是装配问题（构造 ModpackInstaller 时缺少 vanillaInstaller）。',
      );
    }
    report('vanilla', 0, 1, gameVersion);
    await this.vanillaInstaller.install(gameVersion, (p) => {
      report('vanilla', p.done, p.total, p.phase);
    });
    report('vanilla', 1, 1, gameVersion);

    // 2) 加载器
    let versionId = gameVersion;
    let installedLoader: ModpackInstallResult['loader'];
    if (loader !== undefined) {
      if (this.loaderInstaller === undefined) {
        throw new ModpackError(
          'io',
          '没有可用的加载器安装器，无法安装整合包要求的加载器。',
          '这是装配问题（构造 ModpackInstaller 时缺少 loaderInstaller）。',
        );
      }
      report('loader', 0, 1, `${loader.kind} ${loader.version}`);
      // supported 已保证是 fabric / quilt，可以直接转成 LoaderKind
      const kind: LoaderKind = loader.kind === 'quilt' ? 'quilt' : 'fabric';
      const result = await this.loaderInstaller.install(kind, gameVersion, loader.version, (p) => {
        report('loader', p.done, p.total, p.phase);
      });
      versionId = result.versionId;
      installedLoader = { kind: loader.kind, version: loader.version, versionId: result.versionId };
      report('loader', 1, 1, result.versionId);
    }

    // 3) 客户端文件
    await fs.mkdir(instanceDir, { recursive: true });
    const tasks: DownloadTask[] = [];
    for (const file of parsed.clientFiles) {
      const dest = resolveInside(instanceDir, file.path);
      const task: DownloadTask = {
        // 只取第一个地址：Downloader 内部已有「主链失败 → 退避重试 → 镜像回退」，
        // 在外层再排一遍候选只会重复计数
        url: file.downloads[0] as string,
        dest,
      };
      if (file.hashes.sha1 !== undefined) task.sha1 = file.hashes.sha1;
      if (file.fileSize !== undefined) task.size = file.fileSize;
      tasks.push(task);
    }

    report('mods', 0, tasks.length, tasks[0]?.dest);
    if (tasks.length > 0) {
      await fs.mkdir(path.join(instanceDir, 'mods'), { recursive: true });
      const dl = await this.downloader.downloadAll(tasks, (p) => {
        report('mods', p.done, p.total, p.current);
      });
      if (dl.failed.length > 0) {
        const names = dl.failed
          .slice(0, 5)
          .map((t) => path.relative(instanceDir, t.dest) || path.basename(t.dest))
          .join(', ');
        throw new ModpackError(
          'download-failed',
          `整合包有 ${String(dl.failed.length)}/${String(tasks.length)} 个文件下载失败：${names}` +
            (dl.failed.length > 5 ? ' …' : ''),
          '多半是网络或 CDN 不可达。已下载的部分保留在实例目录里，重试会跳过已校验通过的文件。',
        );
      }
      if (!dl.ok) {
        throw new ModpackError(
          'download-failed',
          `下载器报告失败但没有给出失败清单（skipped=${String(dl.skipped)}, downloaded=${String(dl.downloaded)}），拒绝判定为成功。`,
        );
      }
    }
    report('mods', tasks.length, tasks.length);

    // 4) overrides / client-overrides 解压覆盖
    //    server-overrides 一律不碰：那是给服务端准备的，装进客户端只会塞进无关文件。
    //    顺序按 zip 内原始顺序，client-overrides 天然排在 overrides 之后写入 ——
    //    正好是 mrpack 规范里「client-overrides 优先级更高」的语义。
    const overrideEntries = parsed.overrides.filter((e) => e.source !== 'server-overrides');
    report('overrides', 0, overrideEntries.length);

    // zip 只在这里打开一次：大包的 overrides 有几千个条目，每条目重开一次等于反复读几百 MB
    const archive = await openArchive(absFilePath);
    let written = 0;
    for (let i = 0; i < overrideEntries.length; i += 1) {
      const entry = overrideEntries[i] as (typeof overrideEntries)[number];
      const dest = resolveInside(instanceDir, entry.target);
      // 纵深防御：上面已经过 splitSafeZipPath，这里再按绝对路径复核一次
      if (!isInside(instanceDir, dest)) {
        throw new ModpackError('unsafe-path', `覆盖文件「${entry.path}」解析后落在实例目录之外，已中止。`);
      }
      if (entry.isDirectory) {
        await fs.mkdir(dest, { recursive: true });
      } else {
        if (entry.size > this.maxOverrideBytes) {
          throw new ModpackError(
            'bad-index',
            `覆盖文件「${entry.path}」太大（${String(entry.size)} 字节，上限 ${String(this.maxOverrideBytes)}）。`,
          );
        }
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, readArchiveEntry(archive, entry.path));
        written += 1;
      }
      report('overrides', i + 1, overrideEntries.length, entry.target);
    }
    report('overrides', overrideEntries.length, overrideEntries.length);

    // 5) 记一份「这个实例是从哪个整合包装来的」，排错时有据可查（原子写）
    await writeInstanceManifest(instanceDir, {
      name: index.name,
      versionId: index.versionId,
      ...(index.summary === undefined ? {} : { summary: index.summary }),
      gameVersion,
      dependencies: index.dependencies,
      loader: installedLoader ?? null,
      installedAt: new Date().toISOString(),
    });

    report('done', 1, 1);

    const result: ModpackInstallResult = {
      instanceId,
      versionId,
      gameVersion,
      instanceDir,
      stats: {
        files: tasks.length,
        skipped: parsed.skippedServerFiles.length,
        overridden: written,
      },
    };
    if (installedLoader !== undefined) result.loader = installedLoader;
    return result;
  }

  // ── 内部 ──────────────────────────────────────────────────────

  private dataRoot(): string {
    return this.dataRootOverride ?? path.resolve(getDataRoot());
  }
}

// ───────────────────────────── 工具 ─────────────────────────────

function loaderLabel(kind: ModpackLoaderKind): string {
  switch (kind) {
    case 'fabric':
      return 'Fabric';
    case 'quilt':
      return 'Quilt';
    case 'forge':
      return 'Forge';
    case 'neoforge':
      return 'NeoForge';
  }
}

/** 版本号令牌：官方 id 只有这些字符；带上限防止拼出荒谬路径 */
function isSafeVersionToken(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[A-Za-z0-9._+-]+$/.test(id) && id !== '.' && id !== '..';
}

/**
 * 进度上报器。
 *
 * 包一层而不是到处直接调 onProgress：五个阶段各自算 done/total 很容易漏，
 * 而 Web 任务面板要求进度单调、最终收敛到 total。
 */
type Reporter = (phase: string, done: number, total: number, current?: string) => void;

function makeReporter(onProgress: ((p: ModpackProgress) => void) | undefined): Reporter {
  return (phase: string, done: number, total: number, current?: string): void => {
    if (onProgress === undefined) return;
    const p: ModpackProgress = { phase, done, total };
    if (current !== undefined) p.current = current;
    onProgress(p);
  };
}

/**
 * 实例目录是否可用：存在且非空就拒绝。
 *
 * 为什么不做覆盖安装：装整合包会往 mods/ 写一堆文件，覆盖安装等于把两份包搅在一起，
 * 出问题谁都说不清是谁的错。想重装就先把目录删掉。
 */
async function assertInstanceDirUsable(instanceDir: string, instanceId: string): Promise<void> {
  const stat = await fs.stat(instanceDir).catch(() => undefined);
  if (stat === undefined) return;
  if (!stat.isDirectory()) {
    throw new ModpackError('instance-exists', `实例路径已存在且不是一个目录：${instanceDir}`);
  }
  const entries = await fs.readdir(instanceDir).catch(() => []);
  if (entries.length > 0) {
    throw new ModpackError(
      'instance-exists',
      `实例「${instanceId}」已经存在且不是空的，为避免把两份整合包装混，已中止。`,
      '换一个实例名，或先手动删除该实例目录再重装。',
    );
  }
}

/** 打开一次 zip 供 overrides 阶段复用 */
async function openArchive(filePath: string): Promise<ZipArchive> {
  const buf = await fs.readFile(filePath);
  try {
    return openZip(buf);
  } catch (error) {
    throw new ModpackError('not-a-zip', `解压覆盖文件时整合包不可读：${messageOf(error)}`);
  }
}

/** 从已打开的 archive 里读一个条目；条目消失说明文件在安装过程中被换过，必须报错 */
function readArchiveEntry(archive: ZipArchive, entryPath: string): Buffer {
  const entry = archive.entries.find((e) => e.name === entryPath);
  if (entry === undefined) {
    throw new ModpackError('bad-index', `整合包内容发生变化：找不到条目 ${entryPath}`);
  }
  return archive.read(entry);
}

async function writeInstanceManifest(instanceDir: string, manifest: Record<string, unknown>): Promise<void> {
  const file = path.join(instanceDir, 'pcl3-modpack.json');
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ModpackIndex };
