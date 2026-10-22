/**
 * JavaRuntimeInstaller —— 自动下载并落盘 Mojang 官方 JRE。
 *
 * 契约（Lead 指定）：
 *
 * ```ts
 * export class JavaRuntimeInstaller {
 *   constructor(deps: { downloader: Downloader; dataRoot?: string });
 *   fetchManifest(force?: boolean): Promise<JavaRuntimeManifest>;
 *   ensureRuntime(component, onProgress?): Promise<string>;   // 返回 java 可执行文件绝对路径
 *   isInstalled(component: string): boolean;
 *   majorVersionOf(component: string): Promise<number | null>;
 * }
 * ```
 *
 * ## 目录布局
 *
 * ```
 * <dataRoot>/java/
 * ├─ _manifest.json        # 第一段清单缓存（见 manifest.ts）
 * ├─ _manifest.meta.json
 * └─ <component>/          # 例如 java-runtime-gamma
 *    └─ bin/java.exe       # Windows；mac 是 <component>/jre.bundle/Contents/Home/bin/java
 * ```
 *
 * 布局刻意保持「<dataRoot>/java/<component>/…」，是为了能被现有的
 * `src/core/launch/java.ts::findJavaInDataRoot` 直接认出来（它从 `<dataRoot>/java` 往下最深 4 层
 * 找 java home，并从相对路径里的第一段目录名读组件名）。两者职责不重叠：
 *   - 本模块：负责「没有就装」
 *   - findJavaInDataRoot：负责「在已有目录里挑一个版本合适的」
 * 接线由 Lead 决定，本模块不 import 也不修改 launch/java.ts。
 *
 * ## 三态处理（第二段清单的 files 条目）
 *
 *   - `directory` → mkdir -p
 *   - `file`      → 走 Downloader.downloadAll，sha1 直接交给 DownloadTask 校验
 *   - `link`      → **简化：复制**（真实实现是硬链接/symlink）
 *
 * ## 幂等
 *
 * `isInstalled` = jar 目录存在 + 清单里标记 `executable` 且名字是 java/java.exe 的那个文件存在。
 * `ensureRuntime` 会先查一次，已装就直接返回，重复调用不会重复下载。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { DownloadTask } from '../types.js';
import { getDataRoot } from '../download/index.js';
import {
  allEntriesForComponent,
  DEFAULT_MANIFEST_TTL_MS,
  entriesForComponent,
  ManifestStore,
  type JavaRuntimeEntry,
  type JavaRuntimeFileEntry,
  type JavaRuntimeFilesManifest,
  type JavaRuntimeManifest,
  type TextFetcher,
} from './manifest.js';
import {
  majorFromComponentName,
  parseMajorFromVersionName,
  platformCandidates,
} from './platform.js';

/** 契约里 `Downloader` 的最小形状（结构类型，测试可塞 fake，不必是真实类）。 */
export interface DownloaderLike {
  downloadAll(
    tasks: DownloadTask[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<import('../types.js').DownloadResult>;
}

export interface JavaRuntimeInstallerDeps {
  downloader: DownloaderLike;
  /** 数据根；缺省走 download 模块的 `getDataRoot()`（不自行拼路径） */
  dataRoot?: string | undefined;
  /** 镜像根（如 `https://bmclapi2.bangbang93.com`）；缺省只用官方 */
  mirror?: string | undefined;
  /** 清单缓存 TTL，默认 24h */
  manifestTtlMs?: number;
  /** 注入抓取实现（测试用） */
  fetchTextImpl?: TextFetcher;
  /** 注入平台判定（测试用），默认取当前进程 */
  platform?: { platform?: string; arch?: string };
  /** 注入 logger */
  logger?: { warn(message: string, ...args: unknown[]): void };
  /** 注入时钟（测试用） */
  now?: () => number;
}

export interface EnsureRuntimeProgress {
  done: number;
  total: number;
  file: string;
}

/** component 名会被直接当目录名用，必须挡住目录穿越。 */
function assertSafeComponent(component: string): void {
  if (typeof component !== 'string' || component.trim() === '') {
    throw new Error('java component must be a non-empty string');
  }
  if (/[\\/:*?"<>|]/.test(component) || component.includes('..') || component.startsWith('.')) {
    throw new Error(`unsafe java component name: ${component}`);
  }
}

/**
 * 纯字符串（POSIX 语义）归一化相对路径，不碰文件系统、不依赖 cwd。
 * `a/b/../c` → `a/c`；`..` 跑出根时保留前导 `..`，交给 resolveInside 拒绝。
 */
export function normalizeRelative(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * link 目标解析：`<条目所在目录>/<target>` 的归一化相对路径。
 *
 * 例：条目 `legal/java.compiler/COPY_OF_ASSEMBLY`，target `../java.base/X`
 *   → `legal/java.base/X`
 * 注意 base 是**文件路径**，要取它的父目录再拼 target。
 */
export function joinRelative(base: string, relative: string): string {
  const normalizedBase = base.replace(/\\/g, '/');
  const parent = normalizedBase.includes('/')
    ? normalizedBase.slice(0, normalizedBase.lastIndexOf('/'))
    : '';
  return normalizeRelative(parent === '' ? relative : `${parent}/${relative}`);
}

/** 把清单里的相对路径拼成绝对路径，并确保没有跑出运行时目录。 */
function resolveInside(root: string, relative: string): string {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`java runtime manifest contains an absolute path: ${relative}`);
  }
  const abs = path.resolve(root, normalized);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`java runtime manifest path escapes runtime dir: ${relative}`);
  }
  return abs;
}

