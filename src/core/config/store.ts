/**
 * GlobalConfigStore —— 全局配置的唯一读写入口。
 *
 * 为啥要有它：数据目录、默认下载源这类「对整个启动器生效、且决定文件落在哪」的设置，
 * 不能塞进某个实例的 settings.json（那本来就在数据目录里），也不能只用环境变量
 * （普通用户不会去改环境变量）。所以单独一份 config.json，位置固定、与数据目录解耦。
 *
 * 四条纪律：
 *   1. **原子写**：写 `config.json.tmp` → rename。断电留下的只会是临时文件，
 *      不会是一份半截 JSON 把启动器变成"永远读不到配置"。
 *   2. **坏文件不崩**：解析失败 → 备份成 `config.json.bad-<时间戳>`，按默认值继续跑，
 *      并保留一个 `loadProblem` 让上层能如实告诉用户。
 *   3. **写入严格、读取宽松**：`save` / `setDataRoot` 校验不过就抛 `ConfigValidationError`；
 *      `load` 只尽量读懂，读不懂的字段当没设置。
 *   4. **改数据目录不迁移数据**：只校验 + 落盘 + 给出迁移提示。
 *
 * 重要：本模块**不 import download 模块**。download/paths.ts 需要读这份配置，
 * 如果反过来也依赖 download，就变成循环依赖（ESM 下会炸成 TDZ 错误）。
 * 解耦办法见 paths.ts：它通过 `globalThis.__pcl3ConfigStore` 这个可选钩子取默认存储。
 */

import fs from 'node:fs';
import path from 'node:path';

import { defaultConfigPath } from './paths.js';
import {
  ConfigValidationError,
  defaultConfig,
  mergeConfigPatch,
  normalizeConfig,
  type ConfigPatchResult,
} from './types.js';
import {
  measureDirSize,
  migrationNotice,
  validateDataDir,
  type DataDirCheck,
} from './validate-dir.js';

const CONFIG_FILE_NAME = 'config.json';
const TMP_SUFFIX = '.tmp';

/** 代理模式 */
export type ProxyMode = 'off' | 'system' | 'manual';

/** 网络代理配置 */
export interface ProxyConfig {
  /**
   * - `off`    完全不使用代理
   * - `system` 跟随系统设置（Windows 读注册表，其他平台读环境变量）；系统没配就等同 off
   * - `manual` 使用下方 `url`
   */
  mode: ProxyMode;
  /** manual 模式下的代理地址，如 `http://127.0.0.1:7897` / `socks5://127.0.0.1:1080` */
  url?: string;
  /** 不走代理的主机（逗号分隔）。缺省 `127.0.0.1,localhost` */
  bypass?: string;
}

/** 全局配置（字段语义见 ARCHITECTURE 与本模块注释） */
export interface GlobalConfig {
  /** 数据根目录绝对路径；不填则用系统默认（%APPDATA%/PCL3） */
  dataRoot?: string;
  /** 固定的下载源 id；不填则自动测速 */
  preferredMirror?: string;
  /** 是否自动测速 */
  autoProbeMirror: boolean;
  /**
   * 网络代理。
   *
   * 为什么默认 `system`：国内大量网络下 `cdn.modrinth.com`（Fastly）不可达，
   * 而用户往往已经在系统里配好了代理。跟随系统能让这些用户开箱即用，
   * 没配代理的用户则完全不受影响（system 模式下系统没开就等于 off）。
   */
  proxy?: ProxyConfig;
}

/** 默认代理配置 */
export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: 'system',
  bypass: '127.0.0.1,localhost',
};

export interface GlobalConfigStoreOptions {
  /** 显式指定配置文件路径（测试 / 高级用法）。缺省走 defaultConfigPath() */
  configPath?: string;
  /** 环境变量来源（测试可注入，避免污染进程 env） */
  env?: NodeJS.ProcessEnv;
}

