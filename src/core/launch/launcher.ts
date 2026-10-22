/**
 * GameLauncher：把版本元数据变成「可以直接 spawn 的命令行」。
 *
 *   - buildCommand(): 只拼装（外加 natives 解压这类必要的磁盘准备，带缓存可跳过）
 *   - launch():      先 buildCommand，再 spawn
 *
 * 设计要点：
 *   - 唯一真源 ../types.ts，只 import 不修改
 *   - classpath 超长时（Windows CreateProcess 命令行上限约 32767）落盘成 argfile，
 *     用 `-cp @file` 引用，避免 EINVAL
 *   - Java 找不到时抛明确错误，绝不静默使用错误版本
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  Account,
  BuiltCommand,
  ConditionalArg,
  LaunchOptions,
  Library,
  VersionJson,
} from '../types.js';

/**
 * 启动结果。契约里 `LaunchedProcess` 没被写进 types.ts（负责 types 的是 version-dev），
 * 为不越界改共享类型，这里按 ARCHITECTURE.md 的字段在本模块定义并导出。
 */
export interface LaunchedProcess {
  pid: number;
  process: ChildProcess;
}

import {
  buildClasspath,
  buildPlaceholders,
  evaluateArguments,
  hasClasspathPlaceholder,
  hasSystemProperty,
  joinClasspath,
  nativeClassifier,
  planLibraries,
  splitLegacyArguments,
  substitute,
  withDefaultLocale,
} from './command.js';
import type { PlaceholderMap } from './command.js';
import { collectNativeJobs, extractNatives } from './natives.js';
import { DEFAULT_LANG, ensureChineseOptions } from './options-txt.js';
import { detectPlatform, libraryAllowed, DEFAULT_FEATURES, type Platform } from './rules.js';
import {
  findJavaInDataRoot,
  javaExecutable,
  isJavaHome,
  noJavaMessage,
  type JavaRequirement,
} from './java.js';
import { JavaAutoProvisioner } from './java-provision.js';
import { readLauncherMeta } from './meta.js';
import { resolveDataRoot } from './data-root.js';
import { mergeVersionJson } from './version-merge.js';
import type { VersionRepositoryLike, VersionSource } from './version-source.js';

// ───────────────────────────── 常量 ─────────────────────────────

export const DEFAULT_MEMORY_MB = 2048;

/** 未声明时按账户类型给 user_type：正版 msa，离线 legacy（1.21 元数据里硬编码为 msa） */
const USER_TYPE = { microsoft: 'msa', offline: 'legacy' } as const;

/** classid / auth_xuid 的默认值：离线账户没有，留空串 */
const CLIENT_ID = { microsoft: '', offline: '' } as const;

/** Windows CreateProcess 命令行上限 32767 字符，留出余量 */
const ARGFILE_THRESHOLD = 20_000;

/** spawn 兜底超时，避免事件永不触发导致挂死 */
const SPAWN_TIMEOUT_MS = 15_000;

// ───────────────────────────── 类型 ─────────────────────────────

export interface GameLauncherDeps {
  versionRepo: VersionSource;
  /** 覆盖数据根（默认取 download 模块的 getDataRoot，取不到按目录规则兜底） */
  dataRoot?: string;
  /** 覆盖平台识别（默认按当前 OS；测试里可固定成 windows） */
  platform?: Platform;
  /** 覆盖 feature 求值开关（默认 { is_demo_user:false, has_custom_resolution:false }） */
  features?: Readonly<Record<string, boolean>>;
  /** 覆盖 launcher 名称/版本（默认读根 package.json） */
  launcherMeta?: { name: string; version: string };
  /**
   * Java 自动下载器（可选）。缺省时用默认实现（内置 JavaRuntimeInstaller）；
   * 注入一个「永远没装也没法下」的实例即可在测试里关掉自动下载。
   */
  javaProvisioner?: JavaProvisionerLike | null;
}

/** java-provision.ts 里 `JavaAutoProvisioner.ensureJava` 的结构约束 */
export interface JavaProvisionerLike {
  ensureJava(
    requirement: JavaRequirement,
    dataRoot: string,
    explicitPath?: string | null,
  ): Promise<string>;
}

