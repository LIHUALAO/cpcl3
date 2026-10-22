/**
 * 启动期的「Java 自动下载」协调器。
 *
 * 这是把 `src/core/java/` 接进启动流程的唯一一个点。设计目标：**launcher.ts 只改一处，
 * 且那一处不认识 HTTP、不认识清单格式、不认识 Downloader**。
 *
 * 流程（`ensureJava`）：
 *
 *   1. 同步查一遍本地（`pickJavaOrNull`）—— 有就用，**零网络**
 *   2. 没有 → 需要 component 才能下载；版本 JSON 没声明 component 就只能报原来的错
 *   3. 用 `JavaRuntimeInstaller.ensureRuntime(component, onProgress)` 下载
 *   4. 下载完**再查一遍本地**（不直接用 installer 的返回值）：
 *      installer 返回 `<component>/bin/java.exe`，而启动器偏好 `javaw.exe`（无控制台窗口）；
 *      重新查一遍能让「同一个 JRE 但目录结构不同」也被正确识别。
 *   5. 任一步失败 → 抛出**人话**错误（网络 / 磁盘 / 组件不存在 分开说）
 *
 * 惰性装配：`installer` 不传时，第一次真正需要下载才 `await import('../java/index.js')`。
 * 这样：
 *   - 本地已有 Java 的常规路径完全不加载 java 模块
 *   - 单元测试不需要 mock 一个从不使用的依赖
 *   - 也避免了 launch → java → download 的静态 import 链在纯「拼命令」场景下白跑一遍
 */

import path from 'node:path';

import {
  findJavaInDataRoot,
  invalidJavaPathMessage,
  isJavaHome,
  javaExecutable,
  noJavaMessage,
  pickJavaOrNull,
  scanJavaHomes,
  type JavaRequirement,
} from './java.js';

/** installer 的最小结构约束（测试塞 fake；生产是真实的 JavaRuntimeInstaller） */
export interface JavaInstallerLike {
  ensureRuntime(
    component: string,
    onProgress?: (p: { done: number; total: number; file: string }) => void,
  ): Promise<string>;
  isInstalled(component: string): boolean;
  /** 清单里该组件的实际主版本；拿不到返回 null。用于「组件 vs 版本 JSON」一致性校验 */
  majorVersionOf?(component: string): Promise<number | null>;
}

/** 进度事件：形状对齐 web/jobs.ts 的 `ProgressLike`（phase + done/total + current） */
export interface JavaProvisionProgress {
  phase: 'java';
  done: number;
  total: number;
  current?: string;
}

export interface JavaProvisionerDeps {
  /** 覆盖数据根（默认取 GameLauncher 解析出的那个） */
  dataRoot?: string;
  /** 注入 installer（测试用）；缺省惰性加载真实的 JavaRuntimeInstaller */
  installer?: JavaInstallerLike;
  /** 构造真实 installer 时的额外依赖（镜像根等），只在没有注入 installer 时生效 */
  installerFactory?: (dataRoot: string) => JavaInstallerLike;
  /** 注入 downloader（真实 installer 需要它） */
  downloader?: import('../java/index.js').DownloaderLike;
  /** 镜像根，如 https://bmclapi2.bangbang93.com */
  mirror?: string;
  /** 进度回调 */
  onProgress?: (p: JavaProvisionProgress) => void;
  /** logger */
  logger?: { warn(message: string, ...args: unknown[]): void };
}

/** 自动下载失败时的分类错误：`kind` 便于前端/CLI 分辨要不要提示用户换网络 */
export type JavaProvisionFailureKind =
  | 'network'
  | 'disk'
  | 'unknown-component'
  | 'platform'
  | 'version-mismatch'
  | 'unknown';

export class JavaProvisionError extends Error {
  readonly kind: JavaProvisionFailureKind;
  readonly component: string;
  readonly requirement: JavaRequirement;
  /** 底层原始错误（网络/文件系统异常），便于日志排查 */
  override readonly cause?: unknown;

