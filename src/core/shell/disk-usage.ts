/**
 * 数据根磁盘占用统计。
 *
 * 需求：`GET /api/status` 带一个 `diskUsage` 字段（数据根总大小）。
 *
 * 三条硬约束（否则这个功能会把首屏拖死）：
 *   1. **异步算**：绝不能卡在 handleStatus 里同步遍历几万个文件。
 *      主流程先返回上一次的缓存值（没有就是 `{ ready: false }`），算完再供下次读取。
 *   2. **缓存 5 分钟**：数据根大小不会秒变，反复扫只是白烧 IO。
 *   3. **10 万文件上限**：超过就**只算顶层各项的估算**，不再逐个 stat。
 *      用户要的是「大概多少 GB」，不是精确到字节的清单。
 *
 * 另有两条防「统计本身变成事故」的护栏：
 *   - 单次扫描有**时间预算**（默认 4 秒），到点就用已扫到的部分并标记 `partial: true`；
 *   - 同一时刻只允许一个扫描在跑（并发请求共用同一个 Promise）。
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** 顶层目录的占用估计（只做展示，不做审计） */
export interface DiskUsageBucket {
  /** 相对数据根的路径段，例如 `libraries`、`versions` */
  name: string;
  bytes: number;
  files: number;
}

export interface DiskUsageSnapshot {
  /** 数据根 */
  root: string;
  /** 数据根下所有内容的总字节数 */
  bytes: number;
  /** 统计到的文件数 */
  files: number;
  /** 这次统计是什么时候算完的（毫秒时间戳） */
  computedAt: number;
  /** 顶层各项占用，降序（最多 maxBuckets 项） */
  buckets: DiskUsageBucket[];
  /** 是否被文件数上限 / 时间预算截断（截断时数字是下界，UI 必须如实说明） */
  partial: boolean;
  /** 是否扫到了 10 万个文件后改走「只算顶层」 */
  sampled: boolean;
  /** 取数时用了多少毫秒 */
  elapsedMs: number;
  /**
   * 索引签名：让快照可以直接塞进 `Record<string, unknown>` 形态的 HTTP 响应里，
   * 而不必在 Web 层再手工拷贝一遍字段（那样最容易漏字段、也最容易类型对不上）。
   */
  [extra: string]: unknown;
}

export interface DiskUsageOptions {
  /** 缓存时长，默认 5 分钟 */
  ttlMs?: number;
  /** 文件数阈值，超过后不再逐个 stat，默认 100_000 */
  maxFiles?: number;
  /** 单次扫描时间预算，默认 4000 毫秒 */
  budgetMs?: number;
  /** 顶层明细最多给几项，默认 8 */
  maxBuckets?: number;
  /** 注入时钟（测试用） */
  now?: () => number;
}

export const DISK_USAGE_TTL_MS = 5 * 60 * 1000;
export const DISK_USAGE_MAX_FILES = 100_000;
export const DISK_USAGE_BUDGET_MS = 4_000;

/**
 * 带缓存与预算的磁盘占用统计器。
 *
 * 用法：
 *   const usage = new DataDiskUsage(dataRoot);
 *   usage.peek();            // 同步取缓存（可能 undefined），首屏用
 *   void usage.refresh();    // 后台触发一次统计（已在跑就复用）
 *   await usage.get();       // 等它算完（测试 / CLI 用）
 */
export class DataDiskUsage {
  private readonly root: string;
  private readonly ttlMs: number;
  private readonly maxFiles: number;
  private readonly budgetMs: number;
  private readonly maxBuckets: number;
  private readonly now: () => number;

  private cached: DiskUsageSnapshot | undefined;
  private pending: Promise<DiskUsageSnapshot> | undefined;

  constructor(root: string, opts: DiskUsageOptions = {}) {
    this.root = path.resolve(root);
    this.ttlMs = Math.max(0, opts.ttlMs ?? DISK_USAGE_TTL_MS);
    this.maxFiles = Math.max(1, opts.maxFiles ?? DISK_USAGE_MAX_FILES);
    this.budgetMs = Math.max(1, opts.budgetMs ?? DISK_USAGE_BUDGET_MS);
    this.maxBuckets = Math.max(1, opts.maxBuckets ?? 8);
    this.now = opts.now ?? (() => Date.now());
  }

  /** 现有的缓存（可能过期，也可能还没有）。同步，绝不阻塞。 */
  peek(): DiskUsageSnapshot | undefined {
    return this.cached;
  }

  /** 缓存是否仍然新鲜 */
  isFresh(): boolean {
    if (this.cached === undefined) return false;
    return this.now() - this.cached.computedAt < this.ttlMs;
  }

  /** 同步拿「能给前端看的东西」：有缓存给缓存（带 stale 标记），没缓存给 null */
  peekForResponse(): (DiskUsageSnapshot & { stale: boolean }) | null {
    if (this.cached === undefined) return null;
    return { ...this.cached, stale: !this.isFresh() };
  }

