/**
 * 规则（rules）求值与 OS 判定。
 *
 * Mojang 的规则语义（与官方 launcher 一致）：
 *   - 从「默认拒绝」开始；
 *   - 按顺序遍历 rules，某条规则的 os / features 条件全部满足时，就把当前结果设为该规则的 action；
 *   - 空 rules / 未声明 rules → 允许。
 *
 * OS 名称映射：node 的 process.platform → Mojang 的 os.name
 *   win32 → windows，darwin → osx，其余 linux。
 * arch 映射：x64 → x86_64（Mojang 用 "x86" 表示 32 位）。
 */

import * as os from 'node:os';
import type { Rule } from '../types.js';

export interface OsInfo {
  name: string;
  version?: string;
  arch: string;
}

/** 当前运行环境的 OS 描述 */
export function currentOs(): OsInfo {
  const platform = process.platform;
  const name = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
  const archKey = process.arch; // 'x64' | 'arm64' | 'ia32' | ...
  const arch =
    archKey === 'x64' ? 'x86_64' : archKey === 'ia32' ? 'x86' : archKey === 'arm64' ? 'arm64' : archKey;
  return {
    name,
    version: os.release(),
    arch,
  };
}

/**
 * 判断一组规则是否允许在给定环境下生效。
 * 传 `undefined` 视为「无限制」→ 返回 true。
 */
export function rulesAllow(rules: Rule[] | undefined, osInfo: OsInfo = currentOs()): boolean {
  if (!rules || rules.length === 0) return true;

  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, osInfo)) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

/** 单条规则的条件是否满足（不考虑 action） */
function ruleMatches(rule: Rule, osInfo: OsInfo): boolean {
  if (rule.os) {
    const want = rule.os;
    if (want.name !== undefined && want.name !== osInfo.name) return false;
    if (want.arch !== undefined && normalizeArch(want.arch) !== normalizeArch(osInfo.arch)) return false;
    if (want.version !== undefined) {
      // Mojang 在 os.version 里用正则（如 "^10\\.5\\.\\d$"），解析失败就当作整数比较
      try {
        const re = new RegExp(want.version);
        if (!re.test(osInfo.version ?? '')) return false;
      } catch {
        if ((osInfo.version ?? '').startsWith(want.version)) {
          // 退化为前缀匹配，避免正则写错导致整库被误杀
        } else {
          return false;
        }
      }
    }
  }

  if (rule.features) {
    // 本项目暂不启用任何 feature 开关（demo 模式、自定义分辨率等一律 false）
    for (const [feature, required] of Object.entries(rule.features)) {
      const actual = FEATURES[feature] ?? false;
      if (actual !== required) return false;
    }
  }

  return true;
}

const FEATURES: Record<string, boolean> = {
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
};

function normalizeArch(arch: string): string {
  if (arch === 'x64' || arch === 'amd64' || arch === 'x86_64') return 'x86_64';
  if (arch === 'ia32' || arch === 'x86' || arch === 'i386') return 'x86';
  return arch;
}
