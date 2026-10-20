/**
 * PCL3 launch 模块 —— 统一导出。
 *
 * 对外只需要 GameLauncher；底层工具函数导出是为了可测试性与 CLI/debug 复用。
 */

export { GameLauncher, DEFAULT_MEMORY_MB, libraryJarRelativePath } from './launcher.js';
export type { GameLauncherDeps, LaunchContext, LaunchedProcess } from './launcher.js';

export {
  KNOWN_PLACEHOLDERS,
  buildClasspath,
  buildPlaceholders,
  evaluateArguments,
  hasClasspathPlaceholder,
  joinClasspath,
  libraryRelativePath,
  nativeClassifier,
  nativeRelativePath,
  planLibraries,
  splitLegacyArguments,
  substitute,
} from './command.js';
export type { ClasspathPlan, PlaceholderInput, PlaceholderMap } from './command.js';

export {
  DEFAULT_FEATURES,
  detectPlatform,
  libraryAllowed,
  matchesRule,
  nodeArchToOsArch,
  nodePlatformToOsName,
  rulesAllow,
} from './rules.js';
export type { OsArch, OsName, Platform } from './rules.js';

export { collectNativeJobs, extractNatives } from './natives.js';
export type { NativeExtractJob, NativeExtractResult } from './natives.js';

export { openZip } from './zip.js';
export type { ZipArchive, ZipEntry } from './zip.js';

export { findJavaInDataRoot, isJavaHome, javaExecutable, parseMajorVersion } from './java.js';
export type { JavaLookup, JavaRequirement } from './java.js';

export { mavenRelativePath, parseMavenCoordinate } from './maven.js';
export { libraryKey, mergeVersionJson } from './version-merge.js';
export { defaultDataRoot, resolveDataRoot, PRODUCT_DIR_NAME } from './data-root.js';
export { readLauncherMeta } from './meta.js';
export type { LauncherMeta } from './meta.js';
export type { VersionRepositoryLike, VersionSource } from './version-source.js';
