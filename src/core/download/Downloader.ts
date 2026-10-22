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
import { fallbackMirrorFromUrl } from './mirror.js';
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
  /**
   * 仅供测试：替换单文件下载实现。
   * 用来注入「worker 直接抛异常」这类现实中会出现（TLS 超时被上层重抛、
   * 磁盘 IO 异常、编码错误等）但很难用 fixture 复现的路径。
   */
  fetchOneFn?: typeof fetchOne;
  /**
   * 【新增，可选】单个任务彻底失败（所有候选 URL × 所有尝试都用尽）时回调。
   *
   * 用来接「自动换源」：上层（net 模块的 MirrorSelector）在这里累计失败次数，
   * 连续 N 次就从最佳源列表里剔除该源。**不传 = 完全保持原有行为**。
   *
   * 回调里不要抛错（抛了也只会被吞掉，绝不改变下载结果）。
   */
  onRepeatedFailure?: (info: MirrorFailureInfo) => void;
  /**
   * 【新增，可选】每次**单次传输尝试**失败时回调。
   *
   * 与 `onRepeatedFailure` 的区别：这个更细，每个候选 URL 的每次重试都会触发；
   * 适合「刚换到镜像就发现它 5xx，立刻记一笔」这类需要更紧反馈的场景。
   * 同样：不传 = 原有行为。
   */
  onCandidateFailed?: (info: MirrorFailureInfo) => void;
}

/**
 * 【新增类型】一次失败的结构化描述。
 *
 * `mirrorBase` 为空表示「失败来自原始 URL（官方源本身）」；
 * 有值表示「这次是那个镜像前缀失败」—— 上层据此决定要不要降级该源。
 */
export interface MirrorFailureInfo {
  /** 失败的下载任务 */
  task: DownloadTask;
  /** 原始 URL（未套镜像） */
  url: string;
  /** 实际失败的候选地址（可能是镜像地址） */
  failedUrl?: string;
  /** 识别出的镜像前缀 base；官方源失败时为 undefined */
  mirrorBase?: string;
  /** 最后一次错误 */
  error?: Error;
  /** 该任务总尝试次数（候选数 × 每候选尝试次数，实际走到几次算几次） */
  attempts: number;
}

export class Downloader {
  readonly concurrency: number;
  readonly retries: number;
  readonly mirrors: readonly string[];

  private readonly fetchOptions: FetchOptions;
  private readonly fetchOneFn: typeof fetchOne;
  private readonly onRepeatedFailure: ((info: MirrorFailureInfo) => void) | undefined;
  private readonly onCandidateFailed: ((info: MirrorFailureInfo) => void) | undefined;

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
    this.fetchOneFn = opts.fetchOneFn ?? fetchOne;
    this.onRepeatedFailure = opts.onRepeatedFailure;
    this.onCandidateFailed = opts.onCandidateFailed;
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

