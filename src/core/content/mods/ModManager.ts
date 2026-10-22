/**
 * 模组文件的本地管理：列出 / 安装 / 启用禁用 / 删除。
 *
 * 目录规则（全项目唯一真源，别的地方不许各拼一份）：
 *   <instanceDir>/mods/
 *   <instanceDir> = <dataRoot>/instances/<instanceId>/
 *
 * 四条硬规则：
 *   1. **文件名即安全边界**：所有文件名先过 `checkModFilename`，再对最终路径做
 *      「必须落在 mods/ 里」的复核。`..` / 分隔符 / 盘符一个都不放。
 *   2. **去重键只能是文件名**：不用 sha1、不用 mod id。
 *      同一个 mod 的不同构建常常同名不同内容，用哈希去重会让用户想换版本时换不了；
 *      而 mod id 在 jar 里可能重复（一个 jar 带多个 modId），两者都不是唯一身份。
 *   3. **原子落地**：下载到 `<name>.part` 再 rename。Minecraft 不会在游戏加载时
 *      读到半个 jar（那会让整个实例崩在启动阶段）。
 *   4. **列表永不失败**：单个 jar 元数据坏了只影响那一条，不让整个列表 500。
 *
 * 禁用规则：`foo.jar` → `foo.jar.disabled`。Minecraft 只加载 `.jar` 结尾的文件，
 * 改名是官方支持、且最不侵入的做法（改 options.txt 会把用户手改的列表覆盖掉）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { resolveDataRoot } from '../../launch/data-root.js';

import { nameFromFilename, readModJarMeta, type ModJarMeta } from './jar-meta.js';

// ───────────────────────────── 类型 ─────────────────────────────

/** 已安装的模组 */
export interface InstalledMod {
  filename: string;
  /** 从 jar 的 fabric.mod.json / mods.toml 读出来的元数据 */
  id?: string;
  name?: string;
  version?: string;
  /** 文件大小 */
  size: number;
  enabled: boolean;
  /** 元数据来源与问题说明（扩展字段，UI 可用来标注「元数据读不到」） */
  metaSource?: ModJarMeta['source'];
  metaError?: string;
  /** 最后修改时间（毫秒） */
  modifiedAt?: number;
}

/** 安装任务（来自 Modrinth 的 version.files 一项） */
export interface ModInstallTask {
  url: string;
  filename: string;
  sha1?: string;
}

/** 安装进度回调：done/total 是字节数（单文件下载，字节比「1/1」有用得多） */
export type ModInstallProgress = (p: { done: number; total: number; filename: string }) => void;

/** 下载器的最小结构约束（真实的 `Downloader` 天然满足它） */
export interface ModDownloaderLike {
  downloadAll(
    tasks: { url: string; dest: string; sha1?: string; size?: number }[],
    onProgress?: (p: { done: number; total: number; current: string; bytesDone?: number; bytesTotal?: number }) => void,
  ): Promise<{ ok: boolean; skipped: number; downloaded: number; failed: unknown[] }>;
}

export interface ModManagerOptions {
  /** 数据根；不传则走 download 模块的 getDataRoot（取不到按目录规则兜底） */
  dataRoot?: string;
  /** 注入下载器（测试用）。不传时懒加载真实的 Downloader */
  downloader?: ModDownloaderLike;
}

// ───────────────────────────── 常量 ─────────────────────────────

/** 禁用态后缀（与 content/packs 保持同一约定） */
export const DISABLED_SUFFIX = '.disabled';

/** mod 文件扩展名 */
export const MOD_EXTENSION = '.jar';

/** 文件名长度上限（Windows 单段 255，留出 .disabled 的余量） */
export const MAX_FILENAME_LENGTH = 200;

/** 实例 id 上限（与 settings / packs 同口径） */
const MAX_INSTANCE_ID_LENGTH = 64;

/** 视为「模组文件」的名字（列表只列这些） */
const MOD_FILE_PATTERN = /\.jar(\.disabled)?$/i;

