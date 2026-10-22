/**
 * 资源包 / 数据包 / 光影包的共享类型与路径安全工具。
 *
 * 这个模块（src/core/content/packs）只管三类**本地文件**的安装、启用与删除：
 *   resourcepack → <instanceDir>/resourcepacks/                    （.zip 直接丢进去）
 *   datapack     → <instanceDir>/saves/<存档>/datapacks/  或全局 <instanceDir>/datapacks/
 *   shader       → <instanceDir>/shaderpacks/                      （需要 Iris/OptiFine 才生效，我们只负责放文件）
 *
 * 不碰网络协议、不碰 Modrinth、不碰模组。
 *
 * 目录规则里最容易出事的是「用户给的文件名被拼进路径」，所以文件名一律先过
 * `checkFilename`：拒绝分隔符、`..`、盘符、控制字符，再额外做一次 realpath 前缀复核。
 */

/** 三类内容 */
export type PackKind = 'resourcepack' | 'datapack' | 'shader';

/** 合法种类（顺序即 UI 顺序） */
export const PACK_KINDS: readonly PackKind[] = ['resourcepack', 'datapack', 'shader'] as const;

export const PACK_KIND_LABEL: Record<PackKind, string> = {
  resourcepack: '资源包',
  datapack: '数据包',
  shader: '光影包',
};

/**
 * 单个已安装的包。
 *
 * 元数据字段（packFormat / description / mcmetaError）全部是「尽力而为」：
 * 读不到就是 undefined，绝不让列表因此失败。
 */
export interface InstalledPack {
  /** 磁盘上的真实文件名（禁用态也保留原文件名，不带 .disabled 后缀） */
  filename: string;
  kind: PackKind;
  /** 字节数 */
  size: number;
  /** 启用状态：false 表示磁盘上是 `<filename>.disabled` */
  enabled: boolean;
  /** 从 zip 内 pack.mcmeta 读出的 pack_format（对象形式的区间取 min_inclusive） */
  packFormat?: number;
  /** pack.mcmeta 的 description（字符串或聊天组件文字被拍平） */
  description?: string;
  /** 对象形式 pack_format 的完整区间，UI 可据此提示兼容性 */
  packFormatRange?: { minInclusive?: number; maxInclusive?: number };
  /** 光影包：zip 内是否存在 shaders/ 目录下的真实文件 */
  hasShaders?: boolean;
  /** 解析 pack.mcmeta 失败的原因（损坏的 zip、坏 JSON）。不是安装失败，只是元数据缺失 */
  mcmetaError?: string;
  /** 完整路径（只在本地 API 里给排障用，不含任何秘密） */
  path: string;
  /** 最后修改时间（毫秒） */
  modifiedAt: number;
}

/** 一个存档（saves/<name>/，有 level.dat 才算有效） */
export interface SaveSummary {
  name: string;
  /** level.dat 是否在（API 只返回 level.dat 存在的存档） */
  hasLevelDat: boolean;
  /** datapacks 目录是否已存在 */
  hasDatapacks: boolean;
  lastPlayed?: number;
}

/** 安装来源 */
export interface PackInstallTask {
  url: string;
  filename: string;
  sha1?: string;
}

/** 安全校验失败（HTTP 层映射 400） */
export class PackValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'PackValidationError';
    this.field = field;
  }
}

/** 安装前置条件不满足（HTTP 层映射 404/409） */
export class PackNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackNotFoundError';
  }
}

/** 判断字符串是不是合法种类 */
export function isPackKind(value: unknown): value is PackKind {
  return typeof value === 'string' && (PACK_KINDS as readonly string[]).includes(value);
}

/** 解析种类；不合法返回 undefined（HTTP 层据此回 400） */
export function parsePackKind(raw: unknown): PackKind | undefined {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return isPackKind(text) ? text : undefined;
}

/**
 * 一次安装允许的最大字节数。
 *
 * 光影包（Complementary 之类）也就几十 MB，512 MB 足够宽松，
 * 但足以挡住「一不小心把整个磁盘指过来」这种病态输入。
 */
export const MAX_PACK_BYTES = 512 * 1024 * 1024;

/** 文件名长度上限（Windows 单段路径 255，留出 .disabled 后缀的余量） */
export const MAX_FILENAME_LENGTH = 200;

/** 禁用态后缀 */
export const DISABLED_SUFFIX = '.disabled';

/** 包扩展名：Minecraft 只认 .zip（数据包也支持目录，但我们只处理打包好的 zip） */
export const PACK_EXTENSION = '.zip';

// ───────────────────────────── 文件名 / 实例 id 校验 ─────────────────────────────

/** Windows 保留设备名：即使带扩展名也不能用 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * 文件名校验 —— 这是本模块的安全底线。
 *
 * 拒绝的东西（每一条都能造成实际后果）：
 *   - 空 / 超长
 *   - 任何路径分隔符 `/` `\`（Windows 与 POSIX 都算）
 *   - `..`、`.`、`...` 这类点段（相对穿越）
 *   - 盘符 `C:`、UNC 前缀、以分隔符开头的绝对路径
 *   - 控制字符 / 空字节（`\u0000` 会让 fs 抛 ENOENT 或截断路径）
 *   - 以点或空格结尾（Windows 会静默去掉，导致「写进去的文件名和列表里的不一致」）
 *   - Windows 保留设备名
 *
 * 允许 Unicode：中文资源包名（「更好的树叶.zip」）是常态。
 *
 * @returns 规范化后的文件名（原样返回，不做 trim —— 前导/尾随空格本来就是非法的）
 */
