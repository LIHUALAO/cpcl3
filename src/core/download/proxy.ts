/**
 * HTTP / HTTPS 代理支持 —— 零依赖，只用 node:http / node:https / node:tls / node:net。
 *
 * 为什么需要：部分网络下 `cdn.modrinth.com`（Fastly）连不上，用户必须挂代理。
 * 但启动器会下载 Mojang 元数据、游戏资源、mod —— 全都要能走代理，否则挂了一半。
 *
 * 支持的形式：
 *   http://host:port    对 https 目标用 CONNECT 隧道；对 http 目标用绝对 URL 请求
 *   socks5://host:port  SOCKS5 握手（含用户名密码认证），之后原样走字节流
 *   socks5h://host:port 同上，但域名交给代理解析（DNS 不过本地）
 *
 * 刻意不引 `https-proxy-agent`：那会带来好几个传递依赖，而本项目核心模块零依赖。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';
import type { ClientRequest } from 'node:http';

/** 解析后的代理描述 */
export interface ProxyEndpoint {
  /** 'http' | 'https' | 'socks5' | 'socks5h' */
  protocol: 'http' | 'https' | 'socks5' | 'socks5h';
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** 原始字符串，日志与错误信息里用 */
  raw: string;
}

/** 代理配置（与 config 模块的 ProxyConfig 对应，这里只取解析所需的部分） */
export interface ProxyOptions {
  /** 'off' | 'system' | 'manual' */
  mode?: 'off' | 'system' | 'manual';
  /** manual 模式下的地址 */
  url?: string;
  /** 不走代理的主机（逗号分隔），支持 `example.com` / `.example.com` / `*` */
  bypass?: string;
}

const DEFAULT_PORTS: Record<string, number> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
};

/**
 * 解析代理字符串。
 * 接受 `host:port`（默认按 http 处理）、`http://…`、`socks5://user:pass@host:port`。
 */
export function parseProxyUrl(raw: string): ProxyEndpoint | undefined {
  const text = (raw ?? '').trim();
  if (text === '') return undefined;

  // 没写协议就补 http（最常见的手填形式 `127.0.0.1:7897`）
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return undefined;
  }

  const protocol = u.protocol.replace(':', '').toLowerCase();
  if (protocol !== 'http' && protocol !== 'https' && protocol !== 'socks5' && protocol !== 'socks5h') {
    return undefined;
  }

  const host = u.hostname;
  if (host === '') return undefined;

  const port = u.port !== '' ? Number(u.port) : (DEFAULT_PORTS[protocol] ?? 8080);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;

  return {
    protocol: protocol as ProxyEndpoint['protocol'],
    host,
    port,
    ...(u.username !== '' ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password !== '' ? { password: decodeURIComponent(u.password) } : {}),
    raw: text,
  };
}

/**
 * 判断某个主机是否应该绕过代理。
 *
 * 匹配规则（大小写不敏感）：
 *   `*`            全部绕过
 *   `example.com`  精确匹配，或作为后缀（`a.example.com` 也算）
 *   `.example.com` 只匹配子域（`a.example.com`），精确的 `example.com` 不匹配
 *   `192.168.`     前缀匹配（覆盖整段内网）
 */
