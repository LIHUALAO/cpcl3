/**
 * 平台识别与 rules 求值。
 *
 * 规则语义（对齐 Mojang 官方启动器 / PCL2）：
 *   - 无 rules            → 允许
 *   - 有 rules            → 初值为 disallow，按顺序遍历；某条 rule 的 os/features 条件全部匹配时，
 *                           该 rule 的 action 覆盖当前结果。于是「最后一条匹配的 rule 说了算」。
 *   - os.arch 省略       → 匹配任意架构（只有显式声明才参与判定）
 *   - 给了但未知的 features key → 视为 false
 */

import type { Library, Rule } from '../types.js';

/** 平台名，与 rules 里 os.name 的取值域一致 */
export type OsName = 'windows' | 'osx' | 'linux';
/** 架构名，与 rules 里 os.arch 的取值域一致 */
export type OsArch = 'x86' | 'x86_64' | 'arm64';

export interface Platform {
  name: OsName;
  arch: OsArch;
  /** classpath 分隔符 */
  classpathSeparator: string;
  /** rules 的 natives 映射表用的 key（与 os.name 相同） */
  nativesKey: string;
}

/**
 * 本项目统一固定的 feature 取值：只有演示账户与自定义分辨率两个开关，
 * 且恒为 false（启动器暂不支持这两个功能）。
 */
export const DEFAULT_FEATURES: Readonly<Record<string, boolean>> = Object.freeze({
  is_demo_user: false,
  has_custom_resolution: false,
});

export function nodePlatformToOsName(platform: NodeJS.Platform): OsName {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'osx';
    default:
      // Linux 以及其它 POSIX 平台都按 linux 处理
      return 'linux';
  }
}

export function nodeArchToOsArch(arch: string): OsArch {
  switch (arch) {
    case 'ia32':
      return 'x86';
    case 'x64':
      return 'x86_64';
    case 'arm64':
      return 'arm64';
    case 'arm':
      // 32 位 arm 没有对应取值，退化成 x86（绝大多数库不会为它单独声明）
      return 'x86';
    default:
      return 'x86_64';
  }
}

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Platform {
  const name = nodePlatformToOsName(platform);
  return {
    name,
    arch: nodeArchToOsArch(arch),
    classpathSeparator: name === 'windows' ? ';' : ':',
    nativesKey: name,
  };
}

/**
 * 判断单条 rule 是否命中当前平台。
 * 注意：os.arch 只有显式出现时才参与判定；官方元数据里大量库只写 os.name。
 */
export function matchesRule(
  rule: Rule,
  platform: Platform,
  features: Readonly<Record<string, boolean>> = DEFAULT_FEATURES,
): boolean {
  if (rule.os) {
    if (rule.os.name !== undefined && rule.os.name !== platform.name) return false;
    if (rule.os.arch !== undefined && !archMatches(rule.os.arch, platform.arch)) return false;
    // os.version（内核版本）不参与判定：跨平台无法可靠获取，官方库也几乎不用
  }
  if (rule.features) {
    for (const key of Object.keys(rule.features)) {
      const expected = rule.features[key] === true;
      const actual = features[key] === true;
      if (expected !== actual) return false;
    }
  }
  return true;
}

/** os.arch 允许写通配，这里做容错比较 */
function archMatches(expected: string, actual: OsArch): boolean {
  if (expected === actual) return true;
  // 极少数元数据把 x86_64 写成 amd64
  if (actual === 'x86_64' && expected === 'amd64') return true;
  return false;
}

/** 一组 rules 是否让该对象生效 */
export function rulesAllow(
  rules: Rule[] | undefined,
  platform: Platform,
  features: Readonly<Record<string, boolean>> = DEFAULT_FEATURES,
): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false; // 有 rules 时默认 disallow
  for (const rule of rules) {
    if (matchesRule(rule, platform, features)) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

/** 库在当前平台是否应被使用（进 classpath 或进 natives 列表） */
export function libraryAllowed(
  lib: Library,
  platform: Platform,
  features: Readonly<Record<string, boolean>> = DEFAULT_FEATURES,
): boolean {
  return rulesAllow(lib.rules, platform, features);
}
