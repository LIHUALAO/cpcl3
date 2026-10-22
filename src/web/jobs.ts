/**
 * 后台任务表（内存）。
 *
 * 安装 / 启动这类「要跑几十秒到几分钟」的操作不能阻塞 HTTP 请求：
 * POST 立刻返回 jobId，前端轮询 GET /api/jobs/:id 拿进度。
 *
 * 设计要点：
 *   - 纯内存 Map，进程退出即丢（进度本来就是临时状态）
 *   - 完成（成功或失败）后保留 10 分钟，方便前端刷新页面后还能看到上次结果
 *   - `status` 只有三种：running / done / failed —— 前端按它切 UI
 *   - 每个任务维护一段有上限的日志环形缓冲，避免启动一个话痨游戏后把内存吃满
 */

import { randomUUID } from 'node:crypto';

/** 任务状态 */
export type JobStatus = 'running' | 'done' | 'failed';

/** 任务种类（前端据此决定展示哪套进度文案） */
export type JobKind =
  | 'install'      // 安装原版
  | 'launch'       // 启动游戏
  | 'loaders'      // 安装 Fabric / Quilt
  | 'modpack'      // 整合包导入
  | 'packs'        // 资源包 / 数据包 / 光影安装
  | 'content'      // mod 下载（来自 Modrinth）
  | 'mods';        // mod 下载（历史命名，与 content 同义，保留以兼容既有调用方）

/** 一条日志 */
export interface JobLogLine {
  /** 毫秒时间戳 */
  time: number;
  /** 级别：info / warn / error */
  level: 'info' | 'warn' | 'error';
  /** 正文（已去除 ANSI 转义，前端直接显示） */
  text: string;
}

/** 任务对外快照（GET /api/jobs/:id 的返回体） */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  /** 人类可读标题，例如「安装 1.21」 */
  title: string;
  status: JobStatus;
  /** 当前阶段，例如 meta / libraries / assets / natives / done */
  phase: string;
  done: number;
  total: number;
  /** 0~1 的比例；total 为 0 时给 0，避免 NaN */
  ratio: number;
  /** 创建/最后更新时间（毫秒） */
  createdAt: number;
  updatedAt: number;
  /** 失败时的错误信息（人话） */
  error?: string;
  /** 附加结果（例如启动后的 pid、版本 id） */
  result?: Record<string, unknown>;
  /** 日志（最多保留最近 logLimit 条） */
  log: JobLogLine[];
}

/** 内部可变状态 */
interface JobRecord {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  phase: string;
  done: number;
  total: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  result?: Record<string, unknown>;
  log: JobLogLine[];
  /** 完成后清理定时器 */
  reapTimer?: NodeJS.Timeout;
}

/** 进度回调（与 install 模块的 onProgress 形状兼容，多余字段忽略） */
export interface ProgressLike {
  phase: string;
  done: number;
  total: number;
  current?: string;
}

export interface JobTableOptions {
  /** 完成后保留多久（毫秒），默认 10 分钟 */
  retainMs?: number;
  /** 每个任务最多保留多少行日志，默认 400 */
  logLimit?: number;
  /** 定时器实现（测试注入，默认全局 setTimeout） */
  setTimeoutImpl?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutImpl?: (timer: NodeJS.Timeout) => void;
}

export const DEFAULT_RETAIN_MS = 10 * 60 * 1000;
export const DEFAULT_LOG_LIMIT = 400;

/** 去掉 ANSI 颜色转义（游戏与 CLI 工具都会吐这些，前端直接显示会变成乱码） */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * 任务表。
 *
 * 所有变更都是同步的（Node 单线程，不存在竞态）；这里不用锁也不用 Promise。
 */
export class JobTable {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly retainMs: number;
  private readonly logLimit: number;
  private readonly timerImpl: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearImpl: (timer: NodeJS.Timeout) => void;

  constructor(opts: JobTableOptions = {}) {
    this.retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
    this.logLimit = Math.max(1, opts.logLimit ?? DEFAULT_LOG_LIMIT);
    this.timerImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearImpl = opts.clearTimeoutImpl ?? ((timer) => clearTimeout(timer));
  }

