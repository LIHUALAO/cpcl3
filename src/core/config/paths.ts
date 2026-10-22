/**
 * 全局配置文件位置 —— **与数据目录无关**（鸡生蛋问题）。
 *
 * 为什么必须固定：
 *   config.json 里存的就是「数据目录在哪」。如果它自己也放在数据目录里，
 *   那么在「还没决定数据目录」时就没有地方读这份决定 → 死锁。
 *   所以配置永远放在系统的用户配置目录：
 *     Windows       %APPDATA%/PCL3/config.json
 *     macOS/Linux   ~/.pcl3/config.json（与默认数据目录同路径，但那是默认值，不是解析前提）
 *
 * 解析顺序（与 getDataRoot 的取值链保持一致，便于用户理解）：
 *   1. 显式传入 configPath（测试 / 高级用法）
 *   2. 环境变量 `PCL3_CONFIG_FILE`（把配置搬走后仍能自洽）
 *   3. `PCL3_CONFIG_ROOT` / 系统配置目录 + `config.json`
 *
 * 注意：这里**不**读 `PCL3_DATA_ROOT`。数据目录是可变的，配置位置不是。
 */

import { homedir } from 'node:os';
import path from 'node:path';

/** 产品目录名（与 ARCHITECTURE.md 的目录树一致） */
export const PRODUCT_DIR_NAME = 'PCL3';

/** 配置文件名 */
export const CONFIG_FILE_NAME = 'config.json';

/**
 * 系统级用户配置根（不含产品名）。
 *
 * Windows 用 `%APPDATA%`（缺失时退回 `~/AppData/Roaming`），其他平台用 `~`。
 */
export function globalConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['PCL3_CONFIG_ROOT'];
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    const base = typeof appData === 'string' && appData.trim() !== ''
      ? appData
      : path.join(homedir(), 'AppData', 'Roaming');
    return path.resolve(base, PRODUCT_DIR_NAME);
  }
  return path.resolve(homedir(), `.${PRODUCT_DIR_NAME.toLowerCase()}`);
}

/** 全局配置文件绝对路径（不保证存在）。 */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['PCL3_CONFIG_FILE'];
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return path.resolve(explicit.trim());
  }
  return path.join(globalConfigRoot(env), CONFIG_FILE_NAME);
}

/**
 * 默认数据目录。
 *
 * **刻意不复用 `globalConfigRoot`**：两个概念必须分得开 ——
 *   · `PCL3_CONFIG_ROOT` 是「把配置文件搬走」（测试用、高级部署用）
 *   · 默认数据目录始终是产品级路径（%APPDATA%/PCL3）
 * 否则测试里把配置挪到临时目录，会连带把「默认数据目录」也挪过去，
 * 导致「环境变量 > config > 默认」这条链的第三级失去意义。
 */
export function defaultDataRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return defaultDataRootOf(env);
}

/** 默认数据目录的内部实现（也供 getDataRoot 的第三级兜底复用同一套规则） */
function defaultDataRootOf(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    const base = typeof appData === 'string' && appData.trim() !== ''
      ? appData.trim()
      : path.join(homedir(), 'AppData', 'Roaming');
    return path.resolve(base, PRODUCT_DIR_NAME);
  }
  return path.resolve(homedir(), `.${PRODUCT_DIR_NAME.toLowerCase()}`);
}
