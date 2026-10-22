/**
 * PCL3 Web UI 本地 HTTP 服务。
 *
 * 契约（Lead 指定）：
 *   createServer({ port?, host?, dataRoot? }) →
 *     Promise<{ url, close(): Promise<void> }>
 *
 * 安全铁律：
 *   - **只监听 127.0.0.1**。传 `host: '0.0.0.0'` 一律被改写回 127.0.0.1，
 *     不给「同一个 WiFi 下别人也能点开你启动器」留口子。
 *   - 静态资源走 static.ts 的路径勘定，穿越请求直接 403。
 *   - `/api/*` 全部过 Origin/Referer 同源校验。
 *   - 只接受 JSON POST，其它 Content-Type 直接 415（防「表单跨站提交」这类最简单的 CSRF）。
 *
 * 分层：
 *   server.ts   HTTP 服务器与请求分发（本文件）
 *   api.ts      REST 路由与业务
 *   static.ts   静态资源与路径穿越防护
 *   jobs.ts     后台任务表
 *   public/     纯 HTML/CSS/JS 前端（零构建、零 CDN）
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import { getDataRoot } from '../core/download/index.js';
import { GlobalConfigStore, installConfigHook } from '../core/config/index.js';
import { bootstrapAndApplyProxy } from '../core/net/bootstrap.js';
import { JobTable } from './jobs.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  assertDirectLoopback,
  checkOrigin,
  createApiRouter,
  createRealDeps,
  errorMessage,
  sendJson,
  type ApiDeps,
  type CrashAnalyzerLike,
  type DiskUsageLike,
  type DownloaderLike,
  type InstallerLike,
  type LauncherFactoryLike,
  type MirrorSelectorLike,
  type PreflightFactoryLike,
  type VersionRepoLike,
} from './api.js';
import type { FolderService } from '../core/shell/index.js';
import { defaultPublicDir, serveStatic } from './static.js';

// ───────────────────────────── 类型 ─────────────────────────────

export interface WebServerOptions {
  /** 默认 37421；传 0 由系统分配 */
  port?: number;
  /** 默认 127.0.0.1；非回环值会被强制改写 */
  host?: string;
  /** 默认走 download 模块的 getDataRoot() */
  dataRoot?: string;
  /** 静态资源目录（默认 src/web/public，可用 PCL3_WEB_PUBLIC_DIR 覆盖） */
  publicDir?: string;
  /** 注入版本仓库（测试用；不传则创建真实实现） */
  versionRepo?: VersionRepoLike;
  /** 注入下载器（测试用） */
  downloader?: DownloaderLike;
  /** 注入安装器（测试用） */
  installer?: InstallerLike;
  /** 注入启动器工厂（测试用） */
  launcherFactory?: LauncherFactoryLike;
  /**
   * 【ux 追加，可选】文件夹服务工厂（「打开文件夹」功能）。
   *
   * 为什么需要这个注入点：`POST .../folders/:kind/open` 会真的去 spawn 系统文件管理器。
   * 测试必须能把这一步换掉，否则跑一次测试就在用户桌面上弹一个窗口
   * （这条注释是同一条事故的墓志铭：曾弹了 7 次）。
   */
  folderServiceFactory?: (dataRoot: string) => FolderService;
  /** 【ux 追加，可选】磁盘占用统计器（测试注入小预算实例） */
  diskUsage?: DiskUsageLike;
  /** 任务完成后保留多久（毫秒），默认 10 分钟；测试可调小 */
  jobRetainMs?: number;
  /**
   * 【infra 追加，可选】全局配置存储。不传时用进程级默认存储
   * （%APPDATA%/PCL3/config.json），并把它装成 `getDataRoot()` 的配置来源。
   */
  configStore?: GlobalConfigStore;
  /** 【infra 追加，可选】源测速器（测试注入 fake，避免真实联网） */
  mirrorSelector?: MirrorSelectorLike;
  /** 【infra 追加，可选】崩溃分析器（测试注入 fake） */
  crashAnalyzer?: CrashAnalyzerLike;
  /**
   * 【preflight 追加，可选】启动前体检器工厂（测试注入 fake）。
   *
   * 为什么测试必须能注入：真实体检会读磁盘、读版本 JSON、读 Java 清单。
   * 注入 fake 之后，「POST /api/launch 在 blocking 时 409」这类行为才能被确定地断言，
   * 而不需要造一整套真实数据目录。
   */
  preflightFactory?: PreflightFactoryLike;
}

export interface WebServerHandle {
  /** 形如 http://127.0.0.1:37421/ */
  url: string;
  port: number;
  /** 实际监听地址，正常情况恒为 127.0.0.1 */
  host: string;
  close: () => Promise<void>;
  /** 内部对象（测试/CLI 用，不属于契约面） */
  readonly server: http.Server;
  readonly jobs: JobTable;
}

// ───────────────────────────── 入口 ─────────────────────────────

