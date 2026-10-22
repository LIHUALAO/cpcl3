/**
 * PCL3 shell 模块 —— 「基础便利功能」的统一出口。
 *
 * 只装那些**不改变游戏本身、但少了就难受**的能力：
 *   - FolderService：打开游戏 / mods / 存档 / 日志 … 并做路径穿越防护
 *   - DataDiskUsage：数据目录占用（异步 + 5 分钟缓存 + 10 万文件上限）
 *   - launch-command：把 buildCommand() 的结果变成可复制 / 可分享的一行命令
 *
 * 依赖原则：只用 Node 内置模块；`src/core/types.ts` 只 import 不修改。
 */

export {
  FolderService,
  FolderAccessError,
  FOLDER_KINDS,
  FOLDER_LABEL_CN,
  buildOpenCommand,
  checkInstanceIdShape,
  isInside,
  parseFolderKind,
} from './folder-service.js';
export type {
  FolderEntry,
  FolderKind,
  FolderServiceOptions,
  OpenCommand,
  OpenPlatform,
} from './folder-service.js';

export {
  DataDiskUsage,
  DISK_USAGE_BUDGET_MS,
  DISK_USAGE_MAX_FILES,
  DISK_USAGE_TTL_MS,
  formatDiskBytes,
} from './disk-usage.js';
export type { DiskUsageBucket, DiskUsageOptions, DiskUsageSnapshot } from './disk-usage.js';

export {
  baseNameOf,
  formatCommandLine,
  redactArgs,
  summarizeCommand,
} from './launch-command.js';
export type { FormatCommandOptions, LaunchCommandSummary } from './launch-command.js';
