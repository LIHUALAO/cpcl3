/**
 * 进度回调节流：按时间（默认 100ms）或增量（默认 2%）触发，二者满足其一即放。
 *
 * 目的是把「每收一个 chunk 一次」压到「每秒十来次」，同时保证总能收到收尾事件。
 */

export interface ThrottleOptions {
  /** 最小间隔，毫秒 */
  intervalMs?: number;
  /** 最小增量比例（0.02 = 2%） */
  deltaRatio?: number;
}

export class ProgressThrottle<T> {
  private readonly intervalMs: number;
  private readonly deltaRatio: number;
  private lastEmitAt = 0;
  private lastValue = 0;

  constructor(opts: ThrottleOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 100;
    this.deltaRatio = opts.deltaRatio ?? 0.02;
  }

  /**
   * 判断这次是否需要上报。
   * @param value 单调递增的计量值（通常是已收字节数）
   * @param total 总量；未知时传 0，此时只按时间节流
   */
  shouldEmit(value: number, total: number): boolean {
    const now = Date.now();
    const timeReady = now - this.lastEmitAt >= this.intervalMs;

    if (total > 0) {
      const deltaReady = value - this.lastValue >= total * this.deltaRatio;
      if (timeReady && deltaReady) return true;
      if (timeReady && value === total) return true;
      return false;
    }

    if (timeReady) return true;
    return false;
  }

  markEmitted(value: number): void {
    this.lastEmitAt = Date.now();
    this.lastValue = value;
  }

  /** 仅更新时间戳，用于「无条件必须发」的场景（开始/结束）。 */
  markNow(value: number): void {
    this.markEmitted(value);
  }
}
