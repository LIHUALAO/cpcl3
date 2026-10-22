/**
 * 轻量 HTTP(S) 传输层 —— 只依赖 node:http / node:https / node:fs / node:crypto。
 *
 * 刻意不使用内置 fetch：下载动辄几十上百 MB，需要
 *   - 手写 Range 续传
 *   - 边收边写（背压可控）
 *   - 精确的 socket 级超时与 abort
 * 这些用 https.get + pipe 最直接。
 */

import { type WriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Hash } from 'node:crypto';
import { URL } from 'node:url';

import { type ProxyEndpoint, proxyCreateConnection, shouldBypass } from './proxy.js';

export type { WriteStream };

// ───────────────────────────── 进程级代理 ─────────────────────────────

/**
 * 当前生效的代理。设为 undefined 表示直连。
 *
 * 为什么用模块级变量而不是一路透传参数：
 * 下载链路上有 `fetchOne` → `transferOnce` → `openRequest` 好几层，
 * 每层都加一个 proxy 参数会污染所有签名，而代理是**进程级配置**
 * （一个启动器只有一个代理），用模块级变量最贴合语义。
 *
 * 由 config 模块在配置变更时调用 {@link setActiveProxy} 写入。
 */
let currentProxy: ProxyEndpoint | undefined;

/** 设置当前代理。传 undefined / null 即关闭代理。 */
export function setActiveProxy(proxy: ProxyEndpoint | null | undefined): void {
  currentProxy = proxy ?? undefined;
}

/** 读取当前代理（供测试与诊断） */
export function activeProxy(): ProxyEndpoint | undefined {
  return currentProxy;
}

/** 默认最多跟随几跳重定向。5 跳足够覆盖 BMCLAPI 这类「一跳就到位」的轮换节点。 */
export const DEFAULT_MAX_REDIRECTS = 5;

/** 单次 HTTP 连接的默认参数 */
export interface TransportOptions {
  /** 仅建连超时（毫秒） */
  connectTimeoutMs?: number;
  /** 空闲超时：这么久没有收到任何字节就判定连接死亡 */
  idleTimeoutMs?: number;
  /** User-Agent，镜像/CDN 偶尔会按 UA 做策略 */
  userAgent?: string;
  /**
   * 重定向最大跟随跳数（301/302/303/307/308）。默认 {@link DEFAULT_MAX_REDIRECTS}。
   * 设为 0 即完全不跟随：遇到 3xx 直接抛 `TOO_MANY_REDIRECTS`，
   * 让上层明确知道「这个源只会把我甩到别处」，而不是拿到一个没法用的 302 响应。
   */
  maxRedirects?: number;
  /**
   * 不走代理的主机列表（逗号分隔）。默认 `127.0.0.1,localhost`。
   * 只在启用代理时生效；`shouldBypass` 里还硬编码了本机地址直连。
   */
  proxyBypass?: string;
}

export const DEFAULT_TRANSPORT: Required<TransportOptions> = {
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 30_000,
  userAgent: 'PCL3/0.1 (+https://github.com/pcl3)',
  maxRedirects: DEFAULT_MAX_REDIRECTS,
  proxyBypass: '127.0.0.1,localhost',
};

/** 响应 + 已被消费的 body 流。调用方负责 consume 或 destroy。 */
export interface OpenResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: IncomingMessage;
  /**
   * **最终**那次请求（可能是重定向链的最后一跳）。
   * 调用方 `destroy()` 它即可掐断整条链上仍然存活的连接。
   */
  request: ClientRequest;
  /**
   * 重定向后的最终 URL。没有发生重定向时等于入参 URL。
   * 镜像/CDN 会把请求甩到完全不同的域名，错误信息与日志都该用它。
   */
  url: string;
  /** 走过的重定向跳数；0 表示没有重定向。 */
  redirects: number;
}

export type OpenErrorCode =
  | 'INVALID_URL'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'HTTP_ERROR'
  | 'TOO_MANY_REDIRECTS';

export class TransportError extends Error {
  readonly code: OpenErrorCode;
  readonly status?: number;
  readonly url: string;

