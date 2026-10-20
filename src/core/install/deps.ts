/**
 * 安装 / CLI 的外部依赖（version + download）。
 *
 * 契约（docs/ARCHITECTURE.md）：
 * - `src/core/version/index.js` → `VersionRepository`
 * - `src/core/download/index.js` → `Downloader`、`getDataRoot`
 *
 * version-dev / download-dev 已交付，因此这里用**静态 import** 锁定真实实现
 * （不再有运行时探测与回退实现）：缺了就是编译/导入期硬错误，不会静默降级。
 *
 * 收敛点：install 与 cli 都只从这里取依赖，将来换实现只改这一个文件。
 */

import { Downloader, getDataRoot } from '../download/index.js';
import { VersionRepository } from '../version/index.js';

export { Downloader, getDataRoot, VersionRepository };

/** 默认镜像：版本元数据走 BMCLAPI（正确域名 bangbang93） */
export const DEFAULT_MIRROR_ROOT = 'https://bmclapi2.bangbang93.com';

/** 契约里 `VersionRepository` 要求的方法（测试可塞 fake，不必是真实类） */
export interface VersionRepositoryLike {
  fetchManifest(): Promise<import('../types.js').VersionManifest>;
  fetchVersion(id: string): Promise<import('../types.js').VersionJson>;
  resolveInherited(json: import('../types.js').VersionJson): Promise<import('../types.js').VersionJson>;
}

/** 契约里 `Downloader` 要求的方法（测试可塞 fake） */
export interface DownloaderLike {
  downloadAll(
    tasks: import('../types.js').DownloadTask[],
    onProgress?: (p: import('../types.js').DownloadProgress) => void,
  ): Promise<import('../types.js').DownloadResult>;
}

/** install 模块的构造函数入参 */
export interface InstallerDeps {
  versionRepo: VersionRepositoryLike;
  downloader: DownloaderLike;
}

/** 默认依赖装配 */
export interface ResolvedDeps {
  VersionRepository: typeof VersionRepository;
  Downloader: typeof Downloader;
  getDataRoot: () => string;
  /** 依赖就绪情况（doctor 用）。静态 import 后恒为 true，保留字段是为了 CLI 输出稳定。 */
  real: { versionRepo: boolean; downloader: boolean; getDataRoot: boolean };
}

export function resolveDeps(): ResolvedDeps {
  return {
    VersionRepository,
    Downloader,
    getDataRoot,
    real: { versionRepo: true, downloader: true, getDataRoot: true },
  };
}
