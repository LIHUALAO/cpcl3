/**
 * 极简 HTTPS 抓取 + 镜像 URL 重写。只用 Node 内置模块（node:https / node:http / node:zlib）。
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import type { IncomingMessage } from 'node:http';

/** 官方元数据根 */
export const OFFICIAL_ROOT = 'https://launchermeta.mojang.com';
/** 国内镜像根（BMCLAPI） */
export const MIRROR_ROOT = 'https://bmclapi2.bangbang93.com';

export const DEFAULT_USER_AGENT = 'PCL3/0.1.0 (metadata fetcher; +https://github.com/)';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRIES = 2;
/** 最大重定向次数（BMCLAPI 会用 302 把 manifest 指向自己的 CDN） */
export const MAX_REDIRECTS = 5;

export class FetchError extends Error {
  readonly status?: number;
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  headers?: Record<string, string>;
}

export interface FetchTextResult {
  text: string;
  url: string;
  statusCode: number;
}

export interface FetchJsonResult<T> {
  data: T;
  url: string;
  statusCode: number;
}

function once(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
  redirectsLeft: number,
): Promise<FetchTextResult> {
  return new Promise<FetchTextResult>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new FetchError(`invalid url: ${url}`, url));
      return;
    }

    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(
      parsed,
      {
        method: 'GET',
        headers,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        let stream: NodeJS.ReadableStream = res;

        // 重定向：BMCLAPI 对 manifest 会 302 到自身 CDN，这里跟随（同域或跨域均可）
        const location = res.headers['location'];
        if (status >= 300 && status < 400 && typeof location === 'string' && location.length > 0) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new FetchError(`too many redirects (last ${status} -> ${location})`, url, status));
            return;
          }
          let next: string;
          try {
            next = new URL(location, url).toString();
          } catch {
            reject(new FetchError(`invalid redirect location: ${location}`, url, status));
            return;
          }
          once(next, timeoutMs, headers, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new FetchError(`HTTP ${status} for ${url}`, url, status));
          return;
        }

        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        stream.on('end', () => {
          resolve({ text: Buffer.concat(chunks).toString('utf8'), url, statusCode: status });
        });
        stream.on('error', (err: Error) => {
          reject(new FetchError(`response stream error: ${err.message}`, url, status));
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new FetchError(`timeout after ${timeoutMs}ms: ${url}`, url));
    });
    req.on('error', (err: Error) => {
      reject(err instanceof FetchError ? err : new FetchError(err.message, url));
    });
    req.end();
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 拉取文本，失败按指数退避重试；全部失败后抛出最后一次错误 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchTextResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);

  const headers: Record<string, string> = {
    'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
    accept: 'application/json, */*',
    'accept-encoding': 'gzip, deflate, br',
    ...(opts.headers ?? {}),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await once(url, timeoutMs, headers, MAX_REDIRECTS);
    } catch (err) {
      lastError = err;
      // 4xx 是确定性失败（例如 404），不再重试
      const status = err instanceof FetchError ? err.status : undefined;
      if (status !== undefined && status >= 400 && status < 500) break;
      if (attempt < retries) await sleep(300 * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new FetchError(String(lastError), url);
}

/**
 * 可注入的抓取函数签名。
 * 刻意写成具体类型而不是泛型——测试/调用方注入 stub 时不需要写泛型参数。
 */
export type FetchJsonFn = (url: string, opts?: FetchOptions) => Promise<FetchJsonResult<unknown>>;

/** 拉取并解析 JSON */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<FetchJsonResult<T>> {
  const res = await fetchText(url, opts);
  let data: T;
  try {
    data = JSON.parse(res.text) as T;
  } catch (err) {
    throw new FetchError(`invalid JSON from ${url}: ${(err as Error).message}`, url, res.statusCode);
  }
  return { data, url: res.url, statusCode: res.statusCode };
}

/**
 * 把 URL 的 host 替换成镜像 host（保留 protocol / port / pathname / search）。
 * 镜像为 undefined 时原样返回官方 URL。
 */
export function applyMirror(url: string, mirrorRoot?: string): string {
  if (!mirrorRoot) return url;
  try {
    const target = new URL(url);
    const mirror = new URL(mirrorRoot);
    target.protocol = mirror.protocol;
    target.host = mirror.host;
    return target.toString();
  } catch {
    return url;
  }
}
