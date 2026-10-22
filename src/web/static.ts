/**
 * 静态资源服务：把 `src/web/public/` 下的文件按 URL 路径吐出。
 *
 * 安全约束（这是本文件存在的第一理由）：
 *   1. URL 解码后必须仍在 publicDir 内 —— 逐段校验，拒绝 `..` / `.` / 绝对路径 / 盘符 / NUL
 *   2. 解析出的绝对路径再 `path.resolve` 一次做前缀复核（双保险：防 `%2e%2e%2f`、
 *      防 Windows 的 `\\?\`、防符号链接之外的花样）
 *   3. 只发 GET / HEAD；只发已知的静态扩展名（不让人顺手读到 .ts 源码）
 *
 * 路径来源说明：本文件不能静态 import `node:url` 之外的东西，也不需要。
 * 静态目录默认按 `import.meta.url` 定位到 `src/web/public`，
 * 编译后（dist/）同样成立，因为 tsc 不会拷贝 public，所以另外支持
 * `PCL3_WEB_PUBLIC_DIR` 环境变量与构造参数覆盖。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 允许直接对外发送的扩展名 → Content-Type */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** 索引文件名 */
const INDEX_FILES = ['index.html', 'index.htm'];

/**
 * 默认静态目录。
 * `src/web/static.ts` → 同级 `public/`；编译到 `dist/src/web/static.js` 后同样成立。
 */
export function defaultPublicDir(): string {
  const fromEnv = process.env['PCL3_WEB_PUBLIC_DIR'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  try {
    return fileURLToPath(new URL('./public/', import.meta.url));
  } catch {
    return path.resolve(process.cwd(), 'src', 'web', 'public');
  }
}

/** 路径勘定的结果 */
export type ResolveOutcome =
  | { ok: true; filePath: string }
  | { ok: false; reason: 'traversal' | 'notfound' | 'forbidden' };

/**
 * 把 URL 路径映射到 publicDir 下的真实文件，带完整穿越防护。
 *
 * @param urlPath 已去掉 query 的原始路径（未解码），例如 `/app.js`、`/%2e%2e/x`
 */
export async function resolveStaticFile(publicDir: string, urlPath: string): Promise<ResolveOutcome> {
  const root = path.resolve(publicDir);

  // 1) NUL 字节 / 反斜杠统一（Windows 上 `\` 也是分隔符，必须先归一化再判定）
  if (urlPath.includes('\0')) return { ok: false, reason: 'forbidden' };
  const normalizedSeparators = urlPath.replace(/\\/g, '/');

  // 2) 解码。decodeURIComponent 遇到坏的 % 序列会抛，直接当作非法请求
  let decoded: string;
  try {
    decoded = decodeURIComponent(normalizedSeparators);
  } catch {
    return { ok: false, reason: 'forbidden' };
  }
  if (decoded.includes('\0')) return { ok: false, reason: 'forbidden' };
  // 解码后可能又冒出反斜杠（%5c），再归一化一次
  decoded = decoded.replace(/\\/g, '/');

  // 3) 绝对路径 / 盘符 / UNC：一律拒绝
  if (decoded.startsWith('//')) return { ok: false, reason: 'traversal' };
  if (/^[a-zA-Z]:/.test(decoded)) return { ok: false, reason: 'traversal' };

  // 4) 逐段校验，任何 `..` / `.` 直接拒（不做「就地清理」，清理本身容易出错）
  const segments = decoded.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg === '...') return { ok: false, reason: 'traversal' };
  }

  // 5) 拼路径并再做一次前缀复核
  let candidate = path.resolve(root, ...segments);
  if (!isInside(root, candidate)) return { ok: false, reason: 'traversal' };

  // 6) 目录 → 找 index.html
  const stat = await fsp.stat(candidate).catch(() => undefined);
  if (stat === undefined) return { ok: false, reason: 'notfound' };

  if (stat.isDirectory()) {
    let indexFile: string | undefined;
    for (const name of INDEX_FILES) {
      const next = path.join(candidate, name);
      const nextStat = await fsp.stat(next).catch(() => undefined);
      if (nextStat?.isFile() === true) {
        indexFile = next;
        break;
      }
    }
    if (indexFile === undefined) return { ok: false, reason: 'notfound' };
    candidate = indexFile;
  }

  // 7) 真实路径复核：public 内若有符号链接指到外面，这里拦下来
  const real = await fsp.realpath(candidate).catch(() => candidate);
  const realRoot = await fsp.realpath(root).catch(() => root);
  if (!isInside(realRoot, real)) return { ok: false, reason: 'traversal' };
  candidate = real;

  // 8) 只发白名单扩展名，避免顺手把 .ts / .map 源码也吐出去
  const ext = path.extname(candidate).toLowerCase();
  if (!(ext in MIME_TYPES)) return { ok: false, reason: 'forbidden' };

  const finalStat = await fsp.stat(candidate).catch(() => undefined);
  if (finalStat === undefined || !finalStat.isFile()) return { ok: false, reason: 'notfound' };

  return { ok: true, filePath: candidate };
}

/** child 是否在 parent 目录里（大小写不敏感在 Windows 上更宽松，但不放宽穿越判定） */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  return !path.isAbsolute(rel);
}

/** 取 Content-Type */
export function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 处理一个静态资源请求。
 * @returns 是否已经处理（false 表示调用方决定怎么回，通常是 404）
 */
export async function serveStatic(
  publicDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<boolean> {
  const outcome = await resolveStaticFile(publicDir, urlPath);
  if (!outcome.ok) {
    if (outcome.reason === 'traversal') return false;
    return false;
  }

  const body = await fsp.readFile(outcome.filePath).catch(() => undefined);
  if (body === undefined) return false;

  res.writeHead(200, {
    'Content-Type': contentTypeFor(outcome.filePath),
    'Content-Length': String(body.byteLength),
    // 本地开发态：不缓存，改完刷新就能看到
    'Cache-Control': 'no-store',
    // 本地单机服务，顺手关掉嗅探
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
  return true;
}

/** 同步版本（用于极端兜底，例如 handler 内部出错的错误页）；找不到返回 undefined */
export function readStaticSync(publicDir: string, urlPath: string): { body: Buffer; type: string } | undefined {
  const root = path.resolve(publicDir);
  const segments = urlPath.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..');
  const candidate = path.resolve(root, ...segments);
  if (!isInside(root, candidate)) return undefined;
  try {
    const body = fs.readFileSync(candidate);
    return { body, type: contentTypeFor(candidate) };
  } catch {
    return undefined;
  }
}
