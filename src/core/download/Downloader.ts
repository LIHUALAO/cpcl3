/**
 * Downloader —— 契约见 docs/ARCHITECTURE.md「download 模块」一节。
 *
 * 公开签名（不得偏离）：
 *   constructor(opts: { concurrency?: number; retries?: number; mirrors?: string[] })
 *   downloadAll(tasks, onProgress?: (p: DownloadProgress) => void): Promise<DownloadResult>
 *
 * 进度里的 done/total 是**任务计数**，bytesDone/bytesTotal 是字节数，
 * 对应共享类型 DownloadProgress（src/core/types.ts）的可选字段。
 */

import type { DownloadProgress, DownloadResult, DownloadTask } from '../types.js';
import { DEFAULT_FETCH_OPTIONS, fetchOne, type FetchOptions } from './fetcher.js';
import { ProgressThrottle } from './progress.js';
import { runPool } from './pool.js';
import { fileSize } from './verify.js';

/** 回调签名（ARCHITECTURE.md 与共享类型的并集）。 */
export type DownloadProgressCallback = (p: DownloadProgress) => void;

export interface DownloaderOptions {
  concurrency?: number;
  retries?: number;
  mirrors?: string[];
}

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_RETRIES = 3;

export interface DownloaderInternalOptions extends DownloaderOptions {
  /**
   * 镜像套用策略：
   *   - `whitelist`（默认）：只对 Mojang 官方源套镜像，第三方 URL 不拼前缀
   *   - `always`：对任意 http(s) URL 套镜像（自建镜像 / 内网代理 / 测试）
   *   - `never`：完全不用镜像
   */
  mirrorPolicy?: 'whitelist' | 'always' | 'never';
  /** 仅供测试：缩短退避，避免单测干等 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 仅供测试：注入确定性随机源 */
  random?: () => number;
  /** 仅供测试：调整 HTTP 超时 */
  timeouts?: { connectTimeoutMs?: number; idleTimeoutMs?: number };
  /** 单个候选 URL 内允许跟随的重定向跳数，默认 5。见 transport.ts */
  maxRedirects?: number;
}

export class Downloader {
  readonly concurrency: number;
  readonly retries: number;
  readonly mirrors: readonly string[];

  private readonly fetchOptions: FetchOptions;

  constructor(opts: DownloaderInternalOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
    // retries 语义按契约「重试默认 3 次」→ 每个 URL 最多尝试 3 次
    this.retries = Math.max(1, Math.floor(opts.retries ?? DEFAULT_RETRIES));
    this.mirrors = Object.freeze([...(opts.mirrors ?? [])]);

    const fetchOpts: FetchOptions = {
      mirrorList: this.mirrors,
      mirrorPolicy: opts.mirrorPolicy ?? 'whitelist',
      attempts: this.retries,
      backoffBaseMs: opts.backoffBaseMs ?? DEFAULT_FETCH_OPTIONS.backoffBaseMs,
      backoffMaxMs: opts.backoffMaxMs ?? DEFAULT_FETCH_OPTIONS.backoffMaxMs,
    };
    if (opts.random !== undefined) fetchOpts.random = opts.random;
    if (opts.timeouts !== undefined) fetchOpts.timeouts = opts.timeouts;
    if (opts.maxRedirects !== undefined) fetchOpts.maxRedirects = opts.maxRedirects;
    this.fetchOptions = fetchOpts;
  }

  /**
   * 批量下载。永不抛错：单个任务的任何异常都折算成 `failed` 里的一项。
   *
   * `ok` 的含义是「没有任何任务失败」——部分失败时为 false，失败清单在 `failed`。
   */
  async downloadAll(
    tasks: DownloadTask[],
    onProgress?: DownloadProgressCallback,
  ): Promise<DownloadResult> {
    const total = tasks.length;
    if (total === 0) return { ok: true, skipped: 0, downloaded: 0, failed: [] };

    // 字节总量：优先用任务声明的 size，缺失时读磁盘上已有目标文件的长度
    let bytesTotal = 0;
    for (const task of tasks) {
      bytesTotal += task.size ?? (await fileSize(task.dest)) ?? 0;
    }

    let done = 0;
    let skipped = 0;
    let downloaded = 0;
    let bytesDone = 0;
    const failed: DownloadTask[] = [];

    // 全局共享一个节流器：bytesDone 是所有任务累计值，节流按累计值判定
    const throttle = new ProgressThrottle<DownloadProgress>();
    throttle.markNow(0);

    const push = (current: string): void => {
      if (!onProgress) return;
      onProgress({
        done,
        total,
        current,
        ...(bytesTotal > 0 ? { bytesDone, bytesTotal } : {}),
      });
    };

    // 起始事件：不节流，保证调用方一定能拿到 total
    if (tasks[0] !== undefined) push(tasks[0].dest);

    await runPool(tasks, this.concurrency, async (task) => {
      const result = await fetchOne(task, this.fetchOptions, (delta) => {
        bytesDone += delta;
        if (!onProgress) return;
        if (throttle.shouldEmit(bytesDone, bytesTotal)) {
          throttle.markEmitted(bytesDone);
          push(task.dest);
        }
      });

      done += 1;
      if (result.outcome === 'skipped') skipped += 1;
      else if (result.outcome === 'downloaded') downloaded += 1;
      else failed.push(task);

      // 任务收尾事件不节流：done 计数变化必须让调用方看到
      throttle.markEmitted(bytesDone);
      push(task.dest);
    });

    // 尾事件：确保 done === total 且字节数收敛到最终值
    push(failed.length > 0 ? (failed[0] as DownloadTask).dest : (tasks[total - 1] as DownloadTask).dest);

    return { ok: failed.length === 0, skipped, downloaded, failed };
  }
}
