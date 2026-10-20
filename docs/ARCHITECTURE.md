# 项目契约（所有子代理必读）

本文件是 PCL3 各模块之间的**接口契约**。负责某个模块的子代理必须严格按此实现，不得擅自改动其他模块的接口。

## 命名

- 产品名：`PCL3`（占位名，从根 `package.json` 的 `productName` 读取，代码里不要硬编码中文名）
- 包名：`pcl3`
- 目录根：仓库根

## 技术栈

- Node.js >= 20（本机为 v24.21.0）
- TypeScript 5.x，ESM（`"type": "module"`）
- 构建：`tsc`，输出到 `dist/`
- 测试：`node --test`（内置 test runner，不引 vitest，减少依赖）
- 依赖原则：**核心零第三方依赖**，只用 Node 内置模块（`node:fs`、`node:https`、`node:crypto`、`node:child_process`、`node:os`、`node:path`）。

## 目录

```
src/
├─ core/
│  ├─ version/      # 版本元数据
│  ├─ download/     # 下载器
│  ├─ install/      # 安装器
│  ├─ launch/       # 启动器
│  └─ auth/         # 认证
├─ cli/             # 命令行入口
└─ web/             # Web UI + 本地 HTTP 服务
test/               # 测试
docs/               # 文档
```

## 共享类型（唯一真源）

所有跨模块类型定义在 `src/core/types.ts`，由 **version 模块**负责创建与维护。其他模块只能 import，不得改。

```ts
// 版本清单条目
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

// 版本 JSON（只列本项目用到的字段）
export interface VersionJson {
  id: string;
  type: string;
  mainClass: string;
  assets: string;
  assetIndex?: { id: string; sha1: string; size: number; totalSize: number; url: string };
  downloads?: Record<string, { sha1: string; size: number; url: string }>;
  libraries: Library[];
  javaVersion?: { component: string; majorVersion: number };
  arguments?: { game: (string | ConditionalArg)[]; jvm: (string | ConditionalArg)[] };
  minecraftArguments?: string;   // 旧版本
  logging?: unknown;
  inheritsFrom?: string;
}

export interface ConditionalArg {
  rules: Rule[];
  value: string | string[];
}

export interface Rule {
  action: 'allow' | 'disallow';
  os?: { name?: string; version?: string; arch?: string };
  features?: Record<string, boolean>;
}

export interface Library {
  name: string;                 // Maven 坐标 group:artifact:version[:classifier]
  downloads?: {
    artifact?: { path: string; sha1: string; size: number; url: string };
    classifiers?: Record<string, { path: string; sha1: string; size: number; url: string }>;
  };
  natives?: Record<string, string>;
  rules?: Rule[];
  extract?: { exclude: string[] };
  url?: string;                 // 部分老库用 maven 仓库根
}

export interface AssetObject { hash: string; size: number }
export interface AssetIndex {
  objects: Record<string, AssetObject>;
  virtual?: boolean;
  map_to_resources?: boolean;
}
```

## 数据目录

所有运行期数据放在**用户目录**，不进仓库：

```
%APPDATA%/PCL3/          或  ~/.pcl3/
├─ meta/          # 版本元数据缓存
├─ libraries/     # 依赖库
├─ assets/        # 游戏资源
├─ versions/      # 各版本的游戏文件
├─ instances/     # 实例（隔离的游戏目录）
└─ java/          # 自动下载的 JRE
```

由 **download 模块**提供 `getDataRoot(): string`，其他模块调用，不各自拼路径。

## 模块接口

### version 模块（负责人：version-dev）

```ts
export class VersionRepository {
  constructor(opts?: { mirror?: string });
  /** 拉取版本清单，带本地缓存（TTL 10 分钟） */
  fetchManifest(force?: boolean): Promise<VersionManifest>;
  /** 拉取单个版本 JSON，带磁盘缓存 */
  fetchVersion(id: string): Promise<VersionJson>;
  /** 解析继承链（inheritsFrom），合并成可直接使用的完整 VersionJson */
  resolveInherited(json: VersionJson): Promise<VersionJson>;
}
```

要求：
- 缓存落在 `<dataRoot>/meta/`，文件名带 sha1 或版本 id
- 网络失败时**回退到过期缓存**并打日志，不直接抛错
- 镜像可切换：`launchermeta.mojang.com` ↔ `bmclapi2.bangbang93.com`

### download 模块（负责人：download-dev）