  constructor(
    kind: JavaProvisionFailureKind,
    message: string,
    component: string,
    requirement: JavaRequirement,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'JavaProvisionError';
    this.kind = kind;
    this.component = component;
    this.requirement = requirement;
    if (cause !== undefined) this.cause = cause;
  }
}

/** 从错误信息猜测失败类型。分不清就归到 unknown，不硬编一个可能误导的类别。 */
export function classifyProvisionError(raw: string): JavaProvisionFailureKind {
  if (/ENOSPC|EACCES|EPERM|quota|磁盘|空间不足/i.test(raw)) return 'disk';
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|network|网络|timeout|超时|HTTP 5\d\d|HTTP 4(29|08)/i.test(raw)) {
    return 'network';
  }
  if (/找不到组件|没有找到 java 可执行文件|清单里没有|运行时清单为空|缺.*downloads\.raw/i.test(raw)) {
    return 'unknown-component';
  }
  if (/没有可用的 Minecraft Java 运行时|当前平台/i.test(raw)) return 'platform';
  return 'unknown';
}

/** 把底层错误翻成用户能看懂、且指得出下一步的话。 */
export function humanizeProvisionError(
  kind: JavaProvisionFailureKind,
  component: string,
  requirement: JavaRequirement,
  raw: string,
  dataRoot: string,
): string {
  const target = path.join(dataRoot, 'java', component);
  const head = `自动下载 Java ${requirement.majorVersion}（组件 ${component}）失败，游戏无法启动。`;

  switch (kind) {
    case 'network':
      return [
        head,
        `原因：网络无法访问 Mojang 的 java-runtime 元数据或文件服务器。`,
        `原始错误：${raw}`,
        `处理办法：检查网络后重试；国内网络可在启动设置里把镜像切到 BMCLAPI；`
          + `或手动把 JRE 解压到 ${target}（需含 bin/java 或 bin/java.exe）。`,
      ].join('\n');
    case 'disk':
      return [
        head,
        `原因：磁盘写入失败，可能空间不足或没有写入权限。`,
        `原始错误：${raw}`,
        `处理办法：清理磁盘（这个 JRE 约 180–400 MB）后重试；`
          + `或换一个数据目录；或手动把 JRE 放到 ${target}。`,
      ].join('\n');
    case 'unknown-component':
      return [
        head,
        `原因：Mojang 的 java-runtime 清单里没有可用的「${component}」运行时（可能清单改版或该组件已下线）。`,
        `原始错误：${raw}`,
        `处理办法：换一个该版本的 Java 组件；或手动指定 javaPath。`,
      ].join('\n');
    case 'platform':
      return [
        head,
        `原因：当前操作系统/架构没有对应的 Minecraft Java 运行时。`,
        `原始错误：${raw}`,
        `处理办法：手动安装对应架构的 JRE 并在启动设置里指定 javaPath。`,
      ].join('\n');
    case 'version-mismatch':
      return [
        head,
        `原因：Mojang 清单里该组件的实际主版本与版本 JSON 声明的不一致。`,
        `原始错误：${raw}`,
        `处理办法：清除 ${path.join(dataRoot, 'java', '_manifest.json')} 重试；或手动指定 javaPath。`,
      ].join('\n');
    default:
      return [
        head,
        `原始错误：${raw}`,
        `处理办法：重试一次；仍失败则手动把 JRE 解压到 ${target}`
          + `（需含 bin/java 或 bin/java.exe），或在启动设置里指定 javaPath。`,
      ].join('\n');
  }
}

export class JavaAutoProvisioner {
  private readonly deps: JavaProvisionerDeps;

  // 不用 TS 参数属性（`constructor(private deps)`）：Node 的 strip-only 类型剥离不支持
  constructor(deps: JavaProvisionerDeps = {}) {
    this.deps = deps;
  }

