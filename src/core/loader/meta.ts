/**
 * Meta 网络层：Fabric / Quilt 的版本列表与 profile JSON。
 *
 * 实测事实（2026-10，本机联网验证）——
 *
 *   Fabric
 *     GET /v2/versions/loader                 → 200，255 条，扁平 {separator,build,maven,version,stable}
 *     GET /v2/versions/loader/<gv>            → 200，**嵌套** {loader:{…含 stable}, intermediary, launcherMeta}
 *                                              ⚠ 返回 255 条且与全局列表逐项相同（不按 gv 过滤）
 *     GET /v2/versions/loader/<gv>/<lv>/profile/json → 200，带 inheritsFrom / mainClass / libraries
 *
 *   Quilt
 *     GET /v3/versions/loader                 → 200，307 条，扁平，**没有 stable 字段**
 *     GET /v3/versions/loader/<gv>            → 200，但同样是全量数据且换成嵌套形状
 *                                              {loader, hashed, intermediary, launcherMeta}
 *     GET /v3/versions/loader/<gv>/<lv>/profile/json → 200
 *
 * 结论：**两个「按游戏版本查询」的端点都不可信**，只能当形状兼容层处理；
 * 真正的「这个 loader 版本对这个 gv 有没有 profile」只由 profile 端点决定。
 * 本文件因此：全局列表为主，profile 端点做终极判据。
 */

import type { LoaderKind } from './types.js';
import { LOADER_LABEL, META_RETRIES, META_ROOTS, META_TIMEOUT_MS, META_VERSION_SEGMENT, USER_AGENT } from './endpoints.js';
import type { LoaderVersionInfo } from './types.js';

/** meta 请求失败 */
export class LoaderMetaError extends Error {
  readonly kind: LoaderKind;
  readonly url: string;
  readonly status?: number;

