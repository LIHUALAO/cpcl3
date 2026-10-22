/**
 * content/modrinth 模块统一出口。
 *
 * 只做「远程元数据」：搜索、项目详情、版本列表、挑版本。
 * 不碰磁盘、不装文件 —— 安装是 content/mods（ModManager）的事。
 */

export {
  ModrinthClient,
  ModrinthError,
  CLIENT_VERSION,
  DEFAULT_USER_AGENT,
  MODRINTH_API_BASE,
  PROJECT_CACHE_TTL_MS,
  type ModrinthClientOptions,
  type ModrinthErrorKind,
} from './client.js';

export {
  PROJECT_TYPES,
  PROJECT_TYPE_LABEL,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_OFFSET,
  SORT_OPTIONS,
  buildFacets,
  checkGameVersion,
  checkLoader,
  comparePublished,
  encodeFacets,
  isProjectType,
  normalizeSort,
  parseProjectType,
  pickBestVersion,
  pickFile,
  primaryFile,
  type DependencyType,
  type ProjectDependency,
  type ProjectDetail,
  type ProjectFile,
  type ProjectSummary,
  type ProjectType,
  type ProjectVersion,
  type SearchOptions,
  type SortOption,
  type VersionFilter,
} from './types.js';
