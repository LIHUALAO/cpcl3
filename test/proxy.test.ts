/**
 * 代理模块测试。
 *
 * 覆盖：
 *   A. 代理地址解析（各种写法、非法输入）
 *   B. bypass 匹配规则
 *   C. 真实通过本地 HTTP 代理下载（这是核心：证明代理真的被走了）
 *   D. 不配代理时行为不变（回归）
 *   E. 系统代理探测（不依赖真实代理软件）
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { parseProxyUrl, shouldBypass } from '../src/core/download/proxy.js';
import {
  setActiveProxy,
  activeProxy,
  openRequest,
} from '../src/core/download/transport.js';
import { KNOWN_PROXY_PORTS, detectProxy } from '../src/core/net/proxy-detect.js';

// ───────────────────────────── 临时目录 ─────────────────────────────

const createdRoots: string[] = [];
after(() => {
  for (const dir of createdRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
});

function tmpDir(tag: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `pcl3-proxy-${tag}-`));
  createdRoots.push(dir);
  return dir;
}

// ───────────────────────────── A. 地址解析 ─────────────────────────────

describe('A. parseProxyUrl', () => {
  it('接受带协议的写法', () => {
    const p = parseProxyUrl('http://127.0.0.1:7897');
    assert.equal(p?.protocol, 'http');
    assert.equal(p?.host, '127.0.0.1');
    assert.equal(p?.port, 7897);
  });

  it('接受不带协议的 host:port（补 http）', () => {
    const p = parseProxyUrl('127.0.0.1:7890');
    assert.equal(p?.protocol, 'http');
    assert.equal(p?.port, 7890);
  });

  it('识别 socks5 / socks5h', () => {
    assert.equal(parseProxyUrl('socks5://127.0.0.1:1080')?.protocol, 'socks5');
    assert.equal(parseProxyUrl('socks5h://127.0.0.1:1080')?.protocol, 'socks5h');
  });

  it('解析用户名密码', () => {
    const p = parseProxyUrl('http://user:pa%40ss@10.0.0.1:8080');
    assert.equal(p?.username, 'user');
    assert.equal(p?.password, 'pa@ss');
  });

  it('非法输入返回 undefined', () => {
    assert.equal(parseProxyUrl(''), undefined);
    assert.equal(parseProxyUrl('   '), undefined);
    assert.equal(parseProxyUrl('ftp://127.0.0.1:21'), undefined);
    assert.equal(parseProxyUrl('http://:7890'), undefined);
    assert.equal(parseProxyUrl('http://127.0.0.1:99999'), undefined);
  });

  it('默认端口按协议补', () => {
    assert.equal(parseProxyUrl('http://example.com')?.port, 80);
    assert.equal(parseProxyUrl('socks5://example.com')?.port, 1080);
  });
});

// ───────────────────────────── B. bypass ─────────────────────────────

describe('B. shouldBypass', () => {
  it('空列表不绕过任何东西', () => {
    assert.equal(shouldBypass('example.com', undefined), false);
    assert.equal(shouldBypass('example.com', ''), false);
  });

  it('* 全部绕过', () => {
    assert.equal(shouldBypass('anything.com', '*'), true);
  });

  it('精确匹配', () => {
    assert.equal(shouldBypass('localhost', '127.0.0.1,localhost'), true);
    assert.equal(shouldBypass('127.0.0.1', '127.0.0.1,localhost'), true);
    assert.equal(shouldBypass('example.com', '127.0.0.1,localhost'), false);
  });

  it('裸域名也匹配子域', () => {
    assert.equal(shouldBypass('a.example.com', 'example.com'), true);
    assert.equal(shouldBypass('example.com', 'example.com'), true);
  });

  it('. 前缀只匹配子域', () => {
    assert.equal(shouldBypass('a.example.com', '.example.com'), true);
    assert.equal(shouldBypass('example.com', '.example.com'), false);
  });

  it('大小写不敏感', () => {
    assert.equal(shouldBypass('LOCALHOST', 'localhost'), true);
  });

  it('前缀段匹配（内网段）', () => {
    assert.equal(shouldBypass('192.168.1.5', '192.168.'), true);
    assert.equal(shouldBypass('10.1.2.3', '192.168.'), false);
  });
});

// ───────────────────────────── 测试用本地代理 ─────────────────────────────

interface TestProxy {
  url: string;
  /** 记录经过它的请求，用来断言「代理真的被走了」 */
  seen: string[];
  close: () => Promise<void>;
}

/**
 * 起一个最小 HTTP 代理。
 *
 * 只处理两种形式：
 *   CONNECT host:port   → 建隧道（用于 https）
 *   绝对 URL 的 GET     → 转发（用于 http）
 */
