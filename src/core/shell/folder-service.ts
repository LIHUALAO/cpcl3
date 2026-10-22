/**
 * FolderService —— 「打开文件夹」的全部逻辑。
 *
 * 为什么单独成模块（而不是塞进 web/api.ts）：
 *   1. CLI 也要用（`pcl3 open mods`），逻辑不该绑在 HTTP 上；
 *   2. 这里的每一条路径都要过安全校验，集中在一处才审得清、测得完；
 *   3. `spawn` 拉起系统文件管理器这件事在 Web 进程里最危险
 *      （一旦路径可控就等于「远程替你点开任意目录」），所以它必须挨着校验写。
 *
 * 安全模型（三层，缺一不可）：
 *   1. **instanceId 形状校验**：禁止 `/` `\` `..` 盘符 `:` 空字节 —— 它会被拼进路径，
 *      所以它必须长得就像「一层目录名」。
 *   2. **kind 白名单**：只接受枚举里的值，绝不把入参直接当子目录名用。
 *   3. **解析后的绝对路径必须仍在实例目录内**：`path.resolve` 之后再逐段比对，
 *      这一条是防路径穿越的最后一道闸 —— 前两层都过了也照样复核。
 *      另外再做一次 `realpath` 复核，防「实例目录里的符号链接指向外部」。
 */

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// ───────────────────────────── 类型 ─────────────────────────────

/**
 * 可打开的目录种类。
 *
 * 名字与 Minecraft 自己的目录名保持一致（mods / resourcepacks / shaderpacks …），
 * 这样用户在别处（Wiki、论坛）看到的叫法能直接对上。
 */
export type FolderKind =
  | 'instance' // 实例根目录（= 游戏目录，.minecraft 的等价物）
  | 'mods'
  | 'resourcepacks'
  | 'shaderpacks'
  | 'datapacks'
  | 'saves'
  | 'logs'
  | 'crash-reports'
  | 'screenshots'
  | 'config'
  | 'dataRoot'; // 数据根目录

/** 运行时也可用的白名单（`as const` 收窄，便于 `includes`） */
export const FOLDER_KINDS = [
  'instance',
  'mods',
  'resourcepacks',
  'shaderpacks',
  'datapacks',
  'saves',
  'logs',
  'crash-reports',
  'screenshots',
  'config',
  'dataRoot',
] as const satisfies readonly FolderKind[];

/** 目录名（相对实例目录）。instance / dataRoot 不在这里 —— 它们不是「实例下的子目录」。 */
const SUBDIR_BY_KIND: Readonly<Record<Exclude<FolderKind, 'instance' | 'dataRoot'>, string>> = Object.freeze({
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
  datapacks: 'datapacks',
  saves: 'saves',
  logs: 'logs',
  'crash-reports': 'crash-reports',
  screenshots: 'screenshots',
  config: 'config',
});

/** 中文展示名（CLI / API 文案共用，避免两处各写一份） */
export const FOLDER_LABEL_CN: Readonly<Record<FolderKind, string>> = Object.freeze({
  instance: '游戏目录',
  mods: 'mods（模组）',
  resourcepacks: '资源包',
  shaderpacks: '光影包',
  datapacks: '数据包',
  saves: '存档',
  logs: '日志',
  'crash-reports': '崩溃报告',
  screenshots: '截图',
  config: '配置',
  dataRoot: '数据目录',
});

/** 列表里的一项 */
export interface FolderEntry {
  name: string;
  /** 字节数；**目录给 0，不递归统计**（递归 stat 一个 5000 文件的 mods 会卡死 UI） */
  size: number;
  isDir: boolean;
  /** ISO 时间串；stat 失败留空串 */
  mtime: string;
}

/** 打开动作的平台差异 */
export type OpenPlatform = 'win32' | 'darwin' | 'linux';

/** 一次「打开」要执行的命令（拆出来是为了可测：不真弹窗也能断言参数） */
export interface OpenCommand {
  /** 可执行文件 */
  file: string;
  /** 参数数组（已含目标路径） */
  args: string[];
}

