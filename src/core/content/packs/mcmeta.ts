/**
 * 从 pack.mcmeta / zip 目录结构里提取元数据。
 *
 * 只用 `node:zlib` 与 launch 模块的最小 zip 读取器（`../launch/zip.js`，只读复用，不修改）。
 * 不引第三方库。
 *
 * 三种格式都必须认（真实世界全都在用）：
 *   pack.pack_format  数字            {"pack":{"pack_format":15,"description":"x"}}
 *   pack.pack_format  对象区间        {"pack":{"pack_format":{"min_inclusive":15,"max_inclusive":18}}}
 *   pack.description  字符串          ""
 *   pack.description  聊天组件        {"text":"…"} / {"translate":"…"} / ["第一行","第二行"] / {"extra":[…]}
 *   还有 1.20.2+ 的 supported_formats（只认作补充信息，不覆盖 pack_format）
 *
 * 光影包没有 mcmeta，靠 zip 里有没有 `shaders/` 下的真实文件判定。
 */

import { openZip, type ZipArchive } from '../../launch/zip.js';

/** 解析结果（全部字段都是尽力而为，读不到就缺省） */
export interface PackMetaResult {
  /** pack_format 数字；对象区间取 min_inclusive（Minecraft 也是这么比的） */
  packFormat?: number;
  /** 对象形式的完整区间 */
  packFormatRange?: { minInclusive?: number; maxInclusive?: number };
  /** description 拍平成纯文本 */
  description?: string;
  /** 解析失败原因；成功时为 undefined */
  error?: string;
}

/** pack.mcmeta 在 zip 里的候选路径（大小写与深浅都容错，只到第 2 层，不做递归扫描） */
const MCMETA_CANDIDATES = [
  'pack.mcmeta',
  'Pack.mcmeta',
  'pack.mcmeta'.toUpperCase(),
  '__MACOSX/pack.mcmeta',
];

/** mcmeta 体积上限：正常几 KB，超过 1 MB 一定是恶意/损坏文件，不值得 ReadFileSync 进内存 */
export const MCMETA_MAX_BYTES = 1024 * 1024;

/**
 * 打开 zip（失败时返回 undefined，不抛）。
 * 包坏了不该让整个列表报错 —— 用户需要看到「这个包坏了」，而不是「列表加载失败」。
 */
export function tryOpenZip(buf: Buffer): { archive: ZipArchive } | { error: string } {
  if (buf.length < 22) return { error: '文件太小，不是 zip' };
  try {
    return { archive: openZip(buf) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 从 zip 里读 pack.mcmeta 并解析。
 * 没有 mcmeta → 返回空结果 + error（数据包/资源包缺 mcmeta 是「装也能装，但游戏不认」）；
 * 有但坏了 → 返回 error，其它字段缺省。
 */
export function readPackMeta(archive: ZipArchive): PackMetaResult {
  const entry = findMcmetaEntry(archive);
  if (entry === undefined) return { error: 'zip 内没有 pack.mcmeta' };
  if (entry.uncompressedSize > MCMETA_MAX_BYTES) {
    return { error: `pack.mcmeta 过大（${String(entry.uncompressedSize)} 字节）` };
  }

  let text: string;
  try {
    text = archive.read(entry).toString('utf8');
  } catch (error) {
    return { error: `解压 pack.mcmeta 失败：${messageOf(error)}` };
  }

  // UTF-8 BOM 会让 JSON.parse 直接失败，先剥掉
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `pack.mcmeta 不是合法 JSON：${messageOf(error)}` };
  }

  return parsePackMetaJson(parsed);
}

/** 纯函数版：直接解析 mcmeta 的 JSON 文本（测试与上传校验共用） */
export function parsePackMetaText(text: string): PackMetaResult {
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { error: `pack.mcmeta 不是合法 JSON：${messageOf(error)}` };
  }
  return parsePackMetaJson(parsed);
}

/**
 * 已解析的 JSON → PackMetaResult。
 *
 * 容错优先级：`pack.pack_format` 优先；没有才看 `pack.supported_formats`；
 * 两个都没有就当缺失（不猜成 1，猜错会让 UI 显示假的兼容版本）。
 */
