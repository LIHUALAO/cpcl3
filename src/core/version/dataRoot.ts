/**
 * 数据根目录解析。
 *
 * TODO(version-dev): 等 download-dev 产出 `src/core/download/index.ts` 后，
 * 把本文件的实现改为从 `../download/index.js` import `getDataRoot`，删除本地占位实现。
 * 契约见 docs/ARCHITECTURE.md「数据目录」一节：由 download 模块提供 getDataRoot()。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 产品名，与 package.json 的 productName 保持一致（此处按契约不硬编码中文名，只用于目录名） */
const APP_DIR_NAME = 'PCL3';

/**
 * 返回 PCL3 的用户数据根目录（不保证存在）。
 *
 * 优先级：
 * 1. 环境变量 `PCL3_DATA_ROOT`
 * 2. Windows: `%APPDATA%/PCL3`；非 Windows: `~/.pcl3`
 */
export function getDataRoot(): string {
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
