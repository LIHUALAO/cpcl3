/**
 * 从 mod jar 里读元数据。
 *
 * jar 就是 zip：只读中央目录 + 解压需要的几个条目，**不整体解包**
 * （一个 30 MB 的模组包里有上万条资源条目，全解一遍没有必要）。
 *
 * 支持两种元数据（真实世界全都在用）：
 *   1. `fabric.mod.json`   —— Fabric / Quilt：{ id, name, version, ... }
 *   2. `META-INF/mods.toml` —— Forge / NeoForge：TOML，用正则提取字段
 *      （不引 TOML 解析器：核心零第三方依赖，而我们要的只有 id/name/version 三个字符串）
 *
 * 读不到就返回 undefined，**不报错**：用户手动丢进来的 jar 千奇百怪，
 * 一个坏 jar 不该让整个 mod 列表打不开。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// ───────────────────────────── 常量 ─────────────────────────────

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;

/** 元数据文件在 zip 里的候选路径（大小写都容错） */
export const FABRIC_META = 'fabric.mod.json';
export const FORGE_META = 'META-INF/mods.toml';

/**
 * 只读元数据的体积上限。
 *
 * 为什么要有：`fabric.mod.json` 正常 1~3 KB，`mods.toml` 也就几十 KB；
 * 见过恶意/损坏的 jar 在这里声明 4 GB 解压长度，直接 inflate 会把内存打爆。
 */
const META_MAX_BYTES = 4 * 1024 * 1024;

/** 不读进内存的 jar 上限：超过就跳过元数据（模组不可能这么大，多半是整合包改名） */
const MAX_JAR_BYTES = 512 * 1024 * 1024;

// ───────────────────────────── 类型 ─────────────────────────────

/** 从 jar 里读出来的元数据（全部字段都是尽力而为） */
export interface ModJarMeta {
  id?: string;
  name?: string;
  version?: string;
  /** 元数据来自哪种格式：便于排障与前端标注 */
  source: 'fabric.mod.json' | 'mods.toml' | 'none';
  /** 解析异常时的说明（有值不代表没读到东西） */
  error?: string;
}

// ───────────────────────────── 最小 zip 读取 ─────────────────────────────

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ZipArchive {
  entries: ZipEntry[];
  /** 解压某个条目；目录条目返回空 Buffer */
  read(entry: ZipEntry): Buffer;
}

/** 找 EOCD：从尾部往前扫，最多扫注释长度 */
function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
    // 越界保护：i 太小时 readUInt32LE 会抛，提前退出
    if (i <= 0) break;
  }
  throw new Error('不是合法的 zip/jar：找不到 End of Central Directory');
}

function openZip(buf: Buffer): ZipArchive {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) throw new Error('zip 中央目录被截断');
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('zip 中央目录条目签名错误');
    const flags = buf.readUInt16LE(p + 8);
    const compressionMethod = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const nameStart = p + 46;
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', nameStart, nameStart + nameLen);
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    p = nameStart + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    read(entry: ZipEntry): Buffer {
      const lh = entry.localHeaderOffset;
      if (lh + 30 > buf.length) throw new Error(`zip 本地头越界：${entry.name}`);
      if (buf.readUInt32LE(lh) !== LOC_SIG) throw new Error(`zip 本地头签名错误：${entry.name}`);
      const nameLen = buf.readUInt16LE(lh + 26);
      const extraLen = buf.readUInt16LE(lh + 28);
      const dataStart = lh + 30 + nameLen + extraLen;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > buf.length) throw new Error(`zip 数据越界：${entry.name}`);
      const raw = buf.subarray(dataStart, dataEnd);
      switch (entry.compressionMethod) {
        case 0:
          return Buffer.from(raw);
        case 8:
          return zlib.inflateRawSync(raw, { maxOutputLength: META_MAX_BYTES });
        default:
          throw new Error(`不支持的 zip 压缩方法 ${String(entry.compressionMethod)}：${entry.name}`);
      }
    },
  };
}

// ───────────────────────────── 主入口 ─────────────────────────────

/**
 * 读 jar 文件的元数据。
 *
 * 永远 resolve（不 reject）：文件不存在、不是 zip、元数据坏掉，都表现为
 * `{ source: 'none', error }`，由调用方决定怎么展示。
 */
export async function readModJarMeta(filePath: string): Promise<ModJarMeta> {
  const none: ModJarMeta = { source: 'none' };

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    return { ...none, error: `读不到文件：${messageOf(error)}` };
  }
  if (!stat.isFile()) return { ...none, error: '不是一个普通文件' };
  if (stat.size > MAX_JAR_BYTES) return { ...none, error: `文件过大（${String(stat.size)} 字节），跳过元数据解析` };
  if (stat.size < EOCD_MIN_SIZE) return { ...none, error: '文件太小，不是 zip/jar' };

  let buf: Buffer;
  try {
    buf = await fsp.readFile(filePath);
  } catch (error) {
    return { ...none, error: `读取失败：${messageOf(error)}` };
  }

  let archive: ZipArchive;
  try {
    archive = openZip(buf);
  } catch (error) {
    return { ...none, error: `不是合法的 zip/jar：${messageOf(error)}` };
  }

  // 1) Fabric / Quilt
  // 解析失败也照样返回（带 error）：文件里确实有 fabric.mod.json 这个事实，
  // 比「什么也没找到」更有信息量，UI 可以据此提示「这个 jar 的元数据坏了」。
  const fabricEntry = findEntry(archive, FABRIC_META);
  if (fabricEntry !== undefined) return readFabricMeta(archive, fabricEntry);

  // 2) Forge / NeoForge
  const forgeEntry = findEntry(archive, FORGE_META);
  if (forgeEntry !== undefined) {
    return readForgeMeta(archive, forgeEntry);
  }

  return { ...none, error: 'jar 里既没有 fabric.mod.json 也没有 META-INF/mods.toml' };
}

