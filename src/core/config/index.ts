/**
 * config 模块 —— 全局配置（数据目录 / 默认下载源 / 是否自动测速）。
 *
 * 对外只需要三个东西：
 *   `GlobalConfigStore`  读写 config.json
 *   `validateDataDir`    改数据目录前的校验
 *   `defaultConfigPath`  配置文件在哪（自检与界面展示用）
 */

export {
  GlobalConfigStore,
  defaultConfigStore,
  installConfigHook,
  resetDefaultConfigStoreCache,
  // 代理：配置 → 传输层的桥（两个注入点 + 应用函数）
  applyProxyFromConfig,
  currentProxyBypass,
  setProxyApplier,
  setProxyDetector,
  DEFAULT_PROXY_CONFIG,
  type GlobalConfig,
  type GlobalConfigStoreOptions,
  type ProxyApplier,
  type ProxyConfig,
  type ProxyDetectorFn,
  type ProxyMode,
  type SetDataRootResult,
} from './store.js';

export {
  CONFIG_FILE_NAME,
  PRODUCT_DIR_NAME,
  defaultConfigPath,
  defaultDataRootDir,
  globalConfigRoot,
} from './paths.js';

// ── 可选钩子：把默认存储交给 download/paths.ts（避免循环依赖，见 store.ts） ──
import { defaultConfigStore } from './store.js';

if (typeof globalThis === 'object' && globalThis !== null) {
  // 只挂一次，不覆盖调用方已经显式安装的存储
  const slot = globalThis as { __pcl3ConfigStore?: unknown };
  if (slot.__pcl3ConfigStore === undefined) {
    try {
      slot.__pcl3ConfigStore = defaultConfigStore();
    } catch {
      /* 钩子挂不上就退回旧行为：环境变量 → 默认目录 */
    }
  }
}

export {
  DATA_ROOT_MAX_LENGTH,
  KNOWN_MIRROR_IDS,
  ConfigValidationError,
  defaultConfig,
  mergeConfigPatch,
  normalizeConfig,
  type ConfigPatchResult,
  type NormalizedConfig,
} from './types.js';

export {
  DATA_ROOT_MARKERS,
  formatSize,
  isInsideOrEqual,
  measureDirSize,
  migrationNotice,
  pathEquals,
  probeWritable,
  validateDataDir,
  type DataDirCheck,
  type ValidateDataDirOptions,
} from './validate-dir.js';
