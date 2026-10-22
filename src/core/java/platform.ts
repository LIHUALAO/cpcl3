/**
 * java-runtime 清单的平台 key 判定与主版本号推导。
 *
 * 为什么单独一个文件：这两件事都要能被测试直接调用（要求在模拟的 mac / linux 下断言行为），
 * 所以平台与架构全部走**参数注入**，不在函数内部直接读 `process.platform`。
 * 默认值仍然是当前进程，生产调用方不传参数即可。
 *
 * 平台 key 的取值必须以真实 all.json 为准。实测 2026-10 拉到的
 * `https://launchermeta.mojang.com/v1/products/java-runtime/<ver>/all.json`
 * 顶层正好是这 8 个 key：
 *   gamecore, linux, linux-i386, mac-os, mac-os-arm64, windows-arm64, windows-x64, windows-x86
 *
 * 注意：这里是 **platform → component → 条目数组** 的两层结构，
 * 与部分设计稿里「component → platform」的画法相反。以实际数据为准。
 */

import os from 'node:os';

/** 清单顶层可能出现的平台 key。 */
export type RuntimePlatform =
  | 'windows-x64'
  | 'windows-arm64'
  | 'windows-x86'
  | 'mac-os'
  | 'mac-os-arm64'
  | 'linux'
  | 'linux-i386'
  | 'gamecore';

/** Node 的 `process.arch` 取值（只列 runtime 判定会用到的）。 */
export type RuntimeArch = 'x64' | 'ia32' | 'arm64' | 'arm' | string;

export interface PlatformInput {
  /** `process.platform`；默认取当前进程 */
  platform?: string;
  /** `process.arch`；默认取当前进程 */
  arch?: RuntimeArch;
}

/**
 * 按优先顺序返回该机器可接受的平台 key 列表（越前越优先）。
 *
 * 规则：
 *   - Windows：x64 机器优先 `windows-x64`，但若清单里有 `windows-arm64` 也一并作为候选
 *     （arm64 Windows 上跑 x64 JVM 是官方支持的，反过来不行）；
 *     arm64 机器则 `windows-arm64` 优先，回退 `windows-x64`。
 *   - macOS：arm64 机器 `mac-os-arm64` 优先；x64 机器用 `mac-os`。
 *     （Rosetta 下 x64 JRE 也能跑，所以两个都留作候选。）
 *   - Linux：`linux` 优先；纯 32 位 x86 机器才用 `linux-i386`。
 *   - 其余（freebsd / aix / …）：返回空数组，调用方据此明确报错。
 *
 * 注意 `gamecore`（Xbox）永远不会被自动选中 —— 它不是桌面平台的运行时。
 */
export function platformCandidates(input: PlatformInput = {}): string[] {
  const platform = (input.platform ?? process.platform).toLowerCase();
  const arch = (input.arch ?? os.arch()).toLowerCase();

  if (platform === 'win32') {
    return arch === 'arm64' || arch === 'arm'
      ? ['windows-arm64', 'windows-x64']
      : arch === 'ia32'
        ? ['windows-x86', 'windows-x64']
        : ['windows-x64', 'windows-arm64'];
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? ['mac-os-arm64', 'mac-os'] : ['mac-os', 'mac-os-arm64'];
  }
  if (platform === 'linux') {
    return arch === 'ia32' ? ['linux-i386', 'linux'] : ['linux', 'linux-i386'];
  }
  return [];
}

/** 首选平台 key；不支持时返回 null。 */
export function primaryPlatform(input: PlatformInput = {}): string | null {
  return platformCandidates(input)[0] ?? null;
}

/** 在给定的 key 集合里按优先级挑第一个存在的平台 key。 */
export function pickAvailablePlatform(
  available: readonly string[],
  input: PlatformInput = {},
): string | null {
  const set = new Set(available);
  for (const candidate of platformCandidates(input)) {
    if (set.has(candidate)) return candidate;
  }
  return null;
}

// ───────────────────────────── 主版本号推导 ─────────────────────────────

/**
 * 已知组件 → Java 主版本的兜底表。
 *
 * 为什么需要兜底：版本 JSON 里自带 `javaVersion.majorVersion`，正常路径直接用那个值；
 * 但本模块也会被单独调用（例如只拿到 component 名、没有版本 JSON），这时 `majorVersionOf()`
 * 得能给出答案。运行时的 manifest.json 本身**不带** javaVersion 字段（实测只有 `files`），
 * 所以无法从清单反推，只能查表。
 *
 * 这些映射取自已发布版本的 version JSON 实测值：
 *   1.16.5 与 1.12.2 → jre-legacy     / 8
 *   1.17.1           → java-runtime-alpha / 16
 *   1.18.2           → java-runtime-beta  / 17
 *   1.19.4 / 1.20.1  → java-runtime-gamma / 17
 *   1.21 / 1.20.5    → java-runtime-delta / 21
 *   （任务书里「1.21 需要 Java 21」是对的，但组件名是 delta 不是 gamma；
 *     manifest 里 gamma 的 version.name 是 17.0.15，delta 才是 21 系。）
 */
export const KNOWN_COMPONENT_MAJORS: Readonly<Record<string, number>> = Object.freeze({
  'jre-legacy': 8,
  'java-runtime-alpha': 16,
  'java-runtime-beta': 17,
  'java-runtime-gamma': 17,
  'java-runtime-gamma-snapshot': 17,
  'java-runtime-delta': 21,
  'java-runtime-epsilon': 25,
  'minecraft-java-exe': 8,
});

/**
 * 拉取不到清单时，只靠组件名判断主版本。未知组件返回 null。
 * 供 `JavaRuntimeInstaller.majorVersionOf` 在离线场景兜底。
 */
export function majorFromComponentName(component: string): number | null {
  const key = component.trim().toLowerCase();
  const hit = KNOWN_COMPONENT_MAJORS[key];
  return hit === undefined ? null : hit;
}

/**
 * 从清单条目的 `version.name`（如 `17.0.15`、`1.8.0_392`）里读出主版本号。
 * 读不出返回 null。注意 `1.8.0_392` 的语义是 Java 8。
 */
export function parseMajorFromVersionName(name: string | undefined): number | null {
  if (typeof name !== 'string') return null;
  const m = /(\d+)(?:\.(\d+))?/.exec(name);
  if (!m || m[1] === undefined) return null;
  const first = Number(m[1]);
  if (first === 1 && m[2] !== undefined) return Number(m[2]);
  return first;
}
