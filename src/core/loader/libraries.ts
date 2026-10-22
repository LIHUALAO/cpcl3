/**
 * 库下载任务的生成 —— 本模块里最容易踩空的一块。
 *
 * ⚠ 致命坑（实测，2026-10）：
 *   Fabric / Quilt 的 profile JSON 里，`libraries[]` **完全没有 `downloads.artifact`**，
 *   只有 `name` + `url`（https://maven.fabricmc.net/ 或 https://maven.quiltmc.org/repository/release/），
 *   部分条目带平铺 `sha1` / `size`。
 *
 *   如果照搬原版安装器的 `lib.downloads?.artifact` 写法，结果是：
 *   **空下载列表** → 表面「安装成功」→ 依赖全缺 → 启动必崩（NoClassDefFoundError）。
 *
 * 因此这里实现三级回退链：
 *   1. `lib.downloads?.artifact` 存在 → 直接用它（url / path / sha1 / size 全齐）
 *   2. 否则 → `lib.url + mavenRelativePath(lib.name)` 自行拼 URL，
 *             sha1 / size 取平铺的 `lib.sha1` / `lib.size`
 *   3. 两者都没有校验信息（`net.fabricmc:intermediary:<gv>`、
 *      `net.fabricmc:fabric-loader:<ver>`、Quilt 的大部分条目都是这样）
 *      → **裸下载不校验**，在 plan 的 `integrity: 'none'` 里如实标注，
 *        不假装「校验通过」（sha1 缺失时 Downloader 会跳过校验，只做长度收敛）。
 *
 * 库来源域（maven.fabricmc.net / maven.quiltmc.org）不在 download 模块的
 * mirror 白名单内，`whitelist` 策略下 URL 原样直连 —— 这正是我们要的，不改 mirror.ts。
 */

import path from 'node:path';

import type { DownloadTask, Library } from '../types.js';
import type { LoaderKind } from './types.js';
import type { LoaderDownloadTask } from './types.js';

// ───────────────────────────── Maven 路径 ─────────────────────────────

/**
 * Maven 坐标 → 仓库内相对路径。
 *
 * 支持 `group:artifact:version[:classifier][@ext]`，
 * 例如 `net.fabricmc:sponge-mixin:0.15.4+mixin.0.8.7`
 *   → net/fabricmc/sponge-mixin/0.15.4+mixin.0.8.7/sponge-mixin-0.15.4+mixin.0.8.7.jar
 *
 * 注意：Fabric 的这段 `mavenRelativePath()` 与原版安装器的 `mavenPath()` 语义一致，
 * 但这里额外处理了 `@ext` 后缀（Andesite / Quilt 偶尔会带），且不 throw —— 返回 null。
 */
export function mavenRelativePath(coordinate: string): string | null {
  const raw = coordinate.trim();
  if (raw === '') return null;

  let ext = 'jar';
  let body = raw;
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const maybeExt = raw.slice(at + 1).trim();
    if (maybeExt !== '') ext = maybeExt;
    body = raw.slice(0, at);
  }

  const parts = body.split(':');
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return null;

  const dir = `${group.replace(/\./g, '/')}/${artifact}/${version}`;
  const file = classifier
    ? `${artifact}-${version}-${classifier}.${ext}`
    : `${artifact}-${version}.${ext}`;
  return `${dir}/${file}`;
}

/** 把仓库根与相对路径拼成完整 URL（容忍根缺少结尾 `/`） */
export function joinMavenUrl(root: string, relativePath: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  return `${base}${relativePath.replace(/^\/+/, '')}`;
}

// ───────────────────────────── 任务生成 ─────────────────────────────

/** profile 里库条目的额外平铺字段（不在共享类型 Library 里，用收窄读取） */
interface FlatLibraryFields {
  sha1?: unknown;
  size?: unknown;
  url?: unknown;
  downloads?: { artifact?: { url?: unknown; path?: unknown; sha1?: unknown; size?: unknown } };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return n > 0 ? n : undefined;
  }
  return undefined;
}