export interface FolderServiceOptions {
  /** 数据根；不传则走 download 模块的 getDataRoot() */
  dataRoot?: string;
  /**
   * 注入的「执行器」：默认用 `spawn` 拉起系统文件管理器。
   * 测试用它断言「到底有没有 spawn、参数对不对」，绝不真弹窗。
   */
  spawnImpl?: (cmd: OpenCommand) => void;
  /** 平台覆盖（测试用，默认取 process.platform） */
  platform?: NodeJS.Platform;
  /** 列表条目上限，默认 500（目录里塞两万个文件时不能把浏览器噎死） */
  listLimit?: number;
}

// ───────────────────────────── 错误 ─────────────────────────────

/** 参数 / 路径不合法（HTTP 层映射成 400，CLI 映射成退出码 2） */
export class FolderAccessError extends Error {
  readonly code: 'bad-instance' | 'bad-kind' | 'outside' | 'not-found';
  constructor(code: FolderAccessError['code'], message: string) {
    super(message);
    this.name = 'FolderAccessError';
    this.code = code;
  }
}

// ───────────────────────────── 校验 ─────────────────────────────

/**
 * 实例 id 形状校验 —— 与 settings / packs 模块同口径。
 *
 * 为什么不 import 它们的 `checkInstanceId`：那会把 shell 与 settings、packs 三模块耦死，
 * 而这里只需要「能不能当一层目录名」这一个判断。三处口径若不一致，测试会同时暴露。
 */
export function checkInstanceIdShape(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) return '实例 id 不能为空。';
  if (id.length > 64) return `实例 id 过长（${String(id.length)} 个字符，上限 64）。`;
  if (id === '.' || id === '..') return `实例 id 不能是「${id}」。`;
  if (id.includes('\u0000')) return '实例 id 里不能有空字节。';
  if (/[/\\:]/.test(id)) {
    return `实例 id 里不能出现路径分隔符或盘符：「${id}」。`;
  }
  // 反斜杠已被上面拦掉；这里再挡 UNC 前缀与「以点开头」的目录（. 与 .. 已单独处理）
  if (id.startsWith('\\\\') || id.startsWith('//')) return `不接受 UNC 路径：「${id}」。`;
  if (!/^[A-Za-z0-9._+\-\u4e00-\u9fa5 ]+$/.test(id)) {
    return `实例 id 只能包含字母、数字、中文、空格与 . _ + -：「${id}」。`;
  }
  return null;
}

/** kind 白名单校验：不认识的直接抛，绝不「猜你想开 mods」 */
export function parseFolderKind(raw: unknown): FolderKind {
  if (typeof raw !== 'string') {
    throw new FolderAccessError('bad-kind', '文件夹类型必须是字符串。');
  }
  const text = raw.trim();
  for (const kind of FOLDER_KINDS) {
    if (kind === text) return kind;
  }
  throw new FolderAccessError(
    'bad-kind',
    `不认识的文件夹类型「${text}」；可用：${FOLDER_KINDS.join(' / ')}。`,
  );
}

