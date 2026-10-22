/**
 * 读 `.mrpack`：把 zip 中央目录摊平成一份「条目清单」，并把
 * `modrinth.index.json` 解析成 `ModpackIndex`。
 *
 * zip 解析严格复用 `../../launch/zip.js` 的 `openZip`（只读、不改它）。
 * 那一层只认 STORED / DEFLATE 两种压缩方法 —— mrpack 正是这两种，够用。
 *
 * 这里只管「读出来 + 校验」，不落盘、不下载。
 */

import * as fs from 'node:fs/promises';

import { openZip, type ZipArchive, type ZipEntry } from '../../launch/zip.js';

import { splitSafeZipPath } from './safe-path.js';
import {
  ModpackError,
  type ModpackFile,
  type ModpackIndex,
  type ModpackOverrideEntry,
  type OverrideRoot,
} from './types.js';

/** 清单在 zip 里的固定名字 */
export const INDEX_ENTRY = 'modrinth.index.json';

/** 三个 overrides 根目录；数组顺序即「后写的覆盖先写的」的优先级 */
export const OVERRIDE_ROOTS: readonly OverrideRoot[] = ['overrides', 'client-overrides', 'server-overrides'];

/** 清单文件大小上限：正常 mrpack 的 index 只有几十 KB，20 MB 已是荒谬值 */
export const MAX_INDEX_BYTES = 20 * 1024 * 1024;

export interface OpenedModpack {
  archive: ZipArchive;
  indexPath: string;
  fileSize: number;
}

/** 打开并做最基本的形状检查（是不是 zip、有没有清单） */
export async function openModpack(filePath: string): Promise<OpenedModpack> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new ModpackError('not-found', `找不到整合包文件：${filePath}`, '确认路径是否正确（上传后的临时文件在系统临时目录下）。');
  }
  if (!stat.isFile()) {
    throw new ModpackError('not-found', `整合包路径不是一个文件：${filePath}`);
  }

  const buf = await fs.readFile(filePath);
  return { ...openBuffer(buf), fileSize: stat.size };
}

/** 同一个解析流程的 Buffer 版（测试与上传后直接解析都用它） */
export function openBuffer(buf: Buffer): OpenedModpack {
  let archive: ZipArchive;
  try {
    archive = openZip(buf);
  } catch (error) {
    throw new ModpackError(
      'not-a-zip',
      `这个文件不是合法的整合包：${messageOf(error)}`,
      '`.mrpack` 本质是一个 zip；请确认选的是整合包文件而不是被改过扩展名的其它文件。',
    );
  }

  const entry = archive.entries.find((e) => normalizeEntryName(e.name) === INDEX_ENTRY);
  if (entry === undefined) {
    throw new ModpackError(
      'missing-index',
      `整合包里没有 ${INDEX_ENTRY}，这不是 Modrinth 整合包（.mrpack）。`,
      '请确认下载的是「Modrinth 整合包」；CurseForge 的 .zip 整合包结构不同，需要先转换成 .mrpack。',
    );
  }
  if (entry.uncompressedSize > MAX_INDEX_BYTES) {
    throw new ModpackError(
      'bad-index',
      `${INDEX_ENTRY} 过大（${String(entry.uncompressedSize)} 字节，上限 ${String(MAX_INDEX_BYTES)}）。`,
      '这份清单不像正常的整合包，可能是损坏或被构造过的文件。',
    );
  }
  return { archive, indexPath: entry.name, fileSize: buf.byteLength };
}

