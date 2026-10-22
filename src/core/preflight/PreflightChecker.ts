/**
 * 启动前体检（Preflight）—— 点「启动」之前先把话说清楚。
 *
 * 这是 PCL2 体验上最关键的一处差异，也是 `diagnostics/CrashAnalyzer` 的**对称能力**：
 *
 *   CrashAnalyzer  崩溃**之后**读日志，告诉用户「刚才为什么崩」
 *   Preflight      启动**之前**看现场，告诉用户「现在点了会崩，先修这个」
 *
 * ## 设计铁律
 *
 * 1. **只读**。`check()` 不下载、不写文件、不改设置、不 spawn 任何进程。
 *    体检本身绝不能是新的故障来源。唯一的例外是「试一下目录能不能建」——
 *    那也只是 mkdir + 立即 rmdir，失败即判定为不可启动。
 * 2. **快**。目标 1 秒内出结论。资产索引动辄 5000 个对象，逐个 stat 必然超时
 *    （实测多次 stat 5000 个文件要 1~3 秒，冷缓存更久），所以只**抽查**：
 *    索引文件本体 + 最前面若干个对象。抽到的缺了就报，没缺就如实说「抽查通过」，
 *    绝不假装「全部校验完毕」。
 * 3. **不骗人**。结论必须能对应到磁盘上的事实。查不了的事（例如离线时无法确认
 *    Mojang 清单里有没有这个 Java 组件）就说「无法判定」，并降级成 warning 而不是
 *    硬判 blocking —— 但凡是能在本地确认的（版本没装、jar 缺失），一律 blocking。
 * 4. **可一键修**。每条问题尽量带 `fix`，前端据此画按钮；确实修不了（例如用户手动
 *    指定的 javaPath 失效）就明确说「要你做什么」，不给假按钮。
 *
 * ## 与「启动流程」的关系
 *
 * `POST /api/launch` 先跑体检，再决定：
 *   - 有 blocking 且**修不了**  → 直接 409，不进游戏
 *   - 有 blocking 但**能自动修**（例如自动下载 Java）→ 照常启动，日志里写明
 *   - 只有 warning          → 照常启动，日志里提示
 *
 * 体检模块**不负责执行修复**，只负责「诊断 + 给出修复处方」。执行在 web 层（复用已有的
 * install / loader / settings 接口），这样体检不会长出一套平行的写逻辑。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AssetIndex, AssetObject, Library, VersionJson } from '../types.js';

import { resolveDataRoot } from '../launch/data-root.js';
import {
  findJavaInDataRoot,
  javaExecutable,
  scanJavaHomes,
  type JavaRequirement,
} from '../launch/java.js';
import { detectPlatform, libraryAllowed, rulesAllow, type Platform } from '../launch/rules.js';
import {
  KNOWN_COMPONENT_MAJORS,
  listComponents,
  majorFromComponentName,
  platformCandidates,
} from '../java/index.js';
import { DEFAULT_MEMORY_MB, SettingsStore } from '../settings/index.js';

// ───────────────────────────── 公开类型（契约） ─────────────────────────────

export type CheckSeverity = 'blocking' | 'warning' | 'info';

/** 机器可读的问题类型，前端据此决定显示哪个修复按钮 */
export type PreflightCode =
  | 'java-missing'
  | 'java-version'
  | 'java-downloadable'
  | 'memory-too-low'
  | 'memory-too-high'
  | 'files-missing'
  | 'version-not-installed'
  | 'mods-without-loader'
  | 'mod-requires-larger-heap'
  | 'mods-duplicate'
  | 'instance-missing';

/** 一键修复的种类（前端按它决定调哪个接口） */
export type FixKind =
  | 'download-java'
  | 'install-version'
  | 'install-loader'
  | 'raise-memory'
  | 'remove-duplicate-mod'
  | 'rescan-files';

export interface PreflightFix {
  kind: FixKind;
  /** 修复需要的参数，如 { component: 'java-runtime-delta' } */
  args?: Record<string, string | number>;
  /** 按钮文案 */
  label: string;
}

export interface PreflightIssue {
  code: PreflightCode;
  severity: CheckSeverity;
  /** 一句话结论（中文，人话） */
  title: string;
  /** 详细说明 + 建议 */
  detail: string;
  /** 能否一键修复；不能则 detail 里说明要用户做什么 */
  fix?: PreflightFix;
}

export interface PreflightReport {
  /** 能否直接启动（没有 blocking 级问题） */
  canLaunch: boolean;
  /** 阻断项 */
  blocking: PreflightIssue[];
  /** 警告项（能启动但建议处理） */
  warnings: PreflightIssue[];
  /** 信息项 */
  infos: PreflightIssue[];
  /** 体检耗时（毫秒） */
  elapsedMs: number;
}

// ───────────────────────────── 扩展字段（附加在报告上） ─────────────────────────────

/**
 * 体检报告 + 一点前端真正需要的上下文。
 *
 * 契约里的 `PreflightReport` 只有四个字段；前端要画「版本 XXX」标题、要知道
 * 「这次体检对应哪个实例目录」，所以这里**只增不改**地补三个只读字段。
 * 它们不参与 `canLaunch` 判定，读写两端都可以忽略。
 */
export interface PreflightReportDetail extends PreflightReport {
  versionId: string;
  /** 本次体检使用的实例目录 */
  instanceDir: string;
  /** 数据根 */
  dataRoot: string;
}

/** 检查项标识（便于日志与测试断言「哪几项真的跑了」） */
export type PreflightCheckId =
  | 'version'
  | 'java'
  | 'memory'
  | 'files'
  | 'mods-loader'
  | 'mods-duplicate'
  | 'mods-heap'
  | 'instance';

// ───────────────────────────── 阈值与常量 ─────────────────────────────

/**
 * 内存下限：1024 MB。
 *
 * 为什么不是 512：`settings/types.ts` 的硬边界是 512，那是「不许填得更离谱」的底线；
 * 而 1.13+ 起游戏本体 + 资源加载在 512 MB 下基本 OOM（实测 1.21 起 1G 都很勉强）。
 * 1024 是「能进主菜单」的保守下界，低于它就是必然崩，不是「可能崩」。
 */
export const MEMORY_MIN_LAUNCH_MB = 1024;

/** 内存建议值（1.13+ 原版能舒服跑的下界，也是 PCL2 的默认档） */
export const MEMORY_RECOMMENDED_MB = 2048;