```ts
export interface DownloadTask {
  url: string;
  dest: string;
  sha1?: string;
  size?: number;
}

export interface DownloadResult {
  ok: boolean;
  skipped: number;      // 已存在且校验通过
  downloaded: number;
  failed: DownloadTask[];
}

export function getDataRoot(): string;

export class Downloader {
  constructor(opts: { concurrency?: number; retries?: number; mirrors?: string[] });
  /** 批量下载，自动跳过已存在且 SHA1 正确的文件 */
  downloadAll(tasks: DownloadTask[], onProgress?: (p: { done: number; total: number; current: string }) => void): Promise<DownloadResult>;
}
```

要求：
- 并发默认 8，指数退避重试默认 3 次
- 校验 SHA1 失败时删除文件并重下一次
- 支持镜像前缀回退：主 URL 失败后依次尝试 mirrors
- 断点续传：支持 `Range` 头

### install 模块（负责人：install-dev）

依赖 version + download。

```ts
export interface InstallPlan {
  versionId: string;
  tasks: DownloadTask[];
  totalBytes: number;
}

export class VanillaInstaller {
  constructor(deps: { versionRepo: VersionRepository; downloader: Downloader });
  /** 生成安装计划，不实际下载 */
  plan(versionId: string): Promise<InstallPlan>;
  /** 执行安装 */
  install(versionId: string, onProgress?: (p: { phase: string; done: number; total: number }) => void): Promise<void>;
}
```

要求：
- 处理 `-Djava.library.path` 需要的 natives 分类
- 按 OS 规则（`rules`）过滤库文件
- assets 走 BMCLAPI 镜像

### launch 模块（负责人：launch-dev）

依赖 version + install + auth。

```ts
export interface LaunchOptions {
  versionId: string;
  instanceDir: string;
  account: Account;
  javaPath?: string;
  memoryMB?: number;
  extraJvmArgs?: string[];
}

export interface LaunchedProcess { pid: number; process: import('node:child_process').ChildProcess }

export class GameLauncher {
  constructor(deps: { versionRepo: VersionRepository });
  /** 拼装完整启动命令（不启动，便于测试与展示） */
  buildCommand(opts: LaunchOptions): Promise<{ java: string; args: string[]; cwd: string }>;
  /** 启动进程 */
  launch(opts: LaunchOptions): Promise<LaunchedProcess>;
}
```

要求：
- 占位符替换：`${auth_player_name}`、`${version_name}`、`${game_directory}`、`${assets_root}`、`${assets_index_name}`、`${auth_uuid}`、`${auth_access_token}`、`${clientid}`、`${auth_xuid}`、`${user_type}`、`${version_type}`、`${natives_directory}`、`${launcher_name}`、`${launcher_version}`、`${classpath}`、`${classpath_separator}`
- 新旧版本参数格式都要支持（`arguments` 与 `minecraftArguments` 两种）
- natives 解压到实例目录，排除 `META-INF`

### auth 模块（负责人：auth-dev）

```ts
export interface Account {
  type: 'microsoft' | 'offline';
  username: string;
  uuid: string;
  accessToken: string;
  refreshToken?: string;
  xuid?: string;
  expiresAt?: number;
}

export class MicrosoftAuth {
  /** 设备码登录流程：返回验证码与链接，等待用户在浏览器完成 */
  beginDeviceCode(): Promise<{ userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }>;
  /** 轮询直到用户完成登录 */
  completeDeviceCode(deviceCode: string, interval: number): Promise<Account>;
  /** 刷新过期令牌 */
  refresh(account: Account): Promise<Account>;
}

export function offlineAccount(username: string): Account;
```

要求：
- 设备码端点：`https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`
- 令牌端点：`https://login.microsoftonline.com/consumers/oauth2/v2.0/token`
- scope：`XboxLive.signin offline_access`
- 之后走 XBL → XSTS → Minecraft 服务端登录三步换 MC token
- **client_id 用占位符常量 `AZURE_CLIENT_ID`，集中在 `src/core/auth/constants.ts`，方便以后替换**
- refreshToken 持久化到 `<dataRoot>/accounts.json`，文件权限收紧

## 协作规则

1. **只写自己的目录**。改动 `src/core/types.ts` 必须先告诉我，由 version-dev 统一改。
2. 每个模块自带 `test/<模块名>.test.ts`，用 `node --test` 能跑通。
3. 不装任何第三方 npm 依赖。确有需要先报告。
4. 提交的代码必须 `tsc --noEmit` 零错误。
5. 遇到本机环境问题（Node 不在 PATH 等），用绝对路径：
   `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
   包管理：`...\dependencies\pnpm\bin\pnpm.mjs`
6. 不要执行 git 操作，由我统一提交。
