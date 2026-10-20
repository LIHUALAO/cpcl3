/**
 * 校验与文件状态工具：SHA1 流式计算、存在性判定、原子落地。
 */

import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/** 流式计算文件 SHA1（小写十六进制）。文件不存在返回 undefined。 */
export async function sha1File(filePath: string): Promise<string | undefined> {
  try {
    await stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }

  const hash = await hashFileInto(filePath, createHash('sha1'));
  return hash.digest('hex');
}

/**
 * 把文件内容灌进已有 Hash（用于续传：先喂 `.part` 存量，再喂新收到的字节）。
 * 返回同一个 hash 实例便于链式调用。
 */
export async function hashFileInto(filePath: string, hash: Hash): Promise<Hash> {
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(filePath, { highWaterMark: 1 << 20 });
    rs.on('data', (chunk: string | Buffer) => hash.update(chunk));
    rs.on('error', reject);
    rs.on('end', () => resolve());
  });
  return hash;
}

/** 文件大小；不存在返回 undefined。 */
export async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    const st = await stat(filePath);
    return st.isFile() ? st.size : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function sha1Of(chunk: Buffer): string {
  return createHash('sha1').update(chunk).digest('hex');
}

/** 从零开始一个 SHA1 摘要器；`.part` 为空时等价于 sha1Of 的流式版本。 */
export function newSha1(): Hash {
  return createHash('sha1');
}

/**
 * 目标文件是否已可跳过。
 *
 * 判定优先级（契约）：给了 sha1 就用 sha1；没有 sha1 才看 size；两者都没有 → 不跳过。
 * 同时给了 sha1 和 size 时，size 先做一次快速否决，省掉读整个文件的 IO。
 */
export async function isUpToDate(
  filePath: string,
  expected: { sha1?: string; size?: number },
): Promise<boolean> {
  const actualSize = await fileSize(filePath);
  if (actualSize === undefined) return false;

  const wantedSha1 = expected.sha1?.toLowerCase();
  if (wantedSha1 !== undefined && wantedSha1 !== '') {
    if (expected.size !== undefined && actualSize !== expected.size) return false;
    const actualSha1 = await sha1File(filePath);
    return actualSha1 === wantedSha1;
  }

  if (expected.size !== undefined) return actualSize === expected.size;

  // 无 sha1 也无 size：无法证明完整，按契约重新下载
  return false;
}

/** 计算 `.part` 的当前状态：用于决定续传起点与是否需要重来。 */
export async function inspectPart(
  partPath: string,
  expected: { sha1?: string; size?: number },
): Promise<{ exists: boolean; size: number; sha1?: string }> {
  const size = await fileSize(partPath);
  if (size === undefined) return { exists: false, size: 0 };

  // 已知总长却比 .part 短 → .part 是脏数据，丢弃重来
  if (expected.size !== undefined && size > expected.size) {
    await removeQuietly(partPath);
    return { exists: false, size: 0 };
  }

  // 已完整：直接算摘要交给调用方决定（全等则跳过网络）
  if (expected.size !== undefined && size === expected.size) {
    const sha1 = await sha1File(partPath);
    return { exists: true, size, sha1 };
  }

  return { exists: true, size };
}

/**
 * 原子落地：把 `.part` rename 到目标路径。
 *
 * 临时文件由 Downloader 放在**目标同目录**下，因此这里的 rename 一定是同设备操作，
 * 在 POSIX 上是原子的；Windows 上 `fs.rename` 覆盖已存在文件也受支持。
 */
export async function commitPart(partPath: string, dest: string): Promise<void> {
  await rename(partPath, dest);
}

/** 删除文件，不存在时忽略。 */
export async function removeQuietly(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** `.part` 路径：与目标**同目录**（保证 rename 同设备），不污染最终文件名。 */
export function partPathFor(dest: string): string {
  return path.join(path.dirname(dest), `.${path.basename(dest)}.part`);
}
