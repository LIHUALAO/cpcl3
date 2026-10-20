/**
 * 参数拼装：rules 求值 → classpath → natives → jvm/game 参数 → 占位符替换。
 *
 * 全部是纯函数（除 natives 解压需要碰文件系统），方便单测。
 */

import type { ConditionalArg, Library, Rule } from '../types.js';
import { libraryAllowed, rulesAllow, type Platform } from './rules.js';
import { mavenRelativePath } from './maven.js';

// ───────────────────────────── 占位符 ─────────────────────────────

/**
 * 已知占位符全集（契约要求一个不能漏）。
 * 值都已在调用前做成「可直接塞进 args 的字符串」。
 */
export type PlaceholderMap = Readonly<Record<string, string>>;

export interface PlaceholderInput {
  authPlayerName: string;
  versionName: string;
  gameDirectory: string;
  assetsRoot: string;
  assetsIndexName: string;
  authUuid: string;
  authAccessToken: string;
  clientId: string;
  authXuid: string;
  userType: string;
  versionType: string;
  nativesDirectory: string;
  launcherName: string;
  launcherVersion: string;
  classpath: string;
  classpathSeparator: string;
  /** ${game_assets}：老版本的写法，映射到 assets 根（含 virtual/legacy 实例目录） */
  gameAssets: string;
}

export const KNOWN_PLACEHOLDERS: readonly string[] = Object.freeze([
  'auth_player_name',
  'version_name',
  'game_directory',
  'assets_root',
  'assets_index_name',
  'auth_uuid',
  'auth_access_token',
  'clientid',
  'auth_xuid',
  'user_type',
  'version_type',
  'natives_directory',
  'launcher_name',
  'launcher_version',
  'classpath',
  'classpath_separator',
  'game_assets',
]);

export function buildPlaceholders(input: PlaceholderInput): PlaceholderMap {
  return {
    auth_player_name: input.authPlayerName,
    version_name: input.versionName,
    game_directory: input.gameDirectory,
    assets_root: input.assetsRoot,
    assets_index_name: input.assetsIndexName,
    auth_uuid: input.authUuid,
    auth_access_token: input.authAccessToken,
    clientid: input.clientId,
    auth_xuid: input.authXuid,
    user_type: input.userType,
    version_type: input.versionType,
    natives_directory: input.nativesDirectory,
    launcher_name: input.launcherName,
    launcher_version: input.launcherVersion,
    classpath: input.classpath,
    classpath_separator: input.classpathSeparator,
    game_assets: input.gameAssets,
  };
}

/** 逐个替换 ${name}；未知占位符原样保留（便于排查，不静默吞掉） */
export function substitute(text: string, values: PlaceholderMap): string {
  return text.replace(/\$\{([^}]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? (values[name] as string) : whole,
  );
}

export function substituteAll(text: string, values: PlaceholderMap): string[] {
  return [substitute(text, values)];
}

// ───────────────────────────── 参数求值 ─────────────────────────────

function isConditionalArg(arg: string | ConditionalArg): arg is ConditionalArg {
  return typeof arg === 'object' && arg !== null && Array.isArray((arg as ConditionalArg).rules);
}

/**
 * 把 `(string | ConditionalArg)[]` 展开成字符串列表（未做占位符替换）。
 * - 纯字符串：直接加入
 * - 带 rules：rules 求值 → disallow 则整条丢弃；allow 则 value 里每个元素依次加入
 */
export function evaluateArguments(
  args: readonly (string | ConditionalArg)[] | undefined,
  platform: Platform,
  features?: Readonly<Record<string, boolean>>,
): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const arg of args) {
    if (typeof arg === 'string') {
      out.push(arg);
      continue;
    }
    if (!isConditionalArg(arg)) continue;
    if (!rulesAllow(arg.rules as Rule[], platform, features)) continue;
    if (Array.isArray(arg.value)) {
      for (const v of arg.value) out.push(v);
    } else if (typeof arg.value === 'string') {
      out.push(arg.value);
    }
  }
  return out;
}