/** child 是否在 parent 里（含等于）。大小写：Windows 上 path.relative 已经按盘符大小写宽松处理 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel === '..') return false;
  if (rel.startsWith('..')) return false;
  return !path.isAbsolute(rel);
}

// ───────────────────────────── 实现 ─────────────────────────────

export class FolderService {
  private readonly root: string;
  private readonly spawnImpl: ((cmd: OpenCommand) => void) | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly listLimit: number;

  constructor(opts: FolderServiceOptions = {}) {
    // 不直接 import getDataRoot：那会拉进 download 模块并做一次 mkdir。
    // 由调用方（Web / CLI）传进来，测试也就不必碰真数据目录。
    this.root = path.resolve(opts.dataRoot ?? process.cwd());
    this.spawnImpl = opts.spawnImpl;
    this.platform = opts.platform ?? process.platform;
    this.listLimit = Math.max(1, opts.listLimit ?? 500);
  }

  /** 数据根（排障 / API 展示用，不属于契约面） */
  get dataRoot(): string {
    return this.root;
  }

  /** 实例目录 `<dataRoot>/instances/<instanceId>`（已校验 id 形状，但**未必存在**） */
  instanceDir(instanceId: string): string {
    const problem = checkInstanceIdShape(instanceId);
    if (problem !== null) throw new FolderAccessError('bad-instance', problem);
    const dir = path.resolve(this.root, 'instances', instanceId);
    // 复核：即便 id 校验漏了什么，也必须落在 instances/ 之下
    if (!isInside(path.join(this.root, 'instances'), dir) || dir === path.join(this.root, 'instances')) {
      throw new FolderAccessError('bad-instance', `实例 id 解析出的路径越界：「${instanceId}」。`);
    }
    return dir;
  }

  /**
   * 解析某实例下某类目录的绝对路径，并**确保它存在**（mkdir -p）。
   *
   * 这是所有对外能力的唯一入口：`open()` 与 `list()` 都先走它，
   * 校验链因此只有一份，不会出现「一个接口校验了、另一个忘了」的经典漏洞。
   */
  async resolve(instanceId: string, kind: FolderKind): Promise<string> {
    const safeKind = parseFolderKind(kind);

    // dataRoot 不属于任何实例，但仍要走同一条出口（校验 kind 与存在性）
    if (safeKind === 'dataRoot') {
      await fsp.mkdir(this.root, { recursive: true });
      return this.realpathInside(this.root, this.root, safeKind);
    }

    const base = this.instanceDir(instanceId);
    if (safeKind === 'instance') {
      await fsp.mkdir(base, { recursive: true });
      return this.realpathInside(base, base, safeKind);
    }

    const subdir = SUBDIR_BY_KIND[safeKind];
    const target = path.resolve(base, subdir);

    // ★ 防路径穿越的关键一步：resolve 之后再复核前缀。
    //   subdir 来自白名单，理论上不可能越界；但「理论上」不是安全证明，
    //   任何一次重构（比如以后支持自定义子目录名）都可能把它变成漏洞。
    if (!isInside(base, target)) {
      throw new FolderAccessError('outside', `解析出的路径不在实例目录内：${target}`);
    }

    await fsp.mkdir(target, { recursive: true });
    return this.realpathInside(base, target, safeKind);
  }

  /**
   * 在系统文件管理器中打开某目录。
   *
   * 平台差异（都是真实踩过的）：
   *   - Windows：`explorer.exe "<path>"`。**explorer 会返回非 0 退出码**（实测常见为 1），
   *     所以绝不能拿退出码判断成败 —— 只要 spawn 成功就算发出去了。
   *   - macOS：`open "<path>"`
   *   - Linux：`xdg-open "<path>"`（没装 xdg-open 时会 ENOENT，如实报给人）
   *
   * 子进程一律 `detached: true` + `unref()`：文件管理器活多久跟本服务无关，
   * 不能让一个后台窗口把 Node 进程的退出拖住。
   */
  async open(instanceId: string, kind: FolderKind): Promise<void> {
    const target = await this.resolve(instanceId, kind);
    const cmd = buildOpenCommand(this.platform, target);
    if (this.spawnImpl !== undefined) {
      this.spawnImpl(cmd);
      return;
    }
    // ★ 运行期保护（测试事故换来的）：
    //   跑测试 / CI 时，一个漏注入 fake 的用例就会在用户桌面上弹一个资源管理器窗口。
    //   设 PCL3_NO_SHELL=1 后这里只记一条日志、绝不 spawn，是「就算代码写错也不会打扰人」的兜底。
    if (process.env['PCL3_NO_SHELL'] === '1') {
      process.emitWarning(`PCL3：PCL3_NO_SHELL=1，跳过打开文件夹（本应执行 ${cmd.file} ${cmd.args.join(' ')}）`);
      return;
    }
    spawnDetached(cmd);
  }

  /** 只算命令、不执行（`--dry-run` 与测试用） */
  async describeOpen(instanceId: string, kind: FolderKind): Promise<{ path: string; command: OpenCommand }> {
    const target = await this.resolve(instanceId, kind);
    return { path: target, command: buildOpenCommand(this.platform, target) };
  }

  /**
   * 列出目录内容（供 UI 展示）。
   *
   * `size`：文件给真实字节数；**目录给 0**，绝不递归 —— 一个 mods 目录递归 stat
   * 能把一次点击拖成十几秒。想算总量请用 disk-usage 模块（它自己带预算与缓存）。
   */
  async list(instanceId: string, kind: FolderKind): Promise<FolderEntry[]> {
    const dir = await this.resolve(instanceId, kind);
    const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });

    const out: FolderEntry[] = [];
    for (const dirent of dirents) {
      if (out.length >= this.listLimit) break;
      const full = path.join(dir, dirent.name);
      // 符号链接一律按 lstat 看，不跟随：避免链接指向的巨型目录被 stat 卡住
      const stat = await fsp.lstat(full).catch(() => undefined);
      if (stat === undefined) continue;
      const isDir = stat.isSymbolicLink() ? dirent.isDirectory() : stat.isDirectory();
      out.push({
        name: dirent.name,
        size: isDir ? 0 : Number(stat.size),
        isDir,
        mtime: stat.mtime instanceof Date && !Number.isNaN(stat.mtime.getTime()) ? stat.mtime.toISOString() : '',
      });
    }

    // 目录在前、同类型按名字排（资源管理器也是这个直觉）
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return out;
  }

  /** 该实例全部关键路径（供 UI 显示 / 复制；不逐个 mkdir，只挑存在的说说） */
  async paths(instanceId: string): Promise<Record<FolderKind, string>> {
    const base = this.instanceDir(instanceId);
    const out = {} as Record<FolderKind, string>;
    out.dataRoot = this.root;
    out.instance = base;
    for (const [kind, subdir] of Object.entries(SUBDIR_BY_KIND) as [keyof typeof SUBDIR_BY_KIND, string][]) {
      out[kind] = path.resolve(base, subdir);
    }
    return out;
  }

  /**
   * realpath 复核：解析符号链接之后再确认还在 parent 里。
   *
   * 场景：有人在实例目录里放了个 `mods → C:\Windows\System32` 的链接，
   * 单纯的前缀比对是看不出来的 —— 它对字面路径成立。
   */
  private async realpathInside(parent: string, target: string, kind: FolderKind): Promise<string> {
    const realParent = await fsp.realpath(parent).catch(() => path.resolve(parent));
    const realTarget = await fsp.realpath(target).catch(() => undefined);
    if (realTarget === undefined) return path.resolve(target);
    if (!isInside(realParent, realTarget)) {
      throw new FolderAccessError(
        'outside',
        `「${FOLDER_LABEL_CN[kind]}」是指向实例目录外部的符号链接，已拒绝打开：${realTarget}`,
      );
    }
    return realTarget;
  }
}

