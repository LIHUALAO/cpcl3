/**
 * 本机代理探测。
 *
 * 为什么需要：用户不一定知道自己的代理端口是多少。Clash 默认 7890/7897，
 * v2rayN 默认 10809，V2Ray 默认 1080/20171 —— 与其让用户去翻软件设置，
 * 不如我们直接试一遍常见端口，能连上就告诉他「检测到代理」。
 *
 * 探测分两步，先便宜后昂贵：
 *   1. TCP 连一下端口（几十毫秒）
 *   2. 连上了才发一个真实 HTTP 请求确认它真的是代理（避免把普通服务当成代理）
 */

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseProxyUrl, type ProxyEndpoint } from '../download/proxy.js';

const execFileAsync = promisify(execFile);

/** 常见代理软件的默认端口 */
const COMMON_PORTS = [
  7890, // Clash for Windows / Clash Verge
  7897, // Clash Verge Rev（新默认）
  7891, // Clash 混合端口
  10809, // v2rayN（HTTP）
  10808, // v2rayN（SOCKS）
  1080, // 通用 SOCKS
  2080, // 通用
  8889, // 部分机场客户端
  20171, // V2RayN 旧版
  33210, // 部分客户端
];

export interface DetectedProxy {
  /** 可直接填进配置的地址，如 `http://127.0.0.1:7890` */
  url: string;
  /** 探测来源 */
  source: 'registry' | 'env' | 'common-port';
  /** 说明，给用户看的 */
  label: string;
}

export interface DetectOptions {
  /** 单端口 TCP 超时，默认 400ms */
  connectTimeoutMs?: number;
  /** 是否扫描常见端口，默认 true */
  scanPorts?: boolean;
  /** 是否读系统设置，默认 true */
  readSystem?: boolean;
}

/** TCP 连通性检查（不严格：只要能建连就算通） */
function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 确认某端口上跑的是 HTTP 代理。
 *
 * 做法：向它发一个 CONNECT 请求建到 example.com:443 的隧道。
 * 返回 200 就是代理；返回 4xx/5xx 或超时就不是（或者是但不能用）。
 * 这样不会误把「某个恰好开着 7890 端口的网站」当成代理。
 */
function looksLikeHttpProxy(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      resolve(ok);
    };

    const req = http.request({
      host,
      port,
      method: 'CONNECT',
      path: 'example.com:443',
      timeout: timeoutMs,
      headers: { Host: 'example.com:443' },
    });

    req.once('connect', (res, socket) => {
      socket.destroy();
      finish(res.statusCode === 200);
    });
    req.once('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.once('error', () => finish(false));

    req.end();
    // 兜底：有些代理对未知域名会挂住
    setTimeout(() => {
      req.destroy();
      finish(false);
    }, timeoutMs + 200).unref?.();
  });
}

/** 读 Windows 系统代理设置 */
async function readWindowsRegistry(): Promise<DetectedProxy | undefined> {
  if (process.platform !== 'win32') return undefined;
  try {
    const { stdout } = await execFileAsync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
      ],
      { timeout: 3000, windowsHide: true },
    );
    // 只认 ProxyEnable = 0x1
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)) return undefined;

    const server = await execFileAsync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
      ],
      { timeout: 3000, windowsHide: true },
    );
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(server.stdout);
    if (!m || m[1] === undefined) return undefined;

    const raw = m[1].trim();
    // 可能是 `host:port` 也可能带协议前缀（`http=host:port;https=host:port`）
    const first = raw.includes('=') ? raw.split(';')[0]?.split('=')[1] ?? raw : raw;
    const normalized = /^[a-z]+:\/\//i.test(first) ? first : `http://${first}`;
    if (parseProxyUrl(normalized) === undefined) return undefined;

    return {
      url: normalized,
      source: 'registry',
      label: 'Windows 系统代理',
    };
  } catch {
    return undefined;
  }
}

/** 读环境变量 */
function readEnvProxy(): DetectedProxy | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const) {
    const raw = process.env[key]?.trim() ?? '';
    if (raw === '') continue;
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    if (parseProxyUrl(normalized) === undefined) continue;
    return { url: normalized, source: 'env', label: `环境变量 ${key}` };
  }
  return undefined;
}

