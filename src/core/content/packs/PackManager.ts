/**
 * PackManager —— 资源包 / 数据包 / 光影包的本地安装、启用、删除。
 *
 * 目录规则（本项目最容易搞错的地方，写死在这里，别的地方不许各拼一份）：
 *   resourcepack → <instanceDir>/resourcepacks/
 *   datapack     → <instanceDir>/saves/<saveName>/datapacks/   （传了 saveName）
 *                → <instanceDir>/datapacks/                    （没传，1.20+ 全局）
 *   shader       → <instanceDir>/shaderpacks/
 *   <instanceDir> = <dataRoot>/instances/<instanceId>/
 *
 * 三条设计原则：
 *   1. **原子落地**：先写 `<name>.part`，校验通过再 rename。中途失败不会留下半截 zip
 *      被 Minecraft 当成坏包（那会让游戏直接崩在资源加载阶段）。
 *   2. **文件名即安全边界**：所有进入路径的文件名都先过 `checkFilename`，
 *      再对最终路径做一次「必须在目标目录内」的复核。
 *   3. **列表永不失败**：单个包损坏 / mcmeta 坏掉，只让那一条缺元数据，不能让整个列表 500。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { resolveDataRoot } from '../../launch/data-root.js';

import { detectShader, readPackMeta, tryOpenZip } from './mcmeta.js';
import { listSaves, saveExists } from './saves.js';
import {
  DISABLED_SUFFIX,
  MAX_PACK_BYTES,
  PACK_EXTENSION,
  PACK_KIND_LABEL,
  PackValidationError,
  checkFilename,
  checkInstanceId,
  checkSaveName,
  diskNameOf,
  enabledNameOf,
  isPackKind,
  sanitizeFilename,
  type InstalledPack,
  type PackInstallTask,
  type PackKind,
  type SaveSummary,
} from './types.js';

// ───────────────────────────── 依赖形状（便于注入测试替身） ─────────────────────────────

/** 只声明用到的那一个方法 —— 真实的 `Downloader` 天然满足它 */
export interface PackDownloaderLike {
  downloadAll(
    tasks: { url: string; dest: string; sha1?: string; size?: number }[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<{ ok: boolean; skipped: number; downloaded: number; failed: unknown[] }>;
}

export interface PackManagerOptions {
  /** 数据根；不传则走 download 模块的 getDataRoot（取不到时按目录规则兜底） */
  dataRoot?: string;
  /** 注入下载器（测试用）。不传时 installFromUrl 懒加载真实的 Downloader */
  downloader?: PackDownloaderLike;
}

/** 进度回调 */
export type PackProgress = (p: { done: number; total: number }) => void;

/** 上传落地结果 */
export interface PackUploadResult {
  filename: string;
  path: string;
  size: number;
  /** 落盘后的元数据（与列表项同形，但不需要再扫一遍目录） */
  pack: InstalledPack;
}

/** 安装/导入的公共选项 */
export interface PackInstallOptions {
  /** 数据包的目标存档；不传 = 全局 datapacks/ */
  saveName?: string;
  onProgress?: PackProgress;
  /** 同名文件已存在时覆盖（默认 true，与「导入」的心智一致） */
  overwrite?: boolean;
}

// ───────────────────────────── 常量 ─────────────────────────────

/** 临时文件后缀：与 download 模块的 `.part` 同约定，别的地方看到它就知道是未完成的 */
const PART_SUFFIX = '.part';

/** 单次上传的内存上限（与 MAX_PACK_BYTES 同值；服务层另有自己的请求体上限） */
export const MAX_UPLOAD_BYTES = MAX_PACK_BYTES;

/** 视为「包文件」的后缀（列表里只列这些，避免把 desktops.ini 之类当包） */
const PACK_FILE_PATTERN = /\.zip(\.disabled)?$/i;

/** 目录名（相对 instanceDir） */
const DIR_BY_KIND: Record<PackKind, string> = {
  resourcepack: 'resourcepacks',
  datapack: 'datapacks',
  shader: 'shaderpacks',
};

// ───────────────────────────── 主类 ─────────────────────────────

export class PackManager {
  private readonly root: string;
  private downloaderRef: PackDownloaderLike | undefined;

  constructor(opts: PackManagerOptions = {}) {
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
    if (problem !== null) throw new PackValidationError('instanceId', problem);
    return path.join(this.root, 'instances', instanceId);
  }

  /**
   * 某类内容的安装目录。
   *
   * `saveName` 只对 datapack 有意义：资源包/光影包传了也忽略
   * （宁可忽略也不报错 —— 前端切换存档时会把 saveName 一并带上，拒绝会让交互很别扭）。
   */
  targetDir(instanceId: string, kind: PackKind, saveName?: string): string {
    if (!isPackKind(kind)) {
      throw new PackValidationError('kind', `未知的内容类型「${String(kind)}」，只支持 resourcepack / datapack / shader。`);
    }
    const base = this.instanceDir(instanceId);
    const dir = DIR_BY_KIND[kind];
    if (kind === 'datapack' && typeof saveName === 'string' && saveName.trim().length > 0) {
      const problem = checkSaveName(saveName);
      if (problem !== null) throw new PackValidationError('saveName', problem);
      return path.join(base, 'saves', saveName, dir);
    }
    return path.join(base, dir);
  }

  // ───────────────────────── 列表 ─────────────────────────

  /**
   * 列出已安装的包。
   *
   * 目录不存在 → 空数组（新实例的正常状态）。
   * 单个包读元数据失败 → 仍然列出，只是缺 packFormat/description 并带 mcmetaError。
   */
  async list(instanceId: string, kind: PackKind, saveName?: string): Promise<InstalledPack[]> {
    const dir = this.targetDir(instanceId, kind, saveName);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);

    const out: InstalledPack[] = [];
    for (const entry of entries) {
      if (!PACK_FILE_PATTERN.test(entry.name)) continue;

      const filename = enabledNameOf(entry.name);
      const filePath = path.join(dir, entry.name);

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue; // 列目录与 stat 之间被删掉了
      }
      // 目录名叫 xxx.zip 的怪东西不算包；符号链接指向外部一律不认
      if (!stat.isFile() || entry.isSymbolicLink()) continue;

      out.push(await this.describe(filePath, entry.name, kind, stat));
    }

    out.sort((a, b) => a.filename.localeCompare(b.filename, 'zh'));
    return out;
  }