export function parsePackMetaJson(parsed: unknown): PackMetaResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'pack.mcmeta 顶层不是对象' };
  }
  const pack = (parsed as Record<string, unknown>)['pack'];
  if (pack === undefined) return { error: 'pack.mcmeta 缺少 pack 字段' };

  // 少数资源包把 pack 本身写成字符串/数字的变体不存在，但数组是真实出现过的坏文件
  if (typeof pack !== 'object' || pack === null || Array.isArray(pack)) {
    return { error: 'pack.mcmeta 的 pack 字段不是对象' };
  }
  const record = pack as Record<string, unknown>;

  const out: PackMetaResult = {};

  const format = record['pack_format'];
  const range = asRange(format);
  if (range !== undefined) {
    if (range.minInclusive !== undefined) out.packFormat = range.minInclusive;
    if (range.minInclusive !== undefined || range.maxInclusive !== undefined) {
      out.packFormatRange = range;
    }
  }

  // 1.20.2+ 的 supported_formats：只用作补充（pack_format 缺失时顶上来）
  if (out.packFormat === undefined) {
    const supported = asRange(record['supported_formats']);
    if (supported !== undefined && supported.minInclusive !== undefined) {
      out.packFormat = supported.minInclusive;
      out.packFormatRange = supported;
    }
  }

  if ('description' in record) {
    const text = chatToPlainText(record['description']);
    if (text !== undefined) out.description = text;
  }

  return out;
}

/** 数字 / `{min_inclusive,max_inclusive}` / `[min,max]` → 区间 */
function asRange(raw: unknown): { minInclusive?: number; maxInclusive?: number } | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { minInclusive: Math.trunc(raw), maxInclusive: Math.trunc(raw) };
  }
  if (Array.isArray(raw) && raw.length >= 1) {
    const min = toInt(raw[0]);
    const max = toInt(raw[1] ?? raw[0]);
    if (min === undefined && max === undefined) return undefined;
    return {
      ...(min === undefined ? {} : { minInclusive: min }),
      ...(max === undefined ? {} : { maxInclusive: max }),
    };
  }
  if (typeof raw === 'object' && raw !== null) {
    const rec = raw as Record<string, unknown>;
    const min = toInt(rec['min_inclusive']);
    const max = toInt(rec['max_inclusive']);
    if (min === undefined && max === undefined) return undefined;
    return {
      ...(min === undefined ? {} : { minInclusive: min }),
      ...(max === undefined ? {} : { maxInclusive: max }),
    };
  }
  return undefined;
}

function toInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  // 有些包把数字写成字符串（"15"），认了不影响判定
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

/**
 * 聊天组件 → 纯文本。
 *
 * 这是「两种格式都要处理」里最容易做漏的一处：
 *   "description": "树叶重制"                        ← 字符串
 *   "description": {"text":"树叶重制"}                ← 组件
 *   "description": {"translate":"pack.name"}          ← 翻译键（我们翻译不了，原样显示键名）
 *   "description": {"text":"A","extra":["B",{"text":"C"}]}
 *   "description": ["第一行","第二行"]                ← 数组（1.20.3+ 常见）
 *
 * 拍平后把换行归一成 ` / `，避免 UI 里出现多行把列表撑爆。
 */
export function chatToPlainText(raw: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined; // 深层嵌套的恶意 JSON 直接放弃

  if (typeof raw === 'string') return clampText(raw);
  if (typeof raw === 'number' || typeof raw === 'boolean') return clampText(String(raw));
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      const text = chatToPlainText(item, depth + 1);
      if (text !== undefined && text.length > 0) parts.push(text);
    }
    // 数组元素之间只用空格：换行在叶子节点已经拍成 ` / `，再拼 `/` 会出现 `A B / C` 这种怪东西
    return parts.length === 0 ? undefined : clampText(parts.join(' '), { allowBreak: false });
  }
  if (typeof raw === 'object' && raw !== null) {
    const rec = raw as Record<string, unknown>;
    const parts: string[] = [];
    // text 与 translate 不会同时出现；两个都认，先 text
    const head = chatToPlainText(rec['text'], depth + 1) ?? chatToPlainText(rec['translate'], depth + 1);
    if (head !== undefined && head.length > 0) parts.push(head);
    // with 是 translate 的参数，偶尔有用（我们不做真翻译，只把参数摊开）
    if (rec['with'] !== undefined) {
      const withText = chatToPlainText(rec['with'], depth + 1);
      if (withText !== undefined && withText.length > 0) parts.push(`(${withText})`);
    }
    if (rec['extra'] !== undefined) {
      const extra = chatToPlainText(rec['extra'], depth + 1);
      if (extra !== undefined && extra.length > 0) parts.push(extra);
    }
    return parts.length === 0 ? undefined : clampText(parts.join(' '), { allowBreak: false });
  }
  return undefined;
}

