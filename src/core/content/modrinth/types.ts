/**
 * Modrinth 内容源的类型与纯函数工具。
 *
 * 这里刻意**不 import 任何其它模块**：facets 编码、版本挑选这类逻辑是纯函数，
 * 网络层（client.ts）坏了、离线了，这些工具照样能被测试与前端复用。
 */

/** 支持的内容类型（Modrinth 的 project_type） */
export type ProjectType = 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'modpack';

/** 全部合法类型（顺序即 UI 顺序） */
export const PROJECT_TYPES: readonly ProjectType[] = ['mod', 'resourcepack', 'shader', 'datapack', 'modpack'];

/** 类型 → 中文标签（日志 / 错误文案 / 前端都从这里取，别各写一份） */
export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  mod: '模组',
  resourcepack: '资源包',
  shader: '光影',
  datapack: '数据包',
  modpack: '整合包',
};

export function isProjectType(raw: unknown): raw is ProjectType {
  return typeof raw === 'string' && (PROJECT_TYPES as readonly string[]).includes(raw);
}

/** 把任意输入解析成 ProjectType；认不出返回 undefined（不猜） */
export function parseProjectType(raw: unknown): ProjectType | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().toLowerCase();
  return isProjectType(text) ? text : undefined;
}

/** 搜索参数 */
export interface SearchOptions {
  query: string;
  projectType?: ProjectType;
  /** 游戏版本，如 1.21 */
  gameVersion?: string;
  /** 加载器，如 fabric / quilt / forge */
  loader?: string;
  limit?: number;
  offset?: number;
  /** relevance | downloads | follows | newest | updated */
  sortBy?: string;
}

/** 搜索结果里的一条项目 */
export interface ProjectSummary {
  slug: string;
  title: string;
  description: string;
  iconUrl?: string;
  downloads: number;
  projectType: string;
  categories: string[];
  /** 最新适配的版本 */
  latestGameVersions: string[];
}

/** 项目详情（getProject 的返回） */
export interface ProjectDetail extends ProjectSummary {
  body?: string;
  /** Modrinth 的项目 id（`AANobbMI`），与 slug 不同，用于依赖解析 */
  id?: string;
  /** 项目支持的全部游戏版本（升序，来自详情接口） */
  gameVersions?: string[];
  /** 项目支持的全部加载器 */
  loaders?: string[];
  follows?: number;
  /**
   * 作者填的项目主页 / 源码仓库。**这是「官网」按钮的首选来源**：
   * 多数 mod 填的是 GitHub 仓库，也有填 CurseForge 或个人站的。
   */
  sourceUrl?: string;
  /** 作者填的 Wiki 地址（可能是 fandom、github wiki 或自己的站） */
  wikiUrl?: string;
  /** issue 跟踪页 */
  issuesUrl?: string;
  /** Discord 邀请链接 */
  discordUrl?: string;
}

/** 依赖类型 */
export type DependencyType = 'required' | 'optional' | 'incompatible' | 'embedded';

/** 一个版本声明的一条依赖 */
export interface ProjectDependency {
  projectId?: string;
  versionId?: string;
  dependencyType: DependencyType;
}

/** 版本里的一个文件 */
export interface ProjectFile {
  url: string;
  filename: string;
  size: number;
  primary: boolean;
  sha1?: string;
}

/** 项目的一个版本 */
export interface ProjectVersion {
  id: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  /** 该版本依赖的其他项目（必装） */
  dependencies: ProjectDependency[];
  files: ProjectFile[];
  datePublished: string;
}

/** 搜索默认页大小 / 上限（Modrinth 服务端上限 100） */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_MAX_OFFSET = 10_000;

