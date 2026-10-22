/**
 * java-runtime 清单（两段式）的拉取与磁盘缓存。
 *
 * ## 两段式是什么
 *
 * 第一段：`all.json`
 *   `https://launchermeta.mojang.com/v1/products/java-runtime/<ver>/all.json`
 *   结构是 **platform → component → 条目数组**（实测，见 platform.ts 顶部注释）：
 *
 *   ```json
 *   {
 *     "windows-x64": {
 *       "java-runtime-delta": [
 *         {
 *           "availability": { "group": 7609, "progress": 100 },
 *           "manifest": {
 *             "sha1": "…40hex…",
 *             "size": 148571,
 *             "url": "https://piston-meta.mojang.com/v1/packages/…/manifest.json"
 *           },
 *           "version": { "name": "21.0.x", "released": "…" }
 *         }
 *       ],
 *       "linux": { … }
 *     }
 *   }
 *   ```
 *
 * 第二段：上面那个 `manifest.url`，内容是 `{ files: { "<相对路径>": 条目 } }`。
 *   条目有三种 type，见 installer.ts。
 *
 * ## 缓存
 *
 *   - `<dataRoot>/java/_manifest.json`      —— 只有 **all.json** 这一段（体积小、变动极少）
 *   - `<dataRoot>/java/_manifest.meta.json` —— 旁挂 `{ fetchedAt, url }`，记录拉取时间
 *
 * TTL 24 小时：JRE 清单变动极少，没必要每次启动都拉。
 * 网络失败时**回退过期缓存**并打 warning，只有「网络失败 + 磁盘无缓存」才抛错。
 *
 * 运行时自身的 manifest.json（第二段）**不进这里**：它体积可以到几百 KB 且每个 component 一份，
 * 按需拉取即可。真正落盘的是 JRE 文件本体，`isInstalled` 以文件为准，不依赖清单缓存。
 *
 * ## 为什么不复用 version 模块的 MetaCache
 *
 * MetaCache 位于 `src/core/version/`，属于 version-dev 的模块私有实现；跨模块 import 会制造
 * 隐性耦合，且它的目录布局绑死在 `<dataRoot>/meta/`。这里只用到「读 JSON / 原子写 JSON / 判新鲜」
 * 三件小事，直接内联更清晰，也不越界。
 */

import fs from 'node:fs';
import path from 'node:path';

import { fetchText } from '../version/http.js';

/** 官方 all.json 根（`{ROOT}/all.json`） */
export const JAVA_RUNTIME_PRODUCT_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871';

/** 国内镜像（BMCLAPI）。它是**同路径前缀**镜像，直接替换 origin 即可。 */
export const BMCLAPI_ROOT = 'https://bmclapi2.bangbang93.com';

/** 缓存 TTL：24 小时 */
export const DEFAULT_MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;

/** 清单缓存文件名（固定名，不是每个 component 一份） */
export const MANIFEST_CACHE_FILE = '_manifest.json';
export const MANIFEST_META_FILE = '_manifest.meta.json';

/**
 * 第一段清单里单个 component 在某平台上的条目。
 * 真实数据里还有 `availability`，这里不声明但只要不丢字段就行——多余字段会被原样保留。
 */
export interface JavaRuntimeEntry {
  manifest: { url: string; sha1: string; size: number };
  version: { name: string; released: string };
  availability?: { group: number; progress: number };
}

/**
 * all.json 的解析结果。
 *
 * 设计稿写的是 `[component][platform]`，实测是 **`[platform][component]`**。
 * 这里按实测结构声明；为了方便调用方与设计稿对齐，额外导出了
 * `listComponents` / `entriesForComponent` 两个访问器，不要自己手写下标。
 */
export interface JavaRuntimeManifest {
  [platformOrComponent: string]: {
    [componentOrPlatform: string]: JavaRuntimeEntry[];
  };
}

/** 第二段：运行时清单 `{ files: { 相对路径: 条目 } }` */
export interface JavaRuntimeFilesManifest {
  files: Record<string, JavaRuntimeFileEntry>;
}

export type JavaRuntimeFileType = 'file' | 'directory' | 'link';

