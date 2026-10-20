/**
 * 数据根目录解析 —— 全项目唯一路径真源。
 *
 * 规则（契约见 docs/ARCHITECTURE.md「数据目录」一节）：
 *   1. 优先环境变量 `PCL3_DATA_ROOT`
 *   2. Windows: %APPDATA%/PCL3
 *   3. 其他平台: ~/.pcl3
 *
 * 首次解析时确保目录存在（mkdir -p 语义）。解析结果在进程内缓存，
 * 保证同一进程里多次调用返回同一个字符串、且只做一次 mkdir。
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 各子目录名（与契约中的目录树一一对应） */
export type DataSubdir = 'meta' | 'libraries' | 'assets' | 'versions' | 'instances' | 'java';

let cachedRoot: string | undefined;

function computeRoot(): string {
  // 1. 环境变量优先。空白值视为未设置，避免误把 cwd 当数据根。
  const fromEnv = process.env['PCL3_DATA_ROOT'];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return path.resolve(fromEnv.trim());
  }

  // 2. Windows 用 %APPDATA%（缺失时退回 ~/AppData/Roaming），其他平台用 ~
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    const base = typeof appData === 'string' && appData.trim() !== ''
      ? appData
      : path.join(homedir(), 'AppData', 'Roaming');
    return path.resolve(base, 'PCL3');
  }

  return path.resolve(homedir(), '.pcl3');
}

/**
 * 返回数据根目录绝对路径，并确保该目录存在。
 * 全项目唯一定义处，其他模块一律调用本函数，不自行拼路径。
 */
export function getDataRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;

  const root = computeRoot();
  mkdirSync(root, { recursive: true });
  cachedRoot = root;
  return root;
}

/** 数据根下的子目录路径（不自动创建，需要写入时由调用方确保）。 */
export function dataSubdir(name: DataSubdir): string {
  return path.join(getDataRoot(), name);
}

/** 仅供测试使用：清空解析缓存，让下次 getDataRoot() 重新读环境变量。 */
export function resetDataRootCache(): void {
  cachedRoot = undefined;
}
