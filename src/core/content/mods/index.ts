/**
 * content/mods 模块统一出口。
 *
 * 本地模组文件管理（不联网）：列出、安装（走 download 模块）、启用禁用、删除。
 * 远程搜索与版本挑选在 content/modrinth，两边目录严格分开。
 */

export {
  ModManager,
  ModValidationError,
  DISABLED_SUFFIX,
  MAX_FILENAME_LENGTH,
  MOD_EXTENSION,
  checkInstanceId,
  checkModFilename,
  diskNameOf,
  enabledNameOf,
  sanitizeJarFilename,
  type InstalledMod,
  type ModDownloaderLike,
  type ModInstallProgress,
  type ModInstallTask,
  type ModManagerOptions,
} from './ModManager.js';

export {
  FABRIC_META,
  FORGE_META,
  nameFromFilename,
  readMetaFromBuffer,
  readModJarMeta,
  tomlString,
  type ModJarMeta,
} from './jar-meta.js';
