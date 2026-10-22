/**
 * 启动期 Java 解析：**只查找，不下载**。
 *
 * 自动下载的触发点在 `launcher.ts`（`buildCommand` 里 `pickJava` 之后），不放这里。
 * 理由是 downloads = 网络 IO = 异步，而本模块的 `pickJava` 是同步的；把异步塞进同步函数
 * 只会逼调用方改签名。因此职责切成两块：
 *
 *   java.ts（本文件）   纯同步：显式 javaPath → 数据目录里按 majorVersion 匹配 → 明确报错
 *   launcher.ts         拿到「没有可用 Java」这个信号后，调 JavaRuntimeInstaller 下载 → 再查一遍
 *
 * 这是对原有实现的最小扩展：新增一个 `pickJavaOrNull`（找不到返回 null 而不是抛错），
 * 原 `pickJava` 的行为与错误文案保持逐字不变（launch 模块既有测试直接断言那段文案）。
 *
 * `JavaRequirement` 已抽到 `java-types.ts`（避免 java.ts ↔ java-provision.ts 循环 import），
 * 这里原样再导出，`launch/index.ts` 与既有 import 路径都不用改。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { JavaRequirement } from './java-types.js';

const JAVA_BIN = process.platform === 'win32' ? 'javaw.exe' : 'java';

/** 版本目录里可执行文件的位置（Windows / *nix 都试一遍） */
function executableIn(home: string): string[] {
  return [
    path.join(home, 'bin', 'javaw.exe'),
    path.join(home, 'bin', 'java.exe'),
    path.join(home, 'bin', 'java'),
  ];
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isJavaHome(home: string): boolean {
  return executableIn(home).some((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** 取 java home 下的启动可执行文件；优先 javaw（Windows 无控制台窗口） */
export function javaExecutable(home: string): string {
  const candidates = executableIn(home);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 继续找下一个 */
    }
  }
  return process.platform === 'win32' ? path.join(home, 'bin', 'javaw.exe') : path.join(home, 'bin', 'java');
}

/** 从目录名里抠出主版本号：`17`、`jdk-17`、`jdk1.8`、`1.8.0_392`、`java-21-openjdk` 都要能识别 */
export function parseMajorVersion(text: string): number | null {
  const m = /(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  const first = Number(m[1]);
  if (first === 1 && m[2] !== undefined) return Number(m[2]); // 1.8 → 8
  return first;
}

export type { JavaRequirement };

export interface JavaLookup {
  javaHome: string;
  /** majorVersion（若推断得出） */
  majorVersion: number | null;
  component?: string;
}

/**
 * 在 `<dataRoot>/java/` 下找可用的 JRE。
 *
 * 匹配规则（宁缺毋滥，绝不拿错版本顶替）：
 *   - 路径里能读出主版本号时，必须 ≥ `required.majorVersion`（Java 向下兼容），
 *     且只能用于同一套 major 或更高 major；读不出来（null）的视为不可判定，不采用。
 *   - 组件名（如 java-runtime-gamma）命中时优先。
 * 目录命名不做假设：既支持 `<home>/java-runtime-gamma/bin/java`，也支持
 * `<home>/java-runtime-gamma/jdk-17/bin/java` 这种嵌套结构，深度限制 4 层。
 */
export function findJavaInDataRoot(dataRoot: string, required: JavaRequirement): JavaLookup[] {
  return scanJavaHomes(dataRoot, required)
    .filter((f) => f.accepted)
    .map((f) => f.lookup);
}

/**
 * 单个 java home 的扫描结果。
 *
 * `accepted` 对应原来那套严格规则的判定；被拒的条目**故意保留**下来，
 * 因为自动下载产出的布局是 `<dataRoot>/java/<component>/bin/java.exe`，
 * 组件名（`java-runtime-delta`）里没有数字，靠路径猜不出大版本会被拒。
 * 调用方可以拿 `javaHome` 再用权威来源（版本 JSON 的 majorVersion）复核。
 */
export interface ScannedJavaHome {
  lookup: JavaLookup;
  /** 原规则是否采纳 */
  accepted: boolean;
  /** 被拒原因；accepted 时为 undefined */
  rejectedReason?: 'unparsable-major' | 'too-low';
  score: number;
}

/** 扫描 `<dataRoot>/java` 下所有像 java home 的目录（不按版本过滤）。内部/高级 API。 */
export function scanJavaHomes(dataRoot: string, required: JavaRequirement): ScannedJavaHome[] {
  const javaRoot = path.join(dataRoot, 'java');
  if (!isDirectory(javaRoot)) return [];

  const homes: { home: string; depth: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    if (isJavaHome(dir)) {
      homes.push({ home: dir, depth });
      return; // 找到 java home 就不再往下钻
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(javaRoot, 0);

  void javaRoot;

  const out: ScannedJavaHome[] = [];
  for (const { home } of homes) {
    const rel = path.relative(javaRoot, home);
    const majorVersion = parseMajorVersion(rel);
    const component = rel.split(/[/\\]/)[0] ?? '';
    const lookup: JavaLookup = { javaHome: home, majorVersion };
    if (component !== '') lookup.component = component;

    if (majorVersion === null) {
      // 读不出主版本号 → 原规则不采用
      out.push({ lookup, accepted: false, rejectedReason: 'unparsable-major', score: 0 });
      continue;
    }
    if (majorVersion < required.majorVersion) {
      out.push({ lookup, accepted: false, rejectedReason: 'too-low', score: 0 });
      continue;
    }
    let score = 0;
    if (required.component && component === required.component) score += 1000;
    // 版本号：越接近要求越好（major 相同最优）
    score += 500 - Math.min(499, (majorVersion - required.majorVersion) * 10);
    out.push({ lookup, accepted: true, score });
  }

  out.sort((a, b) => b.score - a.score || a.lookup.javaHome.localeCompare(b.lookup.javaHome));
  return out;
}

/** 给用户看的明确错误信息 */
export function noJavaMessage(required: JavaRequirement, dataRoot: string, searched: string[]): string {
  const lines = [
    `找不到可用的 Java 运行时，无法启动游戏。`,
    `版本要求：Java ${required.majorVersion}${required.component ? `（组件 ${required.component}）` : ''}`,
    `已查找目录：${path.join(dataRoot, 'java')}`,
  ];
  if (searched.length > 0) {
    lines.push(`候选目录（版本不匹配，未采用）：${searched.join(', ')}`);
  }
  lines.push(`处理办法：1) 在启动选项里手动指定 javaPath（指向 java home 或其 bin/java 可执行文件）；`
    + `2) 或先安装对应大版本的 JRE。`);
  return lines.join('\n');
}

// ───────────────────────────── 启动期解析（新增） ─────────────────────────────

/** 显式 javaPath 不可用时的错误文案（launch 既有测试逐字断言） */
export function invalidJavaPathMessage(raw: string): string {
  return `指定的 javaPath 不可用：${raw}\n请指向 java/javaw 可执行文件，或指向 java home（含 bin/java 的目录）。`;
}

/**
 * 同步解析可用 Java，**找不到时返回 null 而不是抛错**。
 *
 * 这是给 `GameLauncher` 用的：它需要在「找不到」时先尝试自动下载，
 * 只有下载也失败才报错。返回 null 让上层能区分这两种情况。
 *
 * @param explicitPath `opts.javaPath`；给了就必须可用，否则直接抛错（不自动下载，
 *                     用户显式指定了路径，静默换成别的 Java 是更差的行为）
 */
export function pickJavaOrNull(
  dataRoot: string,
  required: JavaRequirement,
  explicitPath?: string | null,
): string | null {
  const raw = explicitPath?.trim() ?? '';
  if (raw.length > 0) {
    const p = path.resolve(raw);
    if (isFile(p)) return p;
    if (isJavaHome(p)) return javaExecutable(p);
    throw new Error(invalidJavaPathMessage(raw));
  }

  const first = findJavaInDataRoot(dataRoot, required)[0];
  return first === undefined ? null : javaExecutable(first.javaHome);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export { JAVA_BIN };