export interface JavaRuntimeFileEntry {
  type: JavaRuntimeFileType;
  /** file 才有；link 没有 */
  downloads?: {
    raw?: { url: string; sha1: string; size: number };
    /** 实测存在 lzma 变体，我们只用 raw（通用、无需解压器） */
    lzma?: { url: string; sha1: string; size: number };
  };
  /** file 才可能为 true */
  executable?: boolean;
  /** link 才有：相对符号链接目标 */
  target?: string;
}

/** 可注入的抓取实现（测试注入，生产默认 fetchText） */
export type TextFetcher = (url: string) => Promise<string>;

export interface ManifestStoreOptions {
  /** `<dataRoot>/java` 目录 */
  javaDir: string;
  /** 镜像根；空/undefined 表示只用官方 */
  mirror?: string | undefined;
  /** 缓存 TTL（毫秒） */
  ttlMs?: number;
  /** 注入的抓取实现 */
  fetchTextImpl?: TextFetcher;
  /** 注入的 logger */
  logger?: { warn(message: string, ...args: unknown[]): void };
  /** 注入时钟（测试用） */
  now?: () => number;
}

export interface ManifestCacheMeta {
  fetchedAt: number;
  url: string;
}

const consoleLogger = {
  warn: (message: string, ...args: unknown[]): void => {
    console.warn(message, ...args);
  },
};

/** 把镜像根套到官方 URL 上：BMCLAPI 与官方同路径，只换 origin。 */
export function withMirror(url: string, mirror?: string): string {
  if (typeof mirror !== 'string') return url;
  const base = mirror.trim().replace(/\/+$/, '');
  if (base === '') return url;
  try {
    const target = new URL(url);
    const m = new URL(base);
    target.protocol = m.protocol;
    target.host = m.host;
    return target.toString();
  } catch {
    return url;
  }
}

/** 直接从 all.json 结构里取某个 component 在给定平台候选上的条目（纯函数，先平台后组件）。 */
export function entriesForComponent(
  manifest: JavaRuntimeManifest,
  component: string,
  platforms: readonly string[],
): JavaRuntimeEntry[] {
  for (const platform of platforms) {
    const byComponent = manifest[platform];
    if (byComponent === undefined || byComponent === null) continue;
    const entries = byComponent[component];
    if (Array.isArray(entries) && entries.length > 0) return entries;
  }
  return [];
}

/**
 * 该 component 在**所有**平台上出现过的所有条目。
 * 用于 `majorVersionOf`（拿 version.name 推主版本），不关心当前机器是什么平台。
 */
export function allEntriesForComponent(
  manifest: JavaRuntimeManifest,
  component: string,
): JavaRuntimeEntry[] {
  const out: JavaRuntimeEntry[] = [];
  for (const value of Object.values(manifest)) {
    if (value === null || typeof value !== 'object') continue;
    const entries = (value as Record<string, unknown>)[component];
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (isRuntimeEntry(e)) out.push(e);
    }
  }
  return out;
}

/** 清单里声明过的全部 component 名（去重，保持稳定顺序）。 */
export function listComponents(manifest: JavaRuntimeManifest): string[] {
  const seen = new Set<string>();
  for (const value of Object.values(manifest)) {
    if (value === null || typeof value !== 'object') continue;
    for (const name of Object.keys(value)) seen.add(name);
  }
  return [...seen];
}

function isRuntimeEntry(value: unknown): value is JavaRuntimeEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<JavaRuntimeEntry>;
  return (
    entry.manifest !== null &&
    typeof entry.manifest === 'object' &&
    typeof entry.manifest?.url === 'string'
  );
}

/** 结构校验：确认拿到的是 platform → component 两层对象，而不是错误页 / 别的 JSON。 */
export function isRuntimeManifest(value: unknown): value is JavaRuntimeManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  let sawComponent = false;
  for (const perPlatform of Object.values(value as Record<string, unknown>)) {
    if (perPlatform === null || typeof perPlatform !== 'object' || Array.isArray(perPlatform)) {
      return false;
    }
    for (const entries of Object.values(perPlatform as Record<string, unknown>)) {
      if (!Array.isArray(entries)) return false;
      if (entries.length > 0) sawComponent = true;
    }
  }
  return sawComponent;
}

