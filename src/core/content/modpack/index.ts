/**
 * 整合包（`.mrpack`）模块统一出口。
 *
 * 三层：
 *   mrpack.ts      zip 读取 + `modrinth.index.json` 解析（不落盘、不下载）
 *   safe-path.ts   来自 zip 的路径一律过这里（防 zip-slip），实例名也在这里校验
 *   installer.ts   ModpackInstaller：装原版 → 装加载器 → 下载客户端文件 → 解压 overrides
 *
 * 依赖关系（全部复用既有模块，不重复实现）：
 *   原版   → VanillaInstaller.install(gameVersion)
 *   加载器 → LoaderInstaller.install(kind, gameVersion, loaderVersion)
 *   文件   → Downloader.downloadAll(tasks)（sha1 校验）
 *   zip    → launch/zip.ts 的 openZip（只读复用）
 */

export {
  ModpackInstaller,
  MODPACK_PHASES,
  MAX_OVERRIDE_BYTES,
  resolveLoaderDependency,
  isClientFile,
} from './installer.js';
export type {
  ModpackDownloaderLike,
  ModpackLoaderInstallerLike,
  ModpackInstallerDeps,
  ModpackVanillaInstallerLike,
} from './installer.js';

export {
  INDEX_ENTRY,
  OVERRIDE_ROOTS,
  MAX_INDEX_BYTES,
  openModpack,
  openBuffer,
  readIndex,
  listOverrides,
  countEntries,
} from './mrpack.js';
export type { OpenedModpack } from './mrpack.js';

export { splitSafeZipPath, resolveInside, isInside, checkInstanceName } from './safe-path.js';

export { ModpackError } from './types.js';
export type {
  ModpackErrorCode,
  ModpackFile,
  ModpackIndex,
  ModpackInstallOptions,
  ModpackInstallResult,
  ModpackLoaderDependency,
  ModpackLoaderKind,
  ModpackOverrideEntry,
  ModpackParseResult,
  ModpackProgress,
  OverrideRoot,
} from './types.js';