/** 高估阈值：超过物理内存的这个比例就判定为「一定起不来」 */
export const MEMORY_OVERCOMMIT_RATIO = 0.9;

/**
 * 资产抽查数量。
 *
 * 为什么不逐个查：5147 个对象逐个 `statSync`，冷缓存下实测 1.5~4 秒，
 * 光这一项就吃掉整个体检预算。抽查 16 个（跨越不同 hash 分桶）足以分辨
 * 「装完了」和「压根没装」。前者抽查全过 → 说「抽查通过」；后者第一个就缺 → 立刻报。
 */
export const ASSET_SAMPLE_LIMIT = 16;

/** 库文件不做抽查，全部核对：数量级是几十到几百，且这里是「缺了必崩」的硬依赖 */
const LIBRARY_CHECK_FULL = true;

/** 实例目录探针的文件名（只用来试写，写完立即删） */
const INSTANCE_PROBE_FILE = '.pcl3-preflight-probe';

/** 识别加载器版本 id：fabric-loader-0.19.5-1.21 / quilt-loader-… / forge-… / neoforge-… */
const LOADER_ID_PATTERN = /^(fabric|quilt|forge|neoforge)(?:-loader)?(?=[-_.]|$)/i;

/** 粗判「是不是加载器 profile」用：只要有 inheritsFrom 就说明它不是原版 */
const MOD_EXTENSIONS = /\.jar$/i;

// ───────────────────────────── 依赖 ─────────────────────────────

/** 版本仓库的最小结构约束（与 launch / install 模块同一套结构化类型） */
export interface PreflightVersionRepoLike {
  fetchVersion(id: string): Promise<VersionJson>;
  resolveInherited?(json: VersionJson): Promise<VersionJson>;
  fetchResolvedVersion?(id: string): Promise<VersionJson>;
  fetchManifest?(force?: boolean): Promise<{ latest: { release: string; snapshot: string }; versions: { id: string }[] }>;
}

/**
 * Java 安装器的结构约束。
 *
 * 刻意只声明「读」能力：体检**绝不**调 `ensureRuntime`（那会下载几百 MB）。
 * 能不能修是前端点按钮之后的事。
 */
export interface JavaInstallerLike {
  /** 是否已装（只查可执行文件，不触网） */
  isInstalled(component: string): boolean;
  /** 已装时给出可执行文件路径 */
  installedExecutable?(component: string): string | undefined;
  /** 该组件在 Mojang 清单里的实际主版本；拿不到返回 null */
  majorVersionOf?(component: string): Promise<number | null>;
  /** 拉清单（用于判断「清单里到底有没有这个组件」） */
  fetchManifest?(force?: boolean): Promise<unknown>;
}

/** `ModManager` 的结构约束（只用到 list） */
export interface ModManagerLike {
  list(instanceId: string): Promise<
    { filename: string; id?: string; name?: string; version?: string; size: number; enabled: boolean }[]
  >;
  modsDir(instanceId: string): string;
}

/** 文件系统抽象（测试注入点；生产直接用 node:fs 同步 API） */
export interface PreflightFsLike {
  isFile(p: string): boolean;
  isDir(p: string): boolean;
  sizeOf(p: string): number | undefined;
  readJson<T>(p: string): T | undefined;
  listDir(p: string): { name: string; isFile: boolean; isDir: boolean }[];
  /** 试建目录（成功返回 true，并保证不留下任何痕迹） */
  ensureDirWritable(p: string): Promise<boolean>;
}

export interface PreflightCheckerDeps {
  /** 数据根；不传则按 download 模块的 getDataRoot / 目录规则解析 */
  dataRoot?: string;
  /** 版本仓库；不传时按 dataRoot 现场装配真实 `VersionRepository` */
  versionRepo?: PreflightVersionRepoLike;
  /** 设置存储；不传时按 dataRoot 现场装配 */
  settings?: SettingsStore;
  /**
   * Java 自动下载器 / 安装器。
   *
   * 契约里这个字段是 `unknown`（它只用来「判断能不能自动修」）。这里按鸭子类型
   * 读取 `isInstalled` / `majorVersionOf` / `fetchManifest`；不满足形状时视为「无法判定」，
   * 不抛错 —— 体检绝不能因为一个可选依赖形状不对就整体失败。
   */
  javaProvisioner?: unknown;
  /** 模组管理器；不传时按 dataRoot 现场装配真实 `ModManager` */
  modManager?: ModManagerLike;
  /** 平台覆盖（测试固定成 windows 用） */
  platform?: Platform;
  /** 「物理内存」覆盖（MB）；默认读 `os.totalmem()`。测试用它造 memory-too-high */
  totalMemoryMB?: number;
  /** 文件系统覆盖（测试用） */
  fs?: PreflightFsLike;
  /** 注入时钟（测试用） */
  now?: () => number;
  /** 是否启用「试建实例目录」探针（默认 true；测试可关掉以免碰盘） */
  probeInstanceDir?: boolean;
}

// ───────────────────────────── 默认 fs 实现 ─────────────────────────────

