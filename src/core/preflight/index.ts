/**
 * preflight 模块统一出口。
 *
 * 两条使用路径：
 *
 *   1. **显式依赖**（测试、CLI、其它模块）：
 *      ```ts
 *      const checker = new PreflightChecker({ dataRoot, versionRepo, settings, modManager });
 *      const report = await checker.check({ versionId: '1.21' });
 *      ```
 *
 *   2. **真实装配**（Web 层）：
 *      ```ts
 *      const checker = createPreflightChecker({ dataRoot });
 *      ```
 *      本文件负责把 `VersionRepository` / `SettingsStore` / `ModManager` / `JavaRuntimeInstaller`
 *      按数据根装起来，并调用 `setDefaultModManagerFactory` 把 ModManager 的构造权交给这里 ——
 *      这样 `PreflightChecker.ts` 本身**不需要** import `content/mods`，
 *      保持了「体检核心不依赖内容模块」的分层。
 *
 * 为什么 Installer 不在这里 new：`JavaRuntimeInstaller` 需要一个 `Downloader`，而体检
 * **从不下载**，只需要它读清单的能力。web 层已经把 downloader 装好了，由它传进来更自然，
 * 也避免这个模块为了「可能用不上」的能力把 download 模块拖进依赖链。
 */

import path from 'node:path';

import { VersionRepository } from '../version/index.js';
import { ModManager } from '../content/mods/index.js';
import { SettingsStore } from '../settings/index.js';

import {
  ASSET_SAMPLE_LIMIT,
  MEMORY_MIN_LAUNCH_MB,
  MEMORY_OVERCOMMIT_RATIO,
  MEMORY_RECOMMENDED_MB,
  PreflightChecker,
  javaRequirementOf,
  loaderKindOf,
  sampleAssets,
  setDefaultModManagerFactory,
  type CheckSeverity,
  type FixKind,
  type JavaInstallerLike,
  type ModManagerLike,
  type PreflightCheckId,
  type PreflightCheckerDeps,
  type PreflightCode,
  type PreflightFix,
  type PreflightFsLike,
  type PreflightIssue,
  type PreflightReport,
  type PreflightReportDetail,
  type PreflightVersionRepoLike,
} from './PreflightChecker.js';

// 把 ModManager 的构造权交给本文件：PreflightChecker 只认结构类型，不 import content 模块
setDefaultModManagerFactory((dataRoot: string) => new ModManager({ dataRoot }));

export {
  PreflightChecker,
  ASSET_SAMPLE_LIMIT,
  MEMORY_MIN_LAUNCH_MB,
  MEMORY_OVERCOMMIT_RATIO,
  MEMORY_RECOMMENDED_MB,
  javaRequirementOf,
  loaderKindOf,
  sampleAssets,
  setDefaultModManagerFactory,
};

export type {
  CheckSeverity,
  FixKind,
  JavaInstallerLike,
  ModManagerLike,
  PreflightCheckId,
  PreflightCheckerDeps,
  PreflightCode,
  PreflightFix,
  PreflightFsLike,
  PreflightIssue,
  PreflightReport,
  PreflightReportDetail,
  PreflightVersionRepoLike,
};

/** 真实装配的选项 */
export interface CreatePreflightOptions {
  /** 数据根（必填：体检必须明确知道看哪个目录） */
  dataRoot: string;
  /** 注入 Java 安装器（web 层用它读清单判断「能不能自动下」） */
  javaInstaller?: JavaInstallerLike;
  /** 覆盖任何单项依赖（测试 / 高级用法） */
  overrides?: Partial<PreflightCheckerDeps>;
  /** 「物理内存」覆盖（MB） */
  totalMemoryMB?: number;
}

/**
 * 按数据根装配一个体检器（每次调用都是新实例：`VersionRepository` 带磁盘缓存，
 * 跨请求共享会串味；`ModManager` 构造极轻，不需要复用）。
 */
export function createPreflightChecker(opts: CreatePreflightOptions): PreflightChecker {
  const dataRoot = path.resolve(opts.dataRoot);
  const deps: PreflightCheckerDeps = {
    dataRoot,
    versionRepo: new VersionRepository({ dataRoot }) as unknown as PreflightVersionRepoLike,
    settings: new SettingsStore({ dataRoot }),
    modManager: new ModManager({ dataRoot }),
  };
  if (opts.javaInstaller !== undefined) deps.javaProvisioner = opts.javaInstaller;
  if (opts.totalMemoryMB !== undefined) deps.totalMemoryMB = opts.totalMemoryMB;
  return new PreflightChecker({ ...deps, ...(opts.overrides ?? {}) });
}

// ───────────────────────────── 报告 → 前端可读形状 ─────────────────────────────

/** 报告里所有问题平铺一遍（顺序：blocking → warning → info） */
export function allIssues(report: PreflightReport): PreflightIssue[] {
  return [...report.blocking, ...report.warnings, ...report.infos];
}

/** 报告里所有**带修复按钮**的问题 */
export function fixableIssues(report: PreflightReport): (PreflightIssue & { fix: PreflightFix })[] {
  return allIssues(report).filter((i): i is PreflightIssue & { fix: PreflightFix } => i.fix !== undefined);
}

/** 报告的一句话摘要（前端 toast / 启动日志用） */
export function summarize(report: PreflightReport): string {
  const b = report.blocking.length;
  const w = report.warnings.length;
  if (b === 0 && w === 0) return '体检通过，没有发现问题。';
  const parts: string[] = [];
  if (b > 0) parts.push(`${String(b)} 个阻断问题`);
  if (w > 0) parts.push(`${String(w)} 个警告`);
  return `体检发现 ${parts.join('、')}。`;
}

/** 真能不能启动：只有「有 blocking」才不能 */
export function canLaunch(report: PreflightReport): boolean {
  return report.blocking.length === 0;
}
