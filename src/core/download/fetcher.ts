/**
 * 单文件下载引擎：重试 + 指数退避 + 抖跳 + 镜像回退 + Range 续传 + SHA1 校验 + 原子落地。
 *
 * 一次 `fetchOne` 调用内部可能经历：
 *   候选 URL 序列 = [primary, mirror1+path, mirror2+path, ...]
 *   对每个候选做 attempt 次尝试；attempt 之间退避，URL 之间切换。
 *   只有「全部候选 × 全部尝试」都失败才返回失败。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import type { DownloadTask } from '../types.js';
import { buildCandidates, type MirrorPolicy } from './mirror.js';
import {
  DEFAULT_MAX_REDIRECTS,
  closeWriter,
  openRequest,
  streamToFile,
  TransportError,
} from './transport.js';
import {
  commitPart,
  hashFileInto,
  inspectPart,
  isUpToDate,
  newSha1,
  partPathFor,
  removeQuietly,
} from './verify.js';

export type FetchOutcome = 'downloaded' | 'skipped' | 'failed';

export interface FetchResult {
  outcome: FetchOutcome;
  /** 失败时的最后错误，便于上层汇总 */
  error?: Error;
  /** 本次实际收取的字节数 */
  bytes?: number;
}

export interface FetchOptions {
  mirrorList: readonly string[];
  /** 镜像套用策略，默认 whitelist（只对官方源）。见 mirror.ts */
  mirrorPolicy?: MirrorPolicy;
  /** 每个 URL 的最大尝试次数（含首次） */
  attempts: number;
  /** 退避基数，毫秒 */
  backoffBaseMs: number;
  /** 退避上限，毫秒 */
  backoffMaxMs: number;
  /** 用于测试注入，默认 Math.random */
  random?: () => number;
  /** 仅供测试：覆盖 transport 的超时配置 */
  timeouts?: { connectTimeoutMs?: number; idleTimeoutMs?: number };
  /** 单个候选 URL 内允许跟随的重定向跳数，默认 5。见 transport.ts */
  maxRedirects?: number;
}

export const DEFAULT_FETCH_OPTIONS: Omit<FetchOptions, 'mirrorList'> = {
  attempts: 3,
  backoffBaseMs: 500,
  backoffMaxMs: 8_000,
};

/** 指数退避：base * 2^attempt，叠加 ±25% 抖动，封顶 backoffMaxMs。 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = exp * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** 这些 HTTP 状态码值得换一个源再试（而不是原地重试）。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** 这些状态码说明「这个源上没有这个文件」，不必对同一源反复试。 */
function isFatalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

export function parseContentRange(header: string | undefined): { start: number; end: number; total?: number } | undefined {
  if (!header) return undefined;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!m) return undefined;
  const start = Number(m[1] ?? NaN);
  const end = Number(m[2] ?? NaN);
  const totalText = m[3];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const total = totalText === undefined || totalText === '*' ? undefined : Number(totalText);
  return { start, end, total };
}

/** 解析 Content-Length；缺失或非法返回 undefined。 */
function contentLength(headers: Record<string, unknown>): number | undefined {
  const raw = headers['content-length'];
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * 从 `partPath` 的当前长度开始下载并落到 `dest`。
 * 返回 `skipped` 表示 `.part` 已经是完整且合法的文件（直接 rename）。
 */
export async function fetchOne(
  task: DownloadTask,
  opts: FetchOptions,
  onBytes?: (delta: number) => void,
): Promise<FetchResult> {
  const dest = task.dest;
  const partPath = partPathFor(dest);
  const random = opts.random ?? Math.random;
  const attempts = Math.max(1, opts.attempts);

  // ── 1. 目标已就绪则直接跳过 ────────────────────────────────────────────
  if (await isUpToDate(dest, { sha1: task.sha1, size: task.size })) {
    return { outcome: 'skipped' };
  }

  await mkdir(path.dirname(dest), { recursive: true });

  const candidates = buildCandidates(task.url, opts.mirrorList, opts.mirrorPolicy ?? 'whitelist');
  let lastError: Error | undefined;

  // ── 2. 逐个候选 URL 尝试 ──────────────────────────────────────────────
  for (let ci = 0; ci < candidates.length; ci++) {
    const url = candidates[ci] as string;
    const isPrimary = ci === 0;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await sleep(backoffDelay(attempt - 1, opts.backoffBaseMs, opts.backoffMaxMs, random));
      }

      try {
        return await transferOnce(url, partPath, task, opts, onBytes);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        lastError = e;

        // 4xx（非可重试类）说明这个源压根没有该文件 → 该源不再尝试，换下一个镜像
        if (e instanceof TransportError && e.status !== undefined && isFatalStatus(e.status)) {
          break;
        }
        // 镜像不可用（DNS/连接失败）时快速切下一个源，别在原源上耗满退避
        if (!isPrimary && e instanceof TransportError && e.code === 'NETWORK' && attempt === 0) {
          break;
        }
      }
    }
  }

  // 全部失败：丢掉可能污染的 .part，避免下次拿脏数据当续传起点
  await removeQuietly(partPath).catch(() => undefined);

  return {
    outcome: 'failed',
    error: lastError ?? new Error(`all candidates failed for ${task.url}`),
  };
}