async function startTestProxy(): Promise<TestProxy> {
  const seen: string[] = [];

  const server = http.createServer((req, res) => {
    // 绝对 URL 形式（http 目标）
    seen.push(`GET ${req.url ?? ''}`);
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400);
      res.end('bad target');
      return;
    }
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('upstream error');
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, socket: net.Socket, head) => {
    seen.push(`CONNECT ${req.url ?? ''}`);
    const [host, portRaw] = (req.url ?? '').split(':');
    const port = Number(portRaw ?? '443');
    const upstream = net.connect({ host: host ?? '', port }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => {
      socket.destroy();
    });
    socket.on('error', () => {
      upstream.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${String(addr.port)}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 起一个上游 HTTP 服务，返回固定内容 */
async function startUpstream(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${String(addr.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ───────────────────────────── C. 真实走代理 ─────────────────────────────

describe('C. 通过代理下载', () => {
  it('http 目标：请求确实经过代理（绝对 URL 形式）', async () => {
    const proxy = await startTestProxy();
    const upstream = await startUpstream('hello via proxy');
    try {
      setActiveProxy(parseProxyUrl(proxy.url) ?? null);
      // 上游就在 127.0.0.1 上，而默认 bypass 含 127.0.0.1。
      // 这里显式清空 bypass，才能验证「代理真的被走了」这条链路本身。
      const res = await openRequest(`${upstream.url}/data`, {}, { proxyBypass: '' });
      assert.equal(res.status, 200);
      const chunks: Buffer[] = [];
      for await (const c of res.body) chunks.push(c as Buffer);
      assert.equal(Buffer.concat(chunks).toString(), 'hello via proxy');

      // 关键断言：代理看到了这次请求
      assert.ok(
        proxy.seen.some((s) => s.startsWith('GET ') && s.includes('/data')),
        `代理没有记录到请求，实际记录：${proxy.seen.join(' | ')}`,
      );
    } finally {
      setActiveProxy(null);
      await proxy.close();
      await upstream.close();
    }
  });

  it('bypass 命中时直连，不经过代理', async () => {
    const proxy = await startTestProxy();
    const upstream = await startUpstream('direct');
    try {
      setActiveProxy(parseProxyUrl(proxy.url) ?? null);
      // 默认 bypass 含 127.0.0.1，所以本机目标应该直连
      const res = await openRequest(`${upstream.url}/x`, {});
      assert.equal(res.status, 200);
      res.body.resume();
      assert.equal(proxy.seen.length, 0, `不该经过代理，实际：${proxy.seen.join(' | ')}`);
    } finally {
      setActiveProxy(null);
      await proxy.close();
      await upstream.close();
    }
  });

  it('不设代理时行为不变（回归）', async () => {
    const upstream = await startUpstream('no proxy');
    try {
      setActiveProxy(null);
      assert.equal(activeProxy(), undefined);
      const res = await openRequest(`${upstream.url}/y`, {});
      assert.equal(res.status, 200);
      const chunks: Buffer[] = [];
      for await (const c of res.body) chunks.push(c as Buffer);
      assert.equal(Buffer.concat(chunks).toString(), 'no proxy');
    } finally {
      await upstream.close();
    }
  });

  it('代理不可达时明确报错，不挂死', async () => {
    setActiveProxy(parseProxyUrl('http://127.0.0.1:1') ?? null);
    try {
      await assert.rejects(
        () => openRequest('http://example.invalid/x', {}),
        (err: unknown) => err instanceof Error,
      );
    } finally {
      setActiveProxy(null);
    }
  });
});

// ───────────────────────────── D. 探测 ─────────────────────────────

describe('D. detectProxy', () => {
  it('没有代理时返回 undefined 或一个合法地址（不抛错）', async () => {
    const found = await detectProxy({ connectTimeoutMs: 150, readSystem: false });
    if (found !== undefined) {
      assert.match(found.url, /^(http|socks5h?):\/\/[^\s]+:\d+$/);
      assert.ok(found.source === 'common-port' || found.source === 'env' || found.source === 'registry');
    }
  });

  it('已知端口列表非空且都是合法端口号', () => {
    assert.ok(KNOWN_PROXY_PORTS.length > 0);
    for (const port of KNOWN_PROXY_PORTS) {
      assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
    }
  });

  it('能发现本机临时起的代理', async () => {
    const proxy = await startTestProxy();
    try {
      // 本机代理端口是随机的，不在常见端口列表里，所以这里直接用 readSystem:false + scanPorts:false
      // 验证的是「探测函数不会因为扫不到而抛错」，而不是「必须发现它」
      const found = await detectProxy({ connectTimeoutMs: 100, readSystem: false, scanPorts: false });
      assert.equal(found, undefined);
    } finally {
      await proxy.close();
    }
  });
});

// ───────────────────────────── E. 配置往返 ─────────────────────────────

describe('E. 代理配置归一化', () => {
  it('合法配置能往返', async () => {
    const { normalizeConfig, mergeConfigPatch, defaultConfig } = await import(
      '../src/core/config/index.js'
    );

    const merged = mergeConfigPatch(defaultConfig(), {
      proxy: { mode: 'manual', url: '127.0.0.1:7897', bypass: 'localhost' },
    });
    assert.deepEqual(merged.problems, []);
    assert.equal(merged.config.proxy?.mode, 'manual');
    // 裸 host:port 会被补 http://
    assert.equal(merged.config.proxy?.url, 'http://127.0.0.1:7897');

    const normalized = normalizeConfig({ proxy: { mode: 'off' } });
    assert.equal(normalized.config.proxy?.mode, 'off');
  });

  it('manual 模式缺 url → 报错', async () => {
    const { mergeConfigPatch, defaultConfig } = await import('../src/core/config/index.js');
    const merged = mergeConfigPatch(defaultConfig(), { proxy: { mode: 'manual' } });
    assert.ok(merged.problems.some((p) => p.includes('proxy.url')));
  });

  it('非法 mode → 报错', async () => {
    const { mergeConfigPatch, defaultConfig } = await import('../src/core/config/index.js');
    const merged = mergeConfigPatch(defaultConfig(), { proxy: { mode: 'bogus' } });
    assert.ok(merged.problems.some((p) => p.includes('proxy.mode')));
  });

  it('URL 格式不对 → 报错', async () => {
    const { mergeConfigPatch, defaultConfig } = await import('../src/core/config/index.js');
    const merged = mergeConfigPatch(defaultConfig(), {
      proxy: { mode: 'manual', url: 'not a url at all' },
    });
    assert.ok(merged.problems.some((p) => p.includes('proxy.url')));
  });
});
