/**
 * 测试临时目录登记簿 —— 所有 `pcl3-*` 临时目录的**唯一**创建入口。
 *
 * 为什么要这个：以前每个测试各写 `fs.mkdtempSync(os.tmpdir(), 'pcl3-xxx-')` 然后
 * 在 `finally` 里删。只要有一条断言在 `finally` 之前抛错、或者测试被 --test 的并发
 * worker 打断，目录就留在 `%TEMP%` 里。攒了几千个、几百 MB，还会拖慢后续磁盘操作。
 *
 * 现在的做法：
 *   1. 建目录一律走 `makeTempDir()`，它把路径记进进程级列表
 *   2. 测试文件里 `after(() => cleanupTempDirs())` 兜底删一遍（幂等）
 *   3. 关键的是：注册了 `process.on('exit')` —— 就算用例中途崩了也删得掉
 *      （`rmSync` 是同步的，exit 钩子里能跑）
 *
 * 只删自己登记的路径，绝不按通配符扫 `%TEMP%`（那会误删别的进程正在用的目录）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 本进程创建过、尚未清理的临时目录 */
const created = new Set<string>();

/** 统一前缀：`pcl3-<tag>-<random>` */
export const TEMP_PREFIX = 'pcl3-';

let hooked = false;

function installExitHook(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    cleanupTempDirs();
  });
}

/** 建一个受管理的临时目录 */
export function makeTempDir(tag: string): string {
  installExitHook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${tag}-`));
  created.add(dir);
  return dir;
}

/** 删掉一个受管理的目录（幂等；不在登记簿里的路径也允许删，只要在 os.tmpdir() 之内） */
export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 删不掉也不能让测试失败：Windows 上偶发 EBUSY */
  }
  created.delete(dir);
}

/** 删掉本进程登记过的全部目录（幂等，可在 after() 里反复调用） */
export function cleanupTempDirs(): void {
  for (const dir of [...created]) removeTempDir(dir);
}

/** 当前还挂着多少个（自检用） */
export function pendingTempDirCount(): number {
  return created.size;
}

/** 列出 `%TEMP%` 下所有以 `pcl3-packs` 开头的目录名（验收脚本用，只读不删） */
export function listLeftoverPackTempDirs(): string[] {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return [];
  }
  return entries.filter((name) => name.startsWith('pcl3-packs')).sort();
}