/**
 * 单次传输：处理 Range 续传、完整性校验、校验失败重下、原子 rename。
 * 抛错即代表「这一次尝试失败」，由 fetchOne 决定退避还是换源。
 */
async function transferOnce(
  url: string,
  partPath: string,
  task: DownloadTask,
  opts: FetchOptions,
  onBytes?: (delta: number) => void,
): Promise<FetchResult> {
  // 决定续传起点。注意必须在「拿到响应前」读一次 .part，
  // 并且如果 .part 已经和预期完全一致，连网络都不用发。
  let partInfo = await inspectPart(partPath, { sha1: task.sha1, size: task.size });

  if (partInfo.exists && task.sha1 !== undefined && partInfo.size === task.size) {
    if (partInfo.sha1?.toLowerCase() === task.sha1.toLowerCase()) {
      await commitPart(partPath, task.dest);
      return { outcome: 'downloaded', bytes: 0 };
    }
    // 长度对但内容不对 → 脏 .part，丢掉重来
    await removeQuietly(partPath);
    partInfo = { exists: false, size: 0 };
  }

  const startOffset = partInfo.size;
  const headers: Record<string, string> = {};
  if (startOffset > 0) headers['Range'] = `bytes=${startOffset}-`;

  const response = await openRequest(url, headers, {
    ...(opts.timeouts ?? {}),
    maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
  });

  // ── 响应分类 ─────────────────────────────────────────────────────────
  if (response.status === 416) {
    // 服务器说范围不合法，通常意味着 .part 已经够了或与远端不一致 → 重下
    await removeQuietly(partPath);
    throw new TransportError('HTTP_ERROR', `416 range not satisfiable: ${url}`, url, 416);
  }

  if (response.status !== 200 && response.status !== 206) {
    response.body.resume(); // 丢弃 body，释放 socket
    throw new TransportError('HTTP_ERROR', `HTTP ${response.status}: ${url}`, url, response.status);
  }

  let writeOffset: number;
  let expectedTotal: number | undefined;

  if (response.status === 206) {
    const range = parseContentRange(response.headers['content-range']);
    if (!range) {
      response.body.resume();
      throw new TransportError('HTTP_ERROR', `206 without usable Content-Range: ${url}`, url, 206);
    }
    if (range.start !== startOffset) {
      // 服务端返回的起点和我们要的不一致，续传拼接会错位 → 放弃这次，从头来
      response.body.resume();
      await removeQuietly(partPath);
      throw new TransportError(
        'HTTP_ERROR',
        `Content-Range start ${range.start} != requested ${startOffset}: ${url}`,
        url,
        206,
      );
    }
    writeOffset = startOffset;
    expectedTotal = range.total ?? task.size;
  } else {
    // 200：服务器不支持 Range（或本来就是首次请求）。整下覆盖。
    writeOffset = 0;
    expectedTotal = contentLength(response.headers) ?? task.size;
    if (startOffset > 0) await removeQuietly(partPath);
  }

  // ── 写盘 + 边写边算 SHA1 ─────────────────────────────────────────────
  const hash = newSha1();
  if (writeOffset > 0) await hashFileInto(partPath, hash);

  const writer = createWriteStream(partPath, {
    flags: writeOffset > 0 ? 'r+' : 'w',
    start: writeOffset,
  });
  const writerError = new Promise<never>((_, reject) => {
    writer.once('error', (e: Error) => reject(e));
  });
  // 避免 writer 错误在 await 到之前变成 unhandled rejection
  writerError.catch(() => undefined);

  let received = 0;
  try {
    received = await Promise.race([
      streamToFile(response.body, writer, hash, (delta) => {
        onBytes?.(delta);
      }),
      writerError,
    ]);
    await closeWriter(writer);
  } catch (err) {
    response.request.destroy();
    await removeQuietly(partPath).catch(() => undefined);
    throw err instanceof Error ? err : new Error(String(err));
  }

  const totalWritten = writeOffset + received;
  const digest = hash.digest('hex');

  // ── 校验 ─────────────────────────────────────────────────────────────
  if (task.sha1 !== undefined && digest !== task.sha1.toLowerCase()) {
    await removeQuietly(partPath);
    throw new Error(
      `sha1 mismatch for ${task.url}: expected ${task.sha1.toLowerCase()}, got ${digest}`,
    );
  }

  const expectedBytes = task.size ?? expectedTotal;
  if (expectedBytes !== undefined && totalWritten !== expectedBytes) {
    // 短传说明连接被中途掐断，保留 .part 供下次 Range 续传（不删！）
    if (totalWritten < expectedBytes) {
      throw new Error(
        `short read for ${task.url}: ${totalWritten}/${expectedBytes} bytes`,
      );
    }
    await removeQuietly(partPath);
    throw new Error(`oversize for ${task.url}: ${totalWritten}/${expectedBytes} bytes`);
  }

  // ── 原子落地 ─────────────────────────────────────────────────────────
  await commitPart(partPath, task.dest);
  return { outcome: 'downloaded', bytes: received };
}

/** 供测试核对：确认目标路径上存在可读文件。 */
export async function assertNoPartial(dest: string): Promise<boolean> {
  try {
    const fh = await open(dest, 'r');
    await fh.close();
    return true;
  } catch {
    return false;
  }
}
