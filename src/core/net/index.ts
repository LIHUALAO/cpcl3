/**
 * net 模块 —— 下载源测速与自动换源。
 *
 * 出口：
 *   `MirrorSelector`      测速 / 选源 / 失败降级
 *   `MIRROR_DEFINITIONS`  已知源常量表
 *   `createSelectorFromConfig()`  按全局配置装配（固定源 / 自动测速）
 */

export {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_TTL_MS,
  MirrorSelector,
  PROBE_CACHE_FILE,
  PROBE_ROUNDS,
  type MirrorProbe,
  type MirrorSelectorOptions,
} from './MirrorSelector.js';

export {
  MIRROR_DEFINITIONS,
  PROBE_PATH,
  findMirror,
  mirrorLabel,
  orderedMirrorBases,
  type MirrorDefinition,
} from './mirrors.js';

// ── 代理探测（网络受限时用户需要挂代理，但往往不知道自己端口是多少） ──
export {
  KNOWN_PROXY_PORTS,
  detectProxy,
  testProxy,
  type DetectedProxy,
  type DetectOptions,
} from './proxy-detect.js';

// ── 引导：把 config 的代理配置接到 download 的传输层 ──
export { bootstrapAndApplyProxy, bootstrapNetwork, isNetworkBootstrapped } from './bootstrap.js';

import type { GlobalConfig } from '../config/index.js';
import { MirrorSelector, type MirrorSelectorOptions } from './MirrorSelector.js';

/**
 * 按全局配置建一个 selector。
 *
 * 语义：
 *   - `autoProbeMirror === false` 且给了 `preferredMirror` → 固定源，不测速
 *   - 否则 → 自动测速（`preferredMirror` 只作为「全部测不通时」的偏好，不影响测速本身）
 */
export function createSelectorFromConfig(
  cfg: GlobalConfig,
  opts: Omit<MirrorSelectorOptions, 'preferredId'> = {},
): MirrorSelector {
  const useFixed = cfg.autoProbeMirror === false && typeof cfg.preferredMirror === 'string'
    && cfg.preferredMirror.trim() !== '';
  const options: MirrorSelectorOptions = { ...opts };
  if (useFixed) options.preferredId = cfg.preferredMirror?.trim();
  return new MirrorSelector(options);
}