  /** 列出存档（数据包目标选择器用） */
  async listSaves(instanceId: string): Promise<SaveSummary[]> {
    return listSaves(this.instanceDir(instanceId));
  }

  /** 单个包：读 zip 中央目录提取元数据 */
  private async describe(filePath: string, diskName: string, kind: PackKind, stat: fs.Stats): Promise<InstalledPack> {
    const pack: InstalledPack = {
      filename: enabledNameOf(diskName),
      kind,
      size: stat.size,
      enabled: !diskName.toLowerCase().endsWith(DISABLED_SUFFIX),
      path: filePath,
      modifiedAt: stat.mtimeMs,
    };

    // 超过 512 MB 的 zip 不解析：读进内存解析元数据不值当，而且它也不会是正常包
    if (stat.size > MAX_PACK_BYTES) {
      pack.mcmetaError = `文件过大（${String(stat.size)} 字节），未解析元数据`;
      return pack;
    }

    let buf: Buffer;
    try {
      buf = await fsp.readFile(filePath);
    } catch (error) {
      pack.mcmetaError = `读取失败：${messageOf(error)}`;
      return pack;
    }

    const opened = tryOpenZip(buf);
    if ('error' in opened) {
      pack.mcmetaError = `不是合法的 zip：${opened.error}`;
      return pack;
    }

    if (kind === 'shader') {
      // 光影包没有 mcmeta，只认 shaders/ 结构
      pack.hasShaders = detectShader(opened.archive);
      if (!pack.hasShaders) pack.mcmetaError = 'zip 内没有 shaders/ 目录，可能不是光影包';
      return pack;
    }

    const meta = readPackMeta(opened.archive);
    if (meta.packFormat !== undefined) pack.packFormat = meta.packFormat;
    if (meta.description !== undefined) pack.description = meta.description;
    if (meta.packFormatRange !== undefined) pack.packFormatRange = meta.packFormatRange;
    if (meta.error !== undefined) pack.mcmetaError = meta.error;
    return pack;
  }