export interface LaunchContext {
  version: VersionJson;
  platform: Platform;
  features: Readonly<Record<string, boolean>>;
  dataRoot: string;
  librariesRoot: string;
  versionsRoot: string;
  instanceDir: string;
  gameDir: string;
  /** 实例目录下用来放原生库的父目录（真正使用的子目录另见 nativesDir） */
  nativesRoot: string;
  assetsRoot: string;
  realVersionId: string;
  /**
   * 用于定位**游戏本体 jar** 的版本 id。
   *
   * 与 `realVersionId` 不同的原因：加载器版本（Fabric / Quilt / Forge …）是纯元数据，
   * 目录里**只有 json 没有 jar**，真正的 client jar 属于它 `inheritsFrom` 的原版。
   * 老代码用 `realVersionId` 拼 jar 路径 → classpath 指向不存在的文件 →
   * Fabric 报 `couldn't locate the game` 直接崩（P0）。
   *
   * 解析顺序见 {@link GameLauncher.resolveClientJarVersion}：
   *   自身目录有 jar → 自身；否则沿 inheritsFrom 链向上找第一个真有 jar 的祖先。
   * 链上都没 jar 时**退回自身**（保持旧行为），由下游给出可读的错误。
   */
  clientJarVersion: string;
  /**
   * 资产索引兜底用的版本 id（加载器的 assets 必须跟随原版）。
   * 正常情况下 `version.assetIndex` / `version.assets` 已由继承链合并带下来，
   * 这个值只在两者都缺失时兜底。
   */
  gameVersion: string;
}

// ───────────────────────────── 实现 ─────────────────────────────

export class GameLauncher {
  private readonly deps: GameLauncherDeps;
  /** versionId → 已合并继承的完整 JSON */
  private readonly resolvedCache = new Map<string, VersionJson>();

  constructor(deps: GameLauncherDeps) {
    if (!deps || typeof deps !== 'object' || !deps.versionRepo) {
      throw new TypeError('GameLauncher 需要依赖 { versionRepo }');
    }
    this.deps = deps;
  }

  // ── 公共 API ────────────────────────────────────────────────

  async buildCommand(opts: LaunchOptions): Promise<BuiltCommand> {
    const ctx = await this.resolveContext(opts);
    const { version, platform, features } = ctx;

    // 0) 首次启动默认中文：确保 options.txt 存在且含 lang:
    //    只补缺失，用户改过的语言一个字都不动（见 options-txt.ts）
    await this.ensureOptionsTxt(ctx);

    // 1) natives：解压到实例目录下的隔离子目录，保证 -Djava.library.path 指向真实存在的目录
    const nativesDir = await this.prepareNatives(ctx);

    // 2) classpath：按 rules 过滤 → 游戏本体 jar 永远最后
    //    ⚠ 这里必须用 clientJarVersion 而不是 realVersionId：
    //    加载器版本没有自己的 jar，jar 属于它 inheritsFrom 的原版。
    const plan = planLibraries(version.libraries ?? [], platform, features);
    const versionJar = path.join(
      ctx.versionsRoot,
      ctx.clientJarVersion,
      `${ctx.clientJarVersion}.jar`,
    );
    const classpathEntries = buildClasspath({
      entries: plan.entries,
      librariesRoot: ctx.librariesRoot,
      versionJar,
      path,
      separator: platform.classpathSeparator,
    });
    const classpath = joinClasspath(classpathEntries, platform.classpathSeparator);

    // 3) 占位符
    const meta = this.launcherMeta();
    const assetsIndexName = version.assetIndex?.id ?? version.assets ?? ctx.gameVersion;
    const placeholders = buildPlaceholders({
      authPlayerName: opts.account.username,
      versionName: opts.instanceName ?? version.id ?? opts.versionId,
      gameDirectory: ctx.gameDir,
      assetsRoot: ctx.assetsRoot,
      assetsIndexName,
      authUuid: opts.account.uuid,
      authAccessToken: opts.account.accessToken,
      clientId: CLIENT_ID[opts.account.type] ?? '',
      authXuid: opts.account.xuid ?? '',
      userType: accountUserType(opts.account),
      versionType: typeof version.type === 'string' && version.type.length > 0 ? version.type : 'release',
      nativesDirectory: nativesDir,
      launcherName: meta.name,
      launcherVersion: meta.version,
      classpath,
      classpathSeparator: platform.classpathSeparator,
      gameAssets: ctx.assetsRoot,
    });

    // 4) 参数模板（未替换）→ 5) 替换占位符
    const jvmTemplates = this.jvmArgumentTemplates(version, opts, platform, features);
    const gameTemplates = this.gameArgumentTemplates(version, platform, features, opts);
    const jvmArgs = jvmTemplates.map((t) => substitute(t, placeholders));
    const gameArgs = gameTemplates.map((t) => substitute(t, placeholders));

    // 6) 日志配置参数（版本声明了 logging 且文件已下载时才有）
    const loggingArgs = this.loggingArgs(version, ctx, placeholders);

    // 7) classpath 超长 → argfile
    let jvmFinal = [...jvmArgs, ...loggingArgs];
    if (classpath.length > ARGFILE_THRESHOLD && hasClasspathPlaceholder(jvmTemplates)) {
      jvmFinal = await this.rewriteToArgfile(ctx, jvmFinal, classpathEntries, platform.classpathSeparator);
    }

    // 8) locale 双保险：补 -Duser.language=zh / -Duser.country=CN（与 options.txt 的 lang 配合）。
    //    必须插在 -cp 之前 —— JVM 一旦读到 -cp 就认为 JVM 参数结束，后面的 -D 会被当成类名。
    //    用户自己传过任何一个键就不重复添加（见 withDefaultLocale 的逐键判断）。
    const jvmWithLocale = insertLocaleBeforeClasspath(jvmFinal);

    // 9) mainClass 必须在 jvm 参数之后、game 参数之前
    const mainClass = mainClassOf(version);
    const args = [...jvmWithLocale, mainClass, ...gameArgs];

    const java = await this.pickJava(opts, version, ctx, nativesDir);
    return { java, args, cwd: ctx.gameDir };
  }

