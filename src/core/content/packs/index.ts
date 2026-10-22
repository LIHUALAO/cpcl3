/**
 * content/packs 模块统一出口。
 *
 * 只管三件事：资源包 / 数据包 / 光影包的**本地**安装、启用、删除。
 *   - 不做网络协议（URL 下载复用 download 模块的 Downloader）
 *   - 不做搜索 / 远程索引（那是 modrinth 模块的事，两边目录严格分开）
 */

export {
  PackManager,
  MAX_UPLOAD_BYTES,
  looksLikePackFile,
  sha1OfBuffer,
  type PackDownloaderLike,
  type PackInstallOptions,
  type PackManagerOptions,
  type PackProgress,
  type PackUploadResult,
} from './PackManager.js';

export {
  DISABLED_SUFFIX,
  MAX_FILENAME_LENGTH,
  MAX_PACK_BYTES,
  PACK_EXTENSION,
  PACK_KINDS,
  PACK_KIND_LABEL,
  PackNotFoundError,
  PackValidationError,
  checkFilename,
  checkInstanceId,
  checkSaveName,
  diskNameOf,
  enabledNameOf,
  hasZipExtension,
  isPackKind,
  parsePackKind,
  sanitizeFilename,
  type InstalledPack,
  type PackInstallTask,
  type PackKind,
  type SaveSummary,
} from './types.js';

export {
  MAX_DESCRIPTION_LENGTH,
  MCMETA_MAX_BYTES,
  SHADER_ENTRY_FILES,
  chatToPlainText,
  detectShader,
  parsePackMetaJson,
  parsePackMetaText,
  readPackMeta,
  tryOpenZip,
  type PackMetaResult,
} from './mcmeta.js';

export { listSaves, listSavesSync, saveExists } from './saves.js';
