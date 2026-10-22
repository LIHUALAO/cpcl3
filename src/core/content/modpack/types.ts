/**
 * 整合包（`.mrpack`）的类型定义与错误类型。
 *
 * 只描述本模块自己的东西；共享类型（DownloadTask / VersionJson …）一律从
 * `../../types.js` import，不在这里重复定义。
 */

/** `modrinth.index.json` 里的一个待下载文件 */
export interface ModpackFile {
  /** 相对实例目录的落点，例如 `mods/sodium.jar` */
  path: string;
  hashes: { sha1?: string; sha512?: string };
  /** client / server 各取 required | optional | unsupported */
  env?: { client?: string; server?: string };
  /** 按顺序尝试的下载地址 */
  downloads: string[];
  /** 声明的字节数（可能缺），缺失时从 Content-Length 反推 */
  fileSize?: number;
}

/** 解析并归一化后的整合包清单 */
export interface ModpackIndex {
  formatVersion: number;
  name: string;
  versionId: string;
  summary?: string;
  game: string;
  /** { minecraft: "1.21", "fabric-loader": "0.16.9" } */
  dependencies: Record<string, string>;
  files: ModpackFile[];
}

/** zip 里一个 overrides 条目 */
export interface ModpackOverrideEntry {
  /** zip 内的原始路径，例如 `overrides/config/foo.json` */
  path: string;
  /** 解压后的相对路径（已剥掉 `overrides/` 前缀并校验过），例如 `config/foo.json` */
  target: string;
  /** 条目来自哪个目录：overrides / client-overrides / server-overrides */
  source: OverrideRoot;
  size: number;
  isDirectory: boolean;
}

export type OverrideRoot = 'overrides' | 'client-overrides' | 'server-overrides';

/** `parse()` 的返回值：只读不写，不下载任何东西 */
export interface ModpackParseResult {
  index: ModpackIndex;
  /** zip 内所有 overrides 条目（三个根目录合并，按 zip 内顺序） */
  overrides: ModpackOverrideEntry[];
  /** zip 中央目录里的条目总数 */
  entryCount: number;
  /** 整合包文件本身的绝对路径 */
  filePath: string;
  /** 整合包文件大小（字节） */
  fileSize: number;
  /** 安装时会实际下载的文件（已按 env.client 过滤） */
  clientFiles: ModpackFile[];
  /** 因为 `env.client === 'unsupported'` 被跳过的文件 */
  skippedServerFiles: ModpackFile[];
  /** 客户端要下载的文件总字节数（fileSize 缺失的按 0 计） */
  totalBytes: number;
  /** dependencies 里认出来的加载器；原版包为 undefined */
  loader?: ModpackLoaderDependency;
}

/** 从 dependencies 里识别出的加载器 */
export interface ModpackLoaderDependency {
  /** raw = dependencies 里的原始 key，例如 `fabric-loader` */
  raw: string;
  /** 归一化后的加载器种类 */
  kind: ModpackLoaderKind;
  /** 加载器版本号 */
  version: string;
  /** 是否为 LoaderInstaller 支持的加载器（目前只有 fabric / quilt） */
  supported: boolean;
}

/**
 * 归一化后的加载器种类。
 *
 * `fabric` / `quilt` 可以直接交给 `LoaderInstaller.install(kind, gv, ver)`；
 * `forge` / `neoforge` 本项目的 LoaderInstaller 还不支持（它只认 fabric / quilt），
 * 所以单独标出、如实报错，绝不假装装上了。
 */
export type ModpackLoaderKind = 'fabric' | 'quilt' | 'forge' | 'neoforge';

/** 进度回调（阶段：vanilla / loader / mods / overrides / done） */
export interface ModpackProgress {
  phase: string;
  done: number;
  total: number;
  current?: string;
}

export interface ModpackInstallOptions {
  instanceName: string;
  onProgress?: (p: ModpackProgress) => void;
}

export interface ModpackInstallResult {
  /** 实例 id（= 目录名，位于 `<dataRoot>/instances/<instanceId>/`） */
  instanceId: string;
  /**
   * 启动时该用的版本 id：
   *   - 装了加载器 → loader profile 的 id（如 `fabric-loader-0.16.9-1.21`）
   *   - 纯原版整合包 → 原版版本号（如 `1.21`）
   */
  versionId: string;
  /** 实际使用的原版版本 */
  gameVersion: string;
  /** 实际安装的加载器（没有则不填） */
  loader?: { kind: ModpackLoaderKind; version: string; versionId: string };
  /** 实例目录绝对路径 */
  instanceDir: string;
  /** 客户端 mod 文件数 / 跳过数 / 覆盖文件数 */
  stats: {
    files: number;
    skipped: number;
    overridden: number;
  };
}

/** 整合包解析/安装的业务错误：message 一律是人话，可直接展示给用户 */
export class ModpackError extends Error {
  readonly code: ModpackErrorCode;
  readonly hint?: string;

  constructor(code: ModpackErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ModpackError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export type ModpackErrorCode =
  /** 文件不存在 / 读不了 */
  | 'not-found'
  /** 不是 zip */
  | 'not-a-zip'
  /** 缺 modrinth.index.json */
  | 'missing-index'
  /** index 内容不合法 */
  | 'bad-index'
  /** zip-slip / 绝对路径 / 盘符路径 */
  | 'unsafe-path'
  /** 整合包不带 minecraft 依赖 */
  | 'missing-minecraft'
  /** 加载器不受支持（forge/neoforge） */
  | 'unsupported-loader'
  /** 实例名非法 */
  | 'bad-instance-name'
  /** 实例已存在 */
  | 'instance-exists'
  /** 下载失败 */
  | 'download-failed'
  /** 其它 IO */
  | 'io';