/** 判断文件名是不是 java 本体（不是 javaw / javac / jar）。
 *  注意 Windows 清单里 `bin/javaw.exe` 也是 `executable: true`，但它不是 java 本体。 */
export function isJavaExecutableName(relativePath: string): boolean {
  const base = relativePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return base === 'java' || base === 'java.exe';
}

/**
 * 在运行时清单里找出 java 本体。
 *
 * 优先 `executable: true` 且文件名是 java/java.exe 的 file 条目；
 * 其次任取一个 executable 的 java 条目（极少数清单漏标 executable 时兜底）；
 * 都没有返回 undefined。
 */
export function findJavaEntry(
  files: Record<string, JavaRuntimeFileEntry>,
): { relativePath: string; entry: JavaRuntimeFileEntry } | undefined {
  let fallback: { relativePath: string; entry: JavaRuntimeFileEntry } | undefined;

  for (const [relativePath, entry] of Object.entries(files)) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.type !== 'file') continue;
    if (!isJavaExecutableName(relativePath)) continue;

    if (entry.executable === true) return { relativePath, entry };
    fallback ??= { relativePath, entry };
  }
  return fallback;
}

/** 统计每种 type 的数量（测试与日志用）。 */
export function countEntryTypes(files: Record<string, JavaRuntimeFileEntry>): {
  directory: number;
  file: number;
  link: number;
  other: number;
} {
  const counts = { directory: 0, file: 0, link: 0, other: 0 };
  for (const entry of Object.values(files)) {
    const type = entry?.type;
    if (type === 'directory' || type === 'file' || type === 'link') counts[type] += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * 把第二段清单的 files 折算成「要建哪些目录 / 要下哪些文件 / 要复制哪些链接」。
 *
 * 单独提出来是为了**先全量校验、后写盘**：路径越界的清单必须整体拒绝，
 * 不能在数据目录里先建一半目录再抛错。这里还是会抛错（resolveInside 校验），
 * 但因为是纯函数、且在 mkdir 之前调用，所以抛错时磁盘上什么都没留下。
 */
export interface RuntimeFilePlan {
  /** 需要 mkdir -p 的绝对路径 */
  directories: string[];
  /** 需要交给 Downloader 的任务（已带 sha1 / size） */
  tasks: DownloadTask[];
  /** link 条目（简化成复制） */
  links: { relative: string; dest: string; target: string }[];
  totalEntries: number;
}

export function planRuntimeFiles(
  root: string,
  files: Record<string, JavaRuntimeFileEntry>,
): RuntimeFilePlan {
  const directories: string[] = [];
  const tasks: DownloadTask[] = [];
  const links: { relative: string; dest: string; target: string }[] = [];

  for (const [relative, item] of Object.entries(files)) {
    if (item === null || typeof item !== 'object') continue;

    if (item.type === 'directory') {
      directories.push(resolveInside(root, relative));
      continue;
    }
    if (item.type === 'file') {
      // 只用 raw：lzma 需要额外解压器，raw 通用且直连 CDN。
      const raw = item.downloads?.raw;
      if (raw === undefined || typeof raw.url !== 'string' || raw.url === '') continue;
      const task: DownloadTask = { url: raw.url, dest: resolveInside(root, relative) };
      if (typeof raw.sha1 === 'string' && raw.sha1 !== '') task.sha1 = raw.sha1;
      if (typeof raw.size === 'number') task.size = raw.size;
      tasks.push(task);
      continue;
    }
    if (item.type === 'link') {
      links.push({
        relative,
        dest: resolveInside(root, relative),
        target: typeof item.target === 'string' ? item.target : '',
      });
    }
  }

  return { directories, tasks, links, totalEntries: Object.keys(files).length };
}

/**
 * 拒绝符号链接逃逸：如果目标目录的某个已存在祖先是指向外部的 symlink，就抛错。
 * 正常情况下不会发生（目录是我们自己建的），但清单是外部数据，多一道闸成本很低。
 */
function guardEscapes(root: string, targets: readonly string[]): void {
  const seen = new Set<string>();
  for (const target of targets) {
    let current = target;
    while (current !== root && current.startsWith(root)) {
      if (seen.has(current)) break;
      seen.add(current);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error(`java runtime path escapes runtime dir (symlink): ${current}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('escapes runtime dir')) throw err;
        // 不存在是正常的：还没建
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

export class JavaRuntimeInstaller {
  /** `<dataRoot>/java` —— 所有 JRE 的父目录 */
  readonly javaDir: string;

  private readonly downloader: DownloaderLike;
  private readonly store: ManifestStore;
  private readonly platformInput: { platform?: string; arch?: string };
  private readonly logger: { warn(message: string, ...args: unknown[]): void };
  private readonly fetchTextImpl: TextFetcher;

  /** 同一个 component 的并发 ensureRuntime 合并成一次 */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(deps: JavaRuntimeInstallerDeps) {
    this.downloader = deps.downloader;
    const dataRoot = deps.dataRoot ?? getDataRoot();
    this.javaDir = path.join(dataRoot, 'java');

    this.store = new ManifestStore({
      javaDir: this.javaDir,
      mirror: deps.mirror,
      ttlMs: deps.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS,
      fetchTextImpl: deps.fetchTextImpl ?? ((url) => defaultFetchText(url)),
      logger: deps.logger ?? { warn: (message, ...args) => console.warn(message, ...args) },
      now: deps.now ?? Date.now,
    });

    this.platformInput = deps.platform ?? {};
    this.logger = deps.logger ?? {
      warn: (message, ...args) => console.warn(message, ...args),
    };
    this.fetchTextImpl = deps.fetchTextImpl ?? ((url) => defaultFetchText(url));
  }

  /** 当前机器可接受的平台 key，按优先级。 */
  platformOrder(): string[] {
    return platformCandidates(this.platformInput);
  }

  /** 某个 component 在 `<dataRoot>/java/` 下的安装目录。 */
  runtimeDir(component: string): string {
    assertSafeComponent(component);
    return path.join(this.javaDir, component);
  }

  /** 拉取并缓存官方 java-runtime 清单（TTL 24h，网络失败回退过期缓存）。 */
  fetchManifest(force = false): Promise<JavaRuntimeManifest> {
    return this.store.fetch(force);
  }

  /**
   * 只检查是否已安装，不下载、不触网。
   *
   * 判定：运行时目录存在 + java 可执行文件名（java / java.exe，Windows 下也接受 javaw.exe）存在。
   * 注意这里不校验 sha1、也不逐个文件核对 —— 契约要求的就是「jar 目录存在 + java 可执行文件存在」。
   */
  isInstalled(component: string): boolean {
    return this.executableIn(this.runtimeDir(component)) !== undefined;
  }

  /** 已安装时的 java 可执行文件绝对路径；未安装返回 undefined。 */
  installedExecutable(component: string): string | undefined {
    return this.executableIn(this.runtimeDir(component));
  }

  /**
   * 确保运行时可用，返回 java 可执行文件绝对路径。
   *
   * 流程：
   *   1. 已安装 → 直接返回（幂等，零网络）
   *   2. 拉第一段清单 → 按平台候选找 component 条目 → 拉第二段清单
   *   3. 按 type 三态落盘（directory / file / link）
   *   4. 确认 java 本体存在 → 返回绝对路径
   */
  async ensureRuntime(
    component: string,
    onProgress?: (p: EnsureRuntimeProgress) => void,
  ): Promise<string> {
    assertSafeComponent(component);

    const installed = this.executableIn(this.runtimeDir(component));
    if (installed !== undefined) return installed;

    const running = this.inflight.get(component);
    if (running !== undefined) return running;

    const task = this.doEnsure(component, onProgress).finally(() => {
      this.inflight.delete(component);
    });
    this.inflight.set(component, task);
    return task;
  }

  /**
   * 该 component 对应的 Java 主版本。
   *
   * 来源优先级：
   *   1. 第一段清单里版本条目的 `version.name`（如 `21.0.7` → 21）—— 权威但需触网
   *   2. 内置组件对照表（离线可用，见 platform.ts::KNOWN_COMPONENT_MAJORS）
   *
   * 注意运行时自己的 manifest.json 里**没有** javaVersion 字段（实测），所以不能用它。
   * 清单里从未出现过的 component 才返回 null。
   */
  async majorVersionOf(component: string): Promise<number | null> {
    assertSafeComponent(component);

    try {
      const manifest = await this.fetchManifest();
      const entries = allEntriesForComponent(manifest, component);
      for (const entry of entries) {
        const major = parseMajorFromVersionName(entry.version?.name);
        if (major !== null) return major;
      }
      // 清单在国内是「有该 component 但结构异样」时也走兜底
      return majorFromComponentName(component);
    } catch (err) {
      this.logger.warn(
        `[java] 无法从清单读取 ${component} 的主版本，改用内置对照表：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return majorFromComponentName(component);
    }
  }

  // ───────────────────────────── 内部实现 ─────────────────────────────

  private async doEnsure(
    component: string,
    onProgress?: (p: EnsureRuntimeProgress) => void,
  ): Promise<string> {
    const root = this.runtimeDir(component);
    const platformOrder = this.platformOrder();
    if (platformOrder.length === 0) {
      throw new Error(
        `当前平台（${this.platformInput.platform ?? process.platform}/${this.platformInput.arch ?? process.arch}）`
          + '没有可用的 Minecraft Java 运行时，请手动指定 javaPath。',
      );
    }

    const coarse = await this.fetchManifest();
    const entry = pickRuntimeEntry(coarse, component, platformOrder);
    if (entry === undefined) {
      throw new Error(
        `java-runtime 清单里找不到组件 ${component} 的平台 ${platformOrder.join(' / ')} 条目。`,
      );
    }

    const filesManifest = await this.fetchRuntimeFiles(entry.manifest.url);
    const files = filesManifest.files;
    if (files === null || typeof files !== 'object' || Object.keys(files).length === 0) {
      throw new Error(`运行时清单为空：${entry.manifest.url}`);
    }

    const javaEntry = findJavaEntry(files);
    if (javaEntry === undefined) {
      throw new Error(`运行时清单里没有找到 java 可执行文件：${entry.manifest.url}`);
    }

    // ── 0. 先把全部路径解析一遍（含安全校验）──────────────────────────────
    //
    // 必须在写任何东西之前做完：清单里只要有一条路径越界，整个安装就该拒绝，
    // 而不是「先 mkdir 一半再抛错」在数据目录里留下垃圾。
    // 同时这里顺带拒绝符号链接逃逸（父目录被做成指向外部的 symlink）。
    const plan = planRuntimeFiles(root, files);

    // 空目录不算安装：必须先确认 java 本体真的落在计划里
    if (!plan.tasks.some((t) => t.dest === resolveInside(root, javaEntry.relativePath))) {
      throw new Error(
        `运行时清单里 java 可执行文件 ${javaEntry.relativePath} 缺少 downloads.raw，无法下载：`
          + entry.manifest.url,
      );
    }

    fs.mkdirSync(root, { recursive: true });
    if (plan.directories.length > 0) guardEscapes(root, plan.directories);
    if (plan.tasks.length > 0) guardEscapes(root, plan.tasks.map((t) => path.dirname(t.dest)));

    // ── 1. directory：建目录 ─────────────────────────────────────────────
    for (const dir of plan.directories) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // ── 2. file：批量交给 Downloader（sha1 直接做校验）───────────────────
    const tasks = plan.tasks;
    if (tasks.length > 0) {
      const result = await this.downloader.downloadAll(
        tasks,
        onProgress === undefined
          ? undefined
          : (p) => {
              onProgress({ done: p.done, total: p.total, file: p.current });
            },
      );
      if (result.failed.length > 0) {
        const first = result.failed[0] as DownloadTask;
        throw new Error(
          `Java 运行时下载未完成：${result.failed.length}/${tasks.length} 个文件失败`
            + `（首个：${first.dest}）。重试 ensureRuntime('${component}') 会从中断处继续。`,
        );
      }
    }

    // ── 3. link：简化为复制 ──────────────────────────────────────────────
    //
    // Mojang 官方实现是「硬链接指向同目录里另一份文件」（例如 legal/*/ADDITIONAL_LICENSE_INFO
    // → ../java.base/ADDITIONAL_LICENSE_INFO）。这里**刻意简化成复制**：
    //   - 复制语义上等价（内容一致），JVM 不在乎是不是链接；
    //   - 省掉 Windows 上硬链接需要同卷 / 权限的问题，也不需要区分 symlink 与 hardlink；
    //   - 代价是这几个 license/conf 小文件会多占几 KB 磁盘，可以接受。
    // 复制必须放在所有 file 下载完成之后，否则源文件可能还不存在。
    for (const link of plan.links) {
      if (link.target === '') {
        this.logger.warn(`[java] link 条目缺少 target，跳过：${link.relative}`);
        continue;
      }
      try {
        // link 的 target 是相对该条目所在目录的。这里自己拼字符串，不用 path.posix.resolve：
        // 后者会把相对路径接到**进程 cwd** 上（Windows 上还会得到 /Users/... 这种假根），
        // 拿它去读文件必然 ENOENT。自己归一化后再走 resolveInside 做越界校验。
        const source = resolveInside(root, joinRelative(link.relative, link.target));
        fs.mkdirSync(path.dirname(link.dest), { recursive: true });
        fs.copyFileSync(source, link.dest);
      } catch (err) {
        // 个别 link 指向的文件可能不在本次清单里（Mojang 历史数据有这种情况）。
        // 它不影响 JVM 启动，记警告继续，不让整个安装失败。
        this.logger.warn(
          `[java] 复制 link 失败（不影响启动，已跳过）：${link.relative} → ${link.target}：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // ── 4. 收尾：确认 java 本体真的在 ────────────────────────────────────
    const executable = resolveInside(root, javaEntry.relativePath);
    if (!isFile(executable)) {
      throw new Error(
        `Java 运行时安装后仍找不到可执行文件：${executable}`
          + `（清单共 ${plan.totalEntries} 个条目，其中 ${tasks.length} 个文件）`,
      );
    }
    onProgress?.({ done: tasks.length, total: tasks.length, file: executable });
    return executable;
  }

  /** 拉第二段运行时清单（纯文本 HTTP，不走 Downloader —— 它只负责二进制落盘）。 */
  private async fetchRuntimeFiles(url: string): Promise<JavaRuntimeFilesManifest> {
    const text = await this.fetchTextImpl(url);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      throw new Error(
        `解析运行时清单失败：${url} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`运行时清单不是对象：${url}`);
    }
    const files = (parsed as { files?: unknown }).files;
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
      throw new Error(`运行时清单缺少 files 字段：${url}`);
    }
    return parsed as JavaRuntimeFilesManifest;
  }

  /** 在安装目录里找 java 本体（不触网、不读清单，纯本地判定）。 */
  private executableIn(root: string): string | undefined {
    if (!isDirectory(root)) return undefined;
    // 常规位置优先；mac 的运行时多一层 jre.bundle/Contents/Home，排在后面兜底。
    // 同时接受 javaw.exe（launch/java.ts 的偏好），Windows 上它同样是 java 本体。
    const candidates = [
      path.join(root, 'bin', 'java.exe'),
      path.join(root, 'bin', 'java'),
      path.join(root, 'bin', 'javaw.exe'),
      path.join(root, 'jre.bundle', 'Contents', 'Home', 'bin', 'java'),
    ];
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
    return undefined;
  }
}

/**
 * 从第一段清单里按「组件 + 平台优先级」挑出运行时条目。
 *
 * 平台顺序由 platformCandidates 给出（越前越优先）；同一平台有多条时取第一条。
 * 组件在所有候选平台都不存在、或条目结构不合法，一律返回 undefined 由调用方报错。
 */
export function pickRuntimeEntry(
  manifest: JavaRuntimeManifest,
  component: string,
  platforms: readonly string[],
): JavaRuntimeEntry | undefined {
  const entry = entriesForComponent(manifest, component, platforms)[0];
  if (entry === undefined) return undefined;
  if (typeof entry.manifest?.url !== 'string' || entry.manifest.url === '') return undefined;
  return entry;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 默认抓取：复用 version 模块已有的 HTTPS 抓取（带重试、重定向、gzip）。 */
async function defaultFetchText(url: string): Promise<string> {
  const { fetchText } = await import('../version/http.js');
  const res = await fetchText(url);
  return res.text;
}