  /**
   * 启动进程。
   *
   * 额外满足：即使进程在 spawn 后立刻退出，也不抛错——真实 JDK 会在
   * `CommandLineWrapper` 里另起游戏进程后自己退出，这是正常行为。
   * 只有 spawn 本身失败（ENOENT/EACCES/EINVAL…）才 reject。
   */
  async launch(opts: LaunchOptions): Promise<LaunchedProcess> {
    const built = await this.buildCommand(opts);
    const child = spawn(built.java, built.args, {
      cwd: built.cwd,
      stdio: 'inherit',
      windowsHide: false,
    });
    const proc = await waitForSpawn(child);
    return { pid: proc.pid ?? -1, process: proc };
  }

  // ── 内部：上下文 ────────────────────────────────────────────

  private launcherMeta(): { name: string; version: string } {
    return this.deps.launcherMeta ?? readLauncherMeta();
  }

  private dataRoot(): string {
    return this.deps.dataRoot ?? resolveDataRoot();
  }

  private async resolveContext(opts: LaunchOptions): Promise<LaunchContext> {
    const platform = this.deps.platform ?? detectPlatform();
    const features = this.deps.features ?? DEFAULT_FEATURES;
    const dataRoot = this.dataRoot();
    const version = await this.loadVersion(opts.versionId);
    const instanceDir = path.resolve(opts.instanceDir);
    const realVersionId = version.id || opts.versionId;

    // 版本隔离（官方启动器语义）：
    //   <instanceDir>/versions/<id>/<id>.json 存在 → 游戏 jar 取实例自带的隔离版本
    //   否则取数据目录 <dataRoot>/versions/<id>/<id>.jar
    const isolated = isFile(path.join(instanceDir, 'versions', realVersionId, `${realVersionId}.json`));
    const versionsRoot = isolated ? path.join(instanceDir, 'versions') : path.join(dataRoot, 'versions');

    // 游戏本体 jar 的定位（P0 修复）：沿 inheritsFrom 链向下找真正带 jar 的版本
    const clientJarVersion = await this.resolveClientJarVersion(
      opts.versionId,
      realVersionId,
      versionsRoot,
    );

    // 资产索引兜底跟随原版（加载器自身不带 assets）
    const gameVersion = clientJarVersion || realVersionId;

    return {
      version,
      platform,
      features,
      dataRoot,
      librariesRoot: path.join(dataRoot, 'libraries'),
      versionsRoot,
      instanceDir,
      gameDir: instanceDir,
      nativesRoot: path.join(instanceDir, 'natives'),
      assetsRoot: path.join(dataRoot, 'assets'),
      realVersionId,
      clientJarVersion,
      gameVersion,
    };
  }

