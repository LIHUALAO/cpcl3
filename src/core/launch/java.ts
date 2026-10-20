/**
 * JVM 选择与进程内运行类。
 *
 * 选择顺序：
 *   1. opts.javaPath（显式指定）—— 存在即用，不做版本校验
 *   2. `<dataRoot>/java/` 下与 `javaVersion.majorVersion` 匹配的 JRE
 *   3. 全部失败 → 抛错，绝不退回 PATH 里随便一个 java
 *
 * 注意：本机 Node 不在 PATH，因此不使用 `spawnSync('where', ...)` 之类的命令探测，
 * 一律直接读文件系统。
 */

import fs from 'node:fs';
import path from 'node:path';

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

export interface JavaRequirement {
  /** 版本 JSON 里的 javaVersion.majorVersion；缺省按 8 */
  majorVersion: number;
  /** 版本 JSON 里的 javaVersion.component，如 jre-legacy / java-runtime-gamma */
  component?: string;
}

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

  const found: { lookup: JavaLookup; score: number }[] = [];
  for (const { home } of homes) {
    const rel = path.relative(javaRoot, home);
    const majorVersion = parseMajorVersion(rel);
    // 读不出主版本号 → 无法保证兼容，不采用（由调用方报错要求用户指定）
    if (majorVersion === null) continue;
    // 低于要求的版本一律不用
    if (majorVersion < required.majorVersion) continue;

    const component = rel.split(/[/\\]/)[0] ?? '';
    let score = 0;
    if (required.component && component === required.component) score += 1000;
    // 版本号：越接近要求越好（major 相同最优）
    score += 500 - Math.min(499, (majorVersion - required.majorVersion) * 10);
    const lookup: JavaLookup = { javaHome: home, majorVersion };
    if (required.component) lookup.component = component;
    found.push({ lookup, score });
  }

  found.sort((a, b) => b.score - a.score || a.lookup.javaHome.localeCompare(b.lookup.javaHome));
  return found.map((f) => f.lookup);
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

export { JAVA_BIN };