/**
 * 从内存里的 zip 字节读元数据（测试 / 上传 / 未来「预览 jar」场景）。
 */
export function readMetaFromBuffer(buf: Buffer): ModJarMeta {
  let archive: ZipArchive;
  try {
    archive = openZip(buf);
  } catch (error) {
    return { source: 'none', error: `不是合法的 zip/jar：${messageOf(error)}` };
  }
  const fabricEntry = findEntry(archive, FABRIC_META);
  if (fabricEntry !== undefined) return readFabricMeta(archive, fabricEntry);
  const forgeEntry = findEntry(archive, FORGE_META);
  if (forgeEntry !== undefined) return readForgeMeta(archive, forgeEntry);
  return { source: 'none', error: 'jar 里既没有 fabric.mod.json 也没有 META-INF/mods.toml' };
}

// ───────────────────────────── 各格式解析 ─────────────────────────────

/** 在中央目录里按名字找条目（大小写不敏感，`./` 前缀容错） */
function findEntry(archive: ZipArchive, wanted: string): ZipEntry | undefined {
  const target = wanted.toLowerCase();
  for (const entry of archive.entries) {
    const name = entry.name.toLowerCase().replace(/^\.\//, '');
    if (name === target) return entry;
    // 某些打包工具会多套一层目录（`mymod/fabric.mod.json`），认它
    if (name.endsWith(`/${target}`)) return entry;
  }
  return undefined;
}

function readFabricMeta(archive: ZipArchive, entry: ZipEntry): ModJarMeta {
  if (entry.uncompressedSize > META_MAX_BYTES) {
    return { source: 'fabric.mod.json', error: `fabric.mod.json 过大（${String(entry.uncompressedSize)} 字节）` };
  }

  let text: string;
  try {
    text = archive.read(entry).toString('utf8');
  } catch (error) {
    return { source: 'fabric.mod.json', error: `解压 fabric.mod.json 失败：${messageOf(error)}` };
  }

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { source: 'fabric.mod.json', error: `fabric.mod.json 不是合法 JSON：${messageOf(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { source: 'fabric.mod.json', error: 'fabric.mod.json 顶层不是对象' };
  }

  const rec = parsed as Record<string, unknown>;
  const out: ModJarMeta = { source: 'fabric.mod.json' };
  const id = str(rec['id']);
  if (id !== undefined) out.id = id;
  const name = str(rec['name']) ?? (str(rec['id']) ?? undefined);
  if (name !== undefined) out.name = name;
  const version = str(rec['version']);
  if (version !== undefined) out.version = version;
  return out;
}

/**
 * Forge / NeoForge 的 `META-INF/mods.toml`。
 *
 * 只用正则取三个字段：
 *   modId     = "sodium"        （或 modId="sodium"，单引号也认）
 *   displayName = "Sodium"
 *   version   = "0.5.8"
 *
 * 坑：`version` 经常写作 `${file.jarVersion}` 这类占位符（Forge 在运行时替换），
 * 这种「不是版本号」的值直接丢掉，别让 UI 显示 `${file.jarVersion}`。
 */
function readForgeMeta(archive: ZipArchive, entry: ZipEntry): ModJarMeta {
  if (entry.uncompressedSize > META_MAX_BYTES) {
    return { source: 'mods.toml', error: `mods.toml 过大（${String(entry.uncompressedSize)} 字节）` };
  }

  let text: string;
  try {
    text = archive.read(entry).toString('utf8');
  } catch (error) {
    return { source: 'mods.toml', error: `解压 mods.toml 失败：${messageOf(error)}` };
  }

  const out: ModJarMeta = { source: 'mods.toml' };
  const modId = tomlString(text, 'modId');
  if (modId !== undefined) out.id = modId;

  const displayName = tomlString(text, 'displayName');
  const name = displayName ?? modId;
  if (name !== undefined) out.name = name;

  const version = tomlString(text, 'version');
  if (version !== undefined && !/\$\{/.test(version)) out.version = version;

  if (out.id === undefined && out.name === undefined && out.version === undefined) {
    out.error = 'mods.toml 里没找到 modId / displayName / version';
  }
  return out;
}

/** TOML 里取一个 `key = "value"` 的字符串值（不区分大小写，单/双引号都认） */
export function tomlString(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*("([^"\\n]*)"|'([^'\\n]*)')`, 'im');
  const m = pattern.exec(text);
  if (m === null) return undefined;
  const value = (m[2] ?? m[3] ?? '').trim();
  return value.length > 0 ? value : undefined;
}

/** 从文件名猜一个展示名（元数据读不到时的兜底）：`sodium-fabric-0.5.8.jar` → `sodium-fabric-0.5.8` */
export function nameFromFilename(filename: string): string {
  const base = path.basename(filename);
  return base.replace(/\.jar(\.disabled)?$/i, '');
}

function str(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