  /**
   * 找到真正持有 client jar 的版本 id。
   *
   * 背景：Fabric / Quilt / Forge 这类加载器版本的目录里只有 json，jar 属于原版。
   * 老代码直接把 `<realVersionId>.jar` 塞进 classpath，于是 Fabric 的 Knot 报
   * `Class path entries reference missing files` + `couldn't locate the game`。
   *
   * 解析顺序：
   *   1. `<versionsRoot>/<realVersionId>/<realVersionId>.jar` 存在 → 用它（原版）
   *   2. 否则从**未合并**的原始 JSON 读 `inheritsFrom`，沿链向上逐级找第一个有 jar 的版本
   *   3. 整条链都没 jar → 退回 realVersionId（保持旧行为，让缺文件错误落在它身上）
   *
   * 注意：合并后的 `version` 已经没有 `inheritsFrom`（resolveInherited 会清掉），
   * 所以这里必须重新读原始 JSON，不能依赖 ctx.version。
   */
  private async resolveClientJarVersion(
    requestedId: string,
    realVersionId: string,
    versionsRoot: string,
  ): Promise<string> {
    const jarOf = (id: string): string => path.join(versionsRoot, id, `${id}.jar`);

    if (isFile(jarOf(realVersionId))) return realVersionId;

    // 沿 inheritsFrom 链向上找（最多 16 层，防环）
    const seen = new Set<string>([realVersionId]);
    let currentId = await this.inheritsFromOf(requestedId);
    let depth = 0;

    while (currentId.length > 0 && depth < 16) {
      if (seen.has(currentId)) break;
      seen.add(currentId);
      if (isFile(jarOf(currentId))) return currentId;
      currentId = await this.inheritsFromOf(currentId);
      depth += 1;
    }

    // 链上没有任何 jar：退回自身，让下游明确报告缺文件
    return realVersionId;
  }

  /** 读未合并 JSON 的 inheritsFrom；读不到返回空串 */
  private async inheritsFromOf(id: string): Promise<string> {
    try {
      const raw = await this.fetchRawVersion(id);
      return typeof raw.inheritsFrom === 'string' ? raw.inheritsFrom : '';
    } catch {
      return '';
    }
  }