/** 读出并解析清单 */
export function readIndex(opened: OpenedModpack): ModpackIndex {
  const entry = opened.archive.entries.find((e) => e.name === opened.indexPath);
  if (entry === undefined) {
    throw new ModpackError('missing-index', `整合包里没有 ${INDEX_ENTRY}。`);
  }

  let text: string;
  try {
    text = opened.archive.read(entry).toString('utf8');
  } catch (error) {
    throw new ModpackError('bad-index', `${INDEX_ENTRY} 读取失败：${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ModpackError(
      'bad-index',
      `${INDEX_ENTRY} 不是合法 JSON：${messageOf(error)}`,
      '整合包可能下载不完整，重新下载一次试试。',
    );
  }
  return normalizeIndex(parsed);
}

/** 列出 overrides / client-overrides / server-overrides 下的所有条目 */
export function listOverrides(archive: ZipArchive): ModpackOverrideEntry[] {
  const out: ModpackOverrideEntry[] = [];
  for (const entry of archive.entries) {
    const parsed = parseOverrideEntry(entry);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** zip 中央目录条目总数（含目录条目） */
export function countEntries(archive: ZipArchive): number {
  return archive.entries.length;
}

// ───────────────────────────── 内部：清单归一化 ─────────────────────────────

function normalizeIndex(raw: unknown): ModpackIndex {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badIndex('顶层不是 JSON 对象。');
  }
  const rec = raw as Record<string, unknown>;

  const formatVersion = typeof rec['formatVersion'] === 'number' ? rec['formatVersion'] : Number(rec['formatVersion']);
  if (!Number.isFinite(formatVersion)) {
    throw badIndex('缺 formatVersion（应当是 1）。');
  }
  if (formatVersion !== 1) {
    throw new ModpackError(
      'bad-index',
      `不支持的整合包格式版本 ${String(formatVersion)}，本启动器只认 formatVersion 1。`,
      '这类包可能是更新版本的 .mrpack，需要更新启动器。',
    );
  }

  const game = typeof rec['game'] === 'string' && rec['game'].trim() !== '' ? rec['game'].trim() : 'minecraft';
  if (game !== 'minecraft') {
    throw new ModpackError('bad-index', `这是「${game}」的整合包，不是 Minecraft 的，装不了。`);
  }

  const name = typeof rec['name'] === 'string' && rec['name'].trim() !== '' ? rec['name'].trim() : '未命名整合包';
  const versionId =
    typeof rec['versionId'] === 'string' && rec['versionId'].trim() !== '' ? rec['versionId'].trim() : '1.0.0';
  const summary = typeof rec['summary'] === 'string' && rec['summary'].trim() !== '' ? rec['summary'].trim() : undefined;

  const dependencies = normalizeDependencies(rec['dependencies']);
  const files = normalizeFiles(rec['files']);

  const index: ModpackIndex = {
    formatVersion,
    name,
    versionId,
    game,
    dependencies,
    files,
  };
  if (summary !== undefined) index.summary = summary;
  return index;
}

function normalizeDependencies(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badIndex('dependencies 必须是对象，例如 { "minecraft": "1.21" }。');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw badIndex(`dependencies 里「${key}」的值不是字符串。`);
    }
    const trimmed = value.trim();
    if (trimmed !== '') out[key.toLowerCase()] = trimmed;
  }
  return out;
}

function normalizeFiles(raw: unknown): ModpackFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw badIndex('files 必须是数组。');
  }

  const out: ModpackFile[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw badIndex(`files[${String(i)}] 不是对象。`);
    }
    const rec = item as Record<string, unknown>;

    const rawPath = rec['path'];
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      throw badIndex(`files[${String(i)}].path 缺失。`);
    }
    // 路径在这里就过一遍安全检查：解析阶段就拒绝，而不是等到解压时才炸
    const segments = splitSafeZipPath(rawPath.trim());
    if (segments.length === 0) {
      throw badIndex(`files[${String(i)}].path 是空路径。`);
    }
    const filePath = segments.join('/');

    const downloadsRaw = rec['downloads'];
    if (!Array.isArray(downloadsRaw)) {
      throw badIndex(`files[${String(i)}].downloads 必须是数组。`);
    }
    const downloads = downloadsRaw
      .filter((u): u is string => typeof u === 'string' && u.trim() !== '')
      .map((u) => u.trim());
    if (downloads.length === 0) {
      throw badIndex(`files[${String(i)}]（${filePath}）没有任何下载地址。`);
    }

    const hashes: { sha1?: string; sha512?: string } = {};
    const hashesRaw = rec['hashes'];
    if (hashesRaw !== undefined && hashesRaw !== null) {
      if (typeof hashesRaw !== 'object' || Array.isArray(hashesRaw)) {
        throw badIndex(`files[${String(i)}].hashes 必须是对象。`);
      }
      const h = hashesRaw as Record<string, unknown>;
      if (typeof h['sha1'] === 'string' && h['sha1'].trim() !== '') hashes.sha1 = h['sha1'].trim().toLowerCase();
      if (typeof h['sha512'] === 'string' && h['sha512'].trim() !== '') hashes.sha512 = h['sha512'].trim().toLowerCase();
    }

    const file: ModpackFile = { path: filePath, hashes, downloads };

    const envRaw = rec['env'];
    if (envRaw !== undefined && envRaw !== null) {
      if (typeof envRaw !== 'object' || Array.isArray(envRaw)) {
        throw badIndex(`files[${String(i)}].env 必须是对象。`);
      }
      const e = envRaw as Record<string, unknown>;
      const env: { client?: string; server?: string } = {};
      if (typeof e['client'] === 'string') env.client = e['client'].trim().toLowerCase();
      if (typeof e['server'] === 'string') env.server = e['server'].trim().toLowerCase();
      file.env = env;
    }

    const sizeRaw = rec['fileSize'];
    if (typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) && sizeRaw >= 0) {
      file.fileSize = Math.floor(sizeRaw);
    }

    out.push(file);
  });

  return out;
}

// ───────────────────────────── 内部：overrides ─────────────────────────────

function parseOverrideEntry(entry: ZipEntry): ModpackOverrideEntry | undefined {
  const name = normalizeEntryName(entry.name);
  const isDirectory = name.endsWith('/');

  for (const root of OVERRIDE_ROOTS) {
    if (!name.startsWith(`${root}/`)) continue;
    const rest = name.slice(root.length + 1);
    if (rest === '') continue; // 根目录自身

    // 安全底线：含 .. / 绝对路径 / 盘符 的条目直接拒绝，整个包作废。
    // 不静默丢弃——静默丢弃会让「攻击包里少一个恶意文件」看起来像正常安装成功。
    const segments = splitSafeZipPath(isDirectory ? rest.replace(/\/+$/, '') : rest);

    return {
      path: entry.name,
      target: segments.join('/'),
      source: root,
      size: entry.uncompressedSize,
      isDirectory: isDirectory || segments.length === 0,
    };
  }
  return undefined;
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/');
}

function badIndex(detail: string): ModpackError {
  return new ModpackError('bad-index', `${INDEX_ENTRY} 内容不合法：${detail}`, '这份整合包可能已损坏，重新下载一次再试。');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
