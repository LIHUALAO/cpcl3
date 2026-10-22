/**
 * MirrorSelector —— 实测各下载源延迟、自动选源、失败自动降级。
 *
 * 用户原话：「测速也交给你，速度不行你就尝试换源」。
 *
 * 三条设计要点：
 *
 * 1. **可比性**：所有源测**同一个文件**（`mc/game/version_manifest_v2.json`），
 *    并且要求「HTTP 2xx + 至少收到一个数据块」。只看建连成功会误判 ——
 *    有些源 TCP 通但一发数据就卡。
 *
 * 2. **抗抖动**：每个源测 2 次取**最小值**。取最小值而不是平均值，
 *    是因为网络抖动只会让单次变慢、不会让单次变快（除非真的更快）。
 *
 * 3. **可降级**：`reportFailure(base)` 累计连续失败，达到阈值就把该源标成不可用
 *    并立刻重算最优源。下一次 `best()` 不会再把流量送给它。
 *    成功一次即清零 —— 网络恢复了就该恢复。
 *
 * 缓存：
 *   - 内存：`best()` 在 TTL 内直接命中，不重新测速
 *   - 磁盘：`<dataRoot>/cache/mirror-probe.json`，跨进程复用（重启启动器不用重新测 6 秒）
 *   - 显式 `refresh()` 才强制重测（界面上「重新测速」按钮）
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { getDataRoot } from '../download/paths.js';
import { MIRROR_DEFINITIONS, findMirror, type MirrorDefinition } from './mirrors.js';

/** 一次测速的结果（契约形状，不得删字段） */
export interface MirrorProbe {
  /** 源标识，如 'mojang' | 'bmclapi' */
  id: string;
  /** 基础 URL */
  base: string;
  /** 实测延迟 ms；失败为 Infinity */
  latencyMs: number;
  /** 是否可用 */
  ok: boolean;
  /** 测速时间（毫秒时间戳） */
  probedAt: number;
}

/** 默认超时：单个源单次请求 5 秒 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** 默认缓存有效期：30 分钟 */
export const DEFAULT_PROBE_TTL_MS = 30 * 60 * 1000;

/** 每个源测几次（取最小值） */
export const PROBE_ROUNDS = 2;

/** 连续失败多少次算「这个源不行了」 */
export const DEFAULT_FAILURE_THRESHOLD = 2;

/** 磁盘缓存文件名（相对 <dataRoot>/cache/） */
export const PROBE_CACHE_FILE = 'mirror-probe.json';

export interface MirrorSelectorOptions {
  /** 数据根；缺省走 download 模块的 getDataRoot() */
  dataRoot?: string;
  /** 注入 fetch（测试用；缺省用全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 缓存有效期，默认 30 分钟 */
  ttlMs?: number;
  /** 连续失败阈值，默认 2 */
  failureThreshold?: number;
  /** 参与测速的源（默认全部已知源；测试可只给两个） */
  mirrors?: readonly MirrorDefinition[];
  /** 固定的源 id：设了就不再自动测速，`best()` 直接返回它（仍然会标 ok） */
  preferredId?: string;
  /** 是否禁用磁盘缓存（测试用） */
  disableDiskCache?: boolean;
}

/** 磁盘缓存的形状（带版本号，将来改格式不会读出脏数据） */
interface ProbeCacheFile {
  version: 1;
  savedAt: number;
  probes: MirrorProbe[];
}

/** 内部：一个源的失败计数 */
interface FailureState {
  consecutive: number;
  lastError: string;
  lastAt: number;
}

/** Infinity 无法写进 JSON（会变成 null），缓存里用 -1 表示「测过且失败」 */
function encodeLatency(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : -1;
}

function decodeLatency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return Number.POSITIVE_INFINITY;
  return value;
}

function validateCacheEntry(raw: unknown): MirrorProbe | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || rec['id'].trim() === '') return undefined;
  if (typeof rec['base'] !== 'string' || rec['base'].trim() === '') return undefined;
  const latency = decodeLatency(rec['latencyMs']);
  const ok = rec['ok'] === true && Number.isFinite(latency);
  return {
    id: rec['id'].trim(),
    base: rec['base'].trim(),
    latencyMs: ok ? latency : Number.POSITIVE_INFINITY,
    ok,
    probedAt: typeof rec['probedAt'] === 'number' && Number.isFinite(rec['probedAt']) ? rec['probedAt'] : 0,
  };
}

