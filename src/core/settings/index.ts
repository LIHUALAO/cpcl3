/**
 * settings 模块 —— 每个版本/实例独立的内存与 Java 设置。
 *
 * 只依赖 Node 内置模块与 `../launch/data-root.js`（取数据根），不碰 launch 的其他实现。
 */

export { SettingsStore, SettingsValidationError, commitTempFile, writeTempFile } from './store.js';
export type { SettingsStoreOptions } from './store.js';

export {
  ARG_MAX_COUNT,
  ARG_MAX_LENGTH,
  DEFAULT_MEMORY_MB,
  DISPLAY_NAME_MAX,
  JAVA_PATH_MAX,
  MEMORY_MAX_MB,
  MEMORY_MIN_MB,
  MEMORY_SLIDER_MAX_MB,
  WINDOW_MAX,
  WINDOW_MIN,
  checkInstanceId,
  defaultSettings,
  normalizeStored,
  validateSettings,
} from './types.js';
export type { InstanceSettings, ValidationResult } from './types.js';

import type { InstanceSettings } from './types.js';

/**
 * 把实例设置摊平成 LaunchOptions 的一部分。
 *
 * 为什么需要它：`LaunchOptions` 有 `javaPath`、`memoryMB`、`extraJvmArgs`、`extraGameArgs`，
 * 但**没有** `minMemoryMB`。要让最小内存真正生效，只能把 `-Xmn<min>M` 合成一条 JVM 参数——
 * launch 模块会把 extraJvmArgs 追加在 `-cp` 之前，JVM 同参数后出现者覆盖前者，所以这条会
 * 压过 launch 自动补的 `-Xmn(1/4 * Xmx)M`。`windowWidth/Height` 同理走游戏参数
 * （`--width/--height` 是原版客户端自带的选项），`fullscreen` 走 `--fullscreen`。
 *
 * 全部字段都是可选的：没填的一律不出现，让 launch 模块保持自己的默认行为。
 */
export interface LaunchOptionFields {
  memoryMB?: number;
  extraJvmArgs?: string[];
  extraGameArgs?: string[];
  javaPath?: string;
}

/** 最小内存对应的 JVM 参数（调用方已保证 minMemoryMB 是正整数） */
export function minMemoryJvmArg(minMemoryMB: number | undefined): string | undefined {
  if (typeof minMemoryMB !== 'number' || !Number.isFinite(minMemoryMB) || minMemoryMB <= 0) return undefined;
  return `-Xmn${String(Math.floor(minMemoryMB))}M`;
}

export function toLaunchOptionFields(settings: InstanceSettings): LaunchOptionFields {
  const out: LaunchOptionFields = {};

  if (typeof settings.memoryMB === 'number' && Number.isFinite(settings.memoryMB) && settings.memoryMB > 0) {
    out.memoryMB = Math.floor(settings.memoryMB);
  }

  const jvm = (settings.extraJvmArgs ?? []).filter((a) => typeof a === 'string' && a.length > 0);
  const minArg = minMemoryJvmArg(settings.minMemoryMB);
  const jvmFinal = minArg === undefined ? jvm : [...jvm, minArg];
  if (jvmFinal.length > 0) out.extraJvmArgs = jvmFinal;

  const game = [...(settings.extraGameArgs ?? []).filter((a) => typeof a === 'string' && a.length > 0)];
  if (typeof settings.windowWidth === 'number' && settings.windowWidth > 0) {
    game.push('--width', String(Math.floor(settings.windowWidth)));
  }
  if (typeof settings.windowHeight === 'number' && settings.windowHeight > 0) {
    game.push('--height', String(Math.floor(settings.windowHeight)));
  }
  if (settings.fullscreen === true) game.push('--fullscreen');
  if (game.length > 0) out.extraGameArgs = game;

  if (typeof settings.javaPath === 'string' && settings.javaPath.trim().length > 0) {
    out.javaPath = settings.javaPath.trim();
  }

  return out;
}