export function checkFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return '文件名必须是字符串。';
  if (raw.length === 0) return '文件名不能为空。';
  if (raw.length > MAX_FILENAME_LENGTH) {
    return `文件名过长（${String(raw.length)} 个字符，上限 ${String(MAX_FILENAME_LENGTH)}）。`;
  }
  if (raw.includes('\u0000')) return '文件名里不能有空字节。';
  // eslint-disable-next-line no-control-regex
  if (/[\u0001-\u001f\u007f]/.test(raw)) return '文件名里不能有控制字符（换行、制表符等）。';
  if (raw.includes('/') || raw.includes('\\')) {
    return '文件名里不能出现路径分隔符（/ 或 \\），只接受单独的文件名。';
  }
  if (raw === '.' || raw === '..' || /^\.+$/.test(raw)) {
    return `文件名不能是「${raw}」。`;
  }
  if (/^[a-zA-Z]:/.test(raw)) return '文件名里不能出现盘符。';
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return '不接受 UNC 路径。';
  if (/[. ]$/.test(raw)) return '文件名不能以点或空格结尾（Windows 会静默去掉，导致读写不一致）。';
  const base = raw.replace(/\.[^.]*$/, '').toLowerCase();
  if (RESERVED_NAMES.has(base) || RESERVED_NAMES.has(raw.toLowerCase())) {
    return `「${raw}」是 Windows 保留设备名，换一个文件名。`;
  }
  return null;
}

/**
 * 实例 id 校验：它会被拼进 `<dataRoot>/instances/<id>/`，所以形状必须像「一层目录名」。
 * 口径与 settings 模块的 checkInstanceId 一致（字母数字、中文、空格与 . _ + -），
 * 但不 import 它——那会把 packs 与 settings 耦死；这里只需要「能不能拼路径」这一个判断。
 */
export function checkInstanceId(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) return '实例 id 不能为空。';
  if (id.length > 64) return `实例 id 过长（${String(id.length)} 个字符，上限 64）。`;
  if (id === '.' || id === '..') return `实例 id 不能是「${id}」。`;
  if (id.includes('\u0000')) return '实例 id 里不能有空字节。';
  if (/[/\\:]/.test(id)) return `实例 id 里不能出现路径分隔符或盘符：「${id}」。`;
  if (!/^[A-Za-z0-9._+\-\u4e00-\u9fa5 ]+$/.test(id)) {
    return `实例 id 只能包含字母、数字、中文、空格与 . _ + -：「${id}」。`;
  }
  return null;
}

/** 存档名校验：同实例 id 口径（它是 saves/ 下的一层目录名） */
export function checkSaveName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return '存档名不能为空。';
  if (name.length > 128) return `存档名过长（${String(name.length)} 个字符，上限 128）。`;
  if (name === '.' || name === '..' || /^\.+$/.test(name)) return `存档名不能是「${name}」。`;
  if (name.includes('\u0000')) return '存档名里不能有空字节。';
  if (/[/\\:]/.test(name)) return `存档名里不能出现路径分隔符或盘符：「${name}」。`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0001-\u001f\u007f]/.test(name)) return '存档名里不能有控制字符。';
  if (/[. ]$/.test(name)) return '存档名不能以点或空格结尾。';
  return null;
}

/**
 * 把「用户可能给的一串名字」收拾成能当文件名的样子。
 *
 * 只用在上传 / URL 安装时没人给文件名的情况下：
 *   1. 去掉 URL 的 query/fragment，取最后一段
 *   2. 解码 %XX
 *   3. 把非法字符换成 `_`
 *   4. 保证 `.zip` 结尾
 *   5. 再校验一遍（此时应当必然通过；不通过就回落到 fallback）
 */
export function sanitizeFilename(raw: string, fallback = 'pack.zip'): string {
  let text = String(raw ?? '');
  const cut = text.search(/[?#]/);
  if (cut >= 0) text = text.slice(0, cut);
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (slash >= 0) text = text.slice(slash + 1);
  try {
    text = decodeURIComponent(text);
  } catch {
    /* 解码失败就按原样用 */
  }
  text = text.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '_').trim();
  text = text.replace(/^\.+/, '');
  text = text.replace(/[. ]+$/, '');
  if (text.length === 0) text = fallback;
  if (!text.toLowerCase().endsWith(PACK_EXTENSION)) text += PACK_EXTENSION;
  if (text.length > MAX_FILENAME_LENGTH) {
    const head = text.slice(0, MAX_FILENAME_LENGTH - PACK_EXTENSION.length);
    text = `${head}${PACK_EXTENSION}`;
  }
  return checkFilename(text) === null ? text : fallback;
}

/**
 * 禁用态的文件名 ↔ 原文件名。
 *
 * 真实文件名本身是 `xxx.zip.disabled` 的罕见情况会发生「双 .disabled」，
 * 这在 Minecraft 那边同样算禁用（它只认 .zip 结尾），所以无歧义。
 */
export function enabledNameOf(filename: string): string {
  return filename.toLowerCase().endsWith(DISABLED_SUFFIX)
    ? filename.slice(0, -DISABLED_SUFFIX.length)
    : filename;
}

/** 磁盘上的实际文件名 */
export function diskNameOf(filename: string, enabled: boolean): string {
  return enabled ? enabledNameOf(filename) : `${enabledNameOf(filename)}${DISABLED_SUFFIX}`;
}

/** 只保留纯 zip 的包扩展名（Minecraft 不认 .jar 资源包……其实认，但那是模组形状，不在这里管） */
export function hasZipExtension(filename: string): boolean {
  return filename.toLowerCase().endsWith(PACK_EXTENSION);
}
