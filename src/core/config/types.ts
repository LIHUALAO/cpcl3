/**
 * 全局配置的字段约束与人话文案 —— 路由层（HTTP / CLI）只负责把 `problems` 拼进响应。
 *
 * 设计原则：
 *   1. **非法值不静默吞掉**：未知字段被忽略但会记进 `ignored`，让调用方能如实告诉用户
 *      「你写的这一项没生效」，而不是假装保存成功。
 *   2. **坏值回落默认**：读盘时不做严格校验（严格校验只在写入路径上），
 *      这样手改坏一个字段不会让整个启动器打不开 —— 只在读取时把它当「没设置」。
 */

import type { GlobalConfig } from './store.js';

/** 数据目录最大长度（Windows MAX_PATH 之外的实用上限） */
export const DATA_ROOT_MAX_LENGTH = 260;

/** 镜像 id 白名单（与 net 模块的已知源对齐；未来加源要同步这里） */
export const KNOWN_MIRROR_IDS: readonly string[] = ['mojang', 'piston', 'bmclapi'];

/** 默认配置：自动测速开启，其余留空 */
export function defaultConfig(): GlobalConfig {
  return {
    autoProbeMirror: true,
    // 代理默认「跟随系统」：国内网络下 cdn.modrinth.com 常不可达，
    // 而多数用户已经在系统里配好了代理。系统没配就等于不用代理，不影响任何人。
    proxy: { mode: 'system', bypass: '127.0.0.1,localhost' },
  };
}

export interface NormalizedConfig {
  config: GlobalConfig;
  /** 被忽略的未知字段名 */
  ignored: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 宽松归一化：**从不抛错**。
 *
 * 用于 `load()`。任何字段不合法时丢回默认值并记一条 `ignored`，
 * 让上层能提示「配置里有内容没生效」，同时保证程序照常可用。
 */
export function normalizeConfig(raw: unknown): NormalizedConfig {
  const out: GlobalConfig = defaultConfig();
  const ignored: string[] = [];
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) ignored.push('（整个文件不是 JSON 对象）');
    return { config: out, ignored };
  }

  const rawRoot = raw['dataRoot'];
  if (rawRoot !== undefined && rawRoot !== null) {
    const value = typeof rawRoot === 'string' ? rawRoot.trim() : '';
    if (value === '') {
      // 空串 = 显式清空（回到默认目录），这是合法状态，不算错误
      out.dataRoot = undefined;
    } else if (value.length > DATA_ROOT_MAX_LENGTH) {
      ignored.push('dataRoot（过长）');
    } else {
      out.dataRoot = value;
    }
  }

  const rawMirror = raw['preferredMirror'];
  if (rawMirror !== undefined && rawMirror !== null) {
    if (typeof rawMirror !== 'string' || rawMirror.trim() === '') {
      out.preferredMirror = undefined;
    } else {
      out.preferredMirror = rawMirror.trim();
    }
  }

  const rawAuto = raw['autoProbeMirror'];
  if (rawAuto !== undefined && rawAuto !== null) {
    if (typeof rawAuto === 'boolean') out.autoProbeMirror = rawAuto;
    else ignored.push('autoProbeMirror（不是布尔值）');
  }

  const rawProxy = raw['proxy'];
  if (rawProxy !== undefined && rawProxy !== null) {
    if (!isPlainObject(rawProxy)) {
      ignored.push('proxy（不是对象）');
    } else {
      const mode = rawProxy['mode'];
      const url = rawProxy['url'];
      const bypass = rawProxy['bypass'];
      const next: { mode: 'off' | 'system' | 'manual'; url?: string; bypass?: string } = {
        mode: 'system',
      };
      if (mode === 'off' || mode === 'system' || mode === 'manual') {
        next.mode = mode;
      } else if (mode !== undefined) {
        ignored.push('proxy.mode（只能是 off / system / manual）');
      }
      if (typeof url === 'string' && url.trim() !== '') next.url = url.trim();
      else if (url !== undefined && url !== null && url !== '') ignored.push('proxy.url（不是字符串）');
      if (typeof bypass === 'string') next.bypass = bypass.trim();
      // manual 模式却没给 url：降级为 system，避免「选了手动但什么都不填」导致全部请求失败
      if (next.mode === 'manual' && next.url === undefined) {
        ignored.push('proxy.url（manual 模式缺少地址，已退回 system）');
        next.mode = 'system';
      }
      out.proxy = next;
    }
  }

  for (const key of Object.keys(raw)) {
    if (
      key === 'dataRoot' ||
      key === 'preferredMirror' ||
      key === 'autoProbeMirror' ||
      key === 'proxy'
    ) {
      continue;
    }
    if (!key.startsWith('_')) ignored.push(key);
  }

  return { config: out, ignored };
}