/**
 * 探测本机可用代理。
 *
 * 顺序：系统设置 → 环境变量 → 常见端口扫描。
 * 前者只要格式合法就直接返回（信任用户已配好）；
 * 端口扫描必须通过 CONNECT 验证才算数。
 */
export async function detectProxy(opts: DetectOptions = {}): Promise<DetectedProxy | undefined> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 400;

  if (opts.readSystem !== false) {
    const fromRegistry = await readWindowsRegistry();
    if (fromRegistry !== undefined) return fromRegistry;
    const fromEnv = readEnvProxy();
    if (fromEnv !== undefined) return fromEnv;
  }

  if (opts.scanPorts === false) return undefined;

  // 端口扫描：并发探测，第一个通过验证的胜出
  const candidates = COMMON_PORTS;
  const results = await Promise.all(
    candidates.map(async (port): Promise<DetectedProxy | undefined> => {
      const reachable = await canConnect('127.0.0.1', port, connectTimeoutMs);
      if (!reachable) return undefined;
      const isProxy = await looksLikeHttpProxy('127.0.0.1', port, 1500);
      if (!isProxy) return undefined;
      return {
        url: `http://127.0.0.1:${String(port)}`,
        source: 'common-port',
        label: `检测到本地端口 ${String(port)}`,
      };
    }),
  );

  const found = results.filter((r): r is DetectedProxy => r !== undefined);
  if (found.length === 0) return undefined;

  // 优先返回端口号小的（Clash 的 7890 比 7897 更常见）
  found.sort((a, b) => {
    const pa = Number(new URL(a.url).port);
    const pb = Number(new URL(b.url).port);
    return pa - pb;
  });
  return found[0];
}

/**
 * 用给定（或自动探测的）代理测试一次真实连接。
 *
 * 默认目标是 Modrinth CDN —— 那正是国内最容易挂的域名。
 */
export async function testProxy(
  proxyUrl: string,
  target: string = 'https://cdn.modrinth.com/',
  timeoutMs = 8000,
): Promise<{ ok: boolean; latencyMs: number; error?: string; viaProxy: boolean }> {
  const proxy: ProxyEndpoint | undefined = parseProxyUrl(proxyUrl);

  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, latencyMs: Date.now() - started, viaProxy: proxy !== undefined, ...(error !== undefined ? { error } : {}) });
    };

    const url = new URL(target);
    const isHttps = url.protocol === 'https:';

    let req: http.ClientRequest;

    if (proxy === undefined) {
      // 直连对比
      const mod = isHttps ? https : http;
      req = mod.request(
        url,
        { method: 'HEAD', timeout: timeoutMs },
        (res) => {
          res.resume();
          finish(true);
        },
      );
    } else {
      // 通过代理：只测 HTTP 代理的 CONNECT；socks5 交给调用方在真实下载里验证
      if (!isHttps) {
        finish(false, '只支持测试 HTTPS 目标');
        return;
      }
      req = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${url.hostname}:${String(url.port !== '' ? Number(url.port) : 443)}`,
        timeout: timeoutMs,
        headers: {
          Host: `${url.hostname}:${String(url.port !== '' ? Number(url.port) : 443)}`,
          ...(proxy.username !== undefined
            ? {
                'Proxy-Authorization': `Basic ${Buffer.from(
                  `${proxy.username}:${proxy.password ?? ''}`,
                ).toString('base64')}`,
              }
            : {}),
        },
      });
      req.once('connect', (res, socket) => {
        socket.destroy();
        if (res.statusCode === 200) finish(true);
        else finish(false, `代理拒绝 CONNECT：HTTP ${String(res.statusCode ?? 0)}`);
      });
    }

    req.once('timeout', () => {
      req.destroy();
      finish(false, `超时（${String(timeoutMs)}ms）`);
    });
    req.once('error', (err: Error) => {
      finish(false, err.message);
    });
    req.end();
  });
}

/** 供 UI 展示的常见端口列表 */
export const KNOWN_PROXY_PORTS = COMMON_PORTS;
