/**
 * 可选依赖：download 模块的 getDataRoot()。
 *
 * 契约要求从 `src/core/download/index.js` 取，但该模块由 download-dev 并行开发，
 * 本模块必须能在它缺席时独立通过 tsc 与测试。因此：
 *   1. 优先调用 `getDataRoot()`
 *   2. 其次读环境变量 PCL3_DATA_ROOT
 *   3. 最后按 ARCHITECTURE.md 的目录规则自己拼（%APPDATA%/PCL3 或 ~/.pcl3）
 */

import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const PRODUCT_DIR_NAME = 'PCL3';

declare global {
  // eslint-disable-next-line no-var
  var __pcl3DownloadModule: { getDataRoot?: () => string } | undefined;
}

function fromDownloadModule(): string | null {
  const override = globalThis.__pcl3DownloadModule;
  if (override && typeof override.getDataRoot === 'function') {
    try {
      const v = override.getDataRoot();
      if (typeof v === 'string' && v.length > 0) return v;
    } catch {
      /* 降级到默认路径 */
    }
  }
  try {
    const require = createRequire(import.meta.url);
    // 运行时解析，模块缺失时抛错即可被 catch；用变量路径避免 TS 静态解析
    const spec = ['..', 'download', 'index.js'].join('/');
    const mod = require(spec) as { getDataRoot?: () => string };
    if (mod && typeof mod.getDataRoot === 'function') {
      const v = mod.getDataRoot();
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    /* 模块还没产出，走默认路径 */
  }
  return null;
}

export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PCL3_DATA_ROOT) return path.resolve(env.PCL3_DATA_ROOT);
  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, PRODUCT_DIR_NAME);
  }
  return path.join(os.homedir(), `.${PRODUCT_DIR_NAME.toLowerCase()}`);
}

export function resolveDataRoot(): string {
  return fromDownloadModule() ?? defaultDataRoot();
}
