/**
 * Modrinth API v2 客户端。
 *
 * 契约要点：
 *   - **无需 API key**，但官方要求 User-Agent 能标识出调用方：
 *     `PCL3/<version> (github.com/LIHUALAO/cpcl3)`
 *   - 端点：`/v2/search`、`/v2/project/{id}`、`/v2/project/{id}/version`
 *   - 搜索**不落盘**（实时性优先）；`getProject` 允许 5 分钟内存缓存
 *   - 网络失败给人话错误，绝不把裸 `fetch failed` 抛给 UI
 *
 * 为什么错误要包一层 `ModrinthError`：
 *   上层（Web API）要按 kind 给出不同的提示与状态码
 *   （网络问题 502、项目不存在 404、参数不合法 400），
 *   光凭 `TypeError: fetch failed` 是分不出来的。
 */

import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_OFFSET,
  buildFacets,
  checkGameVersion,
  checkLoader,
  encodeFacets,
  isProjectType,
  normalizeSort,
  pickBestVersion,
  type ProjectDetail,
  type ProjectDependency,
  type ProjectFile,
  type ProjectSummary,
  type ProjectType,
  type ProjectVersion,
  type SearchOptions,
  type VersionFilter,
} from './types.js';

// ───────────────────────────── 常量 ─────────────────────────────

/** 官方 API 根地址（可在构造参数里覆盖，便于测试与将来换镜像） */
export const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';

/** 版本号：`package.json` 的 version。这里写死常量而不是读文件，避免 ESM 下的路径花样 */
export const CLIENT_VERSION = '0.1.0';

/** 默认 User-Agent（Modrinth 明确要求能联系到调用方） */
export const DEFAULT_USER_AGENT = `PCL3/${CLIENT_VERSION} (github.com/LIHUALAO/cpcl3)`;

/** getProject 的内存缓存 TTL：5 分钟 */
export const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000;

/** 默认单次请求超时 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 项目详情缓存上限：几百个项目的对象，几百 KB 级别，够用又不会失控 */
const PROJECT_CACHE_MAX_ENTRIES = 512;

// ───────────────────────────── 错误 ─────────────────────────────

export type ModrinthErrorKind =
  /** 网络层：DNS / 连接 / 超时 / TLS */
  | 'network'
  /** 服务器返回了非 2xx */
  | 'http'
  /** 项目 / 版本不存在 */
  | 'not-found'
  /** 请求参数不合法（本地就能发现） */
  | 'invalid'
  /** 返回体不是预期的 JSON 形状 */
  | 'bad-response';

/** Modrinth 相关错误：message 已经是人话，可以直接给用户看 */
export class ModrinthError extends Error {
  readonly kind: ModrinthErrorKind;
  /** HTTP 状态码（如果走到过服务端） */
  readonly status?: number;
  /** 出错的 URL */
  readonly url?: string;
  /** 给用户的补充建议（前端可以显示成第二行） */
  readonly hint?: string;

  constructor(
    kind: ModrinthErrorKind,
    message: string,
    extra: { status?: number; url?: string; hint?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ModrinthError';
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.url !== undefined) this.url = extra.url;
    if (extra.hint !== undefined) this.hint = extra.hint;
    if (extra.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = extra.cause;
    }
  }
}

// ───────────────────────────── 客户端 ─────────────────────────────

export interface ModrinthClientOptions {
  /** 注入 fetch（测试用；默认全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 覆盖 User-Agent */
  userAgent?: string;
  /** 覆盖 API 根地址（测试 / 镜像） */
  apiBase?: string;
  /** 单次请求超时（毫秒），默认 15 秒 */
  timeoutMs?: number;
  /** 项目详情缓存 TTL，传 0 关闭缓存（测试用） */
  projectCacheTtlMs?: number;
  /** 注入时钟（测试缓存过期用） */
  now?: () => number;
}

interface CacheEntry {
  value: ProjectDetail;
  expiresAt: number;
}