export interface ConfigPatchResult {
  config: GlobalConfig;
  problems: string[];
  ignored: string[];
}

/**
 * 把一份「局部更新」合并进当前配置并校验。
 *
 * 与 `normalizeConfig` 的区别：这里**严格**。用户明确写了 `autoProbeMirror: "yes"`
 * 这种，必须报错而不是悄悄转成 true —— 那会让用户以为自己改成功了。
 */
export function mergeConfigPatch(current: GlobalConfig, patch: unknown): ConfigPatchResult {
  const problems: string[] = [];
  const ignored: string[] = [];
  const next: GlobalConfig = { ...current };

  if (!isPlainObject(patch)) {
    return { config: next, problems: ['配置必须是 JSON 对象。'], ignored };
  }

  if ('dataRoot' in patch) {
    const raw = patch['dataRoot'];
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      next.dataRoot = undefined;
    } else if (typeof raw !== 'string') {
      problems.push('dataRoot 必须是字符串（目录绝对路径）。');
    } else if (raw.trim().length > DATA_ROOT_MAX_LENGTH) {
      problems.push(`dataRoot 太长（上限 ${String(DATA_ROOT_MAX_LENGTH)} 字符）。`);
    } else {
      next.dataRoot = raw.trim();
    }
  }

  if ('preferredMirror' in patch) {
    const raw = patch['preferredMirror'];
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      next.preferredMirror = undefined;
    } else if (typeof raw !== 'string') {
      problems.push('preferredMirror 必须是字符串（源 id，例如 "bmclapi"）。');
    } else {
      const id = raw.trim();
      if (!KNOWN_MIRROR_IDS.includes(id)) {
        problems.push(`不认识的下载源「${id}」，可选：${KNOWN_MIRROR_IDS.join(' / ')}。`);
      } else {
        next.preferredMirror = id;
      }
    }
  }

  if ('autoProbeMirror' in patch) {
    const raw = patch['autoProbeMirror'];
    if (typeof raw !== 'boolean') {
      problems.push('autoProbeMirror 必须是布尔值（true / false）。');
    } else {
      next.autoProbeMirror = raw;
    }
  }

  if ('proxy' in patch) {
    const raw = patch['proxy'];
    if (raw === null) {
      // 显式 null = 回到默认（跟随系统）
      next.proxy = { mode: 'system', bypass: '127.0.0.1,localhost' };
    } else if (!isPlainObject(raw)) {
      problems.push('proxy 必须是对象，例如 { "mode": "manual", "url": "http://127.0.0.1:7897" }。');
    } else {
      const mode = raw['mode'];
      const url = raw['url'];
      const bypass = raw['bypass'];
      const proxy: { mode: 'off' | 'system' | 'manual'; url?: string; bypass?: string } = {
        mode: next.proxy?.mode ?? 'system',
      };
      if (mode !== undefined) {
        if (mode === 'off' || mode === 'system' || mode === 'manual') proxy.mode = mode;
        else problems.push('proxy.mode 只能是 "off" / "system" / "manual"。');
      }
      if (url !== undefined) {
        if (typeof url === 'string') {
          const trimmed = url.trim();
          if (trimmed === '') delete proxy.url;
          else if (!/^([a-z][a-z0-9+.-]*:\/\/)?[^\s/]+:\d{1,5}$/i.test(trimmed)) {
            problems.push(
              'proxy.url 格式不对，应形如 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080。',
            );
          } else {
            proxy.url = /^[a-z]/i.test(trimmed) && trimmed.includes('://') ? trimmed : `http://${trimmed}`;
          }
        } else if (url !== null) {
          problems.push('proxy.url 必须是字符串。');
        }
      }
      if (bypass !== undefined) {
        if (typeof bypass === 'string') proxy.bypass = bypass.trim();
        else if (bypass !== null) problems.push('proxy.bypass 必须是字符串（逗号分隔的主机名）。');
      }
      if (proxy.mode === 'manual' && proxy.url === undefined) {
        problems.push('proxy.mode 设为 manual 时必须同时提供 proxy.url。');
      }
      next.proxy = proxy;
    }
  }

  for (const key of Object.keys(patch)) {
    if (
      key === 'dataRoot' ||
      key === 'preferredMirror' ||
      key === 'autoProbeMirror' ||
      key === 'proxy'
    ) {
      continue;
    }
    if (!key.startsWith('_')) ignored.push(key);
  }

  return { config: next, problems, ignored };
}

/** 配置不合法（HTTP 层映射成 400，CLI 层映射成退出码 2） */
export class ConfigValidationError extends Error {
  readonly problems: string[];
  readonly ignored: string[];
  constructor(problems: string[], ignored: string[] = []) {
    super(problems.join(' '));
    this.name = 'ConfigValidationError';
    this.problems = problems;
    this.ignored = ignored;
  }
}