export async function createServer(opts: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = normalizeHost(opts.host);
  const port = normalizePort(opts.port);

  // 【infra 追加】先把全局配置装成 dataRoot 的来源，再解析 dataRoot。
  // 顺序不能反：getDataRoot() 内部会缓存，先解析就锁死在旧值上了。
  // 传了 opts.configStore（测试）就用它，否则用进程级默认存储（%APPDATA%/PCL3/config.json）。
  const configStore = opts.configStore ?? new GlobalConfigStore();
  installConfigHook(configStore);

  // 【代理追加】把配置里的代理接到下载传输层。
  //
  // 为什么放在这里：之后所有下载（库 / 资源 / mod / 版本元数据）都要走代理，
  // 必须赶在任何请求发出之前完成。`await` 是必要的 —— 系统代理探测要读注册表
  // 或扫端口，异步。失败不影响启动（applyProxyFromConfig 内部吞掉所有异常）。
  try {
    await bootstrapAndApplyProxy(configStore);
  } catch {
    /* 代理配错绝不能让服务起不来 */
  }

  const dataRoot = path.resolve(opts.dataRoot ?? getDataRoot());
  const publicDir = path.resolve(opts.publicDir ?? defaultPublicDir());

  const jobs = new JobTable(opts.jobRetainMs === undefined ? {} : { retainMs: opts.jobRetainMs });

  // 真实实现只建一次；有注入的项就用注入的，其余仍是真实现
  const real = createRealDeps(dataRoot, jobs);
  const deps: ApiDeps = {
    jobs,
    dataRoot: () => dataRoot,
    versionRepo: opts.versionRepo ?? real.versionRepo,
    downloader: opts.downloader ?? real.downloader,
    installer: opts.installer ?? real.installer,
    launcherFactory: opts.launcherFactory ?? real.launcherFactory,
    // 【infra 追加】三项基础设施依赖：注入优先，否则由 api.ts 现场装配
    configStore,
    ...(opts.mirrorSelector === undefined ? {} : { mirrorSelector: opts.mirrorSelector }),
    ...(opts.crashAnalyzer === undefined ? {} : { crashAnalyzer: opts.crashAnalyzer }),
    // 【ux 追加】文件夹服务与磁盘统计：注入优先（测试绝不真 spawn）
    ...(opts.folderServiceFactory === undefined ? {} : { folderServiceFactory: opts.folderServiceFactory }),
    ...(opts.diskUsage === undefined ? {} : { diskUsage: opts.diskUsage }),
    // 【preflight 追加】体检器：注入优先，否则由 api.ts 按 dataRoot 现场装配
    ...(opts.preflightFactory === undefined ? {} : { preflightFactory: opts.preflightFactory }),
  };

  const apiRouter = createApiRouter(deps);

  // 端口在这里是「真实监听端口」的可变引用：port 传 0 时系统分配的端口
  // 只有 listen 之后才知道，而 Origin 校验必须拿真实端口比对，
  // 否则同源请求会被自己拒掉（曾是真实 bug，已有回归测试）。
  const runtime = { port };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, { apiRouter, publicDir, runtime });
  });

  await listen(server, port, host);
  const address = server.address() as AddressInfo | null;
  const actualPort = address?.port ?? port;
  const actualHost = address?.address ?? host;
  runtime.port = actualPort;

  return {
    url: `http://${formatHostForUrl(actualHost)}:${String(actualPort)}/`,
    port: actualPort,
    host: actualHost,
    server,
    jobs,
    close: async () => {
      jobs.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 轮询/长连接会把 close 卡住，这里主动断开空闲连接
        server.closeAllConnections?.();
      });
    },
  };
}

// ───────────────────────────── 请求分发 ─────────────────────────────

/**
 * 唯一被放行非 JSON 写操作的路径：资源包 / 数据包 / 光影包上传。
 * （理由见 handleRequest 里的注释；只匹配这一条，别的接口仍然只收 JSON。）
 */
const PACK_UPLOAD_PATHS = /^\/api\/instances\/[^/]+\/packs\/upload\/?$/;

/**
 * 「打开文件夹」接口。
 *
 * 这是全项目**唯一**会在用户桌面上弹出资源管理器窗口的 POST，
 * 也是唯一能把本机绝对路径暴露给调用方的动作，所以除了全局的 Origin 同源校验，
 * 还要求请求**必须来自本机直连、且不经代理转发**（见 api.ts 的 assertDirectLoopback）。
 *
 * 只匹配这一条路径，别的接口不受影响。
 */
const OPEN_FOLDER_PATH = /^\/api\/instances\/[^/]+\/folders\/[^/]+\/open\/?$/;

interface RequestContext {
  apiRouter: ReturnType<typeof createApiRouter>;
  publicDir: string;
  /** 本服务实际监听端口（Origin 校验用）；port:0 时在 listen 后写回真实值 */
  runtime: { port: number };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // ── /api/* ──
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const origin = checkOrigin(req, ctx.runtime.port);
      if (!origin.ok) {
        sendJson(res, 403, { error: origin.reason });
        return;
      }

