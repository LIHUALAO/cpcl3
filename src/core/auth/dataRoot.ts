/**
 * 数据根目录。
 *
 * 契约（docs/ARCHITECTURE.md「数据目录」）：由 **download 模块** 提供 `getDataRoot()`，
 * 其他模块调用，不各自拼路径。
 *
 * 现状：download 模块（`src/core/download/index.js`）尚未产出。因此这里：
 * - 用 `warmUpDataRoot()` 动态 `import('../download/index.js')` 接契约。之所以不写静态
 *   `import { getDataRoot } from '../download/index.js'`：目标文件目前不存在，静态解析失败
 *   会连带整个 auth 模块的模块图一起崩，动态 import 的失败可以被 catch 后回退。
 * - 兜底顺序：环境变量 `PCL3_DATA_ROOT` → `%APPDATA%/PCL3`（Windows）/ `~/.pcl3`
 *
 * download 模块一旦就绪，无需改动本文件（下次进程启动时 warmUp 会自动接上）。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 与 package.json 的 productName 对齐（不硬编码中文名） */
const APP_DIR_NAME = 'PCL3';

/** download 模块入口（相对本文件编译产物 dist/core/auth/） */
const DOWNLOAD_MODULE_SPECIFIER = '../download/index.js';

/** 接上了就用 download 模块的实现 */
let downloadGetDataRoot: (() => string) | null = null;
/** 是否已探测过（避免重复 import 失败） */
let downloadProbeDone = false;

/** 本地兜底实现：环境变量优先 */
function localGetDataRoot(): string {
  const fromEnv = process.env['PCL3_DATA_ROOT'];
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData && appData.trim().length > 0) {
      return path.join(appData, APP_DIR_NAME);
    }
    return path.join(os.homedir(), 'AppData', 'Roaming', APP_DIR_NAME);
  }
  return path.join(os.homedir(), '.pcl3');
}

/**
 * 返回 PCL3 数据根目录（不保证存在）。
 *
 * 解析顺序：download 模块的 `getDataRoot()`（若已经预热成功）
 *        → 环境变量 `PCL3_DATA_ROOT`
 *        → 平台默认目录。
 */
export function getDataRoot(): string {
  if (downloadGetDataRoot) {
    try {
      const p = downloadGetDataRoot();
      if (typeof p === 'string' && p.trim().length > 0) return path.resolve(p);
    } catch {
      // download 模块自身抛错时不连带 auth 模块一起挂
    }
  }
  return localGetDataRoot();
}

/**
 * 预热：download 模块一旦就绪，就把它的 `getDataRoot` 接过来。
 *
 * - 幂等，可重复调用（进程内只真正 import 一次）
 * - 模块不存在 / 没导出 getDataRoot 时静默回退到本地实现
 * - 用动态 import 而不是静态 import：下载模块尚未产出时静态解析失败会连带整个
 *   auth 模块的模块图一起崩掉，动态 import 的失败可以被 catch。
 */
export async function warmUpDataRoot(): Promise<boolean> {
  if (downloadProbeDone) return downloadGetDataRoot !== null;
  downloadProbeDone = true;
  try {
    const mod = (await import(DOWNLOAD_MODULE_SPECIFIER)) as { getDataRoot?: unknown };
    if (typeof mod.getDataRoot === 'function') {
      downloadGetDataRoot = mod.getDataRoot as () => string;
      return true;
    }
  } catch {
    // download 模块尚未就绪：保持本地兜底
  }
  downloadGetDataRoot = null;
  return false;
}

/** 测试用：重置探测状态 */
export function resetDataRootProbe(): void {
  downloadGetDataRoot = null;
  downloadProbeDone = false;
}

/** 测试用：注入一个假的 download 模块实现 */
export function __setDownloadGetDataRootForTest(fn: (() => string) | null): void {
  downloadGetDataRoot = fn;
  downloadProbeDone = fn !== null;
}