/**
 * 单条库 → 下载任务（回退链的实现点）。
 *
 * @param lib              profile 里的库条目（原样，不预处理）
 * @param fallbackMavenRoot 该库完全没写 `url` 时才用的仓库根
 * @param librariesRoot    <dataRoot>/libraries
 * @returns 生成不了（坐标非法且无 artifact）时返回 undefined，并在调用处计入警告
 */
export function libraryToTask(
  lib: Library,
  fallbackMavenRoot: string,
  librariesRoot: string,
): LoaderDownloadTask | undefined {
  const name = typeof lib.name === 'string' ? lib.name.trim() : '';
  const extra = lib as Library & FlatLibraryFields;

  // ── 回退 1：profile 自带 downloads.artifact（Fabric/Quilt 目前都没有，但保留兼容） ──
  const artifact = lib.downloads?.artifact;
  if (artifact && asString(artifact.url)) {
    const rel = asString(artifact.path) ?? (name !== '' ? mavenRelativePath(name) : null);
    if (!rel) return undefined;
    const task: LoaderDownloadTask = {
      url: asString(artifact.url) as string,
      dest: path.join(librariesRoot, ...rel.split('/')),
      library: name,
      integrity: 'artifact',
    };
    const sha1 = asString(artifact.sha1);
    if (sha1) task.sha1 = sha1;
    const size = asNumber(artifact.size);
    if (size !== undefined) task.size = size;
    return task;
  }

  if (name === '') return undefined;
  const rel = mavenRelativePath(name);
  if (!rel) return undefined;

  // ── 回退 2：lib.url + maven 路径自拼；sha1/size 取平铺字段 ──
  const libUrl = asString(extra.url);
  const root = libUrl ?? fallbackMavenRoot;
  const url = joinMavenUrl(root, rel);

  const task: LoaderDownloadTask = {
    url,
    dest: path.join(librariesRoot, ...rel.split('/')),
    library: name,
    integrity: 'none',
  };

  const sha1 = asString(extra.sha1);
  const size = asNumber(extra.size);
  if (sha1) {
    task.sha1 = sha1;
    task.integrity = 'library-sha1';
  }
  if (size !== undefined) task.size = size;

  return task;
}

/**
 * 整个 profile 的 `libraries[]` → 下载任务列表。
 *
 * 只做「有 URL 就下」的判定，不做 OS 规则过滤之外的取舍：
 * Fabric/Quilt 的库列表本身不带 natives / rules（实测），但保留 rules 兼容
 * （万一将来加），由调用方传入的谓词决定是否保留。
 */
export function librariesToTasks(
  libraries: readonly Library[],
  options: {
    kind: LoaderKind;
    fallbackMavenRoot: string;
    librariesRoot: string;
    /** 默认全部保留；调用方可传 rules 过滤 */
    keep?: (lib: Library) => boolean;
  },
): { tasks: LoaderDownloadTask[]; skipped: { name: string; reason: string }[] } {
  const tasks: LoaderDownloadTask[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const lib of libraries) {
    const name = typeof lib.name === 'string' ? lib.name.trim() : '(unnamed)';
    if (options.keep && !options.keep(lib)) {
      skipped.push({ name, reason: 'rules 该平台不适用' });
      continue;
    }
    const task = libraryToTask(lib, options.fallbackMavenRoot, options.librariesRoot);
    if (!task) {
      skipped.push({ name, reason: '坐标非法且无 downloads.artifact，无法拼出下载地址' });
      continue;
    }
    const key = process.platform === 'win32' ? task.dest.toLowerCase() : task.dest;
    if (seen.has(key)) {
      skipped.push({ name, reason: '目标路径重复（同 artifact 已包含）' });
      continue;
    }
    seen.add(key);
    tasks.push(task);
  }

  return { tasks, skipped };
}

/** 转成契约的 DownloadTask（剥掉本模块的附加字段） */
export function toDownloadTasks(tasks: readonly LoaderDownloadTask[]): DownloadTask[] {
  return tasks.map((t) => {
    const base: DownloadTask = { url: t.url, dest: t.dest };
    if (t.sha1 !== undefined) base.sha1 = t.sha1;
    if (t.size !== undefined) base.size = t.size;
    return base;
  });
}