  // ───────────────────────── 从 URL 安装 ─────────────────────────

  /**
   * 从 URL 下载安装，返回最终落盘路径。
   *
   * 走 download 模块的 `Downloader`（并发/重试/镜像/断点续传/SHA1 校验都在那边），
   * 这里只负责：校验文件名 → 确保目录 → 下到 `.part` → rename 到正式名。
   *
   * 为什么下到 `.part` 再改名：Downloader 自己也会写 `<dest>.part` 再原子改名，
   * 但它的 dest 是最终名；如果我们直接把 dest 设为正式名，Minecraft 可能在下到一半时
   * 读到半个 zip。所以这一层先让它下到 `<name>.part`（下载器内部再套一层 `.part.part`），
   * 全部校验通过后由我们做最后一次 rename —— 最终名要么不存在，要么是完整文件。
   */
  async installFromUrl(
    instanceId: string,
    kind: PackKind,
    task: PackInstallTask,
    opts: PackInstallOptions = {},
  ): Promise<string> {
    const dir = this.targetDir(instanceId, kind, opts.saveName);
    const filename = this.requireFilename(task.filename);
    const url = this.requireUrl(task.url);

    if (!filename.toLowerCase().endsWith(PACK_EXTENSION)) {
      throw new PackValidationError('filename', `只接受 .zip 文件，收到「${filename}」。`);
    }

    await fsp.mkdir(dir, { recursive: true });
    const finalPath = this.resolveInside(dir, diskNameOf(filename, true));

    // 覆盖语义：新旧同名都不允许同时存在（否则启用状态会串）
    await this.removeSiblings(dir, filename);

    const partPath = `${finalPath}${PART_SUFFIX}`;
    const downloader = await this.downloader();

    const result = await downloader.downloadAll(
      [
        {
          url,
          dest: partPath,
          ...(typeof task.sha1 === 'string' && task.sha1.length > 0 ? { sha1: normalizeSha1(task.sha1) } : {}),
        },
      ],
      opts.onProgress === undefined
        ? undefined
        : (p) => {
            // 单任务下载：done/total 是任务计数（0/1 → 1/1），字节数在 bytesDone/bytesTotal
            const progress = p as { done: number; total: number; bytesDone?: number; bytesTotal?: number };
            opts.onProgress?.({
              done: typeof progress.bytesDone === 'number' ? progress.bytesDone : progress.done,
              total: typeof progress.bytesTotal === 'number' ? progress.bytesTotal : progress.total,
            });
          },
    );

    if (!result.ok) {
      await fsp.rm(partPath, { force: true }).catch(() => undefined);
      throw new Error(`下载失败：${describeFailure(result.failed)}`);
    }

    const stat = await fsp.stat(partPath).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) {
      throw new Error('下载器报告成功，但磁盘上没有这个文件（下载链路异常）。');
    }
    if (stat.size > MAX_PACK_BYTES) {
      await fsp.rm(partPath, { force: true }).catch(() => undefined);
      throw new PackValidationError('size', `文件过大（${String(stat.size)} 字节，上限 ${String(MAX_PACK_BYTES)}）。`);
    }