  /** 建一个新任务（状态 running），返回 id */
  create(kind: JobKind, title: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.jobs.set(id, {
      id,
      kind,
      title,
      status: 'running',
      phase: 'starting',
      done: 0,
      total: 0,
      createdAt: now,
      updatedAt: now,
      log: [],
    });
    return id;
  }

  /** 任务是否存在（不论状态） */
  has(id: string): boolean {
    return this.jobs.has(id);
  }

  /** 取快照；不存在返回 undefined */
  get(id: string): JobSnapshot | undefined {
    const rec = this.jobs.get(id);
    return rec === undefined ? undefined : toSnapshot(rec);
  }

  /** 列出全部任务（新的在前），供 /api/status 展示「正在装什么」 */
  list(): JobSnapshot[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(toSnapshot);
  }

  /** 是否还有正在运行的任务（同类互斥用） */
  runningOf(kind: JobKind): JobSnapshot | undefined {
    for (const rec of this.jobs.values()) {
      if (rec.kind === kind && rec.status === 'running') return toSnapshot(rec);
    }
    return undefined;
  }

  /** 更新进度（install 的 onProgress 直接丢进来） */
  progress(id: string, p: ProgressLike): void {
    const rec = this.jobs.get(id);
    if (rec === undefined || rec.status !== 'running') return;
    rec.phase = String(p.phase ?? rec.phase);
    rec.done = Number.isFinite(p.done) ? Math.max(0, Math.floor(p.done)) : rec.done;
    rec.total = Number.isFinite(p.total) ? Math.max(0, Math.floor(p.total)) : rec.total;
    rec.updatedAt = Date.now();
  }

  /** 追加一行日志 */
  log(id: string, text: string, level: JobLogLine['level'] = 'info'): void {
    const rec = this.jobs.get(id);
    if (rec === undefined) return;
    const clean = stripAnsi(String(text)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const line of clean.split('\n')) {
      if (line.length === 0) continue;
      rec.log.push({ time: Date.now(), level, text: line });
    }
    // 只保留尾部：启动游戏会刷几千行，没必要全留
    if (rec.log.length > this.logLimit) {
      rec.log.splice(0, rec.log.length - this.logLimit);
    }
    rec.updatedAt = Date.now();
  }

  /** 标记成功 */
  succeed(id: string, result?: Record<string, unknown>): void {
    const rec = this.jobs.get(id);
    if (rec === undefined) return;
    rec.status = 'done';
    rec.phase = 'done';
    if (rec.total > 0) rec.done = rec.total;
    if (result !== undefined) rec.result = result;
    rec.error = undefined;
    rec.updatedAt = Date.now();
    this.scheduleReap(rec);
  }

  /** 标记失败（error 应当是人话） */
  fail(id: string, error: string): void {
    const rec = this.jobs.get(id);
    if (rec === undefined) return;
    rec.status = 'failed';
    rec.phase = 'failed';
    rec.error = stripAnsi(error);
    rec.updatedAt = Date.now();
    this.log(id, rec.error, 'error');
    this.scheduleReap(rec);
  }

  /** 清空（关服务 / 测试用） */
  clear(): void {
    for (const rec of this.jobs.values()) {
      if (rec.reapTimer !== undefined) this.clearImpl(rec.reapTimer);
    }
    this.jobs.clear();
  }

  private scheduleReap(rec: JobRecord): void {
    if (rec.reapTimer !== undefined) this.clearImpl(rec.reapTimer);
    rec.reapTimer = this.timerImpl(() => {
      // 定时器不能抛错，否则会打崩进程
      try {
        this.jobs.delete(rec.id);
      } catch {
        /* 忽略 */
      }
    }, this.retainMs);
    // 不要让这个定时器拖住进程退出
    (rec.reapTimer as unknown as { unref?: () => void }).unref?.();
  }
}

function toSnapshot(rec: JobRecord): JobSnapshot {
  const snap: JobSnapshot = {
    id: rec.id,
    kind: rec.kind,
    title: rec.title,
    status: rec.status,
    phase: rec.phase,
    done: rec.done,
    total: rec.total,
    ratio: rec.total > 0 ? Math.min(1, Math.max(0, rec.done / rec.total)) : 0,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    log: rec.log.map((l) => ({ ...l })),
  };
  if (rec.error !== undefined) snap.error = rec.error;
  if (rec.result !== undefined) snap.result = { ...rec.result };
  return snap;
}
