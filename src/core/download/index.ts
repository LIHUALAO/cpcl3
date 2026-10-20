/**
 * PCL3 download 模块统一出口。
 *
 * 契约（docs/ARCHITECTURE.md「download 模块」）：
 *   - `getDataRoot()`：全项目唯一路径真源
 *   - `Downloader`：批量下载，带并发 / 重试 / 镜像回退 / 断点续传 / SHA1 校验
 *
 * 其余导出是给 install / version 等模块与测试使用的可复用零件，不属于契约约束面。
 */

export { getDataRoot, dataSubdir, resetDataRootCache, type DataSubdir } from './paths.js';
export {
  Downloader,
  DEFAULT_CONCURRENCY,
  DEFAULT_RETRIES,
  type DownloaderOptions,
  type DownloaderInternalOptions,
  type DownloadProgressCallback,
} from './Downloader.js';

// ── 可复用零件（非契约面） ────────────────────────────────────────────────
export { buildCandidates, isMirrorable, MIRRORABLE_HOSTS } from './mirror.js';
export { sha1File, isUpToDate, partPathFor, hashFileInto, newSha1 } from './verify.js';
export { runPool } from './pool.js';
export { ProgressThrottle } from './progress.js';
export {
  fetchOne,
  backoffDelay,
  parseContentRange,
  DEFAULT_FETCH_OPTIONS,
  type FetchOptions,
  type FetchResult,
  type FetchOutcome,
} from './fetcher.js';
export { openRequest, TransportError, DEFAULT_MAX_REDIRECTS, type TransportOptions } from './transport.js';

// 共享类型转出口，方便 `import { DownloadTask } from '../download/index.js'`
export type { DownloadTask, DownloadResult, DownloadProgress } from '../types.js';