/** 未完成的下载后缀（与 download 模块的约定一致） */
const PART_SUFFIX = '.part';

/** Windows 保留设备名 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// ───────────────────────────── 错误 ─────────────────────────────

/** 模组相关错误（message 已经是人话；field 供 HTTP 层标出是哪个参数的问题） */
export class ModValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ModValidationError';
    this.field = field;
  }
}

// ───────────────────────────── 文件名 / 实例 id ─────────────────────────────

/**
 * 模组文件名校验 —— 模块的安全底线。
 *
 * 拒绝：空 / 超长 / 路径分隔符 / `.` `..` / 盘符 / UNC / 控制字符与空字节 /
 * 以点或空格结尾（Windows 会静默去掉，导致读写不一致）/ 保留设备名。
 * 允许 Unicode：中文模组文件名是常态。
 */
export function checkModFilename(raw: unknown): string | null {
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
  if (raw === '.' || raw === '..' || /^\.+$/.test(raw)) return `文件名不能是「${raw}」。`;
  if (/^[a-zA-Z]:/.test(raw)) return '文件名里不能出现盘符。';
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return '不接受 UNC 路径。';
  if (/[. ]$/.test(raw) && !raw.toLowerCase().endsWith(DISABLED_SUFFIX)) {
    return '文件名不能以点或空格结尾（Windows 会静默去掉，导致读写不一致）。';
  }
  // 保留设备名：`con.jar` 与 `con` 一样会被 Windows 拒绝写入
  const enabled = enabledNameOf(raw).toLowerCase();
  const base = enabled.replace(/\.[^.]*$/, '');
  if (RESERVED_NAMES.has(base) || RESERVED_NAMES.has(enabled) || RESERVED_NAMES.has(raw.toLowerCase())) {
    return `「${raw}」是 Windows 保留设备名，换一个文件名。`;
  }
  return null;
}

/** 实例 id 校验：它会被拼进 `<dataRoot>/instances/<id>/` */
export function checkInstanceId(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) return '实例 id 不能为空。';
  if (id.length > MAX_INSTANCE_ID_LENGTH) {
    return `实例 id 过长（${String(id.length)} 个字符，上限 ${String(MAX_INSTANCE_ID_LENGTH)}）。`;
  }
  if (id === '.' || id === '..') return `实例 id 不能是「${id}」。`;
  if (id.includes('\u0000')) return '实例 id 里不能有空字节。';
  if (/[/\\:]/.test(id)) return `实例 id 里不能出现路径分隔符或盘符：「${id}」。`;
  if (!/^[A-Za-z0-9._+\-\u4e00-\u9fa5 ]+$/.test(id)) {
    return `实例 id 只能包含字母、数字、中文、空格与 . _ + -：「${id}」。`;
  }
  return null;
}

/** 文件名（含 .disabled 状态）→ 启用态文件名 */
export function enabledNameOf(filename: string): string {
  return filename.toLowerCase().endsWith(DISABLED_SUFFIX)
    ? filename.slice(0, -DISABLED_SUFFIX.length)
    : filename;
}

/** 启用态文件名 + 期望状态 → 磁盘上的实际文件名 */
export function diskNameOf(filename: string, enabled: boolean): string {
  return enabled ? enabledNameOf(filename) : `${enabledNameOf(filename)}${DISABLED_SUFFIX}`;
}

/**
 * 从 URL / 任意串里收拾出一个合法的 jar 文件名。
 * 只在 Modrinth 没给 filename 时兜底用（正常路径一律用 Modrinth 给的名字）。
 */