    // ⚠️ P0 修复点：必须接收 runPool 的返回值。
    // 旧写法 `await runPool(...)` 把返回的 { results, errors } 丢掉了，
    // 而 runPool 对 worker 异常是「收进 errors[] 不重抛」，
    // 于是抛异常的任务既不计 skipped/downloaded，也不进 failed，从统计里蒸发，
    // 上层看到 failed.length === 0 就宣布成功 —— 假成功，磁盘缺文件。
    const { errors } = await runPool(tasks, this.concurrency, async (task) => {
      const result = await this.fetchOneFn(task, this.fetchOptions, (delta) => {
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

      // 【新增】失败上报：只观测、只回调，不改变 outcome 判定
      if (result.outcome === 'failed') this.reportFailure(task, result.error);

      // 任务收尾事件不节流：done 计数变化必须让调用方看到
      throttle.markEmitted(bytesDone);
      push(task.dest);
    });

    // ⚠️ P0 修复点之二：worker 抛异常的位置，任务必须补进 failed。
    // 判据只看 `errors[i]`：worker 正常返回（含 outcome==='failed'）时 results[i] 有值，
    // 那种情况已在 worker 内部计入 failed，不能再加一遍（否则会重复计数）。
    // 只有 errors[i] 有值，才说明 worker 没走完收尾逻辑、任务从统计里蒸发了。
    for (let i = 0; i < tasks.length; i++) {
      if (errors[i] === undefined) continue;
      const task = tasks[i] as DownloadTask;
      if (failed.includes(task)) continue;
      failed.push(task);
      done += 1;
      // 【新增】worker 抛异常也算一次失败，同样上报（避免"整片失败却没人降级源"）
      this.reportFailure(task, errors[i]);
    }

    // ⚠️ P0 修复点之三：契约级不变量自检。
    // 任何任务都必须恰好落在 skipped / downloaded / failed 之一。
    // 不相等说明有任务凭空蒸发，这是比「某些文件没下到」更严重的逻辑错误，
    // 宁可抛错也不能让调用方以为装好了。
    const accounted = skipped + downloaded + failed.length;
    if (accounted !== total) {
      const vanished = total - accounted;
      throw new Error(
        `[download] 任务计数不一致：total=${String(total)}，` +
          `skipped=${String(skipped)} + downloaded=${String(downloaded)} + failed=${String(failed.length)}` +
          ` = ${String(accounted)}，有 ${String(vanished)} 个任务凭空消失。` +
          '这通常意味着 worker 内部异常未被捕获，请连同此错误上报。',
      );
    }

    // 尾事件：确保 done === total 且字节数收敛到最终值
    push(failed.length > 0 ? (failed[0] as DownloadTask).dest : (tasks[total - 1] as DownloadTask).dest);

    return { ok: failed.length === 0, skipped, downloaded, failed };
  }

  /**
   * 【新增】把一次「任务级失败」翻译成结构化信息并回调。
   *
   * 三个铁律：
   *   1. **观测不干预**：任何异常都在这里吞掉，绝不影响 `downloadAll` 的返回值。
   *   2. **只在真的配了回调时才干活**：不配 `onRepeatedFailure` 时零开销、零行为变化。
   *   3. **镜像归属由 mirror.ts 判定**：本文件不解析 URL 语义，
   *      只调用 `fallbackMirrorFromUrl`，保证镜像规则只有一份。
   */
  private reportFailure(task: DownloadTask, error: unknown): void {
    const repeated = this.onRepeatedFailure;
    const candidate = this.onCandidateFailed;
    if (repeated === undefined && candidate === undefined) return;

    try {
      const err = error instanceof Error ? error : undefined;
      // fetchOne 的失败信息里带着最后失败的候选地址（`... : <url>`），尽力取出来；
      // 取不到就当作「原始 URL 失败」，不猜、不编。
      const failedUrl = extractFailedUrl(err?.message, task.url);
      const mirrorBase =
        failedUrl === undefined
          ? null
          : fallbackMirrorFromUrl({ url: failedUrl, ...(err === undefined ? {} : { error: err }) }, task.url, this.mirrors);

      const info: MirrorFailureInfo = {
        task,
        url: task.url,
        ...(failedUrl === undefined ? {} : { failedUrl }),
        ...(mirrorBase === null || mirrorBase === undefined ? {} : { mirrorBase }),
        ...(err === undefined ? {} : { error: err }),
        attempts: this.retries,
      };

      candidate?.(info);
      // 只有「失败确实发生在某个镜像上」时才算该镜像一次失败：
      // 官方源自己挂了不该导致镜像被降级。
      if (mirrorBase !== null && mirrorBase !== undefined) repeated?.(info);
      else if (failedUrl === task.url && mirrorBase === null) {
        // 原始 URL 也失败：这是「官方源 + 所有镜像都不行」，仍要通知上层，
        // 但不带 mirrorBase，让上层自己决定怎么记。
        repeated?.({ ...info, mirrorBase: undefined });
      }
    } catch {
      /* 回调里的异常绝不能影响下载结果 */
    }
  }
}

/**
 * 从错误文案里捞出失败时实际用的候选地址。
 *
 * `fetchOne` / `transport` 的错误串形如 `HTTP 503: https://bmclapi2.../xxx`、
 * `sha1 mismatch for https://...: expected ...`，取最后一个出现的 http(s) 地址。
 * 取不到就返回 undefined —— 宁可少上报一次，也不编造一个源。
 */
function extractFailedUrl(message: string | undefined, fallbackUrl: string): string | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined;
  const matches = message.match(/https?:\/\/[^\s"'<>]+/g);
  if (matches === null || matches.length === 0) return undefined;
  const last = matches[matches.length - 1] as string;
  return last === fallbackUrl ? fallbackUrl : last;
}
