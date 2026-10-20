/**
 * 最小 zip 读取实现：只读不写，仅支持 STORED(0) 与 DEFLATE(8)。
 * natives jar 里不会出现其它压缩方法，够用。
 *
 * 只用 node:zlib 的 inflateRawSync，不引第三方依赖。
 */

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** 读出某个条目的原始字节（目录条目返回空 Buffer） */
  read(entry: ZipEntry): Buffer;
}

const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;

function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('不是合法的 zip 文件：找不到 End of Central Directory 记录');
}

/** 解析 zip 的中央目录 */
export function openZip(buf: Buffer): ZipArchive {
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
    // 通用标志第 11 位（0x800）表示 UTF-8 文件名；natives 里几乎都是 ASCII
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', nameStart, nameStart + nameLen);
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
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
          return zlib.inflateRawSync(raw);
        default:
          throw new Error(
            `不支持的 zip 压缩方法 ${entry.compressionMethod}（仅支持 STORED/DEFLATE）：${entry.name}`,
          );
      }
    },
  };
}