export function sanitizeJarFilename(raw: string, fallback = 'mod.jar'): string {
  let text = String(raw ?? '');
  const cut = text.search(/[?#]/);
  if (cut >= 0) text = text.slice(0, cut);
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (slash >= 0) text = text.slice(slash + 1);
  try {
    text = decodeURIComponent(text);
  } catch {
    /* 解码失败按原样用 */
  }
  text = text.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '_').trim();
  text = text.replace(/^\.+/, '');
  if (!text.toLowerCase().endsWith(MOD_EXTENSION)) {
    text = text.replace(/[. ]+$/, '');
    text = `${text}${MOD_EXTENSION}`;
  }
  // 剥离之后可能只剩一个 ".jar"（原名字是 `..` / `---` 这类垃圾），那不是文件名
  if (text.length === 0 || text.toLowerCase() === MOD_EXTENSION) text = fallback;
  if (text.length > MAX_FILENAME_LENGTH) {
    const head = text.slice(0, MAX_FILENAME_LENGTH - MOD_EXTENSION.length);
    text = `${head}${MOD_EXTENSION}`;
  }
  return checkModFilename(text) === null ? text : fallback;
}

// ───────────────────────────── 主类 ─────────────────────────────

export class ModManager {
  private readonly root: string;
  private downloaderRef: ModDownloaderLike | undefined;

  constructor(opts: ModManagerOptions = {}) {
    this.root = path.resolve(opts.dataRoot ?? resolveDataRoot());
    this.downloaderRef = opts.downloader;
  }

  /** 数据根（排障用，不属于契约面） */
  get dataRoot(): string {
    return this.root;
  }

  /** 实例目录 `<dataRoot>/instances/<id>` */
  instanceDir(instanceId: string): string {
    const problem = checkInstanceId(instanceId);
    if (problem !== null) throw new ModValidationError('instanceId', problem);
    return path.join(this.root, 'instances', instanceId);
  }

  /** mods 目录 `<instanceDir>/mods`（不自动创建） */
  modsDir(instanceId: string): string {
    return path.join(this.instanceDir(instanceId), 'mods');
  }

  // ───────────────────────── 列表 ─────────────────────────

  /**
   * 列出实例的 mods 目录内容。
   *
   * 目录不存在 → 空数组（新实例的正常状态）。
   * 单个 jar 读不到元数据 → 仍然列出，只是缺 id/name/version 并带 metaError。
   * 文件名以 `.part` 结尾的（下载中）不列出，避免用户看到半截文件。
   */
  async list(instanceId: string): Promise<InstalledMod[]> {
    const dir = this.modsDir(instanceId);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);

    const out: InstalledMod[] = [];
    for (const entry of entries) {
      if (!MOD_FILE_PATTERN.test(entry.name)) continue;
      // 符号链接一律不认：文件可能指向数据目录之外的任意位置
      if (entry.isSymbolicLink()) continue;

      const filePath = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue; // 列目录与 stat 之间被删掉了
      }
      if (!stat.isFile()) continue;

      out.push(await this.describe(filePath, entry.name, stat));
    }

    out.sort((a, b) => a.filename.localeCompare(b.filename, 'zh'));
    return out;
  }

  /** 单个 jar → InstalledMod（元数据读不到不抛错） */
  private async describe(filePath: string, diskName: string, stat: fs.Stats): Promise<InstalledMod> {
    const filename = enabledNameOf(diskName);
    const enabled = !diskName.toLowerCase().endsWith(DISABLED_SUFFIX);

    const mod: InstalledMod = {
      filename,
      size: stat.size,
      enabled,
      modifiedAt: stat.mtimeMs,
    };

    const meta = await readModJarMeta(filePath);
    if (meta.id !== undefined) mod.id = meta.id;
    if (meta.name !== undefined) mod.name = meta.name;
    if (meta.version !== undefined) mod.version = meta.version;
    mod.metaSource = meta.source;
    if (meta.error !== undefined) mod.metaError = meta.error;

    // 三个字段全空（元数据读不到）时，至少给一个像样的展示名，UI 不至于显示空白
    if (mod.name === undefined) mod.name = nameFromFilename(filename);

    return mod;
  }

  // ───────────────────────── 安装 ─────────────────────────

  /**
   * 下载并安装一个模组文件到 `<dataRoot>/instances/<instanceId>/mods/`。
   *
   * 返回最终落盘路径。
   *
   * 为什么下到 `<name>.part` 再改名：`Downloader` 自己会写 `<dest>.part` 再原子改名，
   * 但如果 dest 直接用正式名，Minecraft 在下到一半时可能读到半个 jar。
   * 这一层先把 dest 设成 `<name>.jar.part`（下载器内部再套一层 `.part`），
   * 全部校验通过后由我们做最后一次 rename —— 正式名要么不存在，要么是完整文件。
   */
  async install(
    instanceId: string,
    task: ModInstallTask,
    onProgress?: ModInstallProgress,
  ): Promise<string> {
    const dir = this.modsDir(instanceId);
    const filename = this.requireJarFilename(task.filename);
    const url = this.requireUrl(task.url);

    await fsp.mkdir(dir, { recursive: true });
    const finalPath = this.resolveInside(dir, diskNameOf(filename, true));

    // 覆盖语义：启用态与禁用态的同名文件都要清掉，否则列表里会出现两条同名项
    await this.removeSiblings(dir, filename);

    const partPath = `${finalPath}${PART_SUFFIX}`;
    const downloader = await this.downloader();

    const result = await downloader.downloadAll([
      {
        url,
        dest: partPath,
        ...(typeof task.sha1 === 'string' && task.sha1.trim().length > 0 ? { sha1: task.sha1.trim().toLowerCase() } : {}),
      },
    ], onProgress === undefined
      ? undefined
      : (p) => {
          onProgress({
            done: typeof p.bytesDone === 'number' ? p.bytesDone : p.done,
            total: typeof p.bytesTotal === 'number' ? p.bytesTotal : p.total,
            filename,
          });
        });

    if (!result.ok) {
      await fsp.rm(partPath, { force: true }).catch(() => undefined);
      throw new Error(`下载 ${filename} 失败：${describeFailure(result.failed)}`);
    }

    const stat = await fsp.stat(partPath).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) {
      throw new Error(`下载器报告成功，但磁盘上没有 ${filename} 的临时文件（下载链路异常）。`);
    }
    if (stat.size === 0) {
      await fsp.rm(partPath, { force: true }).catch(() => undefined);
      throw new Error(`下载到的 ${filename} 是空文件，已丢弃。`);
    }

    await fsp.rename(partPath, finalPath);
    return finalPath;
  }

  // ───────────────────────── 启用 / 禁用 ─────────────────────────

  /**
   * 启用 / 禁用：`foo.jar` ↔ `foo.jar.disabled`。
   *
   * 幂等：已经是目标状态就直接返回，不报错。
   * 目标名被占用（用户手动放了一个同名的）→ 抛错而不是覆盖别人的文件。
   */
  async setEnabled(instanceId: string, filename: string, enabled: boolean): Promise<void> {
    const dir = this.modsDir(instanceId);
    const name = this.requireJarFilename(filename);
    const current = await this.locate(dir, name);
    if (current === undefined) {
      throw new ModValidationError('filename', `模组「${name}」不在 ${dir} 里，无法切换状态。`);
    }
    if (current === enabled) return;

    const from = this.resolveInside(dir, diskNameOf(name, current));
    const to = this.resolveInside(dir, diskNameOf(name, enabled));

    const occupied = await fsp.stat(to).catch(() => undefined);
    if (occupied !== undefined) {
      throw new ModValidationError(
        'filename',
        `无法切换：目标文件名「${path.basename(to)}」已存在，请先删掉其中一个。`,
      );
    }

    await fsp.rename(from, to);
  }

  // ───────────────────────── 删除 ─────────────────────────

  /**
   * 删除（启用态与禁用态都删，连带可能残留的 `.part`）。
   *
   * 不存在时抛错而不是静默成功：调用方（HTTP）需要如实告诉用户「确实没这个东西」，
   * 否则前端会把「删了个不存在的东西」显示成成功。
   */
  async remove(instanceId: string, filename: string): Promise<void> {
    const dir = this.modsDir(instanceId);
    const name = this.requireJarFilename(filename);
    const located = await this.locate(dir, name);
    if (located === undefined) {
      throw new ModValidationError('filename', `模组「${name}」不存在，可能已经被删掉了。`);
    }

    const enabledPath = this.resolveInside(dir, diskNameOf(name, true));
    const disabledPath = this.resolveInside(dir, diskNameOf(name, false));
    await fsp.rm(enabledPath, { force: true });
    await fsp.rm(disabledPath, { force: true });
    await fsp.rm(`${enabledPath}${PART_SUFFIX}`, { force: true }).catch(() => undefined);
    await fsp.rm(`${disabledPath}${PART_SUFFIX}`, { force: true }).catch(() => undefined);
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  /** 懒加载真实下载器（避免顶层 import 就把 download 模块拉起来） */
  private async downloader(): Promise<ModDownloaderLike> {
    if (this.downloaderRef !== undefined) return this.downloaderRef;
    const mod = await import('../../download/index.js');
    this.downloaderRef = new mod.Downloader({ concurrency: 4, retries: 3 });
    return this.downloaderRef;
  }

  /** 文件名必需且必须是 jar 形状 */
  private requireJarFilename(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new ModValidationError('filename', '缺少文件名（filename）。');
    }
    const name = raw.trim();
    const problem = checkModFilename(name);
    if (problem !== null) throw new ModValidationError('filename', problem);
    if (!enabledNameOf(name).toLowerCase().endsWith(MOD_EXTENSION)) {
      throw new ModValidationError('filename', `只接受 .jar 文件，收到「${name}」。`);
    }
    return name;
  }

  /** URL 只接受 http(s)，不接受带用户名密码的地址（那是凭据泄露的常见形状） */
  private requireUrl(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new ModValidationError('url', '缺少下载地址（url）。');
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new ModValidationError('url', `下载地址不是合法 URL：${raw}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ModValidationError('url', `只支持 http/https 下载地址，收到 ${parsed.protocol}`);
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new ModValidationError('url', '下载地址里不允许带用户名/密码。');
    }
    return parsed.toString();
  }

  /** 拼路径 + 复核：结果必须就在 `dir` 里 */
  private resolveInside(dir: string, name: string): string {
    const resolved = path.resolve(dir, name);
    const rel = path.relative(path.resolve(dir), resolved);
    if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      throw new ModValidationError('filename', `文件名「${name}」会写到目标目录之外，已拒绝。`);
    }
    return resolved;
  }

  /** 在目录里找到这个模组的当前状态（true=启用 / false=禁用 / undefined=都没有） */
  private async locate(dir: string, filename: string): Promise<boolean | undefined> {
    const enabledStat = await fsp.stat(path.join(dir, diskNameOf(filename, true))).catch(() => undefined);
    if (enabledStat?.isFile() === true) return true;
    const disabledStat = await fsp.stat(path.join(dir, diskNameOf(filename, false))).catch(() => undefined);
    if (disabledStat?.isFile() === true) return false;
    return undefined;
  }

  /** 同名覆盖：启用态 / 禁用态 / 残留的 .part 全部清掉 */
  private async removeSiblings(dir: string, filename: string): Promise<void> {
    for (const enabled of [true, false]) {
      const target = path.join(dir, diskNameOf(filename, enabled));
      const stat = await fsp.stat(target).catch(() => undefined);
      if (stat?.isFile() === true) await fsp.rm(target, { force: true }).catch(() => undefined);
      await fsp.rm(`${target}${PART_SUFFIX}`, { force: true }).catch(() => undefined);
    }
  }
}

// ───────────────────────────── 辅助 ─────────────────────────────

/** 下载失败清单 → 人话 */
function describeFailure(failed: unknown[]): string {
  const first = failed[0];
  if (first instanceof Error) return first.message;
  if (typeof first === 'object' && first !== null) {
    const rec = first as Record<string, unknown>;
    if (typeof rec['error'] === 'string') return rec['error'];
    if (rec['error'] instanceof Error) return rec['error'].message;
    if (typeof rec['url'] === 'string') return `无法下载 ${rec['url']}`;
  }
  return failed.length === 0 ? '未知原因' : String(first);
}