  constructor(code: OpenErrorCode, message: string, url: string, status?: number) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

/**
 * 发起 GET 请求，返回**尚未读取**的响应。
 *
 * 自动跟随 301 / 302 / 303 / 307 / 308，最多 `maxRedirects` 跳。
 * 本项目只发 GET，所以 303 的「改成 GET」与本来的语义一致，方法始终不变。
 * 跨跳保留调用方给的额外请求头（`Range` 在内）—— 客户端 CDN 通常支持，
 * 而丢掉它会让「已续传一半」变成「整下」，白白多花流量。
 *
 * 镜像重定向（BMCLAPI → 轮换的第三方节点）就在这里被消化掉，上层看不到 302；
 * 跳转后的域名也不再参与镜像白名单判断，那是镜像自己的事。
 *
 * `signal` 触发时会 abort 请求，并以 `TransportError('ABORTED')` reject 或
 * 在 body 上触发 error —— 由调用方统一按失败处理。
 */
export function openRequest(
  rawUrl: string,
  extraHeaders: Record<string, string>,
  opts: TransportOptions = {},
  signal?: AbortSignal,
): Promise<OpenResponse> {
  const cfg = { ...DEFAULT_TRANSPORT, ...opts };
  const maxRedirects = Math.max(0, Math.floor(cfg.maxRedirects));

  return new Promise<OpenResponse>((resolve, reject) => {
    let settled = false;
    /** 正在进行的请求；重定向时会被替换，供 abort 掐断当前这一跳。 */
    let active: ClientRequest | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = (): void => {
      const req = active;
      if (settled) {
        req?.destroy(new TransportError('ABORTED', `aborted: ${rawUrl}`, rawUrl));
        return;
      }
      finish(() => {
        req?.destroy();
        reject(new TransportError('ABORTED', `aborted: ${rawUrl}`, rawUrl));
      });
    };

    if (signal?.aborted) {
      reject(new TransportError('ABORTED', `aborted before start: ${rawUrl}`, rawUrl));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const hop = (target: string, redirectsLeft: number, from: string | undefined): void => {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        finish(() =>
          reject(new TransportError('INVALID_URL', `invalid url: ${target}`, target)),
        );
        return;
      }

      const isHttps = parsed.protocol === 'https:';
      if (!isHttps && parsed.protocol !== 'http:') {
        finish(() =>
          reject(
            new TransportError(
              'INVALID_URL',
              `unsupported protocol: ${parsed.protocol}`,
              target,
            ),
          ),
        );
        return;
      }

      const headers: Record<string, string> = {
        'User-Agent': cfg.userAgent,
        'Accept': '*/*',
        // 明确要求不压缩，避免为解压再引第三方 zlib 包装（zlib 虽是内置，
        // 但流式 gunzip 会让 Range 偏移计算失真）。
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        ...extraHeaders,
      };

      // ── 代理 ──────────────────────────────────────────────────────
      // HTTPS 目标：CONNECT 隧道，TLS 由我们自己在隧道上做（servername 必须是目标域名）。
      // HTTP  目标：连代理，用绝对 URL 作为请求路径（RFC 7230 §5.3.2）。
      //
      // 是否走代理**只**由 bypass 列表决定（默认 `127.0.0.1,localhost`），
      // 不在代码里额外硬编码「本机直连」—— 那样用户想代理本机服务时反而没法用。
      const proxy = activeProxy();
      const useProxy =
        proxy !== undefined && !shouldBypass(parsed.hostname, cfg.proxyBypass);

      let req!: ClientRequest;

      /**
       * 响应回调。抽成具名函数是为了让三条分支（直连 / CONNECT 隧道 / http 绝对 URL）
       * 共用同一套重定向与错误处理逻辑，内部通过闭包引用 `req`。
       */
      const onResponse = (res: IncomingMessage): void => {
        clearTimeout(connectTimerAsAny);

        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        // ── 重定向 ────────────────────────────────────────────────────
        if (isRedirect(status) && typeof location === 'string' && location !== '') {
          // 先把这一跳的 body 丢掉：不丢会占着 socket，连接池很快被耗尽
          res.resume();

          if (redirectsLeft <= 0) {
            finish(() => {
              req.destroy();
              reject(
                new TransportError(
                  'TOO_MANY_REDIRECTS',
                  `too many redirects (>${maxRedirects}): ${from ?? rawUrl} -> ${location}`,
                  from ?? rawUrl,
                  status,
                ),
              );
            });
            return;
          }

          // Location 可能是相对路径（BMCLAPI 早期给过 `/download/xxx`），
          // 用**当前这一跳**的 URL 作 base 解析，不能拿最初的 rawUrl。
          let next: string;
          try {
            next = new URL(location, parsed).toString();
          } catch {
            finish(() =>
              reject(
                new TransportError(
                  'INVALID_URL',
                  `bad redirect location: ${location}`,
                  target,
                  status,
                ),
              ),
            );
            return;
          }

          hop(next, redirectsLeft - 1, target);
          return;
        }

        // ── 正常响应 ──────────────────────────────────────────────────
        finish(() =>
          resolve({
            status,
            headers: res.headers,
            body: res,
            request: req,
            url: target,
            redirects: maxRedirects - redirectsLeft,
          }),
        );
      };

      // ── 真正发请求 ────────────────────────────────────────────────
      if (useProxy && proxy !== undefined && isHttps) {
        // HTTPS 目标走 CONNECT 隧道：socket 里已经完成 TLS，https.request 不能再做一次
        req = https.request(
          parsed,
          {
            method: 'GET',
            headers,
            agent: false,
            createConnection: proxyCreateConnection(
              proxy,
              {
                host: parsed.hostname,
                port: parsed.port !== '' ? Number(parsed.port) : 443,
                isHttps: true,
              },
              cfg.connectTimeoutMs,
            ),
          } as never,
          onResponse,
        );
      } else if (useProxy && proxy !== undefined) {
        // HTTP 目标：请求行使用绝对 URL（RFC 7230 §5.3.2）
        headers['Host'] = parsed.host;
        if (proxy.username !== undefined) {
          headers['Proxy-Authorization'] = `Basic ${Buffer.from(
            `${proxy.username}:${proxy.password ?? ''}`,
          ).toString('base64')}`;
        }
        req = http.request(
          {
            host: proxy.host,
            port: proxy.port,
            method: 'GET',
            path: parsed.toString(),
            headers,
          },
          onResponse,
        );
      } else {
        req = (isHttps ? https : http).request(
          parsed,
          { method: 'GET', headers },
          onResponse,
        );
      }

      active = req;

      const connectTimer = setTimeout(() => {
        finish(() => {
          req.destroy();
          reject(
            new TransportError(
              'TIMEOUT',
              `connect timeout (${cfg.connectTimeoutMs}ms): ${target}`,
              target,
            ),
          );
        });
      }, cfg.connectTimeoutMs);
      // setTimeout 返回值在不同 lib 下类型不一，统一收敛成 any 便于 clearTimeout
      const connectTimerAsAny = connectTimer as unknown as ReturnType<typeof setTimeout>;
      connectTimer.unref?.();

      req.on('socket', (socket) => {
        socket.setTimeout(cfg.idleTimeoutMs, () => {
          req.destroy(
            new TransportError(
              'TIMEOUT',
              `idle timeout (${cfg.idleTimeoutMs}ms): ${target}`,
              target,
            ),
          );
        });
      });

      req.on('error', (err: Error) => {
        if (settled) return;
        clearTimeout(connectTimerAsAny);
        if (err instanceof TransportError) {
          finish(() => reject(err));
          return;
        }
        const code = (err as NodeJS.ErrnoException).code ?? 'NETWORK';
        finish(() =>
          reject(new TransportError('NETWORK', `${code}: ${err.message} (${target})`, target)),
        );
      });

      req.end();
    };

    hop(rawUrl, maxRedirects, undefined);
  });
}

/** 需要跟随的状态码。300 / 304 / 305 / 306 不在其中：它们不是「去别处取」。 */
function isRedirect(status: number): boolean {
  return (
    status === 301 || status === 302 || status === 303 || status === 307 || status === 308
  );
}

/** 把流写到 `partPath` 的写盘过程。 */
export interface WriteStreamResult {
  bytes: number;
  sha1: string;
}

/**
 * 将 `body` 追加写入已打开的 `writer`（调用方负责以正确的偏移打开文件），
 * 边写边把字节喂给 `hash`（调用方负责把 `.part` 存量预先喂进去）。
 *
 * `onBytes(delta)` 每收到一个 chunk 调一次 —— 调用方自己做节流后才会暴露给外部。
 * resolve 值为本次追加的字节数；写完不代表落盘，落盘由调用方 `closeWriter` 负责。
 */
export function streamToFile(
  body: IncomingMessage,
  writer: WriteStream,
  hash: Hash,
  onBytes: (delta: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let bytes = 0;
    let finished = false;

    const cleanup = (): void => {
      body.off('data', onData);
      body.off('end', onEnd);
      body.off('error', onError);
      body.off('aborted', onAborted);
    };

    const fail = (err: Error): void => {
      if (finished) return;
      finished = true;
      cleanup();
      body.destroy();
      if (!writer.destroyed) writer.destroy();
      reject(err);
    };

    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      hash.update(chunk);
      onBytes(chunk.length);
      if (!writer.write(chunk)) {
        body.pause();
        writer.once('drain', () => body.resume());
      }
    };
    const onEnd = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(bytes);
    };
    const onError = (err: Error): void => fail(err);
    const onAborted = (): void => fail(new Error('response aborted by peer'));

    if (signal?.aborted) {
      fail(new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', () => fail(new Error('aborted')), { once: true });

    body.on('data', onData);
    body.on('end', onEnd);
    body.on('error', onError);
    body.on('aborted', onAborted);
  });
}

/** 关闭写流，等 file descriptor 真正释放。 */
export function closeWriter(writer: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    writer.end(() => {
      writer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    writer.on('error', reject);
  });
}