// ───────────────────────────── 平台命令 ─────────────────────────────

/**
 * 按平台拼「打开这个目录」的命令。
 *
 * 纯函数，所以测试可以直接断言三平台的参数形状，不必真的起文件管理器。
 * 路径作为**单个** argv 元素传入，不拼 shell 字符串 —— 目录名里带空格或中文都安全，
 * 也不可能被注入成额外参数。
 */
export function buildOpenCommand(platform: NodeJS.Platform, targetPath: string): OpenCommand {
  const p = path.resolve(targetPath);
  switch (platform) {
    case 'win32':
      // 用 explorer.exe 而不是 `start`：后者是 cmd 内建命令，必须经过 shell，等于给注入开口子
      return { file: 'explorer.exe', args: [p] };
    case 'darwin':
      return { file: 'open', args: [p] };
    default:
      return { file: 'xdg-open', args: [p] };
  }
}

/** spawn 一个不再管的子进程：失败只记 warning，绝不让「打不开文件夹」变成 500 */
function spawnDetached(cmd: OpenCommand): void {
  let child;
  try {
    child = spawn(cmd.file, cmd.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
  } catch (error) {
    process.emitWarning(
      `PCL3：无法启动文件管理器（${cmd.file}）：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  // explorer / xdg-open 失败时会 error 事件；这里只记日志，不抛。
  child.on('error', (error) => {
    process.emitWarning(`PCL3：打开文件夹失败（${cmd.file}）：${error.message}`);
  });
  // ★ 必须 unref：否则文件管理器窗口会把 Node 进程的退出拖住
  child.unref();
}