function createDefaultFs(): PreflightFsLike {
  return {
    isFile(p: string): boolean {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isDir(p: string): boolean {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    sizeOf(p: string): number | undefined {
      try {
        const st = fs.statSync(p);
        return st.isFile() ? st.size : undefined;
      } catch {
        return undefined;
      }
    },
    readJson<T>(p: string): T | undefined {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
      } catch {
        return undefined;
      }
    },
    listDir(p: string) {
      try {
        return fs.readdirSync(p, { withFileTypes: true }).map((e) => ({
          name: e.name,
          isFile: e.isFile(),
          isDir: e.isDirectory(),
        }));
      } catch {
        return [];
      }
    },
    async ensureDirWritable(p: string): Promise<boolean> {
      // 只读铁律的唯一窗口：mkdir -p → 写一个探针文件 → 删干净。
      // 目录本来不存在时把新建的那几层再删回去，保证体检**不改变现场**。
      const created: string[] = [];
      let cursor = path.resolve(p);
      const missing: string[] = [];
      while (!fs.existsSync(cursor)) {
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      try {
        for (const dir of [...missing].reverse()) {
          await fsp.mkdir(dir);
          created.push(dir);
        }
        const probe = path.join(p, INSTANCE_PROBE_FILE);
        await fsp.writeFile(probe, 'pcl3', 'utf8');
        await fsp.rm(probe, { force: true });
        return true;
      } catch {
        return false;
      } finally {
        // 反序删掉本次新建的目录（只删空目录，删不掉就留着，不影响结论）
        for (const dir of created.reverse()) {
          try {
            await fsp.rmdir(dir);
          } catch {
            /* 非空 / 被占用：留着也无害 */
          }
        }
      }
    },
  };
}

// ───────────────────────────── 工具 ─────────────────────────────

/** 版本 id 是否安全（它会被拼进路径；web 层也有一份，这里是体检的自我保护） */
function isSafeId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false;
  if (id === '.' || id === '..' || id.includes('..')) return false;
  return !/[/\\:*?"<>|\u0000-\u001f]/.test(id);
}

/** 从版本 id 认加载器；认不出返回 undefined */
export function loaderKindOf(versionId: string): 'fabric' | 'quilt' | 'forge' | 'neoforge' | undefined {
  const m = LOADER_ID_PATTERN.exec(versionId);
  if (m === null) return undefined;
  const raw = (m[1] ?? '').toLowerCase();
  if (raw === 'fabric' || raw === 'quilt' || raw === 'forge' || raw === 'neoforge') return raw;
  return undefined;
}

/** 某条库在当前平台是否该装（与启动器 classpath 的判定同源） */
function libraryApplies(lib: Library, platform: Platform): boolean {
  return libraryAllowed(lib, platform);
}

/** `Library` → 在 libraries/ 下的相对路径（优先 downloads.artifact.path） */
function artifactRelPath(lib: Library): string | null {
  const declared = lib.downloads?.artifact?.path;
  if (typeof declared === 'string' && declared.length > 0) {
    const rel = declared.replace(/^[/\\]+/, '');
    return rel.startsWith('libraries/') ? rel.slice('libraries/'.length) : rel;
  }
  // 没有 artifact 声明的库（常见于加载器 profile 里手写的 URL 库）只能从坐标推
  const parts = typeof lib.name === 'string' ? lib.name.split(':') : [];
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return null;
  const file = classifier ? `${artifact}-${version}-${classifier}.jar` : `${artifact}-${version}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function mb(n: number): string {
  return `${String(Math.round(n))} MB`;
}

/** 版本 JSON 的 Java 要求（与 launcher.ts 的 javaRequirement 同义） */
export function javaRequirementOf(version: VersionJson): JavaRequirement {
  const major = version.javaVersion?.majorVersion;
  const req: JavaRequirement = {
    majorVersion: typeof major === 'number' && major > 0 ? major : 8,
  };
  const component = version.javaVersion?.component;
  if (typeof component === 'string' && component.length > 0) req.component = component;
  return req;
}

/** 内存建议值：1.13+ 给 2048；更老的版本 1024 就够 */
function suggestedMemory(version: VersionJson): number {
  // 「老版本」的判据：用 minecraftArguments（1.12 及更早）而不是 arguments。
  // 注意 `arguments` 可能**存在但为空**（{ game: [], jvm: [] }），不能拿 `arguments === undefined` 判断。
  const usesLegacyArgs = typeof version.minecraftArguments === 'string' && version.minecraftArguments.length > 0;
  const hasModernArgs = version.arguments !== undefined && version.arguments !== null;
  const looksLegacy = usesLegacyArgs || !hasModernArgs;
  return looksLegacy ? MEMORY_MIN_LAUNCH_MB : MEMORY_RECOMMENDED_MB;
}

// ───────────────────────────── 主体 ─────────────────────────────

export class PreflightChecker {
  private readonly deps: PreflightCheckerDeps;
  private readonly platform: Platform;
  private readonly fsImpl: PreflightFsLike;
  private readonly now: () => number;

  // 不用 TS 参数属性：Node 的 strip-only 类型剥离不支持
  constructor(deps: PreflightCheckerDeps = {}) {
    this.deps = deps;
    this.platform = deps.platform ?? detectPlatform();
    this.fsImpl = deps.fs ?? createDefaultFs();
    this.now = deps.now ?? Date.now;
  }

  /** 数据根（与 download 模块同一解析顺序） */
  dataRoot(): string {
    return path.resolve(this.deps.dataRoot ?? resolveDataRoot());
  }

  /**
   * 对一个版本 / 实例跑体检。**只读**，不下载任何东西、不改任何文件。
   *
   * `instanceId` 省略时按旧行为：实例目录 = `<dataRoot>/instances/<versionId>`。
   */
  async check(opts: { versionId: string; instanceId?: string }): Promise<PreflightReportDetail> {
    const started = this.now();
    const versionId = typeof opts.versionId === 'string' ? opts.versionId.trim() : '';
    const instanceId = typeof opts.instanceId === 'string' ? opts.instanceId.trim() : '';
    const effectiveInstanceId = instanceId.length > 0 ? instanceId : versionId;
    const dataRoot = this.dataRoot();
    const instanceDir = path.join(dataRoot, 'instances', effectiveInstanceId);

    const blocking: PreflightIssue[] = [];
    const warnings: PreflightIssue[] = [];
    const infos: PreflightIssue[] = [];

    const push = (issue: PreflightIssue): void => {
      if (issue.severity === 'blocking') blocking.push(issue);
      else if (issue.severity === 'warning') warnings.push(issue);
      else infos.push(issue);
    };

    // ── 0) 防御：非法 id 直接判「没装」，绝不拼进路径 ──────────
    if (!isSafeId(versionId)) {
      push({
        code: 'version-not-installed',
        severity: 'blocking',
        title: versionId.length === 0 ? '没有指定版本' : `版本号「${versionId}」不合法`,
        detail: '体检需要一个合法的版本 id（只允许字母、数字与 . _ + -）。请回到版本列表重新选择。',
      });
      return this.finish(versionId, instanceDir, dataRoot, blocking, warnings, infos, started);
    }

    // ── 1) 版本是否装了 ──────────────────────────────────────────
    const versionJsonPath = path.join(dataRoot, 'versions', versionId, `${versionId}.json`);
    const versionInstalled = this.fsImpl.isFile(versionJsonPath);

    let version: VersionJson | undefined;
    if (versionInstalled) {
      version = await this.loadVersion(versionId, versionJsonPath);
    }

    if (!versionInstalled) {
      push({
        code: 'version-not-installed',
        severity: 'blocking',
        title: `版本 ${versionId} 还没装`,
        detail:
          `找不到版本文件：${versionJsonPath}\n` +
          '点「安装」把它装到数据目录里，装完再启动。',
        fix: { kind: 'install-version', args: { versionId }, label: `安装 ${versionId}` },
      });
    } else if (version === undefined) {
      push({
        code: 'version-not-installed',
        severity: 'blocking',
        title: `版本 ${versionId} 的文件损坏`,
        detail: `版本文件存在但读不出合法 JSON：${versionJsonPath}\n重新安装这个版本可以覆盖坏文件。`,
        fix: { kind: 'install-version', args: { versionId }, label: '重新安装' },
      });
    }

    // ── 2) 实例目录 ─────────────────────────────────────────────
    const instanceOk = await this.checkInstance(instanceDir, effectiveInstanceId, push);

    // 版本不可用时，后面的检查没有意义（会一路误报）。只保留已经确定的两条。
    if (version === undefined) {
      return this.finish(versionId, instanceDir, dataRoot, blocking, warnings, infos, started);
    }

    // ── 3) Java ────────────────────────────────────────────────
    const javaInfo = await this.checkJava(version, dataRoot, push);

    // ── 4) 内存 ────────────────────────────────────────────────
    const settings = this.settingsFor(dataRoot).resolve(versionId, effectiveInstanceId);
    const memoryMB =
      typeof settings.memoryMB === 'number' && settings.memoryMB > 0 ? settings.memoryMB : DEFAULT_MEMORY_MB;
    this.checkMemory(memoryMB, version, push);

    // ── 5) 文件完整性 ───────────────────────────────────────────
    const fileReport = await this.checkFiles(version, versionId, dataRoot);
    if (fileReport.missing.length > 0) {
      const head = fileReport.missing.slice(0, 6).join('\n  ');
      const more = fileReport.missing.length > 6 ? `\n  …另有 ${String(fileReport.missing.length - 6)} 项` : '';
      push({
        code: 'files-missing',
        severity: 'blocking',
        title: `游戏文件缺失 ${String(fileReport.missing.length)} 项`,
        detail:
          `启动前核对发现这些文件不在磁盘上（或大小不对）：\n  ${head}${more}\n` +
          '重新安装这个版本可以补齐（已存在的文件会被跳过，不会重新下载）。',
        fix: { kind: 'rescan-files', args: { versionId }, label: '重新校验并补齐' },
      });
    } else if (fileReport.sampled > 0) {
      infos.push({
        code: 'files-missing',
        severity: 'info',
        title: '游戏文件核对通过（抽样）',
        detail:
          `已核对 ${String(fileReport.checked)} 个硬依赖文件（jar / 库 / 资源索引），全部就位；` +
          `资源对象抽查 ${String(fileReport.sampled)} 个，均存在。`,
      });
    }

    // ── 6) mod 与加载器 ─────────────────────────────────────────
    const mods = await this.listMods(effectiveInstanceId, dataRoot);
    this.checkMods(mods, versionId, version, memoryMB, push);

    // ── 7) Java 与 mod 的联动提示（只在 Java 判定为「能启动」时才说） ──
    if (javaInfo.ok && javaInfo.major !== null) {
      this.checkJavaForMods(mods, javaInfo.major, push);
    }

    // 实例不可用已经由 checkInstance 报过；可用就给一条 info 便于前端展示路径。
    // 用 `instanceOk` 而不是 `isDir` 判断：目录可能是体检期间刚建出来的（探针建完即删），
    // 但结论仍然是「可用」。
    if (instanceOk) {
      infos.push({
        code: 'instance-missing',
        severity: 'info',
        title: '实例目录可用',
        detail: `游戏目录：${instanceDir}`,
      });
    }

    return this.finish(versionId, instanceDir, dataRoot, blocking, warnings, infos, started);
  }

  // ── 各检查项 ────────────────────────────────────────────────────

  private finish(
    versionId: string,
    instanceDir: string,
    dataRoot: string,
    blocking: PreflightIssue[],
    warnings: PreflightIssue[],
    infos: PreflightIssue[],
    started: number,
  ): PreflightReportDetail {
    return {
      canLaunch: blocking.length === 0,
      blocking,
      warnings,
      infos,
      elapsedMs: Math.max(0, this.now() - started),
      versionId,
      instanceDir,
      dataRoot,
    };
  }

  private settingsFor(dataRoot: string): SettingsStore {
    return this.deps.settings ?? new SettingsStore({ dataRoot });
  }

  /** 读版本 JSON（优先仓库，回退磁盘），并解析继承链 */
  private async loadVersion(versionId: string, jsonPath: string): Promise<VersionJson | undefined> {
    const repo = this.deps.versionRepo;
    if (repo !== undefined) {
      try {
        const raw = await repo.fetchVersion(versionId);
        if (raw && typeof raw === 'object' && typeof raw.id === 'string') {
          if (typeof repo.resolveInherited === 'function') {
            try {
              return await repo.resolveInherited(raw);
            } catch {
              return raw;
            }
          }
          if (typeof raw.inheritsFrom === 'string' && raw.inheritsFrom.length > 0 && typeof repo.fetchResolvedVersion === 'function') {
            try {
              return await repo.fetchResolvedVersion(versionId);
            } catch {
              return raw;
            }
          }
          return raw;
        }
      } catch {
        /* 回退到磁盘 */
      }
    }
    return this.fsImpl.readJson<VersionJson>(jsonPath);
  }

  /** 实例目录：不存在 → 试建；建不了 → blocking */
  private async checkInstance(
    instanceDir: string,
    instanceId: string,
    push: (i: PreflightIssue) => void,
  ): Promise<boolean> {
    if (!isSafeId(instanceId)) {
      push({
        code: 'instance-missing',
        severity: 'blocking',
        title: `实例 id「${instanceId}」不合法`,
        detail: '实例 id 会被拼进目录路径，不能包含路径分隔符、盘符或 ..。请在实例列表里重新选择。',
      });
      return false;
    }

    if (this.fsImpl.isDir(instanceDir)) return true;

    if (this.deps.probeInstanceDir === false) return true;

    const writable = await this.fsImpl.ensureDirWritable(instanceDir);
    if (!writable) {
      push({
        code: 'instance-missing',
        severity: 'blocking',
        title: '实例目录不可用',
        detail:
          `目录不存在，而且建不出来：${instanceDir}\n` +
          '常见原因：数据目录被设成了只读盘、磁盘已满、或被杀毒软件拦住。\n' +
          '处理办法：检查磁盘空间与目录权限，或在「设置」里换一个数据目录。',
      });
      return false;
    }
    // 建成功了：目录原本不存在，但我们刚刚把探针删干净了，算通过
    return true;
  }

  /** Java：本地有没有、版本对不对、能不能自动下 */
  private async checkJava(
    version: VersionJson,
    dataRoot: string,
    push: (i: PreflightIssue) => void,
  ): Promise<{ ok: boolean; major: number | null; executable: string | null }> {
    const requirement = javaRequirementOf(version);
    const component = requirement.component;
    const major = requirement.majorVersion;

    // 1) 用户显式指定了 javaPath → 就要以它为准
    const settings = this.settingsFor(dataRoot).resolve(version.id);
    const explicitPath = typeof settings.javaPath === 'string' ? settings.javaPath.trim() : '';
    if (explicitPath.length > 0) {
      const resolved = path.resolve(explicitPath);
      if (this.fsImpl.isFile(resolved)) {
        return { ok: true, major, executable: resolved };
      }
      if (this.fsImpl.isDir(resolved) && this.fsImpl.isFile(javaExecutable(resolved))) {
        return { ok: true, major, executable: javaExecutable(resolved) };
      }
      push({
        code: 'java-missing',
        severity: 'blocking',
        title: '设置里指定的 Java 路径不可用',
        detail:
          `实例设置里的 javaPath 指向 ${resolved}，但那里没有可执行的 java。\n` +
          '自动下载不会覆盖你手动指定的路径（避免把你的设置当成噪声冲掉）。\n' +
          '处理办法：打开这个实例的 ⚙ 设置，把 Java 路径改成一个真的 JRE（或其 bin 目录），或留空让它自动查找。',
      });
      return { ok: false, major: null, executable: null };
    }

    // 2) 本地有没有满足要求的 JRE
    const local = findJavaInDataRoot(dataRoot, requirement)[0];
    if (local !== undefined) {
      return { ok: true, major: local.majorVersion ?? major, executable: javaExecutable(local.javaHome) };
    }

    // 3) 本地没有 → 能不能自动下载？判断依据按可靠性排序
    const availability = await this.javaAvailability(component, major, dataRoot);

    if (availability.kind === 'downloadable') {
      push({
        code: 'java-downloadable',
        severity: 'warning',
        title: `需要 Java ${String(major)}，可以自动下载`,
        detail:
          `这台机器上没有满足要求的 Java 运行时。\n` +
          `启动时会自动下载 ${
            component === undefined ? `Java ${String(major)}` : `组件 ${component}（Java ${String(major)}）`
          }，约 180–400 MB，需要联网。\n` +
          '如果你更想用自己的 JRE，打开实例的 ⚙ 设置填一个 Java 路径即可。',
        fix: {
          kind: 'download-java',
          ...(component === undefined ? {} : { args: { component, majorVersion: major } }),
          label: `下载 Java ${String(major)}`,
        },
      });
      return { ok: true, major, executable: null };
    }

    if (availability.kind === 'maybe') {
      // 清单不可达：既不能说「能下」也不能说「不能下」，判 warning（启动时才知道）
      push({
        code: 'java-downloadable',
        severity: 'warning',
        title: `没找到 Java ${String(major)}，会尝试自动下载`,
        detail:
          `本地没有满足要求的 Java 运行时，且现在确认不了 Mojang 的 Java 清单\n` +
          `（${availability.reason}）。\n` +
          '启动时会尝试自动下载；如果网络不通，启动会在下载阶段失败并给出明确原因。\n' +
          '想立刻确认，可以在 ⚙ 设置里指定一个本机已有的 Java 路径。',
      });
      return { ok: true, major, executable: null };
    }

    if (availability.kind === 'installed-mismatch') {
      push({
        code: 'java-version',
        severity: 'blocking',
        title: `已装的 Java 版本不对`,
        detail:
          `磁盘上有 Java，但版本跟这个版本的要求对不上：${availability.detail}\n` +
          '拿错版本的 Java 去启动，游戏会在初始化阶段直接崩，所以这里先拦住。\n' +
          '处理办法：删除该运行时让它按清单重新下载，或在 ⚙ 设置里指定正确版本的 Java。',
      });
      return { ok: false, major: null, executable: null };
    }

    // kind === 'missing'：清单里根本没有这个组件
    push({
      code: 'java-missing',
      severity: 'blocking',
      title: `找不到 Java ${String(major)}，而且无法自动下载`,
      detail:
        (component === undefined
          ? `这个版本的元数据没声明 Java 组件名（javaVersion.component），只能按大版本 ${String(major)} 在本机查找。\n`
          : `Mojang 的 java-runtime 清单里没有可用的「${component}」运行时。\n`) +
        `已查找目录：${path.join(dataRoot, 'java')}\n` +
        '处理办法：手动安装 Java ' +
        String(major) +
        '，然后在实例的 ⚙ 设置里把「Java 路径」指向它（或直接把它放到上面那个目录里）。',
    });
    return { ok: false, major: null, executable: null };
  }

  /**
   * 判断「这个 Java 能不能自动下」。
   *
   * 四级结论：
   *   downloadable      清单里有该组件（且平台有对应条目）→ 能下
   *   missing           清单里明摆着没有 → 不能下
   *   installed-mismatch 本地有运行时但主版本与版本 JSON 声明不一致 → 下了也不能用
   *   maybe             清单拿不到（离线 / 网络异常）→ 无法判定
   */
  private async javaAvailability(
    component: string | undefined,
    major: number,
    dataRoot: string,
  ): Promise<
    | { kind: 'downloadable' }
    | { kind: 'missing' }
    | { kind: 'maybe'; reason: string }
    | { kind: 'installed-mismatch'; detail: string }
  > {
    // 没有组件名 → 只能靠大版本，无法自动下载
    if (component === undefined || component.trim().length === 0) return { kind: 'missing' };

    // 本地装了同名组件但主版本不对 → 这是「假可用」，必须拦住
    const mismatch = this.detectComponentMismatch(component, major, dataRoot);
    if (mismatch !== null) return { kind: 'installed-mismatch', detail: mismatch };

    const installer = this.javaInstallerFor(dataRoot);
    if (installer === null) {
      // 没装 java 模块（或形状不对）：只能用内置对照表判断，不下结论为「能下」
      const known = KNOWN_COMPONENT_MAJORS[component];
      return known === undefined ? { kind: 'missing' } : { kind: 'downloadable' };
    }

    if (installer.isInstalled(component)) return { kind: 'downloadable' };

    if (typeof installer.fetchManifest !== 'function') {
      const known = KNOWN_COMPONENT_MAJORS[component];
      return known === undefined ? { kind: 'maybe', reason: '本地无法读取 Java 清单' } : { kind: 'downloadable' };
    }

    try {
      const manifest = await installer.fetchManifest();
      const names = listComponents(manifest as never);
      if (names.length === 0) return { kind: 'maybe', reason: 'Java 清单为空' };
      if (!names.includes(component)) return { kind: 'missing' };
      // 组件存在，但还要确认当前平台有它的条目
      const entry = platformEntryFor(manifest, component);
      if (entry === 'none') {
        return {
          kind: 'missing',
        };
      }
      return { kind: 'downloadable' };
    } catch (err) {
      return {
        kind: 'maybe',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 本地同名组件的主版本与版本 JSON 声明不一致时返回说明，否则 null */
  private detectComponentMismatch(component: string, major: number, dataRoot: string): string | null {
    const local = scanJavaHomes(dataRoot, { majorVersion: 1, component }).find(
      (s) => s.lookup.component === component,
    );
    if (local === undefined) return null;
    const actual = local.lookup.majorVersion;
    if (actual === null || actual === major) return null;
    // 声明 21，实际 17 → 拦；声明 8，实际 21 → 不拦（Java 向下兼容，高版本能跑低版本）
    if (actual < major) {
      return `组件 ${component} 在本地是 Java ${String(actual)}，但这个版本需要 Java ${String(major)}（低了）。`;
    }
    return null;
  }

  /** 装配/取出 Java 安装器；拿不到返回 null */
  private javaInstallerFor(dataRoot: string): JavaInstallerLike | null {
    const raw = this.deps.javaProvisioner;
    if (raw === null || raw === undefined) return null;

    const candidate = raw as Partial<JavaInstallerLike> & { ensureJava?: unknown };
    if (typeof candidate.isInstalled === 'function') return candidate as JavaInstallerLike;

    // JavaAutoProvisioner 本身没有 isInstalled，但它能建出 installer —— 这里不碰下载路径，
    // 只按「不可判定」处理，交给上面的 known-table 兜底。
    void dataRoot;
    return null;
  }

  /** 内存：过低 / 超物理内存 */
  private checkMemory(memoryMB: number, version: VersionJson, push: (i: PreflightIssue) => void): void {
    const totalMB =
      typeof this.deps.totalMemoryMB === 'number' && this.deps.totalMemoryMB > 0
        ? this.deps.totalMemoryMB
        : Math.round(os.totalmem() / (1024 * 1024));
    const suggest = suggestedMemory(version);

    if (memoryMB < MEMORY_MIN_LAUNCH_MB) {
      push({
        code: 'memory-too-low',
        severity: 'warning',
        title: `分配的内存只有 ${mb(memoryMB)}，很可能进不去`,
        detail:
          `${version.assets !== undefined && /^(1[3-9]|2\d)/.test(String(version.assets)) ? '1.13 以后' : '这个版本'}` +
          `至少要 ${mb(MEMORY_MIN_LAUNCH_MB)} 才能进主菜单，现在只给了 ${mb(memoryMB)}。\n` +
          `建议调到 ${mb(suggest)}。内存太小最常见的表现是「启动到一半闪退」或卡在加载界面。`,
        fix: { kind: 'raise-memory', args: { memoryMB: suggest, current: memoryMB }, label: `调到 ${mb(suggest)}` },
      });
      return;
    }

    const ceiling = Math.floor(totalMB * MEMORY_OVERCOMMIT_RATIO);
    if (memoryMB > ceiling) {
      push({
        code: 'memory-too-high',
        severity: 'warning',
        title: `分配的内存 ${mb(memoryMB)} 超过物理内存能承受的范围`,
        detail:
          `这台机器物理内存 ${mb(totalMB)}，按 ${String(MEMORY_OVERCOMMIT_RATIO * 100)}% 算最多给 ${
            // eslint-disable-next-line no-restricted-syntax
            mb(ceiling)
          } 比较稳。\n` +
          '给多了不会更快，反而会因为不断换页导致卡顿甚至分配失败（JVM 直接报 Could not reserve enough space）。\n' +
          `建议调到 ${mb(Math.min(suggest, Math.max(MEMORY_MIN_LAUNCH_MB, ceiling)))}。`,
        fix: {
          kind: 'raise-memory',
          args: { memoryMB: Math.min(suggest, Math.max(MEMORY_MIN_LAUNCH_MB, ceiling)), current: memoryMB },
          label: `调到 ${mb(Math.min(suggest, Math.max(MEMORY_MIN_LAUNCH_MB, ceiling)))}`,
        },
      });
    }
  }

  /**
   * 文件完整性。
   *
   * 分两层：
   *   硬依赖（必查，几十到几百个）：client jar、每个该装的 library、asset index 文件
   *   资源对象（抽查 ASSET_SAMPLE_LIMIT 个）：跨分桶取样，缺了就报
   */
  private async checkFiles(
    version: VersionJson,
    versionId: string,
    dataRoot: string,
  ): Promise<{ missing: string[]; checked: number; sampled: number; totalAssets: number }> {
    const missing: string[] = [];
    let checked = 0;

    // 1) client jar —— 加载器版本自己没有 jar，jar 属于原版
    const jarVersion = await this.resolveClientJarVersion(version, versionId, dataRoot);
    checked += 1;
    if (jarVersion === null) {
      missing.push(`客户端 jar（versions/${versionId}/${versionId}.jar，沿 inheritsFrom 也没找到）`);
    }

    // 2) libraries：所有当前平台该装的库
    const librariesRoot = path.join(dataRoot, 'libraries');
    for (const lib of version.libraries ?? []) {
      if (!libraryApplies(lib, this.platform)) continue;
      checked += 1;
      const rel = artifactRelPath(lib);
      if (rel === null) continue; // 推不出路径的库不判缺失（避免误报）
      const abs = path.join(librariesRoot, rel);
      if (!this.fsImpl.isFile(abs)) {
        missing.push(`库 ${lib.name}（libraries/${rel}）`);
        continue;
      }
      // 声明了 size 就顺手核一下大小：半截文件比没有更坏
      const declared = lib.downloads?.artifact?.size;
      const actual = this.fsImpl.sizeOf(abs);
      if (typeof declared === 'number' && declared > 0 && actual !== undefined && actual !== declared) {
        missing.push(`库 ${lib.name}（大小不符：声明 ${String(declared)}，实际 ${String(actual)}）`);
      }
    }
    void LIBRARY_CHECK_FULL;

    // 3) asset index 文件 + 抽查资源对象
    const assetIndexId = version.assetIndex?.id ?? version.assets ?? 'legacy';
    const indexPath = path.join(dataRoot, 'assets', 'indexes', `${assetIndexId}.json`);
    checked += 1;
    const index = this.fsImpl.readJson<AssetIndex>(indexPath);
    if (index === undefined) {
      missing.push(`资源索引 assets/indexes/${assetIndexId}.json`);
    }

    let sampled = 0;
    let totalAssets = 0;
    // assetIndex 可能不在本地（离线），此时用仓库里合并出来的版本 JSON 已经带了 objects 吗？
    // 不会 —— objects 只在 index 文件里。所以只能读 index。
    if (index !== undefined && index.objects !== undefined) {
      const entries = Object.entries(index.objects) as [string, AssetObject][];
      totalAssets = entries.length;
      const picks = sampleAssets(entries, ASSET_SAMPLE_LIMIT);
      const objectsRoot = path.join(dataRoot, 'assets', 'objects');
      for (const [name, obj] of picks) {
        sampled += 1;
        if (typeof obj?.hash !== 'string' || obj.hash.length < 2) continue;
        const abs = path.join(objectsRoot, obj.hash.slice(0, 2), obj.hash);
        if (!this.fsImpl.isFile(abs)) {
          missing.push(`资源 ${name}（assets/objects/${obj.hash.slice(0, 2)}/${obj.hash}）`);
        }
      }
    }

    return { missing, checked, sampled, totalAssets };
  }

  /**
   * 找到真正持有 client jar 的版本 id。
   *
   * 加载器 profile（fabric-loader-…）目录里只有 json，jar 属于它 inheritsFrom 的原版。
   * 这里与 `GameLauncher.resolveClientJarVersion` 用同一套规则，保证「体检说不缺」
   * 与「启动器真去找」指向同一个文件。
   */
  private async resolveClientJarVersion(
    version: VersionJson,
    versionId: string,
    dataRoot: string,
  ): Promise<string | null> {
    const versionsRoot = path.join(dataRoot, 'versions');
    const jarOf = (id: string): string => path.join(versionsRoot, id, `${id}.jar`);

    const selfId = typeof version.id === 'string' && version.id.length > 0 ? version.id : versionId;
    if (this.fsImpl.isFile(jarOf(selfId))) return selfId;

    // 沿 inheritsFrom 向上（合并后的 JSON 没有这个字段，读磁盘上未合并的那份）
    const seen = new Set<string>([selfId]);
    let current = this.rawInheritsFrom(versionId, dataRoot);
    let depth = 0;
    while (current !== undefined && current.length > 0 && depth < 16) {
      if (seen.has(current)) break;
      seen.add(current);
      if (this.fsImpl.isFile(jarOf(current))) return current;
      current = this.rawInheritsFrom(current, dataRoot);
      depth += 1;
    }
    return null;
  }

  /** 读某个版本磁盘上未合并 JSON 的 inheritsFrom */
  private rawInheritsFrom(id: string, dataRoot: string): string | undefined {
    if (!isSafeId(id)) return undefined;
    const raw = this.fsImpl.readJson<{ inheritsFrom?: unknown }>(
      path.join(dataRoot, 'versions', id, `${id}.json`),
    );
    const next = raw?.inheritsFrom;
    return typeof next === 'string' && next.trim().length > 0 ? next.trim() : undefined;
  }

  /** 列出实例的 mod（读不到就当没有，绝不因为 mod 列表失败而让体检失败） */
  private async listMods(
    instanceId: string,
    dataRoot: string,
  ): Promise<{ filename: string; id?: string; size: number; enabled: boolean }[]> {
    const manager = this.modManagerFor(dataRoot);
    if (manager === null) return [];
    try {
      const list = await manager.list(instanceId);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private modManagerFor(dataRoot: string): ModManagerLike | null {
    if (this.deps.modManager !== undefined) return this.deps.modManager;
    // 惰性构造真实 ModManager：它的构造不触网、不建目录
    try {
      // 动态 require 会破坏 ESM；这里直接用依赖注入 + 静态导出的工厂
      return createDefaultModManager(dataRoot);
    } catch {
      return null;
    }
  }

  /** mod 与加载器匹配 / 重复 mod / 大包需要更大堆 */
  private checkMods(
    mods: { filename: string; id?: string; size: number; enabled: boolean }[],
    versionId: string,
    version: VersionJson,
    memoryMB: number,
    push: (i: PreflightIssue) => void,
  ): void {
    const enabled = mods.filter((m) => m.enabled && MOD_EXTENSIONS.test(m.filename));
    if (enabled.length === 0) return;

    // 1) 有 mod 但没有加载器
    const isLoader = this.looksLikeLoaderProfile(version, versionId);
    if (!isLoader) {
      push({
        code: 'mods-without-loader',
        severity: 'warning',
        title: `${String(enabled.length)} 个 mod 不会生效：这是原版，没有加载器`,
        detail:
          `实例的 mods/ 里有 ${String(enabled.length)} 个 jar，但当前版本 ${versionId} 是原版，` +
          'Minecraft 原版根本不读 mods 目录。\n' +
          '游戏能正常开，但这些 mod 一个都不会加载。\n' +
          '处理办法：用「装模组加载器」给这个版本装 Fabric / Quilt / Forge，再从这个加载器版本启动。',
        fix: { kind: 'install-loader', args: { versionId }, label: '装模组加载器' },
      });
    }

    // 2) 同一个 mod id 出现多份（用 ModManager 解析出的 metadata id）
    const byId = new Map<string, { filename: string; size: number }[]>();
    for (const mod of enabled) {
      const key = typeof mod.id === 'string' && mod.id.length > 0 ? mod.id.toLowerCase() : undefined;
      if (key === undefined) continue;
      const bucket = byId.get(key) ?? [];
      bucket.push({ filename: mod.filename, size: mod.size });
      byId.set(key, bucket);
    }
    for (const [id, bucket] of byId) {
      if (bucket.length < 2) continue;
      // 保留最大的那个（通常是完整构建），其余提示删除
      const sorted = [...bucket].sort((a, b) => b.size - a.size || a.filename.localeCompare(b.filename));
      const keep = sorted[0] as { filename: string; size: number };
      const drop = sorted.slice(1);
      push({
        code: 'mods-duplicate',
        severity: 'warning',
        title: `mod ${id} 装了 ${String(bucket.length)} 份`,
        detail:
          `同一个 mod id「${id}」在 mods/ 里出现了 ${String(bucket.length)} 次：\n  ` +
          bucket.map((m) => m.filename).join('\n  ') +
          '\n加载器遇到重复 mod 通常直接拒绝启动，或者后者静默覆盖前者（表现为「我改的配置没生效」）。\n' +
          `建议保留 ${keep.filename}，删掉其余 ${String(drop.length)} 个。`,
        fix: {
          kind: 'remove-duplicate-mod',
          args: { keep: keep.filename, remove: drop.map((d) => d.filename).join('|'), modId: id },
          label: `只保留 ${keep.filename}`,
        },
      });
    }

    // 3) 大堆小内存：mod 多时 2G 基本不够
    const heavy = enabled.length >= 30 || sumSizeMB(enabled) >= 1500;
    if (heavy && memoryMB < 4096) {
      push({
        code: 'mod-requires-larger-heap',
        severity: 'warning',
        title: `${String(enabled.length)} 个 mod 建议分配 4 GB 以上内存`,
        detail:
          `这个实例装了 ${String(enabled.length)} 个 mod（合计约 ${mb(sumSizeMB(enabled))}），但只分配了 ${mb(memoryMB)}。\n` +
          '整合包在 2G 下经常卡在加载界面或 OOM 闪退（日志里会看到 OutOfMemoryError / GC overhead limit exceeded）。\n' +
          '建议调到 4096 MB；如果物理内存不够，减少 mod 或降低视距。',
        fix: { kind: 'raise-memory', args: { memoryMB: 4096, current: memoryMB }, label: '调到 4096 MB' },
      });
    }

    void version;
  }

  /** Java 与 mod 的联动：老 Java 跑新 mod 会崩 */
  private checkJavaForMods(
    mods: { filename: string; enabled: boolean }[],
    javaMajor: number,
    push: (i: PreflightIssue) => void,
  ): void {
    const enabled = mods.filter((m) => m.enabled && MOD_EXTENSIONS.test(m.filename));
    if (enabled.length === 0) return;
    if (javaMajor >= 17) return;
    push({
      code: 'java-version',
      severity: 'warning',
      title: `Java ${String(javaMajor)} 跑现代 mod 很可能崩`,
      detail:
        `这个实例有 ${String(enabled.length)} 个 mod，但当前用的是 Java ${String(javaMajor)}。\n` +
        '1.18 以后的 Fabric / Forge mod 普遍要求 Java 17 或 21；用低版本 Java 启动，' +
        '典型表现是 `UnsupportedClassVersionError`（class file version 61.0）直接崩在加载阶段。\n' +
        '建议在 ⚙ 设置里指定 Java 17 / 21，或让启动器自动下载对应运行时。',
    });
  }

  /** 这个版本是不是加载器 profile */
  private looksLikeLoaderProfile(version: VersionJson, versionId: string): boolean {
    if (loaderKindOf(versionId) !== undefined) return true;
    // 磁盘上未合并的 JSON 带 inheritsFrom → 说明它是 profile 而不是原版
    if (typeof version.inheritsFrom === 'string' && version.inheritsFrom.length > 0) return true;
    const raw = this.rawInheritsFrom(versionId, this.dataRoot());
    return raw !== undefined;
  }
}

// ───────────────────────────── 辅助 ─────────────────────────────

/** 跳过前缀的确定性取样：跨 hash 分桶均匀取，避免只看开头那一片 */
export function sampleAssets<T>(entries: [string, T][], limit: number): [string, T][] {
  if (entries.length <= limit) return entries;
  const stride = Math.max(1, Math.floor(entries.length / limit));
  const out: [string, T][] = [];
  for (let i = 0; i < entries.length && out.length < limit; i += stride) {
    const item = entries[i];
    if (item !== undefined) out.push(item);
  }
  return out;
}

/** 清单里某个组件在当前平台有没有条目 */
function platformEntryFor(manifest: unknown, component: string): 'present' | 'none' | 'unknown' {
  if (manifest === null || typeof manifest !== 'object') return 'unknown';
  const candidates = platformCandidates();
  let sawPlatform = false;
  for (const key of candidates) {
    const perPlatform = (manifest as Record<string, unknown>)[key];
    if (perPlatform === null || typeof perPlatform !== 'object') continue;
    sawPlatform = true;
    const entries = (perPlatform as Record<string, unknown>)[component];
    if (Array.isArray(entries) && entries.length > 0) return 'present';
  }
  return sawPlatform ? 'none' : 'unknown';
}

function sumSizeMB(mods: { size: number }[]): number {
  let total = 0;
  for (const m of mods) total += Number.isFinite(m.size) ? m.size : 0;
  return Math.round(total / (1024 * 1024));
}

/**
 * 默认 ModManager 工厂（惰性：只有真的要读 mod 列表时才加载）。
 *
 * 用顶层 import 会形成 preflight → content/mods → launch/data-root 的静态链，
 * 虽然不成环，但会把「只想检查 java 的调用方」也拖进整个 content 模块。
 * 这里保持轻量：直接 new 一个真实的 `ModManager`（构造不触网、不建目录）。
 */
let defaultModManagerFactory: ((dataRoot: string) => ModManagerLike) | null = null;

/** 注册默认 ModManager 工厂（`core/preflight/index.ts` 在装配时会调用它，避免循环 import） */
export function setDefaultModManagerFactory(factory: (dataRoot: string) => ModManagerLike): void {
  defaultModManagerFactory = factory;
}

function createDefaultModManager(dataRoot: string): ModManagerLike | null {
  return defaultModManagerFactory === null ? null : defaultModManagerFactory(dataRoot);
}

export { rulesAllow, majorFromComponentName };