    await fsp.rename(partPath, finalPath);
    return finalPath;
  }

  // ───────────────────────── 从本地文件导入 ─────────────────────────

  /**
   * 从本地文件导入（用户在文件选择器里选的路径）。
   *
   * 先复制到临时文件再改名，原因同 URL 安装：
   * 用户可能选的就是自己正在解压的包，直接 rename 会让源文件消失（跨盘 rename 还会失败）。
   */
  async installFromFile(
    instanceId: string,
    kind: PackKind,
    sourcePath: string,
    opts: PackInstallOptions & { filename?: string } = {},
  ): Promise<string> {
    const dir = this.targetDir(instanceId, kind, opts.saveName);
    const rawSource = typeof sourcePath === 'string' ? sourcePath.trim() : '';
    if (rawSource.length === 0) throw new PackValidationError('sourcePath', '缺少源文件路径。');
    const source = path.resolve(rawSource);

    const stat = await fsp.stat(source).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) {
      throw new PackValidationError('sourcePath', `源文件不存在或不是普通文件：${source}`);
    }
    if (stat.size > MAX_PACK_BYTES) {
      throw new PackValidationError('size', `文件过大（${String(stat.size)} 字节，上限 ${String(MAX_PACK_BYTES)}）。`);
    }

    const filename = this.requireFilename(opts.filename ?? path.basename(source));
    if (!filename.toLowerCase().endsWith(PACK_EXTENSION)) {
      throw new PackValidationError('filename', `只接受 .zip 文件，收到「${filename}」。`);
    }

    await fsp.mkdir(dir, { recursive: true });
    const finalPath = this.resolveInside(dir, diskNameOf(filename, true));
    await this.removeSiblings(dir, filename);

    const partPath = `${finalPath}${PART_SUFFIX}`;
    try {
      await fsp.copyFile(source, partPath);
      await fsp.rename(partPath, finalPath);
    } catch (error) {
      await fsp.rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return finalPath;
  }

  /**
   * 接收上传的字节（Web 层的 `POST .../packs/upload` 用它）。
   *
   * `filename` 会被清洗：用户浏览器给的名字可能带路径、控制字符、或者干脆是空的
   * （某类客户端只发 `blob`）。
   */
  async installFromBuffer(
    instanceId: string,
    kind: PackKind,
    data: Buffer,
    opts: PackInstallOptions & { filename?: string } = {},
  ): Promise<string> {
    const dir = this.targetDir(instanceId, kind, opts.saveName);
    if (data.byteLength === 0) throw new PackValidationError('body', '上传内容为空。');
    if (data.byteLength > MAX_PACK_BYTES) {
      throw new PackValidationError('size', `文件过大（${String(data.byteLength)} 字节，上限 ${String(MAX_PACK_BYTES)}）。`);
    }

    const requested = typeof opts.filename === 'string' && opts.filename.trim().length > 0 ? opts.filename.trim() : '';
    const filename = requested.length === 0
      ? sanitizeFilename('pack.zip')
      : this.requireFilename(requested);
    if (!filename.toLowerCase().endsWith(PACK_EXTENSION)) {
      throw new PackValidationError('filename', `只接受 .zip 文件，收到「${filename}」。`);
    }

    await fsp.mkdir(dir, { recursive: true });
    const finalPath = this.resolveInside(dir, diskNameOf(filename, true));
    await this.removeSiblings(dir, filename);

    const partPath = `${finalPath}${PART_SUFFIX}`;
    try {
      await fsp.writeFile(partPath, data);
      await fsp.rename(partPath, finalPath);
    } catch (error) {
      await fsp.rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return finalPath;
  }

  /** 上传 + 立刻返回元数据（Web 层直接用，省一次全目录扫描） */
  async uploadAndDescribe(
    instanceId: string,
    kind: PackKind,
    data: Buffer,
    opts: PackInstallOptions & { filename?: string } = {},
  ): Promise<PackUploadResult> {
    const filePath = await this.installFromBuffer(instanceId, kind, data, opts);
    const stat = await fsp.stat(filePath);
    const pack = await this.describe(filePath, path.basename(filePath), kind, stat);
    return { filename: pack.filename, path: filePath, size: stat.size, pack };
  }

  // ───────────────────────── 启用 / 禁用 ─────────────────────────

  /**
   * 启用/禁用：改扩展名（加/去 `.disabled`）。
   *
   * Minecraft 只加载 `.zip` 结尾的文件，所以这是官方支持、且最不侵入的做法
   * （另一种做法是改 packs.json / options.txt，那会把用户手改的列表覆盖掉）。
   */
  async setEnabled(
    instanceId: string,
    kind: PackKind,
    filename: string,
    enabled: boolean,
    saveName?: string,
  ): Promise<void> {
    const dir = this.targetDir(instanceId, kind, saveName);
    const name = this.requireFilename(filename);
    const current = await this.locate(dir, name);
    if (current === undefined) {
      throw new PackValidationError('filename', `${PACK_KIND_LABEL[kind]}「${name}」不在 ${dir} 里，无法切换状态。`);
    }
    if (current.enabled === enabled) return; // 已经是目标状态：幂等

    const from = this.resolveInside(dir, diskNameOf(name, current.enabled));
    const to = this.resolveInside(dir, diskNameOf(name, enabled));

    // 目标名已被占用（例如用户手动放了一个同名的）：先把它清掉，避免 rename 失败
    const occupied = await fsp.stat(to).catch(() => undefined);
    if (occupied !== undefined) {
      if (diskNameOf(name, enabled) !== diskNameOf(name, current.enabled)) {
        throw new PackValidationError(
          'filename',
          `无法切换：目标文件名「${path.basename(to)}」已存在，请先删掉其中一个。`,
        );
      }
    }

    await fsp.rename(from, to);
  }

  // ───────────────────────── 删除 ─────────────────────────

  /** 删除（启用态与禁用态都删，连带可能残留的 `.part`） */
  async remove(instanceId: string, kind: PackKind, filename: string, saveName?: string): Promise<void> {
    const dir = this.targetDir(instanceId, kind, saveName);
    const name = this.requireFilename(filename);
    const located = await this.locate(dir, name);
    if (located === undefined) {
      // 删一个本来就不在的东西按幂等处理，但要让调用方知道「确实没这个东西」
      throw new PackValidationError('filename', `${PACK_KIND_LABEL[kind]}「${name}」不存在，可能已经被删掉了。`);
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
  private async downloader(): Promise<PackDownloaderLike> {
    if (this.downloaderRef !== undefined) return this.downloaderRef;
    const mod = await import('../../download/index.js');
    this.downloaderRef = new mod.Downloader({ concurrency: 4, retries: 3 });
    return this.downloaderRef;
  }

  /** 文件名必需且合法 */
  private requireFilename(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new PackValidationError('filename', '缺少文件名（filename）。');
    }
    const name = raw.trim();
    const problem = checkFilename(name);
    if (problem !== null) throw new PackValidationError('filename', problem);
    return name;
  }

  /** URL 只接受 http(s)，并且不允许带用户名密码（那是钓鱼/凭据泄露的常见形状） */
  private requireUrl(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new PackValidationError('url', '缺少下载地址（url）。');
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new PackValidationError('url', `下载地址不是合法 URL：${raw}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new PackValidationError('url', `只支持 http/https 下载地址，收到 ${parsed.protocol}`);
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new PackValidationError('url', '下载地址里不允许带用户名/密码。');
    }
    return parsed.toString();
  }

  /**
   * 拼路径 + 复核：结果必须就在 `dir` 里。
   * 文件名已经过一次校验，这里是第二道锁（防 `path.join` 的行为差异 / Windows 短名怪癖）。
   */
  private resolveInside(dir: string, name: string): string {
    const resolved = path.resolve(dir, name);
    const rel = path.relative(path.resolve(dir), resolved);
    if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      throw new PackValidationError('filename', `文件名「${name}」会写到目标目录之外，已拒绝。`);
    }
    return resolved;
  }

  /** 在目录里找到这个包的当前形态（启用 / 禁用 / 都没有） */
  private async locate(dir: string, filename: string): Promise<{ enabled: boolean } | undefined> {
    const enabledStat = await fsp.stat(path.join(dir, diskNameOf(filename, true))).catch(() => undefined);
    if (enabledStat?.isFile() === true) return { enabled: true };
    const disabledStat = await fsp.stat(path.join(dir, diskNameOf(filename, false))).catch(() => undefined);
    if (disabledStat?.isFile() === true) return { enabled: false };
    return undefined;
  }

  /**
   * 同名覆盖：把「同名但状态不同」的旧文件清掉。
   * 例如用户先装 `a.zip.disabled`，再装 `a.zip` —— 两个都留着会让列表出现两条同名项。
   */
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

function normalizeSha1(raw: string): string {
  return raw.trim().toLowerCase();
}

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 计算 Buffer 的 SHA1（Web 层校验上传可选） */
export function sha1OfBuffer(data: Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

/** 给 Web 层：判断一个目录名像不像包（列表接口的过滤规则） */
export function looksLikePackFile(name: string): boolean {
  return PACK_FILE_PATTERN.test(name);
}
