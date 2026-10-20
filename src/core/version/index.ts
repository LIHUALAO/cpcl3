/**
 * version 模块统一导出。
 */

export {
  VersionRepository,
  DEFAULT_TTL_MS,
  MANIFEST_CACHE_FILE,
  MANIFEST_PATH,
  normalizeMirrorRoot,
  pickArtifact,
} from './repository.js';
export type { Logger, VersionRepositoryOptions } from './repository.js';

export { getDataRoot } from './dataRoot.js';

export { MetaCache } from './cache.js';
export type { CacheEntry, CacheMeta } from './cache.js';

export {
  OFFICIAL_ROOT,
  MIRROR_ROOT,
  DEFAULT_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  MAX_REDIRECTS,
  FetchError,
  applyMirror,
  fetchJson,
  fetchText,
} from './http.js';
export type { FetchJsonResult, FetchJsonFn, FetchOptions, FetchTextResult } from './http.js';

export { mergeLibraries, mergeVersionJson, concatArgs, libraryKey } from './merge.js';

export type { VersionJson, VersionManifest, VersionSummary } from '../types.js';