  /**
   * 读**未合并**的版本 JSON（保留 inheritsFrom）。
   *
   * 不用 `loadVersion`：它返回 resolveInherited 处理过的合并结果，
   * `inheritsFrom` 已被清成 undefined，拿不到链接信息。
   *
   * 优先用仓库的 `fetchVersion`（version 模块已改为「本地 versions/<id>/<id>.json 优先」），
   * 仓库不可用时直接读磁盘。
   */
  private async fetchRawVersion(id: string): Promise<VersionJson> {
    const repo = this.deps.versionRepo as VersionRepositoryLike;
    if (typeof repo.fetchVersion === 'function') {
      try {
        return await repo.fetchVersion(id);
      } catch {
        /* 落到本地磁盘读取 */
      }
    }
    const file = path.join(this.dataRoot(), 'versions', id, `${id}.json`);
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text) as VersionJson;
  }

  private async loadVersion(id: string): Promise<VersionJson> {
    const cached = this.resolvedCache.get(id);
    if (cached) return cached;

    const repo = this.deps.versionRepo as VersionRepositoryLike;
    let json: VersionJson;
    try {
      if (typeof repo.resolveVersionJson === 'function') {
        json = await repo.resolveVersionJson(id);
      } else if (typeof repo.fetchResolvedVersion === 'function') {
        json = await repo.fetchResolvedVersion(id);
      } else {
        json = await repo.fetchVersion(id);
        if (typeof json.inheritsFrom === 'string' && json.inheritsFrom.length > 0) {
          json = await this.resolveChain(json);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`读取版本 JSON 失败（${id}）：${msg}`);
    }

    if (!json || typeof json !== 'object' || typeof json.id !== 'string' || json.id.length === 0) {
      throw new Error(`版本 JSON 无效（${id}）：缺少 id 字段`);
    }
    this.resolvedCache.set(id, json);
    return json;
  }

  /** 解析 inheritsFrom 链：优先交给 versionRepo.resolveInherited，失败则本地合并 */
  private async resolveChain(json: VersionJson): Promise<VersionJson> {
    const repo = this.deps.versionRepo as VersionRepositoryLike;
    if (typeof repo.resolveInherited === 'function') {
      try {
        const merged = await repo.resolveInherited(json);
        if (merged && typeof merged === 'object' && !merged.inheritsFrom) return merged;
      } catch {
        /* 回退到本地合并 */
      }
    }
    const chain: VersionJson[] = [json];
    const seen = new Set<string>([json.id]);
    let current = json;
    while (typeof current.inheritsFrom === 'string' && current.inheritsFrom.length > 0) {
      const parentId = current.inheritsFrom;
      if (seen.has(parentId)) throw new Error(`inheritsFrom 链存在循环：${parentId}`);
      if (seen.size > 16) throw new Error('inheritsFrom 链过深');
      seen.add(parentId);
      const parent = await this.deps.versionRepo.fetchVersion(parentId);
      chain.push(parent);
      current = parent;
    }
    let merged = chain[chain.length - 1] as VersionJson;
    for (let i = chain.length - 2; i >= 0; i--) {
      merged = mergeVersionJson(merged, chain[i] as VersionJson);
    }
    merged.inheritsFrom = undefined;
    return merged;
  }

  // ── 内部：options.txt（首次启动默认中文） ──────────────────

  /**
   * 确保实例目录下有 `options.txt` 且包含 `lang:`。
   *
   * 为什么在启动前做：Minecraft 的界面语言**只认 options.txt 的 lang: 行**，
   * assets 里本来就带全部语言文件。首次启动没有该文件时，游戏按 JVM locale 猜，
   * 经常猜错落回 en_us（用户实测到的「英文界面」）。
   *
   * 安全边界（这个文件是用户资产，写坏 = 画质/键位/音量全丢）：
   *   - 「只补不改」：已有 lang: 就一个字都不写，也不留备份
   *   - 真要写之前先备份，备份失败则放弃写入（action = 'skipped-backup-failed'）
   *   - 实例隔离：路径只由 ctx.instanceDir 决定，绝不跨实例
   * 无论如何都不影响启动（配置问题不该阻止玩游戏），只打日志。
   */
  private async ensureOptionsTxt(ctx: LaunchContext): Promise<void> {
    try {
      const result = await ensureChineseOptions(ctx.instanceDir);
      if (result.action === 'created') {
        console.info(`[launch] 已生成默认 options.txt（lang:${DEFAULT_LANG}）：${result.file}`);
      } else if (result.action === 'appended-lang') {
        console.info(
          `[launch] 已为现有 options.txt 追加 lang:${DEFAULT_LANG}：${result.file}` +
            (result.backup ? `（原文件已备份到 ${path.basename(result.backup)}）` : ''),
        );
      } else if (result.action === 'skipped-backup-failed') {
        // 备份失败 → 明确告知用户「我们没敢动你的配置」，而不是静默
        console.warn(`[launch] ${result.skippedReason ?? '备份失败，已跳过修改 options.txt'}`);
      }
      // action === 'unchanged' 静默（用户已有语言设置，尊重之）
    } catch (err) {
      console.warn(`[launch] 生成 options.txt 失败（不影响启动）：${(err as Error).message}`);
    }
  }

  // ── 内部：natives ───────────────────────────────────────────

  /** 解压 native 库，返回传给 -Djava.library.path 的目录（保证已存在） */
  private async prepareNatives(ctx: LaunchContext): Promise<string> {
    const nativesDir = ctx.nativesRoot;
    const nativeLibs = (ctx.version.libraries ?? []).filter(
      (lib) => libraryAllowed(lib, ctx.platform, ctx.features) && nativeClassifier(lib, ctx.platform),
    );
    await fsp.mkdir(nativesDir, { recursive: true });
    if (nativeLibs.length === 0) return nativesDir;

    const jobs = collectNativeJobs(nativeLibs, ctx.platform, ctx.librariesRoot, nativesDir);
    // 解压失败不应阻止拼命令：这里吞掉异常，让用户至少能看到命令与 java.library.path
    try {
      await extractNatives(jobs);
    } catch {
      /* 目录已创建，jar 缺失或损坏留给安装流程处理 */
    }
    return nativesDir;
  }

  // ── 内部：JVM 参数 ──────────────────────────────────────────

  /**
   * JVM 参数模板（含 -cp ${classpath}）。
   *   1. 以元数据 `arguments.jvm` 为骨架（按 rules 过滤）
   *   2. 缺 -Xmx/-Xmn 时补 -Xmx<memoryMB>M / -Xmn<memoryMB/4>M
   *   3. 缺 -Dfile.encoding=UTF-8 时补上
   *   4. 缺 -Djava.library.path 时补上
   *   5. 缺 -cp 时在末尾补 `-cp ${classpath}`
   *   6. extraJvmArgs 追加在 -cp 之前
   * 老版本（无 arguments.jvm）直接走默认集。
   */
  private jvmArgumentTemplates(
    version: VersionJson,
    opts: LaunchOptions,
    platform: Platform,
    features: Readonly<Record<string, boolean>>,
  ): string[] {
    const memoryMB = normalizeMemory(opts.memoryMB);
    const youngMB = Math.max(1, Math.floor(memoryMB / 4));
    const explicitMemory = isExplicitMemory(opts);
    const extra = (opts.extraJvmArgs ?? []).filter((a): a is string => typeof a === 'string' && a.length > 0);

    const declared = this.declaredJvmArgs(version, platform, features);

    if (declared.length === 0) {
      return [
        `-Xmx${memoryMB}M`,
        `-Xmn${youngMB}M`,
        '-Dfile.encoding=UTF-8',
        '-Dstdout.encoding=UTF-8',
        '-Dstderr.encoding=UTF-8',
        '-Djava.library.path=${natives_directory}',
        ...extra,
        '-cp',
        '${classpath}',
      ];
    }

    let hasXmx = false;
    let hasXmn = false;
    let hasEncoding = false;
    let hasLibraryPath = false;
    let hasClasspath = false;
    const kept: string[] = [];

    for (const t of declared) {
      // 内存：只有调用方显式给了 memoryMB 才覆盖元数据里的取值
      if (t.startsWith('-Xmx')) {
        hasXmx = true;
        if (explicitMemory) kept.push(`-Xmx${memoryMB}M`);
        else kept.push(t);
        continue;
      }
      if (t.startsWith('-Xmn')) {
        hasXmn = true;
        if (explicitMemory) kept.push(`-Xmn${youngMB}M`);
        else kept.push(t);
        continue;
      }
      if (t === '-Dfile.encoding=UTF-8') hasEncoding = true;
      if (t.startsWith('-Djava.library.path')) hasLibraryPath = true;
      if (t === '-cp' || t === '-classpath' || t.startsWith('-cp=') || t.startsWith('-classpath=')) {
        hasClasspath = true;
      }
      kept.push(t);
    }

    const prefixFixes: string[] = [];
    if (!hasXmx) prefixFixes.push(`-Xmx${memoryMB}M`);
    if (!hasXmn) prefixFixes.push(`-Xmn${youngMB}M`);
    if (!hasEncoding) {
      prefixFixes.push('-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8');
    }

    const body = normalizeTrailingArgs(kept, extra);
    const tail: string[] = [];
    if (!hasLibraryPath) tail.push('-Djava.library.path=${natives_directory}');
    if (!hasClasspath) tail.push('-cp', '${classpath}');

    return [...prefixFixes, ...body, ...tail];
  }

  private declaredJvmArgs(
    version: VersionJson,
    platform: Platform,
    features: Readonly<Record<string, boolean>>,
  ): string[] {
    const jvm = version.arguments?.jvm;
    if (!jvm || jvm.length === 0) return [];
    return evaluateArguments(jvm as (string | ConditionalArg)[], platform, features);
  }

  // ── 内部：game 参数 ─────────────────────────────────────────

  /** 新版走 arguments.game；缺省则按老版 minecraftArguments 空格切分 */
  private gameArgumentTemplates(
    version: VersionJson,
    platform: Platform,
    features: Readonly<Record<string, boolean>>,
    opts: LaunchOptions,
  ): string[] {
    const game = version.arguments?.game;
    const base =
      game && game.length > 0
        ? evaluateArguments(game as (string | ConditionalArg)[], platform, features)
        : splitLegacyArguments(version.minecraftArguments);
    const extra = (opts.extraGameArgs ?? []).filter((a): a is string => typeof a === 'string' && a.length > 0);
    return [...base, ...extra];
  }

  // ── 内部：logging ──────────────────────────────────────────

  private loggingArgs(version: VersionJson, ctx: LaunchContext, placeholders: PlaceholderMap): string[] {
    const logging = version.logging as
      | { client?: { argument?: string; file?: { id?: string } } }
      | undefined;
    const client = logging?.client;
    if (!client || typeof client.argument !== 'string') return [];
    const id = client.file?.id;
    if (!id) return [];
    const filePath = path.join(ctx.assetsRoot, 'log_configs', id);
    if (!isFile(filePath)) return []; // 配置还没下载，别让 JVM 因找不到文件报错退出
    return [substitute(client.argument, { ...placeholders, path: filePath })];
  }

  // ── 内部：argfile ──────────────────────────────────────────

  private async rewriteToArgfile(
    ctx: LaunchContext,
    jvmArgs: string[],
    entries: readonly string[],
    separator: string,
  ): Promise<string[]> {
    const dir = path.join(ctx.instanceDir, 'logs');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'classpath-args.txt');
    const quoted = entries.map((e) => `"${e.replace(/\\/g, '\\\\')}"`).join(separator);
    await fsp.writeFile(file, `${quoted}\n`, 'utf8');
    return jvmArgs.map((a) =>
      a === '${classpath}' ? `@${file}` : a.includes('${classpath}') ? a.replace('${classpath}', `@${file}`) : a,
    );
  }

  // ── 内部：java ─────────────────────────────────────────────

  private async pickJava(
    opts: LaunchOptions,
    version: VersionJson,
    ctx: LaunchContext,
    _nativesDir: string,
  ): Promise<string> {
    // 1) 显式指定
    const raw = opts.javaPath?.trim();
    if (raw && raw.length > 0) {
      const p = path.resolve(raw);
      if (isFile(p)) return p;
      if (isJavaHome(p)) return javaExecutable(p);
      throw new Error(
        `指定的 javaPath 不可用：${raw}\n请指向 java/javaw 可执行文件，或指向 java home（含 bin/java 的目录）。`,
      );
    }

    const requirement = javaRequirement(version);

    // 2) 数据目录下已有的 JRE（按 javaVersion.majorVersion 匹配）—— 命中则零网络
    const first = findJavaInDataRoot(ctx.dataRoot, requirement)[0];
    if (first) return javaExecutable(first.javaHome);

    // 3) 本地没有 → 自动下载（Java 21 等）。下载失败会抛出人话错误，不静默用错版本。
    //    provisioner 缺省为 null 时退回原来的「明确报错」行为。
    const provisioner = this.deps.javaProvisioner === undefined
      ? new JavaAutoProvisioner({ dataRoot: ctx.dataRoot })
      : this.deps.javaProvisioner;
    if (provisioner === null || provisioner === undefined) {
      throw new Error(noJavaMessage(requirement, ctx.dataRoot, []));
    }
    const downloaded = await provisioner.ensureJava(requirement, ctx.dataRoot, null);
    if (downloaded) return downloaded;

    // 4) 兜底：绝不用一个错误版本的 java 去启动
    throw new Error(noJavaMessage(requirement, ctx.dataRoot, []));
  }
}