export class ModrinthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  /** slug / id → 详情缓存（内存，进程退出即丢，不落盘） */
  private readonly projectCache = new Map<string, CacheEntry>();

  constructor(opts: ModrinthClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = typeof opts.userAgent === 'string' && opts.userAgent.trim().length > 0
      ? opts.userAgent.trim()
      : DEFAULT_USER_AGENT;
    this.apiBase = (opts.apiBase ?? MODRINTH_API_BASE).replace(/\/+$/, '');
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1000, opts.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = Number.isFinite(opts.projectCacheTtlMs)
      ? Math.max(0, opts.projectCacheTtlMs as number)
      : PROJECT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 当前使用的 User-Agent（排障用） */
  get ua(): string {
    return this.userAgent;
  }

  // ───────────────────────── 搜索 ─────────────────────────

  /**
   * 搜索项目。
   *
   * `limit` / `offset` 在这里就夹到合法范围：负 limit 或巨大的 offset
   * 在服务端会变成 400，本地先收敛能少一次往返，也让前端行为可预期。
   */
  async search(opts: SearchOptions): Promise<{ hits: ProjectSummary[]; totalHits: number }> {
    const query = typeof opts.query === 'string' ? opts.query.trim() : '';
    const limit = clampInt(opts.limit, 1, SEARCH_MAX_LIMIT, SEARCH_DEFAULT_LIMIT);
    const offset = clampInt(opts.offset, 0, SEARCH_MAX_OFFSET, 0);

    if (opts.projectType !== undefined && !isProjectType(opts.projectType)) {
      throw new ModrinthError('invalid', `不支持的内容类型「${String(opts.projectType)}」，只支持 mod / resourcepack / shader / datapack / modpack。`);
    }
    // 版本号 / 加载器会拼进 facets 的 token 里：形状不对就直接拒绝，
    // 免得发出一个「语法正确但永远 0 结果」的请求，让用户以为这个筛选下真的没东西。
    const versionProblem = checkGameVersion(opts.gameVersion);
    if (versionProblem !== null) throw new ModrinthError('invalid', versionProblem);
    const loaderProblem = checkLoader(opts.loader);
    if (loaderProblem !== null) throw new ModrinthError('invalid', loaderProblem);

    const url = new URL(`${this.apiBase}/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('index', normalizeSort(opts.sortBy));

    const facets = buildFacets(opts);
    if (facets.length > 0) {
      // 注意：这里把已编码好的串**再塞进** URLSearchParams 会被二次编码（%25 之类），
      // 所以直接用 searchParams.set —— URLSearchParams 自己会正确编码这一段。
      url.searchParams.set('facets', JSON.stringify(facets));
    }

    const data = await this.getJson(url.toString());
    const record = asRecord(data);
    const rawHits = record === undefined ? undefined : record['hits'];

    if (!Array.isArray(rawHits)) {
      throw new ModrinthError('bad-response', 'Modrinth 搜索接口返回的数据里没有 hits 数组，可能是接口改版了。', {
        url: url.toString(),
      });
    }

    const hits: ProjectSummary[] = [];
    for (const item of rawHits) {
      const summary = toProjectSummary(item);
      if (summary !== undefined) hits.push(summary);
    }

    const rawTotal = record === undefined ? undefined : record['total_hits'];
    const totalHits = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : hits.length;

    return { hits, totalHits };
  }

  // ───────────────────────── 项目详情 ─────────────────────────

  /**
   * 取项目详情（支持 slug 或项目 id）。带 5 分钟内存缓存。
   *
   * 缓存键统一小写：Modrinth 的 slug 本身是大小写不敏感的短名。
   */
  async getProject(slugOrId: string): Promise<ProjectDetail> {
    const key = this.requireSlugOrId(slugOrId);

    const cached = this.projectCache.get(key.toLowerCase());
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cloned(cached.value);
    }

    const url = `${this.apiBase}/project/${encodeURIComponent(key)}`;
    let data: unknown;
    try {
      data = await this.getJson(url);
    } catch (error) {
      if (error instanceof ModrinthError && error.kind === 'not-found') {
        throw new ModrinthError('not-found', `Modrinth 上找不到项目「${key}」。`, {
          status: error.status,
          url,
          hint: '请检查 slug 是否拼错；也可以在「内容」面板里直接搜索。',
        });
      }
      throw error;
    }

    const detail = toProjectDetail(data);
    if (detail === undefined) {
      throw new ModrinthError('bad-response', `Modrinth 返回的项目数据格式不对（${key}）。`, { url });
    }

    if (this.cacheTtlMs > 0) {
      this.remember(key, detail);
    }
    return cloned(detail);
  }

  // ───────────────────────── 版本列表 ─────────────────────────

  /**
   * 列出某项目的版本，可按游戏版本 / 加载器过滤。
   *
   * 过滤交给服务端（`game_versions` / `loaders` 两个 JSON 数组参数），
   * 因为一个大型模组可能有 300+ 个版本，全拉回来再过滤会白白多传几百 KB。
   * 服务端过滤失败（老项目 / 特殊类型不认这些参数）时退回「全量 + 本地过滤」。
   */
  async listVersions(slugOrId: string, filter: Partial<VersionFilter> = {}): Promise<ProjectVersion[]> {
    const key = this.requireSlugOrId(slugOrId);

    const url = new URL(`${this.apiBase}/project/${encodeURIComponent(key)}/version`);
    const gameVersion = typeof filter.gameVersion === 'string' ? filter.gameVersion.trim() : '';
    const loader = typeof filter.loader === 'string' ? filter.loader.trim() : '';
    const versionProblem = checkGameVersion(gameVersion);
    if (versionProblem !== null) throw new ModrinthError('invalid', versionProblem);
    const loaderProblem = checkLoader(loader);
    if (loaderProblem !== null) throw new ModrinthError('invalid', loaderProblem);
    if (gameVersion.length > 0) url.searchParams.set('game_versions', JSON.stringify([gameVersion]));
    if (loader.length > 0) url.searchParams.set('loaders', JSON.stringify([loader]));

    let data: unknown;
    try {
      data = await this.getJson(url.toString());
    } catch (error) {
      if (error instanceof ModrinthError && error.kind === 'not-found') {
        throw new ModrinthError('not-found', `Modrinth 上找不到项目「${key}」，无法列出它的版本。`, {
          status: error.status,
          url: url.toString(),
        });
      }
      throw error;
    }

    if (!Array.isArray(data)) {
      throw new ModrinthError('bad-response', `Modrinth 返回的「${key}」版本列表不是数组，可能是接口改版了。`, {
        url: url.toString(),
      });
    }

    const out: ProjectVersion[] = [];
    for (const item of data) {
      const version = toProjectVersion(item);
      if (version !== undefined) out.push(version);
    }

    // 防御：服务端若忽略了过滤参数，这里再本地过一遍，保证调用方拿到的都是真匹配的
    if (gameVersion.length > 0 || loader.length > 0) {
      return out.filter((v) => {
        if (gameVersion.length > 0 && !v.gameVersions.includes(gameVersion)) return false;
        if (loader.length > 0 && v.loaders.length > 0 && !v.loaders.includes(loader)) return false;
        return true;
      });
    }
    return out;
  }

  /** 选最佳匹配版本（纯函数转发，不请求网络） */
  pickBestVersion(versions: readonly ProjectVersion[], filter: VersionFilter): ProjectVersion | undefined {
    return pickBestVersion(versions, filter);
  }

  /** 清空项目详情缓存（测试 / 排障用） */
  clearProjectCache(): void {
    this.projectCache.clear();
  }

  // ───────────────────────── 内部 ─────────────────────────

  private requireSlugOrId(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new ModrinthError('invalid', '缺少项目标识（slug 或项目 id）。');
    }
    const key = raw.trim();
    if (key.length > 128) {
      throw new ModrinthError('invalid', '项目标识过长（上限 128 字符）。');
    }
    if (!/^[A-Za-z0-9_.+-]+$/.test(key)) {
      throw new ModrinthError('invalid', `项目标识里含非法字符：「${key}」。只能包含字母、数字与 . _ + -。`);
    }
    return key;
  }

  /** 统一的一次 GET：超时、头部、错误归类全在这里 */
  private async getJson(url: string): Promise<unknown> {
    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // 不要让这个定时器拖住进程退出（测试里尤其重要）
    (timer as unknown as { unref?: () => void }).unref?.();

    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw toNetworkError(error, url);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) {
      throw new ModrinthError('not-found', 'Modrinth 上找不到这个项目或版本（404）。', { status: 404, url });
    }
    if (res.status === 429) {
      throw new ModrinthError('http', 'Modrinth 限流了（429），请稍后再试。', {
        status: 429,
        url,
        hint: '官方限制大约每分钟 300 次请求；连续快速搜索容易触发。',
      });
    }
    if (!res.ok) {
      throw new ModrinthError('http', `Modrinth 返回 HTTP ${String(res.status)}。`, { status: res.status, url });
    }

    const text = await res.text().catch((error: unknown) => {
      throw new ModrinthError('network', `读取 Modrinth 响应时连接中断：${messageOf(error)}`, { status: res.status, url });
    });

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ModrinthError('bad-response', `Modrinth 返回的不是合法 JSON（${messageOf(error)}）。`, {
        status: res.status,
        url,
      });
    }
  }

  /** 缓存写入 + LRU 淘汰（Map 的插入顺序就是淘汰顺序） */
  private remember(key: string, value: ProjectDetail): void {
    const k = key.toLowerCase();
    this.projectCache.delete(k);
    this.projectCache.set(k, { value, expiresAt: this.now() + this.cacheTtlMs });
    while (this.projectCache.size > PROJECT_CACHE_MAX_ENTRIES) {
      const oldest = this.projectCache.keys().next();
      if (oldest.done === true) break;
      this.projectCache.delete(oldest.value);
    }
  }
}

// ───────────────────────────── 归一化 ─────────────────────────────

/** 搜索 hit → ProjectSummary（字段缺失就补默认值，绝不因为一条脏数据炸掉整页） */
function toProjectSummary(raw: unknown): ProjectSummary | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;

  const slug = asString(rec['slug']);
  const title = asString(rec['title']);
  if (slug === undefined && title === undefined) return undefined;

  const summary: ProjectSummary = {
    slug: slug ?? (asString(rec['project_id']) ?? ''),
    title: title ?? (slug ?? ''),
    description: asString(rec['description']) ?? '',
    downloads: asNumber(rec['downloads']) ?? 0,
    projectType: asString(rec['project_type']) ?? 'mod',
    categories: asStringArray(rec['display_categories']) ?? asStringArray(rec['categories']) ?? [],
    latestGameVersions: asStringArray(rec['versions']) ?? [],
  };

  const icon = asString(rec['icon_url']);
  if (icon !== undefined) summary.iconUrl = icon;
  if (summary.slug.length === 0) return undefined;
  return summary;
}

/** 项目详情 → ProjectDetail */
function toProjectDetail(raw: unknown): ProjectDetail | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;

  const slug = asString(rec['slug']);
  if (slug === undefined) return undefined;

  const detail: ProjectDetail = {
    slug,
    title: asString(rec['title']) ?? slug,
    description: asString(rec['description']) ?? '',
    downloads: asNumber(rec['downloads']) ?? 0,
    projectType: asString(rec['project_type']) ?? 'mod',
    categories: asStringArray(rec['categories']) ?? [],
    latestGameVersions: asStringArray(rec['game_versions']) ?? [],
  };

  const icon = asString(rec['icon_url']);
  if (icon !== undefined) detail.iconUrl = icon;
  const body = asString(rec['body']);
  if (body !== undefined) detail.body = body;
  const id = asString(rec['id']);
  if (id !== undefined) detail.id = id;
  const gameVersions = asStringArray(rec['game_versions']);
  if (gameVersions !== undefined) detail.gameVersions = gameVersions;
  const loaders = asStringArray(rec['loaders']);
  if (loaders !== undefined) detail.loaders = loaders;
  const follows = asNumber(rec['follows']);
  if (follows !== undefined) detail.follows = follows;

  // 外链：给前端的「百科 / 官网」按钮用。
  // 这些字段作者可能留空，空串一律视为没有（避免前端渲染出一个点了没反应的按钮）。
  const sourceUrl = asString(rec['source_url']);
  if (sourceUrl !== undefined && sourceUrl !== '') detail.sourceUrl = sourceUrl;
  const wikiUrl = asString(rec['wiki_url']);
  if (wikiUrl !== undefined && wikiUrl !== '') detail.wikiUrl = wikiUrl;
  const issuesUrl = asString(rec['issues_url']);
  if (issuesUrl !== undefined && issuesUrl !== '') detail.issuesUrl = issuesUrl;
  const discordUrl = asString(rec['discord_url']);
  if (discordUrl !== undefined && discordUrl !== '') detail.discordUrl = discordUrl;

  return detail;
}

/** 版本 → ProjectVersion */
function toProjectVersion(raw: unknown): ProjectVersion | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;

  const id = asString(rec['id']);
  if (id === undefined) return undefined;

  const files: ProjectFile[] = [];
  const rawFiles = rec['files'];
  if (Array.isArray(rawFiles)) {
    for (const item of rawFiles) {
      const file = toProjectFile(item);
      // 没有 url / filename 的条目不可下载，直接丢掉（留着只会让安装阶段报错）
      if (file !== undefined) files.push(file);
    }
  }

  return {
    id,
    versionNumber: asString(rec['version_number']) ?? id,
    gameVersions: asStringArray(rec['game_versions']) ?? [],
    loaders: asStringArray(rec['loaders']) ?? [],
    dependencies: toDependencies(rec['dependencies']),
    files,
    datePublished: asString(rec['date_published']) ?? '',
  };
}

function toProjectFile(raw: unknown): ProjectFile | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;

  const url = asString(rec['url']);
  const filename = asString(rec['filename']);
  if (url === undefined || filename === undefined) return undefined;

  const file: ProjectFile = {
    url,
    filename,
    size: asNumber(rec['size']) ?? 0,
    primary: rec['primary'] === true,
  };
  const hashes = asRecord(rec['hashes']);
  const sha1 = hashes === undefined ? undefined : asString(hashes['sha1']);
  if (sha1 !== undefined) file.sha1 = sha1;
  return file;
}

function toDependencies(raw: unknown): ProjectDependency[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectDependency[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const type = asString(rec['dependency_type']);
    const dependency: ProjectDependency = {
      dependencyType:
        type === 'required' || type === 'optional' || type === 'incompatible' || type === 'embedded'
          ? type
          : 'required',
    };
    const projectId = asString(rec['project_id']);
    if (projectId !== undefined) dependency.projectId = projectId;
    const versionId = asString(rec['version_id']);
    if (versionId !== undefined) dependency.versionId = versionId;
    // 两个 id 都没有的依赖无从解析，丢掉。
    // 注意：`dependency_type` 缺失是**合法**的 —— 老版本 Modrinth 数据里常见，
    // 官方语义是 "required"，上面已经按 required 兜底，不能因此把这条依赖吞掉。
    if (dependency.projectId === undefined && dependency.versionId === undefined) continue;
    out.push(dependency);
  }
  return out;
}

// ───────────────────────────── 小工具 ─────────────────────────────

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function asString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function asNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function asStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((item): item is string => typeof item === 'string');
  return out;
}

/** 缓存命中时返回副本：调用方乱改返回对象不会污染缓存 */
function cloned(detail: ProjectDetail): ProjectDetail {
  return {
    ...detail,
    categories: [...detail.categories],
    latestGameVersions: [...detail.latestGameVersions],
    ...(detail.gameVersions === undefined ? {} : { gameVersions: [...detail.gameVersions] }),
    ...(detail.loaders === undefined ? {} : { loaders: [...detail.loaders] }),
  };
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 把 fetch 的各种失败翻成人话（DNS / 超时 / 连接被拒 / TLS） */
function toNetworkError(error: unknown, url: string): ModrinthError {
  const raw = messageOf(error);
  const name = error instanceof Error ? error.name : '';

  if (name === 'AbortError' || /aborted|timeout/i.test(raw)) {
    return new ModrinthError('network', '连 Modrinth 超时了，网络可能不稳。', {
      url,
      hint: '稍后重试；国内网络访问 api.modrinth.com 有时需要代理。',
      cause: error,
    });
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return new ModrinthError('network', '解析不了 api.modrinth.com 的域名，本机可能没网或 DNS 不通。', {
      url,
      hint: '检查网络 / 代理设置后重试。',
      cause: error,
    });
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(raw)) {
    return new ModrinthError('network', '与 Modrinth 的连接被中断了，网络环境可能不稳定。', {
      url,
      hint: '检查代理 / 防火墙后重试。',
      cause: error,
    });
  }
  if (/CERT|SSL|TLS/i.test(raw)) {
    return new ModrinthError('network', '访问 Modrinth 时 TLS 握手失败（可能是代理的证书问题）。', {
      url,
      cause: error,
    });
  }
  return new ModrinthError('network', `连不上 Modrinth：${raw}`, { url, cause: error });
}
