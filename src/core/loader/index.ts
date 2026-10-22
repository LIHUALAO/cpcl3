/**
 * loader 模块统一出口（契约入口）。
 *
 * 契约要求的签名（Lead 交付清单）：
 *   export type LoaderKind = 'fabric' | 'quilt'
 *   export interface LoaderVersion { version: string; stable: boolean }
 *   export class LoaderInstaller {
 *     constructor(deps: { versionRepo; downloader; dataRoot? })
 *     listVersions(kind, gameVersion)
 *     fetchProfile(kind, gameVersion, loaderVersion)
 *     install(kind, gameVersion, loaderVersion, onProgress?)
 *   }
 *
 * 其余导出是给 CLI / Web / 测试复用的零件，不属于契约约束面。
 */

export { LoaderInstaller, LoaderPreconditionError, planToDownloadTasks } from './installer.js';
export type {
  LoaderInstallerDeps,
  LoaderInstallerOptions,
  LoaderDownloaderLike,
  LoaderVersionRepoLike,
} from './installer.js';

export {
  FABRIC_META_ROOT,
  QUILT_META_ROOT,
  META_ROOTS,
  META_VERSION_SEGMENT,
  DEFAULT_MAVEN_ROOT,
  LOADER_LABEL,
} from './endpoints.js';

export {
  LoaderMetaError,
  fetchLoaderVersions,
  fetchLoaderVersionsForGame,
  fetchProfileJson,
  profileUrl,
  probeApplicable,
  isPrerelease,
} from './meta.js';

export { mavenRelativePath, joinMavenUrl, libraryToTask, librariesToTasks, toDownloadTasks } from './libraries.js';

export type {
  LoaderKind,
  LoaderVersion,
  LoaderVersionInfo,
  LoaderProgress,
  LoaderDownloadTask,
  LoaderInstallPlan,
} from './types.js';