/** 允许的排序方式（服务端参数 index） */
export const SORT_OPTIONS = ['relevance', 'downloads', 'follows', 'newest', 'updated'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

/** 把任意排序字段收敛到服务端认识的那个（认不出用 relevance，与官方默认一致） */
export function normalizeSort(raw: unknown): SortOption {
  if (typeof raw !== 'string') return 'relevance';
  const text = raw.trim().toLowerCase();
  return (SORT_OPTIONS as readonly string[]).includes(text) ? (text as SortOption) : 'relevance';
}

/**
 * 游戏版本白名单：只允许字母数字和 . _ - +（官方版本 id 就这些字符：`1.21.4`、`26.2-rc-1`、
 * `1.20.1+pre`）。
 *
 * 为什么要它：`gameVersion` 会被拼进 facets，而 facets 是「拼进 query 的一段 JSON」。
 * 虽然客户端对整段做了 URL 编码，但一个带引号 / 空格 / 反斜杠的版本号会让
 * `versions:…` 这个 token 本身变得没有意义（服务端只会返回 0 条，用户却看不出原因）。
 * 在入口处拒绝，比让用户对着空结果发呆好。
 */
const GAME_VERSION_PATTERN = /^[A-Za-z0-9._+-]+$/;

/** 校验游戏版本号；合法返回 null，非法返回人话原因 */
export function checkGameVersion(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return '游戏版本号必须是字符串。';
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text.length > 32) return `游戏版本号过长（${String(text.length)} 个字符，上限 32）：「${text}」。`;
  if (!GAME_VERSION_PATTERN.test(text)) {
    return `游戏版本号里只能有字母、数字与 . _ + - ：「${text}」。`;
  }
  return null;
}

/** 加载器名同理：Modrinth 的加载器 token 是 `fabric` / `neoforge` / `quilt` 这类短名 */
const LOADER_PATTERN = /^[a-z0-9._+-]{1,32}$/i;

/** 校验加载器名；合法返回 null */
export function checkLoader(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return '加载器名必须是字符串。';
  const text = raw.trim();
  if (text.length === 0) return null;
  if (!LOADER_PATTERN.test(text)) return `加载器名里只能有字母、数字与 . _ + - ：「${text}」。`;
  return null;
}

// ───────────────────────────── facets 编码 ─────────────────────────────

/**
 * 一条 facet 条件：`["project_type:mod"]`。
 *
 * Modrinth 的 facets 是「数组的数组」：
 *   外层数组之间是 AND，内层数组里的候选项是 OR。
 *   要「mod 且 1.21 且 (fabric 或 quilt)」就是：
 *   [["project_type:mod"],["versions:1.21"],["categories:fabric","categories:quilt"]]
 *
 * 编码上的坑（真实踩过）：
 *   - `JSON.stringify` 出来的 `+`、`&`、`#`、空格在查询串里会被服务端/中间层误解，
 *     所以整段必须走 `encodeURIComponent`；
 *   - 版本号里有 `+`（`1.20.1+pre`）、`-`、`rc` 这类字符，
 *     手工拼字符串极容易漏编码，测试里专门有这一条。
 */
export function buildFacets(
  opts: Pick<SearchOptions, 'projectType' | 'gameVersion' | 'loader'>,
): string[][] {
  const facets: string[][] = [];
  if (opts.projectType !== undefined && isProjectType(opts.projectType)) {
    facets.push([`project_type:${opts.projectType}`]);
  }
  const version = typeof opts.gameVersion === 'string' ? opts.gameVersion.trim() : '';
  if (version.length > 0) facets.push([`versions:${version}`]);
  const loader = typeof opts.loader === 'string' ? opts.loader.trim() : '';
  if (loader.length > 0) facets.push([`categories:${loader}`]);
  return facets;
}

/** facets → 查询串里那个 `facets=` 的值（已完整编码，可直接拼进 URL） */
export function encodeFacets(facets: readonly (readonly string[])[]): string {
  return encodeURIComponent(JSON.stringify(facets.map((group) => [...group])));
}

// ───────────────────────────── 版本挑选 ─────────────────────────────

/** 版本挑选条件 */
export interface VersionFilter {
  gameVersion: string;
  loader?: string;
}

/**
 * 一张「匹配分」表，只为了让挑选规则可读、可测：
 *   文件 primary                +8   （官方指定的主文件）
 *   游戏版本精确匹配            +4   （`1.21` 命中，`1.21.1` 不命中）
 *   加载器匹配                  +2
 *   日期更新                    +0~1（同分时新的优先，见 pickBestVersion）
 */
const SCORE_PRIMARY = 8;
const SCORE_VERSION = 4;
const SCORE_LOADER = 2;

