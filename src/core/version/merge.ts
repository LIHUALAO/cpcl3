/**
 * 版本 JSON 继承链合并（Forge / Fabric / NeoForge 等 `inheritsFrom` 场景）。
 *
 * 合并规则（对齐契约 docs/ARCHITECTURE.md 与任务说明）：
 *   - `libraries`：两边合并，同名 artifact（Maven `group:artifact` 相同）以后者（子版本）为准，
 *     并按父在前、子在后的顺序去重（保序去重：同 key 用子项覆盖父项但保留首次出现的位置）。
 *   - `mainClass` / `assets` / `assetIndex` / `minecraftArguments`：子版本有则覆盖。
 *   - `arguments.game` / `arguments.jvm`：父在前、子在后拼接（父项里被完全等价的子项重复时跳过）。
 *   - `downloads`：对象浅合并，同 key 子版本覆盖。
 *   - `libraries` 的 `artifact` 同 key 时子覆盖；`classifiers` / `natives` 子合并。
 *   - `rules` / `extract`：子版本有则用子版本的（同 `mainClass` 这类覆盖语义）。
 *   - 合并后 `inheritsFrom` 置为 `undefined`。
 *   - 其余未列出的额外字段：父有子无则继承父值，两边都有则子覆盖。
 *
 * 本模块是纯函数，不触网、不碰磁盘，便于单测。
 */

import type { ConditionalArg, Library, VersionJson } from '../types.js';
import type { DownloadArtifact } from '../types.js';

interface ArgList {
  game: (string | ConditionalArg)[];
  jvm: (string | ConditionalArg)[];
}

/**
 * Maven 坐标的「同名」判定 key：`group:artifact[:classifier]`。
 *
 * ⚠ classifier 必须参与比较。老实现只取 `group:artifact`，于是原版里成对出现的
 *
 *   com.mojang:jtracy:1.14.38                  ← 主 jar，游戏代码真正要加载的
 *   com.mojang:jtracy:1.14.38:natives-windows  ← 原生库（带 rules）
 *
 * 被判成同一个库，后者覆盖前者，合并结果只剩 natives → classpath 缺 jtracy 主 jar →
 * 游戏在 `<clinit>` 阶段 `NoClassDefFoundError: com/mojang/jtracy/TracyClient` 崩溃。
 *
 * 同 group:artifact 且**同 classifier** 才由子覆盖父（正常版本升级）；
 * classifier 不同的视为两个独立库，同时保留。
 */
export function libraryKey(name: string): string {
  const raw = name.trim();
  // 去掉尾部 @ext
  const withoutExt = raw.includes('@') ? raw.slice(0, raw.lastIndexOf('@')) : raw;
  const parts = withoutExt.split(':');
  if (parts.length >= 2) {
    const classifier = parts.length >= 4 ? (parts[3] ?? '') : '';
    return classifier === '' ? `${parts[0]}:${parts[1]}` : `${parts[0]}:${parts[1]}:${classifier}`;
  }
  return withoutExt;
}

function mergeLibraryArtifact(
  child: Library['downloads'],
  parent: Library['downloads'],
): Library['downloads'] | undefined {
  if (!parent && !child) return undefined;
  const artifact: DownloadArtifact | undefined = child?.artifact ?? parent?.artifact;
  const classifiers = { ...(parent?.classifiers ?? {}), ...(child?.classifiers ?? {}) };
  const result: Library['downloads'] = {};
  if (artifact) result.artifact = artifact;
  if (Object.keys(classifiers).length > 0) result.classifiers = classifiers;
  return result;
}

function mergeLibrary(child: Library, parent: Library): Library {
  const merged: Library = { ...parent, ...child };

  const downloads = mergeLibraryArtifact(child.downloads, parent.downloads);
  if (downloads) merged.downloads = downloads;
  else delete merged.downloads;

  const natives = { ...(parent.natives ?? {}), ...(child.natives ?? {}) };
  if (Object.keys(natives).length > 0) merged.natives = natives;
  else delete merged.natives;

  const rules = child.rules ?? parent.rules;
  if (rules) merged.rules = rules;
  else delete merged.rules;

  const extract = child.extract ?? parent.extract;
  if (extract) merged.extract = extract;
  else delete merged.extract;

  return merged;
}

