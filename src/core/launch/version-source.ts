/**
 * 版本仓库的最小结构约束。
 *
 * 为不把 launch 模块绑死在 version 模块的编译产物上（它由 version-dev 并行开发），
 * 这里用结构化类型描述依赖：真实 `VersionRepository` 天然满足（结构化兼容），
 * 测试里的 fake 也只需要实现 `fetchVersion` 即可。
 */

import type { VersionJson } from '../types.js';

export interface VersionSource {
  fetchVersion(id: string): Promise<VersionJson>;
  /** 可选：解析继承链，合并成可直接使用的完整 VersionJson */
  resolveInherited?(json: VersionJson): Promise<VersionJson>;
  /** 可选便捷方法（version 模块里的名字是 fetchResolvedVersion） */
  fetchResolvedVersion?(id: string): Promise<VersionJson>;
  /** 渲染便利别名，与上面等价 */
  resolveVersionJson?(id: string): Promise<VersionJson>;
}

export type VersionRepositoryLike = VersionSource;