// ───────────────────────────── 辅助函数 ─────────────────────────────

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 把默认 locale 参数插到 `-cp` **之前**。
 *
 * 为什么不能简单 append：JVM 读到 `-cp <value>` 就认为选项区结束，
 * 之后再出现的 `-Dxxx` 会被当成主类名 → `Could not find or load main class -Duser.language=zh`。
 *
 * 找不到 `-cp` / `-classpath` 时（理论上不会发生，jvmArgumentTemplates 保证有）
 * 就追加到末尾。
 */
function insertLocaleBeforeClasspath(args: readonly string[]): string[] {
  const withLocale = withDefaultLocale(args);
  // withDefaultLocale 只会在尾部 append，这里把新加的项挪到 -cp 前面
  const added = withLocale.length - args.length;
  if (added <= 0) return withLocale;

  const localeArgs = withLocale.slice(withLocale.length - added);
  const base = withLocale.slice(0, withLocale.length - added);

  const cpAt = base.findIndex(
    (a) => a === '-cp' || a === '-classpath' || a.startsWith('-cp=') || a.startsWith('-classpath='),
  );
  if (cpAt < 0) return [...base, ...localeArgs];
  return [...base.slice(0, cpAt), ...localeArgs, ...base.slice(cpAt)];
}

/**
 * 规范化 JVM 参数尾部：把 `-cp`/`-classpath`（及其值）从原位置摘掉，压到最末尾，
 * 让 `-cp` 永远紧邻 mainClass 之前。否则 `-cp ${classpath}` 之后再出现别的 JVM 参数，
 * JVM 会把那些参数当成「类名」去解析，直接启动失败。
 */
