/**
 * PCL3 共享类型 —— 唯一真源。
 * 所有模块只能 import，不得各自定义重复类型。
 * 修改本文件前必须通知 Lead。
 */

// ───────────────────────────── 版本清单 ─────────────────────────────

export interface VersionSummary {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha';
  url: string;
  time: string;
  releaseTime: string;
  sha1?: string;
  complianceLevel?: number;
}

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: VersionSummary[];
}

// ───────────────────────────── 版本 JSON ─────────────────────────────

export interface Rule {
  action: 'allow' | 'disallow';
  os?: { name?: string; version?: string; arch?: string };
  features?: Record<string, boolean>;
}

export interface ConditionalArg {
  rules: Rule[];
  value: string | string[];
}

export interface DownloadArtifact {
  path?: string;
  sha1: string;
  size: number;
  url: string;
}

export interface Library {
  /** Maven 坐标 group:artifact:version[:classifier] */
  name: string;
  downloads?: {
    artifact?: DownloadArtifact;
    classifiers?: Record<string, DownloadArtifact>;
  };
  natives?: Record<string, string>;
  rules?: Rule[];
  extract?: { exclude: string[] };
  /** 部分老库只给仓库根，需要自行拼 maven 路径 */
  url?: string;
}

export interface AssetIndexRef {
  id: string;
  sha1: string;
  size: number;
  totalSize: number;
  url: string;
}

export interface VersionJson {
  id: string;
  type: string;
  mainClass: string;
  assets: string;
  assetIndex?: AssetIndexRef;
  downloads?: Record<string, DownloadArtifact>;
  libraries: Library[];
  javaVersion?: { component: string; majorVersion: number };
  arguments?: { game: (string | ConditionalArg)[]; jvm: (string | ConditionalArg)[] };
  /** 1.12 及更早版本的参数格式 */
  minecraftArguments?: string;
  logging?: Record<string, unknown>;
  inheritsFrom?: string;
  /** 允许透传未声明的额外字段 */
  [extra: string]: unknown;
}

// ───────────────────────────── 资源索引 ─────────────────────────────

export interface AssetObject {
  hash: string;
  size: number;
}

export interface AssetIndex {
  objects: Record<string, AssetObject>;
  virtual?: boolean;
  map_to_resources?: boolean;
}

// ───────────────────────────── 下载 ─────────────────────────────

export interface DownloadTask {
  url: string;
  /** 绝对路径 */
  dest: string;
  sha1?: string;
  size?: number;
}

export interface DownloadProgress {
  done: number;
  total: number;
  current: string;
  bytesDone?: number;
  bytesTotal?: number;
}

export interface DownloadResult {
  ok: boolean;
  /** 已存在且校验通过，跳过 */
  skipped: number;
  downloaded: number;
  failed: DownloadTask[];
}

// ───────────────────────────── 安装 ─────────────────────────────

export interface InstallPlan {
  versionId: string;
  tasks: DownloadTask[];
  totalBytes: number;
  /** native 解压目标：library name → 目标目录 */
  natives: { name: string; jarPath: string; extractTo: string; exclude: string[] }[];
  assetIndexId: string;
}

export interface InstallProgress {
  phase: 'meta' | 'libraries' | 'assets' | 'natives' | 'done';
  done: number;
  total: number;
  current?: string;
}

// ───────────────────────────── 账户 ─────────────────────────────

export type AccountType = 'microsoft' | 'offline';

export interface Account {
  type: AccountType;
  username: string;
  uuid: string;
  accessToken: string;
  refreshToken?: string;
  xuid?: string;
  /** 毫秒时间戳 */
  expiresAt?: number;
}

export interface DeviceCodeSession {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  /** 轮询间隔，秒 */
  interval: number;
  expiresIn: number;
  message?: string;
}

// ───────────────────────────── 启动 ─────────────────────────────

export interface LaunchOptions {
  versionId: string;
  instanceDir: string;
  account: Account;
  javaPath?: string;
  memoryMB?: number;
  extraJvmArgs?: string[];
  extraGameArgs?: string[];
  /** 实例名，用于 ${version_name} 与实例隔离 */
  instanceName?: string;
}

export interface BuiltCommand {
  java: string;
  args: string[];
  cwd: string;
}

export interface LaunchedProcess {
  pid: number;
  process: import('node:child_process').ChildProcess;
}
