/**
 * 最小 zip 写入器 —— 仅测试使用。
 *
 * 产品代码只需要**读** zip（launch/natives 解压、packs 读 pack.mcmeta），
 * 但测试要造出「像真的一样」的包：pack.mcmeta 的两种格式、shaders/ 目录、
 * 坏 ZIP 头、STORED 与 DEFLATE 混用。用 node:zlib 自己拼，不引第三方库。
 *
 * 只实现 STORED(0) 与 DEFLATE(8)，与 launch/zip.ts 的读取能力对齐。
 */

import zlib from 'node:zlib';

export interface WriteEntry {
  name: string;
  /** 文本（默认 utf8）或原始字节 */
  data: string | Buffer;
  /** 是否 deflate 压缩；默认 true（空内容自动 STORED） */
  deflate?: boolean;
}

interface LocalRecord {
  name: Buffer;
  method: number;
  crc: number;
  compressed: Buffer;
  uncompressedSize: number;
  offset: number;
}

/** CRC32（zip 必须的校验字段） */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] as number;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 构造一个 zip 文件 */
export function buildZip(entries: WriteEntry[]): Buffer {
  const locals: LocalRecord[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const useDeflate = entry.deflate !== false && raw.length > 0;
    const compressed = useDeflate ? zlib.deflateRawSync(raw) : raw;
    const method = useDeflate ? 8 : 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 名字标志
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0x21, 12); // date（1980-01-01 附近，固定值避免测试不确定）
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    chunks.push(header, name, compressed);
    locals.push({
      name,
      method,
      crc: crc32(raw),
      compressed,
      uncompressedSize: raw.length,
      offset,
    });
    offset += header.length + name.length + compressed.length;
  }

  const centralChunks: Buffer[] = [];
  let centralSize = 0;
  for (const local of locals) {
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(local.method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(local.crc, 16);
    cen.writeUInt32LE(local.compressed.length, 20);
    cen.writeUInt32LE(local.uncompressedSize, 24);
    cen.writeUInt16LE(local.name.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(local.offset, 42);
    centralChunks.push(cen, local.name);
    centralSize += cen.length + local.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(locals.length, 8);
  eocd.writeUInt16LE(locals.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...centralChunks, eocd]);
}

/** 造一个 pack.mcmeta（pack_format 为数字） */
export function mcmetaNumeric(packFormat: number, description: string | object): string {
  return `${JSON.stringify({ pack: { pack_format: packFormat, description } }, null, 2)}\n`;
}

/** 造一个 pack.mcmeta（pack_format 为区间对象） */
export function mcmetaRange(
  min: number,
  max: number,
  description: string | object,
): string {
  return `${JSON.stringify(
    { pack: { pack_format: { min_inclusive: min, max_inclusive: max }, description } },
    null,
    2,
  )}\n`;
}

/** 资源包：pack.mcmeta + 一点点 pack.png 占位 */
export function resourcePackZip(opts: { mcmeta?: string; extra?: WriteEntry[] } = {}): Buffer {
  return buildZip([
    { name: 'pack.mcmeta', data: opts.mcmeta ?? mcmetaNumeric(15, '测试资源包') },
    { name: 'pack.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: 'assets/minecraft/lang/zh_cn.json', data: '{"item.apple":"苹果"}' },
    ...(opts.extra ?? []),
  ]);
}

/** 数据包：pack.mcmeta + data/ 下的一个函数文件 */
export function dataPackZip(opts: { mcmeta?: string } = {}): Buffer {
  return buildZip([
    { name: 'pack.mcmeta', data: opts.mcmeta ?? mcmetaNumeric(48, { text: '测试数据包' }) },
    { name: 'data/test/functions/hello.mcfunction', data: 'say hello\n' },
  ]);
}

/** 光影包：**没有** pack.mcmeta，只有 shaders/ 目录 */
export function shaderPackZip(opts: { withEntry?: boolean } = {}): Buffer {
  const entries: WriteEntry[] = [
    { name: 'shaders/final.fsh', data: 'void main() { gl_FragColor = vec4(1.0); }\n' },
    { name: 'shaders/composite.vsh', data: 'void main() { gl_Position = ftransform(); }\n' },
    { name: 'shaders/block.properties', data: 'block.10008=minecraft:water\n' },
  ];
  if (opts.withEntry === false) {
    // 只有无关目录：用来验证「不是光影包」的判定
    return buildZip([{ name: 'readme.txt', data: '这不是光影包' }]);
  }
  return buildZip(entries);
}

/** 一个「不是 zip」的假文件 */
export function notAZip(): Buffer {
  return Buffer.from('this is definitely not a zip file\n', 'utf8');
}