/**
 * 合并两个库列表：父在前、子在后；同 `libraryKey` 的条目由子覆盖父，位置保留父首次出现的位置。
 * 只在子版本里出现的库追加到末尾。
 */
export function mergeLibraries(child: Library[], parent: Library[]): Library[] {
  const index = new Map<string, number>();
  const out: Library[] = [];

  for (const lib of parent) {
    const key = libraryKey(lib.name);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push(lib);
    } else {
      out[at] = lib;
    }
  }

  for (const lib of child) {
    const key = libraryKey(lib.name);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push(lib);
    } else {
      const existing = out[at];
      out[at] = existing ? mergeLibrary(lib, existing) : lib;
    }
  }

  return out;
}

/** 参数项等价判定：字符串按值，条件参数按 JSON 结构 */
function argKey(arg: string | ConditionalArg): string {
  return typeof arg === 'string' ? `s:${arg}` : `c:${JSON.stringify(arg)}`;
}

/**
 * 父在前、子在后拼接参数数组；父项里已被子项完全等价重复的条目会被跳过（保持子项位置）。
 */
export function concatArgs(
  parent: (string | ConditionalArg)[] | undefined,
  child: (string | ConditionalArg)[] | undefined,
): (string | ConditionalArg)[] {
  const p = parent ?? [];
  const c = child ?? [];
  const childKeys = new Set(c.map(argKey));
  const out: (string | ConditionalArg)[] = [];
  for (const arg of p) {
    if (childKeys.has(argKey(arg))) continue;
    out.push(arg);
  }
  for (const arg of c) out.push(arg);
  return out;
}

function mergeArguments(child: ArgList | undefined, parent: ArgList | undefined): ArgList | undefined {
  if (!child && !parent) return undefined;
  return {
    game: concatArgs(parent?.game, child?.game),
    jvm: concatArgs(parent?.jvm, child?.jvm),
  };
}

/**
 * 把子版本 JSON 合并到父版本 JSON 上，返回新的完整 JSON（不修改入参）。
 * 返回值中 `inheritsFrom` 为 undefined。
 */
export function mergeVersionJson(child: VersionJson, parent: VersionJson): VersionJson {
  const merged: VersionJson = { ...parent, ...child };

  // 显式覆盖语义的字段：子版本有则覆盖（这里已由展开完成），父有子无则继承（同样已由展开完成）。
  // 唯一需要特殊处理的是 mainClass 可能为空串的场景，空串视为「未声明」。
  if (typeof child.mainClass !== 'string' || child.mainClass.length === 0) {
    merged.mainClass = parent.mainClass;
  }
  if (typeof child.assets !== 'string' || child.assets.length === 0) {
    merged.assets = parent.assets;
  }

  merged.libraries = mergeLibraries(child.libraries ?? [], parent.libraries ?? []);

  const args = mergeArguments(child.arguments, parent.arguments);
  if (args) merged.arguments = args;
  else delete merged.arguments;

  const downloads = { ...(parent.downloads ?? {}), ...(child.downloads ?? {}) };
  if (Object.keys(downloads).length > 0) merged.downloads = downloads;
  else delete merged.downloads;

  const minecraftArguments = child.minecraftArguments ?? parent.minecraftArguments;
  if (minecraftArguments !== undefined) merged.minecraftArguments = minecraftArguments;
  else delete merged.minecraftArguments;

  const assetIndex = child.assetIndex ?? parent.assetIndex;
  if (assetIndex !== undefined) merged.assetIndex = assetIndex;
  else delete merged.assetIndex;

  const javaVersion = child.javaVersion ?? parent.javaVersion;
  if (javaVersion !== undefined) merged.javaVersion = javaVersion;
  else delete merged.javaVersion;

  const logging = child.logging ?? parent.logging;
  if (logging !== undefined) merged.logging = logging;
  else delete merged.logging;

  // 合并后不再声明继承链
  merged.inheritsFrom = undefined;
  return merged;
}