function primaryFile(version: ProjectVersion): ProjectFile | undefined {
  return version.files.find((f) => f.primary) ?? version.files[0];
}

/** 这个版本能不能交给这个条件用（不满足就完全不考虑，不靠分数兜） */
function matchesFilter(version: ProjectVersion, filter: VersionFilter): boolean {
  const wantedVersion = typeof filter.gameVersion === 'string' ? filter.gameVersion.trim() : '';
  if (wantedVersion.length > 0 && !version.gameVersions.includes(wantedVersion)) return false;

  const wantedLoader = typeof filter.loader === 'string' ? filter.loader.trim() : '';
  if (wantedLoader.length > 0) {
    // 没有加载器概念的资源包/光影，loaders 里通常带 "minecraft" / "iris" 之类；
    // 这里只在「版本确实声明了加载器」时才要求匹配，避免把资源包全过滤掉。
    if (version.loaders.length === 0) return false;
    if (!version.loaders.includes(wantedLoader)) return false;
  }
  return true;
}

function scoreVersion(version: ProjectVersion, filter: VersionFilter): number {
  let score = 0;
  if (version.files.some((f) => f.primary)) score += SCORE_PRIMARY;

  const wantedVersion = typeof filter.gameVersion === 'string' ? filter.gameVersion.trim() : '';
  if (wantedVersion.length > 0) {
    // 「精确命中」与「包含但还多支持几个」都算，但精确命中的略高一点：
    // 1.21 的版本里优先挑只标了 1.21 的那条，避免给用户一个「附赠 1.22」的实验版本。
    score += SCORE_VERSION;
    if (version.gameVersions.length === 1) score += 1;
  }

  const wantedLoader = typeof filter.loader === 'string' ? filter.loader.trim() : '';
  if (wantedLoader.length > 0 && version.loaders.includes(wantedLoader)) {
    // 只支持这一个加载器的版本优先于「fabric + quilt + neoforge 通吃」的版本：
    // 前者通常是作者专门为它构建的，后者偶尔会有平台兼容层的怪问题。
    score += SCORE_LOADER;
    if (version.loaders.length === 1) score += 1;
  }

  return score;
}

/**
 * 选最佳匹配版本：优先 primary 文件、匹配 gameVersion + loader。
 *
 * 规则（按优先级）：
 *   1. 硬过滤：gameVersion 必须命中；给了 loader 就必须命中（都不满足 → undefined，不硬凑）
 *   2. 打分：primary 文件 > 精确游戏版本 > 单一加载器
 *   3. 同分取**更新**的（datePublished 降序），再同分取**更靠前**的（尊重服务端顺序）
 *
 * 找不到就是 undefined —— 让调用方如实告诉用户「没有适配你这个版本的构建」，
 * 而不是把别的版本的 jar 塞进来让游戏崩在启动阶段。
 */
export function pickBestVersion(
  versions: readonly ProjectVersion[],
  filter: VersionFilter,
): ProjectVersion | undefined {
  let best: ProjectVersion | undefined;
  let bestScore = -1;

  for (const version of versions) {
    if (!Array.isArray(version.files) || version.files.length === 0) continue;
    if (!matchesFilter(version, filter)) continue;

    const score = scoreVersion(version, filter);
    if (score > bestScore) {
      best = version;
      bestScore = score;
      continue;
    }
    if (score === bestScore && best !== undefined) {
      const cmp = comparePublished(version, best);
      if (cmp > 0) best = version;
    }
  }

  return best;
}

/** 发布时间降序比较：a 比 b 新返回正数；解析不了按 0 处理（不让坏日期改变选择） */
export function comparePublished(a: ProjectVersion, b: ProjectVersion): number {
  const ta = Date.parse(a.datePublished);
  const tb = Date.parse(b.datePublished);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return ta - tb;
}

/** 版本的主文件（没有 primary 就用第一个，Modrinth 保证至少一个文件） */
export { primaryFile };

/** 从版本里取主文件用于下载；没有文件返回 undefined */
export function pickFile(version: ProjectVersion): ProjectFile | undefined {
  return primaryFile(version);
}