function normalizeTrailingArgs(kept: readonly string[], extra: readonly string[]): string[] {
  const out: string[] = [];
  const classpathPairs: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i] as string;
    if (t === '-cp' || t === '-classpath') {
      const value = kept[i + 1];
      if (value !== undefined) {
        classpathPairs.push(t, value);
        i++;
      }
      continue;
    }
    if (t.startsWith('-cp=') || t.startsWith('-classpath=')) {
      classpathPairs.push(t);
      continue;
    }
    out.push(t);
  }
  out.push(...extra);
  // 额外参数若自带 -cp 也一并摘出来，保证只有一个 classpath 声明且在最末
  const filtered: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const t = out[i] as string;
    if (t === '-cp' || t === '-classpath') {
      const value = out[i + 1];
      if (value !== undefined) {
        classpathPairs.push(t, value);
        i++;
      }
      continue;
    }
    filtered.push(t);
  }
  return [...filtered, ...classpathPairs];
}

function normalizeMemory(memoryMB: number | undefined): number {
  if (typeof memoryMB !== 'number' || !Number.isFinite(memoryMB) || memoryMB <= 0) return DEFAULT_MEMORY_MB;
  return Math.floor(memoryMB);
}

function isExplicitMemory(opts: LaunchOptions): boolean {
  return typeof opts.memoryMB === 'number' && Number.isFinite(opts.memoryMB) && opts.memoryMB > 0;
}