  constructor(message: string, kind: LoaderKind, url: string, status?: number) {
    super(message);
    this.name = 'LoaderMetaError';
    this.kind = kind;
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

// ───────────────────────────── 原始数据结构 ─────────────────────────────

/** 扁平条目（Fabric 全局列表 / Quilt 全局列表） */
interface RawFlatEntry {
  version?: unknown;
  stable?: unknown;
  maven?: unknown;
}

/** Fabric 按 gv 的嵌套条目 */
interface RawFabricGvEntry {
  loader?: RawFlatEntry;
}

/** Quilt 按 gv 的嵌套条目 */
interface RawQuiltGvEntry {
  loader?: RawFlatEntry;
  hashed?: RawFlatEntry;
}

// ───────────────────────────── HTTP ─────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

function metaBase(kind: LoaderKind): string {
  return `${META_ROOTS[kind]}/${META_VERSION_SEGMENT[kind]}/versions/loader`;
}

/** 带超时与重试的 JSON 请求；4xx 直接放弃重试（那是「没有这个资源」，不是抖动） */
async function getJson<T>(kind: LoaderKind, url: string, retries = META_RETRIES): Promise<T> {
  const attempts = Math.max(1, retries + 1);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new LoaderMetaError(
          `${LOADER_LABEL[kind]} meta 返回 HTTP ${String(res.status)}：${url}${body ? ` — ${body.slice(0, 200)}` : ''}`,
          kind,
          url,
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      // 4xx 重试没有意义
      if (e instanceof LoaderMetaError && e.status !== undefined && e.status >= 400 && e.status < 500) {
        throw e;
      }
      if (attempt === attempts - 1) break;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof LoaderMetaError) throw lastError;
  throw new LoaderMetaError(
    `无法访问 ${LOADER_LABEL[kind]} meta（${url}）：${lastError?.message ?? '未知网络错误'}`,
    kind,
    url,
  );
}

// ───────────────────────────── 解析 ─────────────────────────────

/**
 * 从可能存在的三种形状里抠出 {version, stable?, maven?}：
 *   1. 扁平条目 `{version, stable, maven}`
 *   2. Fabric 按 gv 的嵌套 `{loader:{…}}`
 *   3. Quilt 按 gv 的嵌套 `{loader:{…}, hashed:{…}}`
 * 认不出来返回 undefined（不抛错——脏数据不该炸掉整张列表）。
 */
function normalizeEntry(raw: unknown): { version: string; stable?: boolean; maven?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  let candidate: RawFlatEntry | undefined;
  if (typeof obj['version'] === 'string') {
    candidate = obj as RawFlatEntry;
  } else if (obj['loader'] && typeof obj['loader'] === 'object') {
    candidate = obj['loader'] as RawFlatEntry;
  }
  if (!candidate || typeof candidate.version !== 'string' || candidate.version.trim() === '') return undefined;

  const out: { version: string; stable?: boolean; maven?: string } = { version: candidate.version.trim() };
  if (typeof candidate.stable === 'boolean') out.stable = candidate.stable;
  if (typeof candidate.maven === 'string' && candidate.maven.trim() !== '') out.maven = candidate.maven.trim();
  return out;
}

/** 预发布判定：语义化版本里的 alpha / beta / pre / rc / snapshot / dev 之类 */
export function isPrerelease(version: string): boolean {
  return /(?:^|[.\-+])(?:alpha|beta|pre|preview|rc|snapshot|dev|exp)\b/i.test(version) ||
    /-(?:alpha|beta|rc)/i.test(version);
}

/** 把 meta 原始条目变成对外的 LoaderVersionInfo */
function toInfo(entry: { version: string; stable?: boolean; maven?: string }): LoaderVersionInfo {
  const prerelease = isPrerelease(entry.version);
  const info: LoaderVersionInfo = {
    version: entry.version,
    // 没有 stable 字段时：非预发布即视为稳定（启发式，stabilitySource 会如实标注）
    stable: entry.stable ?? !prerelease,
    stabilitySource: entry.stable !== undefined ? 'declared' : 'inferred',
    prerelease,
  };
  if (entry.maven !== undefined) info.maven = entry.maven;
  return info;
}

/** 去重（同版本号只留一条），保持原顺序 */
function dedupe(infos: LoaderVersionInfo[]): LoaderVersionInfo[] {
  const seen = new Set<string>();
  const out: LoaderVersionInfo[] = [];
  for (const info of infos) {
    if (seen.has(info.version)) continue;
    seen.add(info.version);
    out.push(info);
  }
  return out;
}

/**
 * 拉全局 loader 列表（Fabric `/v2/versions/loader`，Quilt `/v3/versions/loader`）。
 *
 * 这是唯一稳定的版本来源：两个项目的按游戏版本接口都不可信（见文件头）。
 */
export async function fetchLoaderVersions(kind: LoaderKind): Promise<LoaderVersionInfo[]> {
  const url = metaBase(kind);
  const raw = await getJson<unknown>(kind, url);
  if (!Array.isArray(raw)) {
    throw new LoaderMetaError(`${LOADER_LABEL[kind]} meta 返回的不是数组：${url}`, kind, url);
  }
  const infos: LoaderVersionInfo[] = [];
  for (const item of raw) {
    const entry = normalizeEntry(item);
    if (entry) infos.push(toInfo(entry));
  }
  if (infos.length === 0) {
    throw new LoaderMetaError(`${LOADER_LABEL[kind]} meta 列表为空或结构无法识别：${url}`, kind, url);
  }
  return dedupe(infos);
}

/**
 * 读取某游戏版本下的 loader 候选（形状兼容层，**不当判据**）。
 *
 * - Fabric：返回嵌套结构，`loader.stable` 可信，但列表本身不按 gv 过滤。
 * - Quilt ：返回嵌套结构，条目里没有 stable。
 *
 * 拿到的列表只用来「排序参考」，适用性必须由 {@link profileUrl} 验证。
 */
export async function fetchLoaderVersionsForGame(kind: LoaderKind, gameVersion: string): Promise<LoaderVersionInfo[]> {
  const url = `${metaBase(kind)}/${encodeURIComponent(gameVersion)}`;
  const raw = await getJson<unknown>(kind, url);
  if (!Array.isArray(raw)) return [];
  const infos: LoaderVersionInfo[] = [];
  for (const item of raw) {
    const entry = normalizeEntry(item);
    if (entry) infos.push(toInfo(entry));
  }
  return dedupe(infos);
}

/** profile JSON 端点 */
export function profileUrl(kind: LoaderKind, gameVersion: string, loaderVersion: string): string {
  return `${metaBase(kind)}/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
}

/**
 * 拉 profile JSON（原样返回，不重写字段）。
 *
 * 这个端点同时是「该组合是否真的可用」的判据：失败即表示这个 loader 版本
 * 没有为这个游戏版本产出 profile。
 */
export async function fetchProfileJson(
  kind: LoaderKind,
  gameVersion: string,
  loaderVersion: string,
  retries = META_RETRIES,
): Promise<Record<string, unknown>> {
  const url = profileUrl(kind, gameVersion, loaderVersion);
  const raw = await getJson<unknown>(kind, url, retries);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LoaderMetaError(`${LOADER_LABEL[kind]} profile 不是对象：${url}`, kind, url);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj['id'] !== 'string' || obj['id'] === '') {
    throw new LoaderMetaError(`${LOADER_LABEL[kind]} profile 缺少 id 字段：${url}`, kind, url);
  }
  return obj;
}

/**
 * 探测某个 loader 版本是否适用于某个游戏版本（不抛错）。
 * 用于给列表补 `applicable` 标记：只做一次 HEAD 级别的轻量确认。
 */
export async function probeApplicable(
  kind: LoaderKind,
  gameVersion: string,
  loaderVersion: string,
): Promise<boolean> {
  const url = profileUrl(kind, gameVersion, loaderVersion);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type { LoaderVersionInfo };