/** `setDataRoot` 的返回：成功给出迁移提示，失败给出人话原因 */
export interface SetDataRootResult {
  ok: boolean;
  reason?: string;
  /** 生效后的路径（成功时） */
  dataRoot?: string;
  /** 上一份数据目录（成功且确实变了时） */
  previousDataRoot?: string;
  /** 「不自动迁移」的告知文案 */
  notice?: string;
  warnings: string[];
  /** 旧目录的占用（字节），仅成功且变化时给 */
  previousSizeBytes?: number;
}

export class GlobalConfigStore {
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  private lastLoadProblem: string | undefined;

  constructor(opts: GlobalConfigStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.file = path.resolve(opts.configPath ?? defaultConfigPath(this.env));
  }

  /** 配置文件绝对路径 */
  get configPath(): string {
    return this.file;
  }

  /** 上次 `load()` 遇到的问题（坏文件 / 未知字段），没有则为 undefined */
  get loadProblem(): string | undefined {
    return this.lastLoadProblem;
  }

  /**
   * 读配置。**永不抛错**：
   *   - 文件不存在 → 默认配置（这是首次安装的正常状态）
   *   - 文件坏了 → 备份后按默认配置，`loadProblem` 说明原因
   */
  load(): GlobalConfig {
    this.lastLoadProblem = undefined;

    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.lastLoadProblem = `读取配置失败：${messageOf(error)}`;
      }
      return defaultConfig();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const where = this.quarantine(`JSON 解析失败：${messageOf(error)}`);
      this.lastLoadProblem = `配置文件不是合法 JSON，已备份为 ${where}，本次按默认配置运行。`;
      return defaultConfig();
    }

    const { config, ignored } = normalizeConfig(parsed);
    if (ignored.length > 0) {
      this.lastLoadProblem = `配置里有 ${String(ignored.length)} 项没生效：${ignored.join('、')}`;
    }
    return config;
  }

  /**
   * 写配置（原子写）。
   *
   * 写入前跑一遍**严格**校验：宁可抛错让人看见，也不写出一个下次读不回来的文件。
   */
  save(cfg: GlobalConfig): void {
    const patch: Record<string, unknown> = {
      dataRoot: cfg.dataRoot ?? null,
      preferredMirror: cfg.preferredMirror ?? null,
      autoProbeMirror: cfg.autoProbeMirror,
    };
    const merged = mergeConfigPatch(defaultConfig(), patch);
    // dataRoot 之类已在别的层校验过路径合法性，这里只挡结构性问题
    if (merged.problems.length > 0) {
      throw new ConfigValidationError(merged.problems, merged.ignored);
    }
    this.write(merged.config);
  }

  /**
   * 局部更新：只改动 `patch` 里出现的字段，其余保持原样。
   * 结构不合法（类型错、未知源 id）抛 `ConfigValidationError`。
   */
  update(patch: Record<string, unknown>): ConfigPatchResult {
    const current = this.load();
    const merged = mergeConfigPatch(current, patch);
    if (merged.problems.length > 0) {
      throw new ConfigValidationError(merged.problems, merged.ignored);
    }
    this.write(merged.config);
    return merged;
  }

  /**
   * 修改数据目录。**只校验 + 落盘，不迁移任何数据**。
   *
   * 返回 `{ ok, reason }` 而不是抛错：这是用户直接操作的一条路径，
   * HTTP / CLI 都要把 `reason` 原样显示给人看。
   */
  async setDataRoot(dir: string): Promise<SetDataRootResult> {
    const before = this.load();
    const previous = typeof before.dataRoot === 'string' && before.dataRoot.trim() !== ''
      ? path.resolve(before.dataRoot.trim())
      : undefined;

    const check: DataDirCheck = await validateDataDir(dir, {
      ...(previous === undefined ? {} : { currentDataRoot: previous }),
      configPath: this.file,
    });

    if (!check.ok) {
      return { ok: false, reason: check.reason, warnings: check.warnings };
    }

    const next: GlobalConfig = { ...before, dataRoot: check.dir };
    try {
      this.write(next);
    } catch (error) {
      return {
        ok: false,
        reason: `配置没能写入磁盘：${messageOf(error)}`,
        warnings: check.warnings,
      };
    }

    const changed = previous === undefined || !samePath(previous, check.dir);
    if (!changed) {
      return { ok: true, dataRoot: check.dir, warnings: check.warnings };
    }

    // 旧目录的占用只用来「告知」，探测失败不影响结果
    const previousSizeBytes = previous === undefined ? undefined : await measureDirSize(previous);
    return {
      ok: true,
      dataRoot: check.dir,
      ...(previous === undefined ? {} : { previousDataRoot: previous }),
      notice: migrationNotice({
        from: previous ?? '（默认目录）',
        to: check.dir,
        ...(previousSizeBytes === undefined ? {} : { sizeBytes: previousSizeBytes }),
      }),
      warnings: check.warnings,
      ...(previousSizeBytes === undefined ? {} : { previousSizeBytes }),
    };
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private write(cfg: GlobalConfig): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });

    const payload: Record<string, unknown> = { autoProbeMirror: cfg.autoProbeMirror === true };
    if (typeof cfg.dataRoot === 'string' && cfg.dataRoot.trim() !== '') payload['dataRoot'] = cfg.dataRoot.trim();
    if (typeof cfg.preferredMirror === 'string' && cfg.preferredMirror.trim() !== '') {
      payload['preferredMirror'] = cfg.preferredMirror.trim();
    }

    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const tmp = path.join(dir, `${CONFIG_FILE_NAME}${TMP_SUFFIX}`);
    fs.writeFileSync(tmp, text, { encoding: 'utf8' });
    try {
      fs.renameSync(tmp, this.file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  /** 把坏文件挪走，返回备份文件名 */
  private quarantine(reason: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${this.file}.bad-${stamp}`;
    try {
      fs.renameSync(this.file, backup);
      process.emitWarning(`PCL3：${this.file} 无法解析（${reason}），已备份为 ${path.basename(backup)}。`);
      return path.basename(backup);
    } catch (error) {
      process.emitWarning(`PCL3：${this.file} 无法解析（${reason}），备份也失败（${messageOf(error)}）。`);
      return path.basename(this.file);
    }
  }
}

// ───────────────────────────── 全局默认存储 ─────────────────────────────

/**
 * 进程级默认存储（惰性创建）。
 *
 * 为什么要单例：`getDataRoot()` 在 download 模块里被到处调用，
 * 每调一次都 new 一个 store、读一次盘会让启动变慢，也没法共享坏文件通知。
 */
export function defaultConfigStore(): GlobalConfigStore {
  const slot = globalThis as { __pcl3DefaultConfigStore?: GlobalConfigStore };
  const cached = slot.__pcl3DefaultConfigStore;
  // 环境变量指向的配置文件变了（同一进程内的测试场景）就重建
  if (cached !== undefined && cached.configPath === defaultConfigPath()) return cached;
  const created = new GlobalConfigStore();
  slot.__pcl3DefaultConfigStore = created;
  return created;
}

/** 仅供测试：清掉进程级默认存储，让下次重新读盘 */
export function resetDefaultConfigStoreCache(): void {
  const slot = globalThis as { __pcl3DefaultConfigStore?: GlobalConfigStore };
  delete slot.__pcl3DefaultConfigStore;
}

/**
 * 把默认存储挂到 `globalThis.__pcl3ConfigStore`，供 download/paths.ts 读取。
 *
 * 这是**单向**的可选钩子：paths.ts 只认这个形状（`{ load(): { dataRoot?: string } }`），
 * 不认识 `GlobalConfigStore` 这个类。于是两个模块之间没有 import 关系，
 * 也就不会出现循环依赖。
 *
 * 必须尽早调用：`server.ts` 在解析 dataRoot 之前会调一次；`cli` 入口同理。
 * 不调也不会出错 —— getDataRoot 会退化成「环境变量 → 默认目录」。
 */
export function installConfigHook(store: GlobalConfigStore = defaultConfigStore()): void {
  (globalThis as { __pcl3ConfigStore?: GlobalConfigStore }).__pcl3ConfigStore = store;
  // 挂钩的同时把代理应用到传输层：之后所有下载（库、资源、mod、元数据）都走它
  void applyProxyFromConfig(store);
}

/**
 * 传输层代理应用的注入点。
 *
 * 和 `__pcl3ConfigStore` 同一个思路：本模块**不能 import download 模块**（会成环，
 * 见文件头注释）。所以由上层（web/server.ts 或 cli）在启动时注入一个回调，
 * 我们把「解析好的代理地址 + bypass」交给它，由它去设 transport 的模块级变量。
 *
 * 没注入时 `applyProxyFromConfig` 就是个空操作 —— 配置照样能存能读，只是不生效。
 */
export interface ProxyApplier {
  (proxy: { url: string } | null, bypass: string): void;
}

/** 注入代理应用器（幂等，重复调用覆盖） */
export function setProxyApplier(applier: ProxyApplier | null): void {
  proxyApplier = applier ?? undefined;
}

let proxyApplier: ProxyApplier | undefined;

/**
 * 系统代理探测器注入点。
 *
 * 同样是为了避免 config → net 的依赖：`detectProxy` 会读注册表、扫端口，
 * 那是 net 模块的事，config 只管「读一份配置」。上层启动时把探测器注入进来。
 */
export type ProxyDetectorFn = () => Promise<{ url: string; label: string } | undefined>;

export function setProxyDetector(fn: ProxyDetectorFn | null): void {
  proxyDetector = fn ?? undefined;
}

let proxyDetector: ProxyDetectorFn | undefined;

/**
 * 把配置里的代理设置应用出去。
 *
 * 语义：
 *   - `off`     → 直连
 *   - `manual`  → 用 `url`；解析不出来就退回直连并记警告
 *   - `system`  → 探测系统代理；探测不到就是直连（不影响没配代理的用户）
 *
 * **永不抛错**：代理配错了只该让下载变慢或失败，绝不能让启动器起不来。
 */
export async function applyProxyFromConfig(
  store: GlobalConfigStore = defaultConfigStore(),
): Promise<{ applied: boolean; url?: string; bypass: string; reason?: string }> {
  let bypass = '127.0.0.1,localhost';
  try {
    const config = store.load();
    const proxy = config.proxy ?? { mode: 'system' as const };
    bypass = proxy.bypass ?? '127.0.0.1,localhost';
    activeBypass = bypass;

    if (proxy.mode === 'off') {
      proxyApplier?.(null, bypass);
      return { applied: false, bypass, reason: '已关闭代理' };
    }

    if (proxy.mode === 'manual') {
      const url = (proxy.url ?? '').trim();
      if (url === '') {
        proxyApplier?.(null, bypass);
        return { applied: false, bypass, reason: '手动模式但没填地址，已直连' };
      }
      proxyApplier?.({ url }, bypass);
      return { applied: true, url, bypass };
    }

    // system：探测一次（探测器由上层注入；没注入就当没检测到）
    if (proxyDetector === undefined) {
      proxyApplier?.(null, bypass);
      return { applied: false, bypass, reason: '未注入系统代理探测器，已直连' };
    }
    const detected = await proxyDetector();
    if (detected === undefined) {
      proxyApplier?.(null, bypass);
      return { applied: false, bypass, reason: '未检测到系统代理，已直连' };
    }
    proxyApplier?.({ url: detected.url }, bypass);
    return { applied: true, url: detected.url, bypass, reason: detected.label };
  } catch (error) {
    proxyApplier?.(null, bypass);
    process.emitWarning(`应用代理配置失败，继续直连：${messageOf(error)}`);
    return { applied: false, bypass, reason: messageOf(error) };
  }
}

/** 当前生效的 bypass 列表 */
let activeBypass = '127.0.0.1,localhost';

/** 读取当前 bypass（供测试与诊断） */
export function currentProxyBypass(): string {
  return activeBypass;
}


function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'linux' ? na === nb : na.toLowerCase() === nb.toLowerCase();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
