/**
 * 版本 JSON 的本地合并（inheritsFrom 链）。
 *
 * `VersionRepository.resolveInherited` 由 version-dev 提供且优先使用；本文件是本地兜底，
 * 语义对齐官方元数据：
 *   - 标量字段子版本优先（mainClass / type / assets / javaVersion / downloads / logging…）
 *   - libraries：父在前、子在后，同 `group:artifact` 的由子版本覆盖（保留父的位置）
 *   - arguments.game / arguments.jvm：父在前、子在后拼接（父项里被完全等价重复的条目跳过）
 *   - minecraftArguments：子优先，缺省继承父
 *   - 合并完成后去掉 inheritsFrom（`exactOptionalPropertyTypes` 为 false，置 undefined 即可）
 */

import type { ConditionalArg, Library, VersionJson } from '../types.js';

/** Maven 同名判定 key：`group:artifact[:classifier]` */
export function libraryKey(name: string): string {
  const raw = name.trim();
  const withoutExt = raw.includes('@') ? raw.slice(0, raw.lastIndexOf('@')) : raw;
  const parts = withoutExt.split(':');
  if (parts.length >= 2) {
    const classifier = parts.length >= 4 ? (parts[3] ?? '') : '';
    return classifier === '' ? `${parts[0]}:${parts[1]}` : `${parts[0]}:${parts[1]}:${classifier}`;
  }
  return withoutExt;
}

function mergeLibraries(parent: readonly Library[], child: readonly Library[]): Library[] {
  const index = new Map<string, number>();
  const out: Library[] = [];
  for (const lib of parent) {
    const key = libraryKey(lib.name);
    if (!index.has(key)) {
      index.set(key, out.length);
      out.push(lib);
    } else {
      out[index.get(key) as number] = lib;
    }
  }
  for (const lib of child) {
    const key = libraryKey(lib.name);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push(lib);
    } else {
      const existing = out[at] as Library;
      out[at] = {
        ...existing,
        ...lib,
        downloads: {
          ...(existing.downloads ?? {}),
          ...(lib.downloads ?? {}),
          classifiers: {
            ...(existing.downloads?.classifiers ?? {}),
            ...(lib.downloads?.classifiers ?? {}),
          },
        },
        natives: { ...(existing.natives ?? {}), ...(lib.natives ?? {}) },
      };
    }
  }
  return out;
}

function argKey(arg: string | ConditionalArg): string {
  return typeof arg === 'string' ? `s:${arg}` : `c:${JSON.stringify(arg)}`;
}

function concatArgs(
  parent: readonly (string | ConditionalArg)[] | undefined,
  child: readonly (string | ConditionalArg)[] | undefined,
): (string | ConditionalArg)[] {
  const p = parent ?? [];
  const c = child ?? [];
  const childKeys = new Set(c.map(argKey));
  return [...p.filter((a) => !childKeys.has(argKey(a))), ...c];
}

export function mergeVersionJson(parent: VersionJson, child: VersionJson): VersionJson {
  const merged: VersionJson = { ...parent, ...child };

  if (typeof child.mainClass !== 'string' || child.mainClass.length === 0) {
    merged.mainClass = parent.mainClass;
  }
  if (typeof child.assets !== 'string' || child.assets.length === 0) {
    merged.assets = parent.assets;
  }

  merged.libraries = mergeLibraries(parent.libraries ?? [], child.libraries ?? []);

  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: concatArgs(parent.arguments?.game, child.arguments?.game),
      jvm: concatArgs(parent.arguments?.jvm, child.arguments?.jvm),
    };
  } else {
    merged.arguments = undefined;
  }

  const downloads = { ...(parent.downloads ?? {}), ...(child.downloads ?? {}) };
  merged.downloads = Object.keys(downloads).length > 0 ? downloads : undefined;

  merged.minecraftArguments = child.minecraftArguments ?? parent.minecraftArguments;
  merged.assetIndex = child.assetIndex ?? parent.assetIndex;
  merged.javaVersion = child.javaVersion ?? parent.javaVersion;
  merged.logging = child.logging ?? parent.logging;

  // 合并后不再声明继承链
  merged.inheritsFrom = undefined;
  return merged;
}