/** 老版本 `minecraftArguments`：按空白切分 */
export function splitLegacyArguments(minecraftArguments: string | undefined): string[] {
  if (!minecraftArguments) return [];
  return minecraftArguments.trim().split(/\s+/).filter((s) => s.length > 0);
}

// ───────────────────────────── classpath ─────────────────────────────

export interface ClasspathPlan {
  /** 进入 classpath 的相对路径（已转成 OS 原生分隔符） */
  entries: Library[];
  /** natives 库（需解压，不进 classpath） */
  natives: Library[];
}

/**
 * 按平台过滤 libraries，区分 classpath 库与 natives 库。
 * natives 库判定：`natives` 字段里针对当前平台有 classifier，且它自己通常没有 artifact。
 */
export function planLibraries(
  libraries: readonly Library[],
  platform: Platform,
  features?: Readonly<Record<string, boolean>>,
): ClasspathPlan {
  const entries: Library[] = [];
  const natives: Library[] = [];
  for (const lib of libraries) {
    if (!libraryAllowed(lib, platform, features)) continue;
    if (nativeClassifier(lib, platform)) {
      natives.push(lib);
      // 同时声明了 artifact 的 natives 库（少见）仍然进 classpath
      if (lib.downloads?.artifact?.path) entries.push(lib);
      continue;
    }
    entries.push(lib);
  }
  return { entries, natives };
}

/** 取当前平台对应的 natives classifier 键 */
export function nativeClassifier(lib: Library, platform: Platform): string | null {
  const raw = lib.natives?.[platform.nativesKey];
  if (!raw) return null;
  return raw.replace('${arch}', platform.arch === 'x86' ? '32' : '64');
}

/** 库在磁盘上的 jar 路径（相对 librariesRoot 的路径），无法推导时返回 null */
export function libraryRelativePath(lib: Library): string | null {
  const artifactPath = lib.downloads?.artifact?.path;
  if (artifactPath) {
    const rel = artifactPath.replace(/^[/\\]+/, '');
    return rel.startsWith('libraries/') ? rel.slice('libraries/'.length) : rel;
  }
  return mavenRelativePath(lib.name);
}

/** natives jar 在磁盘上的相对路径 */
export function nativeRelativePath(lib: Library, classifier: string): string | null {
  const dl = lib.downloads?.classifiers?.[classifier];
  if (dl?.path) {
    const rel = dl.path.replace(/^[/\\]+/, '');
    return rel.startsWith('libraries/') ? rel.slice('libraries/'.length) : rel;
  }
  const coordinate = lib.name.split(':');
  if (coordinate.length >= 3) {
    return mavenRelativePath(`${coordinate[0]}:${coordinate[1]}:${coordinate[2]}:${classifier}`);
  }
  return null;
}

export interface ClasspathInput {
  entries: readonly Library[];
  librariesRoot: string;
  versionJar: string;
  path: { join: (...parts: string[]) => string };
  separator: string;
}

/** 拼 classpath 字符串；游戏本体 jar 永远在最后一位 */
export function buildClasspath(input: ClasspathInput): string[] {
  const list: string[] = [];
  for (const lib of input.entries) {
    const rel = libraryRelativePath(lib);
    if (!rel) continue; // 坐标残缺且没有 downloads 的库无法定位，跳过
    list.push(input.path.join(input.librariesRoot, ...rel.split('/')));
  }
  list.push(input.versionJar);
  return list;
}

// 用于 debug 场景：把 classpath 数组转字符串
export function joinClasspath(entries: readonly string[], separator: string): string {
  return entries.join(separator);
}

/** 是否存在 `${classpath}` 占位（存在时用单个参数传，避免命令行超长） */
export function hasClasspathPlaceholder(args: readonly string[]): boolean {
  return args.some((a) => a.includes('${classpath}'));
}