/**
 * 已知源 id 表 —— **硬编码**，不从 MIRROR_DEFINITIONS 推导。
 *
 * 原因：测试会传入自己的源集合（只有 fast / slow），如果这里跟着 `this.definitions`
 * 走，`reportFailure('mojang')` 之类的调用就会解析到测试源上去。
 * 源 id 是产品级常量，就该写死。
 */
const KNOWN_MIRROR_BASE: Readonly<Record<string, string>> = {
  mojang: 'https://launchermeta.mojang.com',
  piston: 'https://piston-meta.mojang.com',
  bmclapi: 'https://bmclapi2.bangbang93.com',
};

export class MirrorSelector {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly failureThreshold: number;
  private readonly definitions: readonly MirrorDefinition[];
  private readonly disableDiskCache: boolean;

  /** 进程内缓存：来源可能是磁盘或本次实测 */
  private cache: MirrorProbe[] | undefined;
  private cacheAt = 0;
  /** 缓存是否已经和磁盘比对过（避免每次 best() 都读盘） */
  private diskLoaded = false;

  /** 失败计数（按 base 记，durable across probes） */
  private readonly failures = new Map<string, FailureState>();

  /** 固定源（设置里手动指定，不做自动测速） */
  private preferredId: string | undefined;

  constructor(opts: MirrorSelectorOptions = {}) {
    this.root = path.resolve(opts.dataRoot ?? safeDataRoot());
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.ttlMs = Math.max(0, Math.floor(opts.ttlMs ?? DEFAULT_PROBE_TTL_MS));
    this.failureThreshold = Math.max(1, Math.floor(opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD));
    this.definitions = opts.mirrors !== undefined && opts.mirrors.length > 0 ? opts.mirrors : MIRROR_DEFINITIONS;
    this.disableDiskCache = opts.disableDiskCache === true;
    this.preferredId = normalizeId(opts.preferredId);

    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('MirrorSelector 需要可用的 fetch（Node 20+ 内置）');
    }
  }

  // ── 公共 API ──────────────────────────────────────────────────

  /** 测速 URL（全部源共用同一个文件，保证可比） */
  probeUrlOf(mirror: MirrorDefinition): string {
    return mirror.probeUrl;
  }

  /** 参与测速的源定义（只读，界面展示用） */
  get mirrors(): readonly MirrorDefinition[] {
    return this.definitions;
  }

  /** 当前固定源 id（未设置则 undefined = 自动测速） */
  get preferred(): string | undefined {
    return this.preferredId;
  }

  /** 运行时改「固定源」。传 undefined 恢复自动测速。 */
  setPreferred(id: string | undefined): void {
    const next = normalizeId(id);
    if (next !== undefined && findMirror(next) === undefined) {
      throw new Error(`不认识的下载源：${id ?? ''}`);
    }
    this.preferredId = next;
    // 换源策略变了，已经选好的结果不再可信
    this.cacheAt = 0;
  }

  /**
   * 实测所有源，返回按延迟升序的结果（不可用的排最后）。
   *
   * 每次调用都会**真的发请求**；要复用缓存请用 `best()`。
   */
  async probeAll(opts: { timeoutMs?: number } = {}): Promise<MirrorProbe[]> {
    const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS));
    const probedAt = Date.now();

    // 并发测，不要串行 —— 串行会让总耗时变成 3 个源 × 5 秒
    const settled = await Promise.all(
      this.definitions.map(async (def) => this.probeOne(def, timeoutMs, probedAt)),
    );

    const sorted = sortProbes(settled);
    this.cache = sorted;
    this.cacheAt = Date.now();
    this.diskLoaded = true;

    // ⚠️ 注意：这里**不**清失败计数。
    //
    // 「测速能连通」不等于「下载能成功」—— 源可能 manifest 秒回、大文件却一路 5xx/断流。
    // 如果测速成功就重置降级，那么「失败 → 重测（它碰巧通）→ 又选它 → 又失败」
    // 会变成换源死循环，用户看到的就是"永远在最差的源上反复重试"。
    // 解除降级只有两条路：`reportSuccess()`（真的下成功了）或 `refresh()`（用户手动重测）。

    await this.persist(sorted);
    return cloneProbes(sorted);
  }

  /**
   * 拿当前最佳源。
   *
   * 顺序：固定源 → 内存/磁盘缓存（TTL 内）→ 真测速。
   * 全部源都不可用时：**不抛错**，返回延迟为 Infinity 的结果并标 ok=false，
   * 让上层（doctor / 安装流程）能继续跑并如实显示"没一个通"。
   */
  async best(opts: { timeoutMs?: number } = {}): Promise<MirrorProbe> {
    const fixed = this.preferredProbe();
    if (fixed !== undefined) return fixed;

    const cached = await this.readCache();
    if (cached !== undefined && cached.length > 0) {
      const sorted = sortProbes(cached);
      const alive = sorted.filter((p) => p.ok && !this.isDegraded(p.base));
      const pick = alive[0] ?? sorted[0];
      if (pick !== undefined) return cloneProbe(pick);
    }
    const probes = await this.probeAll(opts);
    // 测速本身成功不代表这个源值得用：刚从它身上连续失败过的源照样跳过，
    // 否则「失败了 → 重测（它碰巧还能连）→ 又选它」会变成死循环换源。
    const pick = probes.find((p) => p.ok && !this.isDegraded(p.base)) ?? probes[0];
    if (pick !== undefined) return cloneProbe(pick);

    // 一个源都没配（理论上不会）：给一个占位，明确标不可用，绝不抛错
    return { id: 'unknown', base: '', latencyMs: Number.POSITIVE_INFINITY, ok: false, probedAt: Date.now() };
  }

  /** 强制重测（界面「重新测速」、doctor 的 `--refresh`） */
  async refresh(opts: { timeoutMs?: number } = {}): Promise<MirrorProbe[]> {
    this.cache = undefined;
    this.cacheAt = 0;
    this.diskLoaded = false;
    this.failures.clear();
    return this.probeAll(opts);
  }

  /**
   * 上报一次下载失败（由 Downloader 的 `onRepeatedFailure` / 路由层调用）。
   *
   * 连续失败达到阈值 → 该源进入「降级」状态：
   *   · `probeAll` 仍会把它算进来（延迟是真值），但 `best()` 不会选它
   *   · 解除降级只有两条路：`reportSuccess()`（真的下成功过一次）或 `refresh()`（手动重测）
   *
   * 为什么不用"测速成功"来解除：源可能 manifest 秒回、大文件却一路 5xx。
   * 那样会造成「失败 → 重测 → 又选它 → 又失败」的换源死循环。
   *
   * 返回当前连续失败次数（方便调用方打日志）。
   */
  reportFailure(baseOrId: string): number {
    const base = this.resolveKey(baseOrId);
    if (base === undefined) return 0;
    const prev = this.failures.get(base);
    const consecutive = (prev?.consecutive ?? 0) + 1;
    this.failures.set(base, { consecutive, lastError: '', lastAt: Date.now() });
    if (consecutive >= this.failureThreshold && (prev?.consecutive ?? 0) < this.failureThreshold) {
      // 降级发生：让上一次的「选源结论」立刻失效，下一次 best() 会重新评估。
      // 在阈值那一刻清一次（不是每次失败都清），避免每条失败都触发重测。
      this.cache = undefined;
      this.cacheAt = 0;
    }
    return consecutive;
  }

  /**
   * 上报一次成功（下载成功 / 探测成功）。清零该源的失败计数。返回清零后的计数（恒为 0）。
   */
  reportSuccess(baseOrId: string): number {
    const base = this.resolveKey(baseOrId);
    if (base !== undefined) this.failures.delete(base);
    return 0;
  }

  /** 该源是否已被降级（连续失败达到阈值） */
  isDegraded(baseOrId: string): boolean {
    const base = this.resolveKey(baseOrId);
    if (base === undefined) return false;
    return (this.failures.get(base)?.consecutive ?? 0) >= this.failureThreshold;
  }

  /** 当前降级状态快照（汇报 / 排障用） */
  degraded(): { base: string; consecutive: number }[] {
    const out: { base: string; consecutive: number }[] = [];
    for (const [base, state] of this.failures) {
      if (state.consecutive >= this.failureThreshold) out.push({ base, consecutive: state.consecutive });
    }
    return out;
  }

  /** 磁盘缓存路径 */
  get cachePath(): string {
    return path.join(this.root, 'cache', PROBE_CACHE_FILE);
  }

  /** 清掉内存缓存（改了配置 / 换了数据目录后调用） */
  invalidate(): void {
    this.cache = undefined;
    this.cacheAt = 0;
    this.diskLoaded = false;
  }

  /**
   * 同步 peek：只回答「内存里现在有没有一份没过期的测速结果」。
   *
   * 给 `/api/status` 用的 —— 首屏不能被测速拖住 5~10 秒，
   * 但也不能编一个假的延迟。没有缓存就老实返回 null，由上层决定后台去测。
   * **绝不发请求、绝不读盘。**
   */
  cachedProbes(): MirrorProbe[] | null {
    if (this.cache === undefined || this.cacheAt <= 0) return null;
    if (Date.now() - this.cacheAt > this.ttlMs) return null;
    return cloneProbes(this.cache);
  }

  // ── 内部：单源测速 ────────────────────────────────────────────

  private async probeOne(def: MirrorDefinition, timeoutMs: number, probedAt: number): Promise<MirrorProbe> {
    // 跑 2 轮取最小值；同一轮内部串行，避免两次请求互相抢带宽把结果都拉高
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < PROBE_ROUNDS; round += 1) {
      const ms = await this.timeOnce(def.probeUrl, timeoutMs);
      if (!Number.isFinite(ms)) continue;
      if (ms < best) best = ms;
    }
    const ok = Number.isFinite(best);
    return {
      id: def.id,
      base: def.base,
      latencyMs: ok ? best : Number.POSITIVE_INFINITY,
      ok,
      probedAt,
    };
  }

  /** 单次测速：返回耗时 ms；超时/非 2xx/没收到数据 → Infinity */
  private async timeOnce(url: string, timeoutMs: number): Promise<number> {
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 注意：Race 里的超时定时器必须 clear —— 否则每个源每轮都留一个 5 秒的
    // pending timer，`probeAll()` 结束后如果调用方没有别的句柄，
    // 测试与 CLI 会白等最多 5 秒才能退出。
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`probe timeout ${String(timeoutMs)}ms`));
      }, timeoutMs);
    });
    try {
      const attempt = (async (): Promise<number> => {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'follow',
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP ${String(res.status)}`);
        }
        // 读到第一块数据才算「真的通」：有些源会给 200 然后一直挂着不吐字节
        await readFirstChunk(res);
        return Date.now() - started;
      })();
      // 失败的那一侧不能变成 unhandled rejection
      attempt.catch(() => undefined);
      return await Promise.race([attempt, timeout]);
    } catch {
      return Number.POSITIVE_INFINITY;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ── 内部：缓存 ────────────────────────────────────────────────

  private preferredProbe(): MirrorProbe | undefined {
    const id = this.preferredId;
    if (id === undefined) return undefined;
    const def = findMirror(id) ?? this.definitions.find((d) => d.id === id);
    const base = def?.base ?? '';
    const known = this.cache?.find((p) => p.id === id);
    return {
      id,
      base: base || (known?.base ?? ''),
      // 固定源不做测速：延迟未知，但明确标记 ok=true（用户显式选的，尊重选择）
      latencyMs: known?.latencyMs ?? Number.POSITIVE_INFINITY,
      ok: known?.ok ?? true,
      probedAt: known?.probedAt ?? 0,
    };
  }

  /** 读缓存：内存优先，其次磁盘（只读一次）；过期返回 undefined */
  private async readCache(): Promise<MirrorProbe[] | undefined> {
    if (this.cache !== undefined && this.cacheAt > 0) {
      return Date.now() - this.cacheAt <= this.ttlMs ? this.cache : undefined;
    }
    if (this.diskLoaded) return undefined;
    this.diskLoaded = true;
    if (this.disableDiskCache) return undefined;

    let text: string;
    try {
      text = await fsp.readFile(this.cachePath, 'utf8');
    } catch {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const file = parsed as Partial<ProbeCacheFile>;
    if (file.version !== 1 || !Array.isArray(file.probes)) return undefined;
    if (typeof file.savedAt !== 'number' || !Number.isFinite(file.savedAt)) return undefined;
    if (Date.now() - file.savedAt > this.ttlMs) return undefined;

    const probes: MirrorProbe[] = [];
    for (const raw of file.probes) {
      const entry = validateCacheEntry(raw);
      if (entry !== undefined) probes.push(entry);
    }
    if (probes.length === 0) return undefined;

    this.cache = probes;
    this.cacheAt = file.savedAt;
    return probes;
  }

  /** 写磁盘缓存（失败不影响功能，只是下次要重测） */
  private async persist(probes: readonly MirrorProbe[]): Promise<void> {
    if (this.disableDiskCache) return;
    const payload: ProbeCacheFile = {
      version: 1,
      savedAt: Date.now(),
      probes: probes.map((p) => ({
        id: p.id,
        base: p.base,
        // JSON 不认识 Infinity，用 -1 表示"测过且失败"
        latencyMs: encodeLatency(p.latencyMs),
        ok: p.ok,
        probedAt: p.probedAt,
      })),
    };
    const file = this.cachePath;
    const tmp = `${file}.tmp`;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, file);
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** base 或 id → 规范化的 base（用作失败计数的 key） */
  private resolveKey(baseOrId: string): string | undefined {
    const raw = typeof baseOrId === 'string' ? baseOrId.trim() : '';
    if (raw === '') return undefined;
    // 1) 已知源 id（mojang / piston / bmclapi）
    const def = findMirror(raw);
    if (def !== undefined) return def.base;
    // 2) 产品级 id 表兜底
    const known = KNOWN_MIRROR_BASE[raw.toLowerCase()];
    if (known !== undefined) return known;
    // 3) 参与本实例测速的**自定义**源（仅当 id 不是已知源时才查，见上面的注释）
    const local = this.definitions.find((d) => d.id === raw.toLowerCase());
    if (local !== undefined && !(raw.toLowerCase() in KNOWN_MIRROR_BASE)) return local.base;
    // 4) 原样当作 base（Downloader 回调给的就是 base）
    return raw.replace(/\/+$/, '');
  }
}

// ───────────────────────────── 工具 ─────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 读到第一块非空数据（或流结束）就返回；用于区分「200 但挂住」与「200 且真的在传」 */
async function readFirstChunk(res: Response): Promise<void> {
  const body = res.body;
  if (body === null || body === undefined) {
    // 没有流（某些自定义 fetch 实现 / 已读完）→ 退化为读一小段文本
    await res.text().catch(() => undefined);
    return;
  }
  const reader = body.getReader();
  try {
    const first = await reader.read();
    if (first.done === true) return;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** 排序：可用的按延迟升序；不可用的排后面，同分按定义顺序 */
function sortProbes(list: readonly MirrorProbe[]): MirrorProbe[] {
  const order = new Map(MIRROR_DEFINITIONS.map((d, i) => [d.id, i]));
  return [...list].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.ok && b.ok && a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
    return (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99);
  });
}

function cloneProbe(p: MirrorProbe): MirrorProbe {
  return { id: p.id, base: p.base, latencyMs: p.latencyMs, ok: p.ok, probedAt: p.probedAt };
}

function cloneProbes(list: readonly MirrorProbe[]): MirrorProbe[] {
  return list.map(cloneProbe);
}

function normalizeId(id: string | undefined): string | undefined {
  if (typeof id !== 'string') return undefined;
  const text = id.trim().toLowerCase();
  return text === '' ? undefined : text;
}

function safeDataRoot(): string {
  try {
    return getDataRoot();
  } catch {
    return process.cwd();
  }
}