function accountUserType(account: Account): string {
  return account.type === 'microsoft' ? USER_TYPE.microsoft : USER_TYPE.offline;
}

function javaRequirement(version: VersionJson): JavaRequirement {
  const major = version.javaVersion?.majorVersion;
  const req: JavaRequirement = { majorVersion: typeof major === 'number' && major > 0 ? major : 8 };
  const component = version.javaVersion?.component;
  if (typeof component === 'string' && component.length > 0) req.component = component;
  return req;
}

function mainClassOf(version: VersionJson): string {
  const mainClass = typeof version.mainClass === 'string' ? version.mainClass.trim() : '';
  if (!mainClass) throw new Error(`版本 ${version.id} 的元数据缺少 mainClass，无法启动`);
  return mainClass;
}

/** spawn 的错误可能早于事件触发，用 Promise 包一层，避免返回一个已经死掉的进程 */
function waitForSpawn(child: ChildProcess): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`启动进程超时（${SPAWN_TIMEOUT_MS}ms 内没有 spawn 事件）`)));
    }, SPAWN_TIMEOUT_MS);
    const onSpawn = (): void => finish(() => resolve(child));
    const onError = (err: Error): void => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(() =>
        reject(
          new Error(
            code === 'EINVAL'
              ? `无法执行启动命令（EINVAL，通常是命令行过长或路径含非法字符）：${err.message}`
              : `启动进程失败（${code ?? 'unknown'}）：${err.message}`,
          ),
        ),
      );
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** 调试用：某本书库在磁盘上的相对路径 */
export function libraryJarRelativePath(lib: Library): string | null {
  for (const osName of Object.keys(lib.natives ?? {})) {
    const classifier = (lib.natives?.[osName] ?? '').replace('${arch}', '64');
    const dl = lib.downloads?.classifiers?.[classifier];
    if (dl?.path) return dl.path;
  }
  if (lib.downloads?.artifact?.path) return lib.downloads.artifact.path;
  return null;
}

export type { Account, BuiltCommand, LaunchOptions } from '../types.js';