  /**
   * 确保有可用 Java，返回可执行文件绝对路径。
   *
   * 语义（用户点名的「像 PCL2 一样自动适配 Java 版本」）：
   *   不是「装一个 Java 就行」，而是**按版本要求装对的那个组件**。
   *
   *   1. 精确复用：`<dataRoot>/java/<component>/` 已装且可执行 → 直接用（零网络）
   *   2. 校验：拿清单里该组件的实际主版本，跟版本 JSON 声明的 `majorVersion` 对齐；
   *      不一致 → 报错（清单过期/数据异常），绝不硬启
   *   3. 下载：`ensureRuntime(component)` 装那个特定组件
   *   4. 装完再按 component 精确取回可执行文件
   *
   * @param requirement 版本 JSON 推导出的要求（majorVersion + component）
   * @param dataRoot    数据根
   * @param explicitPath opts.javaPath；给了就必须可用，**不参与**自动下载与组件校验
   */
  async ensureJava(
    requirement: JavaRequirement,
    dataRoot: string,
    explicitPath?: string | null,
  ): Promise<string> {
    // 0) 显式 javaPath：用户说了算，可用即用、不可用直接报错（不偷偷去下载）
    const explicit = explicitPath?.trim() ?? '';
    if (explicit !== '') {
      const picked = pickJavaOrNull(dataRoot, requirement, explicit);
      if (picked === null) throw new Error(invalidJavaPathMessage(explicit));
      return picked;
    }

    // 1) component 是精确匹配的锚点；没有它就只能沿用旧规则（也报旧错）
    const component = requirement.component?.trim() ?? '';
    if (component === '') {
      const loose = pickJavaOrNull(dataRoot, requirement, null);
      if (loose !== null) return loose;
      throw new Error(noJavaMessage(requirement, dataRoot, []));
    }

    // 2) 已装则复用 —— 必须在任何网络请求之前，保证「不重复下 400MB」
    const installed = this.installedExecutable(component, dataRoot);
    const needsInstall = installed === null;

    // 3) 校验清单与版本 JSON 的主版本是否一致。
    //    只下载不校验是不够的：如果 Mojang 改了组件语义，硬装会得到「装好了但启动崩溃」。
    await this.verifyMajorVersion(component, requirement, dataRoot, needsInstall);

    if (!needsInstall) return installed as string;

    // 4) 下载
    const installer = await this.resolveInstaller(dataRoot);
    this.deps.onProgress?.({ phase: 'java', done: 0, total: 1, current: `准备下载 ${component}` });

    try {
      await installer.ensureRuntime(component, (p) => {
        this.deps.onProgress?.({
          phase: 'java',
          done: p.done,
          total: p.total,
          current: p.file,
        });
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const kind = classifyProvisionError(raw);
      throw new JavaProvisionError(
        kind,
        humanizeProvisionError(kind, component, requirement, raw, dataRoot),
        component,
        requirement,
        err,
      );
    }

    this.deps.onProgress?.({ phase: 'java', done: 1, total: 1, current: `已安装 ${component}` });

    // 5) 装完按 component 精确取回（顺带把 javaw.exe 的偏好交回启动器）
    const after = this.installedExecutable(component, dataRoot);
    if (after !== null) return after;

    const installedExe = path.join(dataRoot, 'java', component, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    throw new JavaProvisionError(
      'unknown',
      humanizeProvisionError(
        'unknown',
        component,
        requirement,
        `下载完成但目录里仍没有可用的 java（期望 ${installedExe}）`,
        dataRoot,
      ),
      component,
      requirement,
    );
  }

  /**
   * 精确取「component 目录」下的可执行文件；没有返回 null。
   *
   * 只看 `<dataRoot>/java/<component>/`，不扫描别的目录 ——
   * 这是「按版本要求装对的那个 Java」的落点，也保证 1.21 与 1.8.9 的多 Java 互不覆盖。
   */
  private installedExecutable(component: string, dataRoot: string): string | null {
    const home = path.join(path.resolve(dataRoot), 'java', component);
    if (!isJavaHome(home)) return null;
    return javaExecutable(home);
  }

  /**
   * 校验「清单里该组件的实际主版本」与「版本 JSON 声明的 majorVersion」是否一致。
   *
   * 为什么要校验：
   *   - 组件名是 Mojang 的内部代号（gamma/beta/delta），语义可能随清单更新而变化；
   *   - 硬编码映射表会过期，所以主版本**必须以 all.json 为准**（要求原文）；
   *   - 两者不一致说明「清单过期 / 本地缓存脏 / 版本 JSON 异常」，
   *     这时硬启会得到一个版本错误、启动即崩的 JVM，不如明确报错。
   *
   * 校验失败分两种：
   *   - 拿不到清单（断网且无缓存）：**不阻断**，只打 warning —— 否则离线用户连已装好的 Java 都用不了
   *   - 拿到了但数字不符：**阻断**
   */
  private async verifyMajorVersion(
    component: string,
    requirement: JavaRequirement,
    dataRoot: string,
    isInstallPath: boolean,
  ): Promise<void> {
    const declared = requirement.majorVersion;
    if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return;

    let actual: number | null;
    try {
      const installer = await this.resolveInstaller(dataRoot);
      if (typeof installer.majorVersionOf !== 'function') return;
      actual = await installer.majorVersionOf(component);
    } catch (err) {
      this.deps.logger?.warn(
        `[java] 无法校验 ${component} 的主版本，跳过校验继续：${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (actual === null || actual === undefined) return; // 清单里没有这个组件，交给下载阶段报错
    if (actual === declared) return;

    const detail =
      `组件 ${component} 在 Mojang 的 java-runtime 清单里实际是 Java ${actual}，`
      + `但版本 JSON 声明需要 Java ${declared}。`;
    const hint = isInstallPath
      ? `这通常意味着清单已更新（组件代号被重新分配）或本地缓存过期。`
      + `处理办法：清除 <dataRoot>/java/_manifest.json 后重试（会重新拉取清单）；`
      + `或手动安装 Java ${declared} 并在启动设置里指定 javaPath。`
      : `已安装的运行时版本与版本要求不符，不能用来启动（会崩溃）。`
      + `处理办法：删除 ${path.join(dataRoot, 'java', component)} 后重试（会按清单重新下载）；`
      + `或手动指定 javaPath。`;

    throw new JavaProvisionError(
      'version-mismatch',
      `Java 版本不一致，拒绝启动：\n${detail}\n${hint}`,
      component,
      requirement,
    );
  }

  /**
   * 本地查找（保留给「没有 component」的历史路径）。
   *
   * 有 component 时一律走 `installedExecutable` 的精确匹配 —— 原严格规则靠目录名里的数字
   * 猜大版本，而组件名（`java-runtime-delta`）不含数字，会把自动下载出来的目录误判为「无法判定」。
   */
  private findLocal(
    requirement: JavaRequirement,
    dataRoot: string,
    explicitPath?: string | null,
  ): string | null {
    const strict = pickJavaOrNull(dataRoot, requirement, explicitPath);
    if (strict !== null) return strict;
    if (explicitPath !== null && explicitPath !== undefined && explicitPath.trim() !== '') {
      return null;
    }

    const component = requirement.component?.trim() ?? '';
    if (component === '') return null;
    return this.installedExecutable(component, dataRoot);
  }

  private async resolveInstaller(dataRoot: string): Promise<JavaInstallerLike> {
    if (this.deps.installer !== undefined) return this.deps.installer;
    if (this.deps.installerFactory !== undefined) return this.deps.installerFactory(dataRoot);

    // 惰性加载：只有真的要下载时才会走到这里
    const mod = await import('../java/index.js');
    if (this.deps.downloader === undefined) {
      throw new JavaProvisionError(
        'unknown',
        '尚未注入 Downloader，无法自动下载 Java。请通过 LaunchOptions.javaProvisioner 注入，'
          + '或在应用启动时把 downloader 传进来。',
        '',
        { majorVersion: 0 },
      );
    }
    return new mod.JavaRuntimeInstaller({
      downloader: this.deps.downloader,
      dataRoot,
      ...(this.deps.mirror === undefined ? {} : { mirror: this.deps.mirror }),
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    });
  }
}
