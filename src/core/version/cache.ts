/**
 * 元数据磁盘缓存。
 *
 * 布局（`<dataRoot>/meta/`）：
 *   - `version_manifest_v2.json`          —— 版本清单正文
 *   - `version_manifest_v2.meta.json`     —— 清单的拉取时间等元信息
 *   - `<id>.json`                         —— 单个版本 JSON 正文
 *   - `<id>.meta.json`                    —— 该版本 JSON 的拉取时间等元信息
 *
 * 「记录拉取时间」按契约落在同目录的 `.meta.json` 旁挂文件里，而不是往 JSON 正文里塞额外字段：
 * 版本 JSON 原样落盘，可以直接给其他模块当标准 Mojang JSON 读；同时也能读回没有 meta 旁挂文件的老缓存
 * （视为时间未知，按过期处理，但仍然可以作为网络失败时的回退数据）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CacheMeta {
  /** 拉取完成时间（毫秒时间戳，来自本地时钟） */
  fetchedAt: number;
  /** 数据来源 URL */
  url?: string;
  /** 来源是否镜像 */
  mirror?: boolean;
}

export interface CacheEntry<T> {
  /** 缓存正文，不存在或解析失败时为 undefined */
  data: T | undefined;
  /** 旁挂元信息，不存在时为 undefined */
  meta: CacheMeta | undefined;
  /** 正文文件路径 */
  file: string;
}

export class MetaCache {
  /** meta 缓存目录（绝对路径） */
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 确保缓存目录存在 */
  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 某个缓存条目的正文文件绝对路径 */
  filePath(name: string): string {
    return path.join(this.dir, name);
  }

  /** 某个缓存条目的旁挂元信息文件绝对路径 */
  metaPath(name: string): string {
    const parsed = path.parse(name);
    return path.join(this.dir, `${parsed.name}.meta.json`);
  }

  /** 读取缓存正文 + 元信息；任何 IO/解析错误都视为「没有缓存」 */
  read<T>(name: string): CacheEntry<T> {
    const file = this.filePath(name);
    let data: T | undefined;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      data = undefined;
    }

    let meta: CacheMeta | undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath(name), 'utf8')) as Partial<CacheMeta>;
      if (typeof raw.fetchedAt === 'number' && Number.isFinite(raw.fetchedAt)) {
        meta = { fetchedAt: raw.fetchedAt };
        if (typeof raw.url === 'string') meta.url = raw.url;
        if (typeof raw.mirror === 'boolean') meta.mirror = raw.mirror;
      }
    } catch {
      meta = undefined;
    }

    return { data, meta, file };
  }

  /** 写入缓存正文与拉取时间（原子替换：先写临时文件再 rename） */
  write<T>(name: string, data: T, meta: CacheMeta): void {
    this.ensureDir();
    writeJsonAtomic(this.filePath(name), data);
    writeJsonAtomic(this.metaPath(name), meta);
  }

  /** 该条目是否新鲜（有正文、有拉取时间、且未超过 ttlMs） */
  isFresh(entry: CacheEntry<unknown>, ttlMs: number, now = Date.now()): boolean {
    if (entry.data === undefined || entry.meta === undefined) return false;
    return now - entry.meta.fetchedAt < ttlMs;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