      // 「打开文件夹」是唯一会在桌面上弹窗、且能暴露本机绝对路径的接口，
      // 所以它在同源校验之外再过一道「必须本机直连、不经代理」。
      // 理由见 api.ts 的 assertDirectLoopback：用 frp / nginx 把端口映射出去时，
      // 请求对端就不再是 127.0.0.1，这条闸能把它挡住。
      if (method === 'POST' && OPEN_FOLDER_PATH.test(pathname)) {
        const direct = assertDirectLoopback(req);
        if (!direct.ok) {
          sendJson(res, 403, { error: direct.reason, code: 'not-loopback' });
          return;
        }
      }

      // 写操作必须是 JSON：挡住 <form> 跨站提交（form 只能发 urlencoded/multipart/text-plain）
      //
      // 唯一例外：资源包 / 数据包 / 光影包的上传接口。`<input type="file">` 原生只能发
      // multipart，浏览器也无法把 File 塞进 JSON（除非先 base64，那会白涨 33%）。
      // 这个例外是安全的：所有请求仍然先过上面的 Origin/Referer 同源校验，
      // 别的网页依然发不进来；文件名与体积在 handler 里各自校验。
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const type = String(req.headers['content-type'] ?? '').toLowerCase();
        const isPackUpload = method === 'POST' && PACK_UPLOAD_PATHS.test(pathname);
        const allowed =
          type.includes('application/json') ||
          (isPackUpload && (type.startsWith('multipart/form-data') || type.startsWith('application/octet-stream')));
        if (!allowed) {
          sendJson(res, 415, {
            error: isPackUpload
              ? '上传需要 Content-Type: multipart/form-data（表单上传）或 application/octet-stream（直接发文件字节）。'
              : '写操作必须使用 Content-Type: application/json。',
          });
          return;
        }
      }

      await ctx.apiRouter(req, res);
      return;
    }

    // ── 静态资源 ──
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: `静态资源只支持 GET/HEAD，收到 ${method}。` });
      return;
    }

    const target = pathname === '/' ? '/index.html' : pathname;
    const served = await serveStatic(ctx.publicDir, req, res, target);
    if (!served) {
      // 明确区分「穿越」和「真的没有」：这两件事对人的含义完全不同
      if (looksLikeTraversal(pathname)) {
        sendJson(res, 403, { error: '路径非法：不允许访问 public 目录之外的文件。' });
      } else {
        sendJson(res, 404, { error: `找不到资源：${pathname}` });
      }
    }
  } catch (error) {
    // 兜底：任何未捕获异常都要变成 JSON，不能留空响应
    try {
      sendJson(res, 500, { error: errorMessage(error) });
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"服务器内部错误"}\n');
      } else {
        res.end();
      }
    }
  }
}

/** URL 路径是否呈现穿越意图（用于把 404 和 403 区分开） */
export function looksLikeTraversal(pathname: string): boolean {
  return /(^|[/\\])\.\.([/\\]|$)|%2e%2e|%00|^[a-zA-Z]:|^%5c|%5c\.\./.test(pathname);
}

// ───────────────────────────── 工具 ─────────────────────────────

/**
 * 归一化监听地址：只允许回环。
 *
 * 任何显式的非回环地址都被改写为 127.0.0.1 —— 这是刻意的「静默纠正」，
 * 因为上层（CLI）不应该有办法把启动器暴露到局域网。
 */
export function normalizeHost(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_HOST;
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return DEFAULT_HOST;
  switch (text) {
    case 'localhost':
      return 'localhost';
    case '127.0.0.1':
      return '127.0.0.1';
    case '::1':
      return '::1';
    case '[::1]':
      return '::1';
    default:
      return DEFAULT_HOST;
  }
}

function normalizePort(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  if (!Number.isFinite(raw) || raw < 0 || raw > 65535) return DEFAULT_PORT;
  return Math.floor(raw);
}

/** IPv6 地址在 URL 里要加方括号 */
function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        reject(
          new Error(
            `端口 ${String(port)} 已被占用。可能已经有一个 PCL3 Web 在跑了，`
              + `或者别的程序占着这个端口；换一个端口再试（例如 --port 37422）。`,
          ),
        );
        return;
      }
      if (code === 'EACCES') {
        reject(new Error(`没有权限监听端口 ${String(port)}（1024 以下端口通常需要管理员权限）。`));
        return;
      }
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// ───────────────────────────── 附：独立运行 ─────────────────────────────

/**
 * 便利函数：起服务并返回句柄（给将来的 `pcl3 web` 用）。
 * 不开浏览器 —— 开不开浏览器留给 CLI 决定。
 */
export async function startWebServer(opts: WebServerOptions = {}): Promise<WebServerHandle> {
  const handle = await createServer(opts);
  process.stdout.write(`PCL3 Web UI 已启动：${handle.url}\n`);
  process.stdout.write(`（仅监听本机 ${handle.host}:${String(handle.port)}，把地址复制到浏览器即可使用）\n`);
  return handle;
}

export { DEFAULT_HOST, DEFAULT_PORT };
export type { ApiDeps, DownloaderLike, InstallerLike, LauncherFactoryLike, VersionRepoLike };