/** 原子写 JSON（先写临时文件再 rename，避免半截文件被当成有效缓存）。 */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** 第一段清单的磁盘缓存。 */
export class ManifestStore {
  readonly dir: string;
  readonly cacheFile: string;
  readonly metaFile: string;

  private readonly mirror: string | undefined;
  private readonly ttlMs: number;
  private readonly fetchTextImpl: TextFetcher;
  private readonly logger: NonNullable<ManifestStoreOptions['logger']>;
  private readonly now: () => number;

  /** 同一进程内的并发去重：两个版本同时启动只拉一次 */
  private inflight: Promise<JavaRuntimeManifest> | undefined;
  /** 内存里的最近一次结果（避免反复读盘） */
  private memory: JavaRuntimeManifest | undefined;

  constructor(opts: ManifestStoreOptions) {
    this.dir = opts.javaDir;
    this.cacheFile = path.join(this.dir, MANIFEST_CACHE_FILE);
    this.metaFile = path.join(this.dir, MANIFEST_META_FILE);
    this.mirror = opts.mirror;
    this.ttlMs = opts.ttlMs ?? DEFAULT_MANIFEST_TTL_MS;
    this.fetchTextImpl = opts.fetchTextImpl ?? ((url) => fetchText(url).then((r) => r.text));
    this.logger = opts.logger ?? consoleLogger;
    this.now = opts.now ?? Date.now;
  }

  /** 读磁盘缓存（正文 + 拉取时间），不存在/损坏返回 undefined。 */
  readCache(): { data: JavaRuntimeManifest; fetchedAt?: number } | undefined {
    const raw = readJson(this.cacheFile);
    if (!isRuntimeManifest(raw)) return undefined;
    let fetchedAt: number | undefined;
    const meta = readJson(this.metaFile);
    if (meta !== null && typeof meta === 'object') {
      const at = (meta as Partial<ManifestCacheMeta>).fetchedAt;
      if (typeof at === 'number' && Number.isFinite(at)) fetchedAt = at;
    }
    return fetchedAt === undefined ? { data: raw } : { data: raw, fetchedAt };
  }

  /** 缓存是否新鲜（TTL 内）。 */
  isFresh(now = this.now()): boolean {
    const cached = this.readCache();
    if (cached === undefined || cached.fetchedAt === undefined) return false;
    return now - cached.fetchedAt < this.ttlMs;
  }

  /**
   * 拿清单。`force` 为 true 时跳过 TTL 强制重拉。
   *
   * 行为矩阵：
   *   新鲜缓存 + !force  → 直接返回缓存
   *   网络成功            → 写缓存并返回
   *   网络失败 + 有旧缓存 → 打 warning，返回旧缓存（哪怕过期）
   *   网络失败 + 无缓存   → 抛错（带 URL 与原因）
   */
  async fetch(force = false): Promise<JavaRuntimeManifest> {
    if (!force && this.memory !== undefined) return this.memory;
    if (!force && this.isFresh()) {
      const cached = this.readCache();
      if (cached !== undefined) {
        this.memory = cached.data;
        return cached.data;
      }
    }

    if (this.inflight !== undefined) return this.inflight;
    const task = this.fetchAndStore().finally(() => {
      this.inflight = undefined;
    });
    this.inflight = task;
    return task;
  }

  private async fetchAndStore(): Promise<JavaRuntimeManifest> {
    const url = withMirror(`${JAVA_RUNTIME_PRODUCT_URL}/all.json`, this.mirror);
    let lastError: unknown;
    try {
      const text = await this.fetchTextImpl(url);
      const parsed = JSON.parse(text) as unknown;
      if (!isRuntimeManifest(parsed)) {
        throw new Error(`unexpected java-runtime manifest shape from ${url}`);
      }
      writeJsonAtomic(this.cacheFile, parsed);
      writeJsonAtomic(this.metaFile, { fetchedAt: this.now(), url } satisfies ManifestCacheMeta);
      this.memory = parsed;
      return parsed;
    } catch (err) {
      lastError = err;
    }

    const stale = this.readCache();
    if (stale !== undefined) {
      this.logger.warn(
        `[java] 拉取 java-runtime 清单失败，回退到磁盘缓存（可能已过期）：${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
      this.memory = stale.data;
      return stale.data;
    }

    throw new Error(
      `拉取 java-runtime 清单失败且本地无缓存：${url} — ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
