/**
 * VersionRepository —— 版本元数据仓库。
 *
 * 契约：docs/ARCHITECTURE.md「version 模块」
 *
 * 设计要点：
 *   - 磁盘缓存落在 `<dataRoot>/meta/`，manifest 文件名固定 `version_manifest_v2.json`，
 *     版本 JSON 文件名固定 `<id>.json`，各自有 `.meta.json` 旁挂文件记录拉取时间。
 *   - TTL 10 分钟：TTL 内直接读缓存，不触网。
 *   - 网络失败：只要磁盘上有缓存（哪怕已过期）就返回缓存并打一条 warning，绝不因为网络抖动直接抛错。
 *     只有「网络失败 + 磁盘无缓存」才抛出网络错误（并带 <id>.json 这类定位信息）。
 *   - 镜像：构造函数 `mirror?: string`。官方根 `https://launchermeta.mojang.com`，
 *     国内镜像根 `https://bmclapi2.bangbang93.com`。版本 JSON 的实际 URL 来自 manifest 的 `url` 字段，
 *     切换镜像时把该 URL 的 host 换成镜像 host（path/search 保留）。
 */

import type { DownloadArtifact, VersionJson, VersionManifest, VersionSummary } from '../types.js';
import { getDataRoot as defaultGetDataRoot } from './dataRoot.js';
import { MetaCache, type CacheEntry } from './cache.js';
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, MIRROR_ROOT, OFFICIAL_ROOT } from './http.js';
import { applyMirror, fetchJson, type FetchJsonFn } from './http.js';
import { mergeVersionJson } from './merge.js';

/** 缓存 TTL：10 分钟 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 版本清单缓存文件名（契约要求固定名） */
export const MANIFEST_CACHE_FILE = 'version_manifest_v2.json';

/** 清单在官方根上的路径 */
export const MANIFEST_PATH = '/mc/game/version_manifest_v2.json';

/** 已识别的镜像别名 → 根 URL */
const MIRROR_ALIASES: Record<string, string> = {
  official: OFFICIAL_ROOT,
  mojang: OFFICIAL_ROOT,
  bmclapi: MIRROR_ROOT,
  bmclapi2: MIRROR_ROOT,
  'bmclapi2.bangbang93.com': MIRROR_ROOT,
  'launchermeta.mojang.com': OFFICIAL_ROOT,
};

/**
 * 把构造参数里的 `mirror` 归一化成根 URL。
 * 记住一个坑：BMCLAPI 的版本 JSON 路径与官方一致（`/version/<sha1>/<id>.json`），
 * 因此只替换 host 即可；若调用方给的是裸域名（如 `bmclapi2.bangbang93.com`）要补上 `https://`。
 */