/** description 展示上限：真实描述很少超过 200 字，超长就截断（它会被塞进列表行） */
export const MAX_DESCRIPTION_LENGTH = 500;

/**
 * 拍平 + 截断。
 *
 * `allowBreak` 控制「换行拍成什么」：
 *   - 组件之间（数组元素、extra 子节点）用空格拼接，不允许再引入 `/`
 *   - 顶层描述文本里的真实换行才拍成 ` / `，避免 UI 里出现多行把列表撑爆
 */
function clampText(text: string, opts: { allowBreak?: boolean } = {}): string {
  const allowBreak = opts.allowBreak !== false;
  const unified = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const flat = (allowBreak ? unified.replace(/\s*\n\s*/g, ' / ') : unified.replace(/\s*\n\s*/g, ' ')).trim();
  return flat.length > MAX_DESCRIPTION_LENGTH ? `${flat.slice(0, MAX_DESCRIPTION_LENGTH)}…` : flat;
}

/** 在中央目录里找 pack.mcmeta（精确名优先，其次大小写变体） */
function findMcmetaEntry(archive: ZipArchive) {
  const byLower = new Map<string, (typeof archive.entries)[number]>();
  for (const entry of archive.entries) {
    const key = entry.name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, entry);
  }
  for (const candidate of MCMETA_CANDIDATES) {
    const found = byLower.get(candidate.toLowerCase());
    if (found !== undefined) return found;
  }
  // 兜底：任何以 /pack.mcmeta 结尾的条目（例如 `mypack/pack.mcmeta`，用户多套了一层目录）
  for (const entry of archive.entries) {
    if (entry.name.toLowerCase().endsWith('/pack.mcmeta')) return entry;
  }
  return undefined;
}

// ───────────────────────────── 光影包识别 ─────────────────────────────

/** shaders/ 目录下的已知入口文件（不区分顺序，命中任意一个即可） */
export const SHADER_ENTRY_FILES: readonly string[] = [
  'shaders/final.fsh',
  'shaders/composite.fsh',
  'shaders/composite1.fsh',
  'shaders/composite2.fsh',
  'shaders/gbuffers_basic.fsh',
  'shaders/shadow.fsh',
  'shaders/deferred.fsh',
  'shaders/deferred1.fsh',
  'shaders/begin.csh',
];

/**
 * 判定 zip 是不是光影包。
 *
 * 依据只有一条：中央目录里存在 `shaders/` 目录下的**真实文件**。
 *   - 目录条目本身（`shaders/`，名字以 / 结尾、大小为 0）不算
 *   - 只看第 0 层，避免把「资源包里恰好有个 shaders/ 说明文档」误判：
 *     实际上资源包带 shaders/ 的极少，而光影包 100% 有 shaders/ 下的 .fsh，
 *     所以再加一条「至少有一个 .fsh/.vsh/.glsl/.csh/.properties 结尾的条目」。
 *
 * 读不到（zip 坏了）返回 false 而不是抛错 —— 光影包没有 mcmeta，不能因为读不到元数据就拒绝安装。
 */
export function detectShader(archive: ZipArchive): boolean {
  const entries = archive.entries;
  if (entries.length === 0) return false;

  // 常见入口文件直接命中
  const lower = new Set(entries.map((e) => e.name.toLowerCase().replace(/^\.\//, '')));
  for (const name of SHADER_ENTRY_FILES) {
    if (lower.has(name)) return true;
  }

  // 退一步：shaders/ 下任意一个着色器源文件
  let sawShadersFile = false;
  for (const entry of entries) {
    const name = entry.name.toLowerCase().replace(/^\.\//, '');
    if (name.endsWith('/')) continue; // 目录条目
    if (!name.startsWith('shaders/')) continue;
    if (/\.(fsh|vsh|glsl|csh|gsh|tcs|tes|properties)$/.test(name)) {
      sawShadersFile = true;
      break;
    }
  }
  return sawShadersFile;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