  /**
   * 触发一次统计。
   *
   * 缓存新鲜 → 直接返回缓存，不扫盘；
   * 已经有扫描在跑 → 复用同一个 Promise（避免并发请求把磁盘打满）。
   */
  async refresh(force = false): Promise<DiskUsageSnapshot> {
    if (!force && this.isFresh() && this.cached !== undefined) return this.cached;
    if (this.pending !== undefined) return this.pending;

    this.pending = this.scan()
      .then((snapshot) => {
        this.cached = snapshot;
        return snapshot;
      })
      .catch((error: unknown) => {
        // 统计失败不该影响任何业务：返回上次的值，没有就给一个零值快照并标注 partial
        if (this.cached !== undefined) return this.cached;
        return {
          root: this.root,
          bytes: 0,
          files: 0,
          computedAt: this.now(),
          buckets: [],
          partial: true,
          sampled: false,
          elapsedMs: 0,
          // 错误信息通过 warning 上报，不进快照（前端不该看到栈）
        } satisfies DiskUsageSnapshot;
      })
      .finally(() => {
        this.pending = undefined;
      });

    // 统计失败时别抛给调用方，已经在上面的 catch 里兜住了
    void this.pending.catch(() => {
      process.emitWarning(`PCL3：统计数据目录占用失败（${this.root}）`);
    });

    return this.pending;
  }

  /** 等统计完成（没有缓存就现算） */
  async get(): Promise<DiskUsageSnapshot> {
    return this.refresh(false);
  }

  // ── 内部 ──────────────────────────────────────────────

  private async scan(): Promise<DiskUsageSnapshot> {
    const started = this.now();
    const buckets: DiskUsageBucket[] = [];

    let totalBytes = 0;
    let totalFiles = 0;
    let partial = false;
    let sampled = false;

    const top = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => [] as never);

    for (const dirent of top) {
      if (this.now() - started > this.budgetMs) {
        partial = true;
        break;
      }
      const full = path.join(this.root, dirent.name);

      if (!dirent.isDirectory()) {
        const stat = await fsp.lstat(full).catch(() => undefined);
        const size = stat?.isFile() === true ? Number(stat.size) : 0;
        totalBytes += size;
        if (size > 0) totalFiles += 1;
        buckets.push({ name: dirent.name, bytes: size, files: size > 0 ? 1 : 0 });
        continue;
      }

      // 目录：最多再走深度 3，且全程受文件数 / 时间预算限制
      const sub = await this.walk(full, 3, started, {
        files: totalFiles,
        limit: this.maxFiles,
      });
      totalBytes += sub.bytes;
      totalFiles += sub.files;
      if (sub.partial) partial = true;
      if (sub.sampled) sampled = true;
      buckets.push({ name: dirent.name, bytes: sub.bytes, files: sub.files });
      if (this.now() - started > this.budgetMs) {
        partial = true;
        break;
      }
    }

    buckets.sort((a, b) => b.bytes - a.bytes);

    const elapsedMs = this.now() - started;
    return {
      root: this.root,
      bytes: totalBytes,
      files: totalFiles,
      computedAt: this.now(),
      buckets: buckets.slice(0, this.maxBuckets),
      partial,
      sampled,
      elapsedMs,
    };
  }

  /** 递归累加；超过文件上限或时间预算就停下来，已扫到的部分仍有效（是下界） */
  private async walk(
    dir: string,
    depth: number,
    startedAt: number,
    counter: { files: number; limit: number },
  ): Promise<{ bytes: number; files: number; partial: boolean; sampled: boolean }> {
    let bytes = 0;
    let files = 0;

    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // 两个闸：文件数上限（10 万）、时间预算（4 秒）
      if (counter.files + files >= counter.limit) {
        return { bytes, files, partial: true, sampled: true };
      }
      if (this.now() - startedAt > this.budgetMs) {
        return { bytes, files, partial: true, sampled: false };
      }

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth <= 0) continue;
        const sub = await this.walk(full, depth - 1, startedAt, {
          ...counter,
          files: counter.files + files,
        });
        bytes += sub.bytes;
        files += sub.files;
        if (sub.partial) return { bytes, files, partial: true, sampled: sub.sampled };
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = await fsp.lstat(full).catch(() => undefined);
      if (stat === undefined || !stat.isFile()) continue;
      bytes += Number(stat.size);
      files += 1;
    }

    return { bytes, files, partial: false, sampled: false };
  }
}

/**
 * 展示用格式化（前端也有同名函数；这里是给 CLI / 日志用的）。
 * 数字口径与 web/api.ts 的 formatBytes 完全一致。
 */
export function formatDiskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[i] as string}`;
}