export function shouldBypass(host: string, bypass: string | undefined): boolean {
  const patterns = (bypass ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  if (patterns.length === 0) return false;

  const h = host.toLowerCase();

  for (const p of patterns) {
    if (p === '*') return true;
    if (p.startsWith('.')) {
      if (h.endsWith(p) && h.length > p.length) return true;
      continue;
    }
    if (h === p) return true;
    if (h.endsWith(`.${p}`)) return true;
    // 前缀匹配只在最后一段不是字母数字时启用，避免 `10.0.0.` 误伤 `10.0.0.abc.com`
    if (p.endsWith('.') && h.startsWith(p)) return true;
  }
  return false;
}

/**
 * 为一个 HTTPS 目标建立 CONNECT 隧道。
 *
 * 返回的 socket 已经是 TLS 握手完成的**目标**连接 —— 后续把请求写到它上面即可。
 * 注意：TLS 的 `servername` 必须是目标域名，不能是代理域名，否则证书校验会失败。
 */
export function connectViaHttpProxy(
  proxy: ProxyEndpoint,
  target: { host: string; port: number; servername?: string },
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const authority = `${target.host}:${String(target.port)}`;

    const req = (proxy.protocol === 'https' ? https : http).request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: {
        Host: authority,
        ...(proxy.username !== undefined
          ? {
              'Proxy-Authorization': `Basic ${Buffer.from(
                `${proxy.username}:${proxy.password ?? ''}`,
              ).toString('base64')}`,
            }
          : {}),
      },
      timeout: opts.timeoutMs,
      ...(proxy.protocol === 'https' ? { servername: proxy.host } : {}),
    });

    if (opts.signal !== undefined) {
      const onAbort = (): void => {
        req.destroy(new Error('aborted'));
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${String(res.statusCode ?? 0)}`));
        return;
      }
      // 隧道建好了，再在它上面做 TLS
      const secured = tls.connect({
        socket,
        servername: target.servername ?? target.host,
      });
      secured.once('secureConnect', () => {
        resolve(secured);
      });
      secured.once('error', (err) => {
        secured.destroy();
        reject(err);
      });
    });

    req.once('timeout', () => {
      req.destroy(new Error(`proxy CONNECT timeout after ${String(opts.timeoutMs)}ms`));
    });
    req.once('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * SOCKS5 握手（RFC 1928 + RFC 1929 用户名密码认证）。
 *
 * 成功后返回原始 socket，后续 TLS 或明文 HTTP 都写在这个 socket 上。
 */
export function connectViaSocks5(
  proxy: ProxyEndpoint,
  target: { host: string; port: number },
  opts: { timeoutMs: number; signal?: AbortSignal; remoteDns: boolean },
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    socket.setTimeout(opts.timeoutMs);

    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.once('timeout', () => {
      fail(new Error(`socks5 timeout after ${String(opts.timeoutMs)}ms`));
    });
    socket.once('error', fail);

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) fail(new Error('aborted'));
      else opts.signal.addEventListener('abort', () => fail(new Error('aborted')), { once: true });
    }

    /** 阶段机：greeting → (auth) → connect → done */
    let stage: 'greeting' | 'auth' | 'connect' | 'done' = 'greeting';
    let buffer = Buffer.alloc(0);

    const sendConnect = (): void => {
      stage = 'connect';
      // 目标地址：域名交给代理（ATYP=0x03）还是本地解析（ATYP=0x01）
      const useDomain = opts.remoteDns && !net.isIP(target.host);
      let addrPart: Buffer;
      if (useDomain) {
        const nameBuf = Buffer.from(target.host, 'utf8');
        addrPart = Buffer.concat([Buffer.from([0x03, nameBuf.length]), nameBuf]);
      } else if (net.isIPv4(target.host)) {
        addrPart = Buffer.from([0x01, ...target.host.split('.').map((n) => Number(n) & 0xff)]);
      } else {
        // IPv6 或解析失败的域名：退回让代理解析
        const nameBuf = Buffer.from(target.host, 'utf8');
        addrPart = Buffer.concat([Buffer.from([0x03, nameBuf.length]), nameBuf]);
      }
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(target.port, 0);
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]));
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 0x05) return fail(new Error('socks5: bad version'));
          const method = buffer[1];
          buffer = buffer.subarray(2);
          if (method === 0x00) {
            sendConnect();
            continue;
          }
          if (method === 0x02) {
            if (proxy.username === undefined) {
              return fail(new Error('socks5: proxy requires auth but no credentials given'));
            }
            stage = 'auth';
            const u = Buffer.from(proxy.username, 'utf8');
            const p = Buffer.from(proxy.password ?? '', 'utf8');
            socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
            continue;
          }
          return fail(new Error(`socks5: no acceptable auth method (offered ${String(method)})`));
        }

        if (stage === 'auth') {
          if (buffer.length < 2) return;
          const status = buffer[1];
          buffer = buffer.subarray(2);
          if (status !== 0x00) return fail(new Error('socks5: authentication failed'));
          sendConnect();
          continue;
        }

        if (stage === 'connect') {
          if (buffer.length < 4) return;
          if (buffer[1] !== 0x00) {
            return fail(new Error(`socks5: connect failed with code ${String(buffer[1])}`));
          }
          const atyp = buffer[3];
          let need = 0;
          if (atyp === 0x01) need = 4 + 2;
          else if (atyp === 0x03) need = 1 + (buffer[4] ?? 0) + 2;
          else if (atyp === 0x04) need = 16 + 2;
          else return fail(new Error(`socks5: unknown address type ${String(atyp)}`));

          if (buffer.length < 4 + need) return;
          if (settled) return;
          settled = true;
          stage = 'done';
          socket.removeAllListeners('data');
          socket.removeAllListeners('timeout');
          socket.setTimeout(0);
          socket.pause();
          resolve(socket);
          return;
        }

        return;
      }
    });

    // 先发问候：只支持「无认证」与「用户名密码」两种
    socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
  });
}

/**
 * 按代理类型发起连接，返回可用于 `http.request({ createConnection })` 的 socket。
 */
export async function openTunnel(
  proxy: ProxyEndpoint,
  target: { host: string; port: number; isHttps: boolean },
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<net.Socket> {
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') {
    return connectViaSocks5(proxy, target, {
      ...opts,
      remoteDns: proxy.protocol === 'socks5h',
    });
  }

  if (!target.isHttps) {
    // http 目标：直接连代理，用绝对 URL 形式发请求（由 http.request 自己处理）
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect({ host: proxy.host, port: proxy.port });
      socket.setTimeout(opts.timeoutMs);
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('proxy connect timeout'));
      });
      socket.once('error', reject);
    });
  }

  return connectViaHttpProxy(proxy, { host: target.host, port: target.port }, opts);
}

/**
 * 给 `http.request` / `https.request` 生成 `createConnection`。
 *
 * 用法：
 *   const req = https.request(url, { createConnection: proxyCreateConnection(proxy, url) })
 */
export function proxyCreateConnection(
  proxy: ProxyEndpoint,
  target: { host: string; port: number; isHttps: boolean },
  timeoutMs: number,
): (opts: unknown, cb: (err: Error | null, socket?: net.Socket) => void) => void {
  return (_opts, cb) => {
    openTunnel(proxy, target, { timeoutMs })
      .then((socket) => {
        cb(null, socket);
      })
      .catch((err: unknown) => {
        cb(err instanceof Error ? err : new Error(String(err)));
      });
  };
}

/** 从 ClientRequest 上取底层 socket（用于诊断），取不到返回 undefined。 */
export function socketOf(req: ClientRequest): net.Socket | undefined {
  const s = (req as ClientRequest & { socket?: net.Socket }).socket;
  return s instanceof net.Socket ? s : undefined;
}
