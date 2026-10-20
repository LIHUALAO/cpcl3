/**
 * ANSI 终端样式与进度条 —— 不引任何第三方依赖（不用 chalk / ora / cli-progress）。
 *
 * 原则：
 * - 颜色与动态刷新只在 TTY 上启用；输出被重定向时退化成纯文本，日志里不留转义码。
 * - 环境变量可强制：`NO_COLOR=1` 关色，`CLICOLOR_FORCE=1` 强制开色。
 * - 进度条用 `\r` 原地重绘，宽度按 COLUMNS 自适应（默认 80 列）。
 */

const env = process.env;

function envFlag(name: string): boolean {
  const v = env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

/** 是否输出彩色：显式强制 > NO_COLOR > TTY 判断 */
export function colorEnabled(): boolean {
  if (envFlag('CLICOLOR_FORCE')) return true;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  return process.stdout.isTTY === true;
}

/** 是否做动态刷新（进度条重绘、spinner） */
export function dynamicEnabled(): boolean {
  if (envFlag('CLICOLOR_FORCE')) return true;
  return process.stdout.isTTY === true;
}

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
} as const;

export type ColorName = keyof typeof CODES;

/** 包一层颜色转义；未启用颜色时原样返回 */
export function paint(text: string, ...colors: ColorName[]): string {
  if (!colorEnabled() || colors.length === 0) return text;
  const prefix = colors.map((c) => CODES[c]).join('');
  return `${prefix}${text}${CODES.reset}`;
}

export const bold = (t: string): string => paint(t, 'bold');
export const dim = (t: string): string => paint(t, 'dim');
export const gray = (t: string): string => paint(t, 'gray');
export const red = (t: string): string => paint(t, 'red');
export const green = (t: string): string => paint(t, 'green');
export const yellow = (t: string): string => paint(t, 'yellow');
export const cyan = (t: string): string => paint(t, 'cyan');
export const blue = (t: string): string => paint(t, 'blue');

/** 清掉当前行的可见内容（不换行） */
function clearLine(): string {
  return '\u001b[2K\r';
}

export function write(s: string): void {
  process.stdout.write(s);
}

export function writeLine(s = ''): void {
  process.stdout.write(`${s}\n`);
}

// ───────────────────────────── 进度条 ─────────────────────────────

export interface ProgressBarOptions {
  /** 总步数；为 0 时显示不确定态 */
  total: number;
  /** 标签，例如 "assets" */
  label: string;
  /** 条宽（不含标签/百分比），默认按终端宽度推算 */
  width?: number;
}

/**
 * 极简进度条。
 *
 *   [assets      ] ████████████░░░░░░░░  58%  1450/2500
 */
export class ProgressBar {
  private readonly total: number;
  private readonly label: string;
  private readonly width: number;
  private done = 0;
  private lastRender = 0;
  private closed = false;

  constructor(opts: ProgressBarOptions) {
    this.total = Math.max(0, Math.floor(opts.total));
    this.label = opts.label;
    this.width = opts.width ?? adaptiveWidth(this.label);
  }

  update(done: number, current?: string): void {
    if (this.closed) return;
    const clamped = Math.max(0, Math.min(this.total || done, Math.floor(done)));
    this.done = clamped;

    if (!dynamicEnabled()) {
      // 非 TTY：只在关键节点打一行，避免刷屏
      if (clamped === this.total || clamped === 0) {
        writeLine(`  ${this.label}: ${String(clamped)}/${String(this.total)}${current ? `  ${current}` : ''}`);
      }
      return;
    }

    const now = Date.now();
    // 限流到 ~20fps，别让重绘拖慢下载
    if (now - this.lastRender < 50 && clamped !== this.total) return;
    this.lastRender = now;

    const ratio = this.total === 0 ? 0 : clamped / this.total;
    const filled = Math.round(ratio * this.width);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, this.width - filled))}`;
    const pct = String(Math.floor(ratio * 100)).padStart(3, ' ');
    const label = this.label.padEnd(10, ' ');
    const counter = this.total === 0 ? '' : `  ${String(clamped)}/${String(this.total)}`;
    const tail = current ? `  ${truncate(current, 32)}` : '';
    write(`\r${clearLine()}  ${cyan(label)} [${green(bar)}] ${pct}%${gray(counter)}${gray(tail)}`);
  }

  /** 结束绘制并换行 */
  finish(message?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (dynamicEnabled()) {
      write('\r\u001b[2K');
    }
    if (message !== undefined) writeLine(message);
  }
}

function terminalWidth(): number {
  const cols = Number.parseInt(env['COLUMNS'] ?? '', 10);
  if (Number.isFinite(cols) && cols > 20) return cols;
  return 80;
}

function adaptiveWidth(label: string): number {
  // 预留：2 前缀 + 10 标签 + 3 括号空格 + 4 百分比 + 计数尾部
  const reserved = 2 + 10 + 4 + 12 + 8 + label.length;
  return Math.max(10, Math.min(40, terminalWidth() - reserved));
}

/** 按可见宽度截断（不处理宽字符，路径场景够用） */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `…${text.slice(-(max - 1))}`;
}

// ───────────────────────────── 表格 ─────────────────────────────

/**
 * 打一张等宽表。列宽按内容自适应，中文按 2 列宽估算。
 * 返回渲染好的字符串，便于测试。
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const cells = rows.map((r) => displayWidth(r[i] ?? ''));
    return Math.max(displayWidth(h), ...(cells.length > 0 ? cells : [0]));
  });

  const pad = (text: string, width: number): string => {
    const diff = width - displayWidth(text);
    return diff > 0 ? text + ' '.repeat(diff) : text;
  };

  const lines: string[] = [];
  lines.push(headers.map((h, i) => bold(pad(h, widths[i] ?? 0))).join('  '));
  lines.push(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) {
    lines.push(row.map((cell, i) => pad(cell ?? '', widths[i] ?? 0)).join('  '));
  }
  return lines.join('\n');
}

/** 估算终端显示宽度：CJK / 全角符号按 2 算 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 字节数 → 人类可读 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const fixed = idx === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${fixed} ${units[idx] ?? 'B'}`;
}
