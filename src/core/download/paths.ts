/**
 * 数据根目录解析 —— 全项目唯一路径真源。
 *
 * 规则（契约见 docs/ARCHITECTURE.md「数据目录」一节，本次扩展第三级）：
 *   1. 环境变量 `PCL3_DATA_ROOT`（最高优先级：CI / 便携模式 / 排障用）
 *   2. 全局配置 `config.json` 的 `dataRoot`（界面上「下载位置自定义」写的就是这一项）
 *   3. Windows: %APPDATA%/PCL3；其他平台: ~/.pcl3
 *
 * 为什么配置要排在环境变量之后：环境变量是**这次运行**的临时决定，
 * 配置是**长期**决定。这样「临时指个盘试一下」不需要去改配置。
 *
 * 首次解析时确保目录存在（mkdir -p 语义）。解析结果在进程内缓存，
 * 保证同一进程里多次调用返回同一个字符串、且只做一次 mkdir。
 * 配置改了以后调用 `resetDataRootCache()` 即可让新值生效。
 *
 * ⚠️ 循环依赖：`core/config` 不能 import 本模块（它要提供默认值），
 * 所以这里读配置走的是**可选钩子** `globalThis.__pcl3ConfigStore`
 * （由 `core/config` 的 index 在加载时挂上）。钩子缺席时自动降级为「没有配置」，
 * 行为等价于旧版（环境变量 → 默认目录），不会因此报错。
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 各子目录名（与契约中的目录树一一对应） */
export type DataSubdir = 'meta' | 'libraries' | 'assets' | 'versions' | 'instances' | 'java';

/**
 * config 模块挂上来的可选钩子。
 *
 * 只声明用到的那一点：读当前生效的 `dataRoot`。
 * 用 `globalThis` 属性而不是静态 import，是为了让两个模块互不依赖。
 */
interface ConfigStoreLike {
  load(): { dataRoot?: string };
  configPath?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __pcl3ConfigStore: ConfigStoreLike | undefined;
}

let cachedRoot: string | undefined;

/**
 * 从全局配置里取 dataRoot；拿不到（模块缺席、文件坏、字段为空）一律返回 undefined。
 *
 * 刻意吞掉异常：配置坏掉不该让启动器连数据目录都算不出来，
 * 读配置的问题由 config 模块自己 emitWarning 告知用户。
 */
function rootFromConfig(): string | undefined {
  const store = globalThis.__pcl3ConfigStore;
  if (store === undefined || typeof store.load !== 'function') return undefined;
  try {
    const cfg = store.load();
    const raw = cfg?.dataRoot;
    if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
  } catch {
    /* 配置读不出来就走默认目录 */
  }
  return undefined;
}

function computeRoot(): string {
  // 1. 环境变量优先。空白值视为未设置，避免误把 cwd 当数据根。
  const fromEnv = process.env['PCL3_DATA_ROOT'];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return path.resolve(fromEnv.trim());
  }

  // 2. 全局配置（界面「数据目录」写入的位置）
  const fromCfg = rootFromConfig();
  if (fromCfg !== undefined) return fromCfg;

  // 3. Windows 用 %APPDATA%（缺失时退回 ~/AppData/Roaming），其他平台用 ~
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

/**
 * 数据目录的**来源**（排障与界面展示用）：告诉用户"这个路径是从哪来的"。
 *
 * 例如用户明明改了配置却还是老路径，看到 `source: 'env'` 就知道是被
 * `PCL3_DATA_ROOT` 压住了，而不是配置没保存。
 */
export function dataRootSource(): 'env' | 'config' | 'default' {
  const fromEnv = process.env['PCL3_DATA_ROOT'];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return 'env';
  if (rootFromConfig() !== undefined) return 'config';
  return 'default';
}

/** 数据根下的子目录路径（不自动创建，需要写入时由调用方确保）。 */
export function dataSubdir(name: DataSubdir): string {
  return path.join(getDataRoot(), name);
}

/**
 * 仅供测试使用：清空解析缓存，让下次 getDataRoot() 重新读环境变量 / 配置。
 * 运行时改数据目录（POST /api/config、`pcl3 config set-dir`）也会调它。
 */
export function resetDataRootCache(): void {
  cachedRoot = undefined;
}
