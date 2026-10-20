/**
 * 任务队列 —— 自实现的极简池化调度，不引 p-limit。
 *
 * 语义：
 *   - `run(tasks, worker)` 并发上限固定，任一开始即启动一个 worker
 *   - worker 抛错不会中断队列（错误由 worker 自己吞掉并计入 failed）
 *   - 队列中途不能追加任务（契约里 downloadAll 是一次性全量）
 */

export interface PoolResult<T> {
  /** 与入参 tasks 同序的结果；worker 抛错的位置为 undefined */
  results: (T | undefined)[];
  /** worker 抛出的错误，与入参同序 */
  errors: (Error | undefined)[];
}

export async function runPool<I, O>(
  items: readonly I[],
  concurrency: number,
  worker: (item: I, index: number) => Promise<O>,
): Promise<PoolResult<O>> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: (O | undefined)[] = new Array(items.length).fill(undefined);
  const errors: (Error | undefined)[] = new Array(items.length).fill(undefined);

  let next = 0;

  const pump = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as I;
      try {
        results[index] = await worker(item, index);
      } catch (err) {
        errors[index] = err instanceof Error ? err : new Error(String(err));
      }
    }
  };

  const workers: Promise<void>[] = [];
  const width = Math.min(limit, items.length);
  for (let i = 0; i < width; i++) workers.push(pump());
  await Promise.all(workers);

  return { results, errors };
}