export function normalizeMirrorRoot(mirror?: string): string | undefined {
  if (mirror === undefined) return undefined;
  const raw = mirror.trim();
  if (raw.length === 0) return undefined;

  const alias = MIRROR_ALIASES[raw.toLowerCase()];
  if (alias) {
    // 显式选了官方根，等价于不切镜像（对官方 URL 的重写是恒等变换）
    return alias === OFFICIAL_ROOT ? undefined : alias;
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.host === new URL(OFFICIAL_ROOT).host) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/** 版本 id 是否安全可用作文件名（防目录穿越） */
function assertSafeVersionId(id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('version id must be a non-empty string');
  }
  if (/[\\/:*?"<>|]/.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new Error(`unsafe version id: ${id}`);
  }
}

export interface VersionRepositoryOptions {
  /** 镜像根，例如 `https://bmclapi2.bangbang93.com` 或别名 `bmclapi` */
  mirror?: string;
  /** 数据根目录，默认读取 PCL3_DATA_ROOT / %APPDATA%/PCL3 / ~/.pcl3 */
  dataRoot?: string;
  /** 可注入的 logger（测试里用来断言「网络失败回退时打了警告」） */
  logger?: Logger;
  /** 缓存 TTL（毫秒），默认 10 分钟 */
  ttlMs?: number;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
  /** 单次请求重试次数（不含首次） */
  retries?: number;
  /** 自定义 fetch 实现（测试注入用，返回 `{ data }` 即被当作 JSON 正文） */
  fetchImpl?: FetchJsonFn;
  /** 获取数据根的函数（测试注入用） */
  getDataRoot?: () => string;
}

/** 可注入 logger；只要求有 warn 即可，其余可选 */
export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

const consoleLogger: Logger = {
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  debug: (message, ...args) => console.debug(message, ...args),
};

export class VersionRepository {
  private readonly mirrorRoot: string | undefined;
  private readonly logger: Logger;
  private readonly cache: MetaCache;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchJsonImpl: FetchJsonFn;

  /** 同一进程内的 manifest 并发去重 */
  private manifestInflight: Promise<VersionManifest> | undefined;
  private readonly versionInflight = new Map<string, Promise<VersionJson>>();

  constructor(opts: VersionRepositoryOptions = {}) {
    this.mirrorRoot = normalizeMirrorRoot(opts.mirror);
    this.logger = opts.logger ?? consoleLogger;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.fetchJsonImpl = opts.fetchImpl ?? fetchJson;

    const dataRoot = opts.dataRoot ?? (opts.getDataRoot ?? defaultGetDataRoot)();
    this.cache = new MetaCache(`${dataRoot.replace(/[\\/]+$/, '')}/meta`);
  }

  /** 当前生效的镜像根（undefined 表示走官方） */
  get mirror(): string | undefined {
    return this.mirrorRoot;
  }

  /** 缓存目录（`<dataRoot>/meta`） */
  get cacheDir(): string {
    return this.cache.dir;
  }

  // ───────────────────────────── manifest ─────────────────────────────

  /**
   * 拉取版本清单。
   * @param force 为 true 时忽略 TTL，强制重新拉取（网络失败仍会回退到磁盘缓存）
   */
  async fetchManifest(force = false): Promise<VersionManifest> {
    if (!force) {
      const cached = this.cache.read<VersionManifest>(MANIFEST_CACHE_FILE);
      if (this.cache.isFresh(cached, this.ttlMs)) {
        this.logger.debug?.(`[version] manifest cache hit (fresh): ${cached.file}`);
        return cached.data as VersionManifest;
      }
    }

    const inflight = this.manifestInflight;
    if (inflight) return inflight;

    const task = this.loadManifest().finally(() => {
      this.manifestInflight = undefined;
    });
    this.manifestInflight = task;
    return task;
  }

  private async loadManifest(): Promise<VersionManifest> {
    const url = applyMirror(`${OFFICIAL_ROOT}${MANIFEST_PATH}`, this.mirrorRoot);
    try {
      const { data } = await this.fetchJsonImpl(url, {
        timeoutMs: this.timeoutMs,
        retries: this.retries,
      }) as { data: VersionManifest };
      this.validateManifest(data, url);

      try {
        this.cache.write<VersionManifest>(MANIFEST_CACHE_FILE, data, {
          fetchedAt: Date.now(),
          url,
          mirror: this.mirrorRoot !== undefined,
        });
      } catch (err) {
        this.logger.warn(`[version] failed to persist manifest cache: ${(err as Error).message}`);
      }

      return data;
    } catch (err) {
      const cached = this.cache.read<VersionManifest>(MANIFEST_CACHE_FILE);
      if (cached.data !== undefined) {
        this.logger.warn(
          `[version] manifest fetch failed (${url}): ${(err as Error).message}; ` +
            `falling back to stale on-disk cache ${cached.file}` +
            (cached.meta ? ` (fetched at ${new Date(cached.meta.fetchedAt).toISOString()})` : ' (fetch time unknown)'),
        );
        return cached.data;
      }
      throw err;
    }
  }

  private validateManifest(data: unknown, url: string): asserts data is VersionManifest {
    const manifest = data as Partial<VersionManifest> | null | undefined;
    if (!manifest || typeof manifest !== 'object') {
      throw new Error(`invalid version manifest from ${url}: not an object`);
    }
    if (!Array.isArray(manifest.versions)) {
      throw new Error(`invalid version manifest from ${url}: missing versions[]`);
    }
    if (!manifest.latest || typeof manifest.latest.release !== 'string') {
      throw new Error(`invalid version manifest from ${url}: missing latest.release`);
    }
  }

  // ───────────────────────────── version json ─────────────────────────────

  /**
   * 拉取单个版本 JSON。
   * 优先用磁盘缓存（有缓存且未过期则不触网）；缓存缺失或过期时从 manifest 里找到 `url` 再拉取。
   * 是否走镜像由构造函数决定。
   */
  async fetchVersion(id: string): Promise<VersionJson> {
    assertSafeVersionId(id);

    const cached = this.cache.read<VersionJson>(`${id}.json`);
    if (this.cache.isFresh(cached, this.ttlMs)) {
      this.logger.debug?.(`[version] version cache hit (fresh): ${id}`);
      return cached.data as VersionJson;
    }

    const inflight = this.versionInflight.get(id);
    if (inflight) return inflight;

    const task = this.loadVersion(id, cached).finally(() => {
      this.versionInflight.delete(id);
    });
    this.versionInflight.set(id, task);
    return task;
  }

  private async loadVersion(id: string, cached: CacheEntry<VersionJson>): Promise<VersionJson> {
    const fileName = `${id}.json`;
    let url = '';
    try {
      const manifest = await this.fetchManifest();
      const summary = manifest.versions.find((v) => v.id === id);
      if (!summary) {
        throw new Error(`version "${id}" not found in manifest`);
      }
      // 版本 JSON 的真实 URL 来自 manifest 的 url 字段；切镜像时把 host 换成镜像 host
      url = applyMirror(summary.url, this.mirrorRoot);

      const { data } = await this.fetchJsonImpl(url, {
        timeoutMs: this.timeoutMs,
        retries: this.retries,
      }) as { data: VersionJson };
      if (!data || typeof data !== 'object' || typeof data.id !== 'string') {
        throw new Error(`invalid version json from ${url}`);
      }

      try {
        this.cache.write<VersionJson>(fileName, data, {
          fetchedAt: Date.now(),
          url,
          mirror: this.mirrorRoot !== undefined,
        });
      } catch (err) {
        this.logger.warn(`[version] failed to persist ${id} cache: ${(err as Error).message}`);
      }

      return data;
    } catch (err) {
      if (cached.data !== undefined) {
        this.logger.warn(
          `[version] version fetch failed for ${id}${url ? ` (${url})` : ''}: ${(err as Error).message}; ` +
            `falling back to stale on-disk cache ${cached.file}` +
            (cached.meta ? ` (fetched at ${new Date(cached.meta.fetchedAt).toISOString()})` : ' (fetch time unknown)'),
        );
        return cached.data;
      }
      throw err;
    }
  }

  /** 读本地缓存的版本 JSON（不触网），不存在返回 undefined。给 install/launch 做「离线也能用」的兜底。 */
  readCachedVersion(id: string): VersionJson | undefined {
    assertSafeVersionId(id);
    return this.cache.read<VersionJson>(`${id}.json`).data;
  }

  /** 读本地缓存的版本清单（不触网），不存在返回 undefined。 */
  readCachedManifest(): VersionManifest | undefined {
    return this.cache.read<VersionManifest>(MANIFEST_CACHE_FILE).data;
  }

  /**
   * 把一个已经是本地缓存形态的版本 JSON 写入磁盘（install 模块在安装模组化版本时可用）。
   */
  writeCachedVersion(json: VersionJson): void {
    assertSafeVersionId(json.id);
    this.cache.write<VersionJson>(`${json.id}.json`, json, {
      fetchedAt: Date.now(),
      mirror: this.mirrorRoot !== undefined,
    });
  }

  // ───────────────────────────── 继承链 ─────────────────────────────

  /**
   * 解析继承链（`inheritsFrom`），合并成可直接使用的完整 VersionJson。
   * 支持多层继承（子 → 父 → 祖父 …）；链上任意一层找不到都会抛错。
   */
  async resolveInherited(json: VersionJson): Promise<VersionJson> {
    const chain: VersionJson[] = [json];
    const seen = new Set<string>([json.id]);
    let current = json;

    while (typeof current.inheritsFrom === 'string' && current.inheritsFrom.length > 0) {
      const parentId = current.inheritsFrom;
      if (seen.has(parentId)) {
        throw new Error(`circular inheritsFrom chain detected at "${parentId}"`);
      }
      seen.add(parentId);
      const parent = await this.fetchVersion(parentId);
      chain.push(parent);
      current = parent;
    }

    // chain[0] 是最具体的子版本，反向从最底层父版本开始逐层向上合并
    let merged = chain[chain.length - 1] as VersionJson;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      merged = mergeVersionJson(chain[i] as VersionJson, merged);
    }

    merged.inheritsFrom = undefined;
    return merged;
  }

  /**
   * 便利方法：按 id 拉取并解析继承链。
   */
  async fetchResolvedVersion(id: string): Promise<VersionJson> {
    const json = await this.fetchVersion(id);
    if (typeof json.inheritsFrom === 'string' && json.inheritsFrom.length > 0) {
      return this.resolveInherited(json);
    }
    const { inheritsFrom: _ignored, ...rest } = json;
    return rest as VersionJson;
  }
}

/** 便利函数：从 downloads / assetIndex 里取出 artifact（给 install 模块复用的类型收窄） */
export function pickArtifact(
  downloads: Record<string, DownloadArtifact> | undefined,
  key: string,
): DownloadArtifact | undefined {
  return downloads?.[key];
}

export type { VersionSummary };
