/**
 * 启动命令行 → 「可以复制/分享」的文本 + 人话解读。
 *
 * 为什么需要它：
 *   `GameLauncher.buildCommand()` 交出来的是一条几百个参数、动辄上万字符的 argv。
 *   高级用户排查「为什么启动失败」时想要的是**能原样粘到终端里跑**的一句话；
 *   而论坛求助时又想要一眼看出「内存多少 / 用的哪个 Java / 哪个 classpath」。
 *   这两个需求对应同一份数据，所以在这里一次做完。
 *
 * 三条实现要点：
 *   1. **绝不泄露访问令牌**：`${auth_access_token}` 会被替换成真实 token 塞进命令行。
 *      分享出去的文本必须打码，否则等于把令牌贴到论坛上。默认（`redact: true`）打码。
 *   2. **命令行转义按目标平台来**：Windows 用 CRT 的引号规则（`\"` 与 `\\`），
 *      POSIX 用单引号包裹 + `'\''`。不是「随便加个引号」就行 —— 带空格的路径
 *      正是启动器最常见的路径形态（`C:\Program Files\…`）。
 *   3. **纯函数**：给什么算什么，不读盘不联网，方便单测每种怪路径。
 */

import * as path from 'node:path';

import type { BuiltCommand } from '../types.js';

/** 解读结果（数值已解析好，前端直接显示） */
export interface LaunchCommandSummary {
  java: string;
  cwd: string;
  /** 参数个数（不含 java 本身） */
  argCount: number;
  /** 字符数（拼成一行后的长度；Windows 上限 32767） */
  length: number;
  /** 堆大小 MB（来自 -Xmx），没有就是 null */
  maxMemoryMB: number | null;
  /** 初始堆 MB（来自 -Xms），没有就是 null */
  initMemoryMB: number | null;
  /** 主类（第一个不以 - 开头、也不是类路径值的参数） */
  mainClass: string | null;
  /** classpath 条目数（按 `;` / `:` 切分后计数） */
  classpathEntries: number;
  /** 是否把 classpath 落成了 argfile（`-cp @file`） */
  usesArgFile: boolean;
  /** 是否已经打码 */
  redacted: boolean;
  /** 可复制的完整命令行 */
  commandLine: string;
}

export interface FormatCommandOptions {
  /** 目标平台（决定引号规则），默认当前平台 */
  platform?: NodeJS.Platform;
  /**
   * 是否打码敏感值，默认 **true**。
   * 只有「用户自己要在本机终端里跑」时才关掉 —— Web UI 永远按打码处理。
   */
  redact?: boolean;
}

/** 需要打码的参数名（已做 `normalizeKey` 归一后的形式） */
const SECRET_KEYS = new Set([
  'authaccesstoken',
  'accesstoken',
  'authsession',
  'refreshtoken',
  'clientsecret',
  'token',
]);

/**
 * 打码：把「值是令牌」的参数换成 `<已隐藏>`，同时保留参数名的可读性。
 *
 * 也处理 `--accessToken XXXXX` 这种「名字与值分成两个 argv」的写法 ——
 * 游戏参数里确实有这种形态（`--clientId 123 --authSession abc`）。
 *
 * 键名比较**一律小写**：`auth_access_token` / `accessToken` / `--access-token`
 * 都得拦住，大小写漏一个就等于没打码。
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    // `-Dauth_access_token=abc` 的前缀是 JVM 属性（`-D`），不是参数名的一部分，
    // 所以先把它剥出来、打完码再拼回去，否则 `-Dauth_access_token` 永远匹配不上。
    const jvm = /^-D(?=[^=]+=)/.exec(arg);
    const prefix = jvm === null ? '' : '-D';
    const body = prefix === '' ? arg : arg.slice(2);

    const eq = body.indexOf('=');
    if (eq > 0) {
      const key = normalizeKey(body.slice(0, eq));
      if (SECRET_KEYS.has(key)) {
        out.push(`${prefix}${body.slice(0, eq)}=<已隐藏>`);
        continue;
      }
    }
    const bare = normalizeKey(body);
    if (prefix === '' && SECRET_KEYS.has(bare) && i + 1 < args.length) {
      out.push(arg);
      out.push('<已隐藏>');
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** 键名归一：去掉前导 `-`，把 `-` / `_` 都去掉，转小写 */
function normalizeKey(raw: string): string {
  return raw.trim().replace(/^-+/, '').replace(/[-_]/g, '').toLowerCase();
}

/**
 * 把 argv 拼成一行可粘贴的命令。
 *
 * 规则：
 *   - 含空格 / 制表 / 引号 / `\` / 特殊符号的参数加引号
 *   - Windows：`"a b"`，内部的 `"` 写成 `\"`，行尾的 `\` 双写
 *   - POSIX：`'a b'`，内部的 `'` 写成 `'\''`
 *   - 明显安全（纯 `[A-Za-z0-9._/:=+-]`）的参数不加引号，保持可读
 */
export function formatCommandLine(
  java: string,
  args: readonly string[],
  opts: FormatCommandOptions = {},
): string {
  const platform = opts.platform ?? process.platform;
  const quote = platform === 'win32' ? quoteWindows : quotePosix;
  return [java, ...args].map((part) => quote(String(part))).join(' ');
}

/** 从 argv 里捡出常用的几个值，拼成人话摘要 */
export function summarizeCommand(
  built: BuiltCommand,
  opts: FormatCommandOptions = {},
): LaunchCommandSummary {
  const platform = opts.platform ?? process.platform;
  const redact = opts.redact !== false;
  const rawArgs = built.args.map((a) => String(a));

  const maxMemoryMB = memoryOf(rawArgs, '-Xmx');
  const initMemoryMB = memoryOf(rawArgs, '-Xms');

  // classpath：可能是 `-cp <值>` 也可能是 `-cp @argfile`
  let classpathEntries = 0;
  let usesArgFile = false;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i] as string;
    if (arg !== '-cp' && arg !== '-classpath') continue;
    const value = rawArgs[i + 1] ?? '';
    if (value.startsWith('@')) {
      usesArgFile = true;
      break;
    }
    const sep = platform === 'win32' ? ';' : ':';
    classpathEntries = value.split(sep).filter((s) => s.length > 0).length;
    break;
  }

  const args = redact ? redactArgs(rawArgs) : rawArgs;
  const commandLine = formatCommandLine(built.java, args, { platform });

  return {
    java: built.java,
    cwd: built.cwd,
    argCount: rawArgs.length,
    length: commandLine.length,
    maxMemoryMB,
    initMemoryMB,
    mainClass: mainClassOf(rawArgs),
    classpathEntries,
    usesArgFile,
    redacted: redact,
    commandLine,
  };
}

// ───────────────────────────── 内部 ─────────────────────────────

/** `-Xmx4096M` / `-Xmx4G` / `-Xmx4096m` → MB */
function memoryOf(args: readonly string[], flag: string): number | null {
  for (const arg of args) {
    if (!arg.startsWith(flag)) continue;
    const text = arg.slice(flag.length).trim();
    const m = /^(\d+)([kKmMgGtT]?)$/.exec(text);
    if (m === null) continue;
    const value = Number(m[1]);
    const unit = (m[2] ?? '').toLowerCase();
    const factor = unit === 'k' ? 1 / 1024 : unit === 'g' ? 1024 : unit === 't' ? 1024 * 1024 : 1;
    const mb = Math.round(value * factor);
    return Number.isFinite(mb) && mb > 0 ? mb : null;
  }
  return null;
}

/**
 * 主类：JVM 参数里 `-cp <path>` 后面紧跟的那个「不带 - 的类名」。
 *
 * 不简单地取「第一个非 - 开头的参数」：`-cp` 的值本身就是非 `-` 开头，
 * 直接取会把 classpath 当成主类（这 bug 在排查日志里会把人带偏）。
 */
function mainClassOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '-cp' || arg === '-classpath' || arg === '-jar') {
      i += 1; // 跳过它的值
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

/** POSIX 引号：能裸奔就裸奔，否则单引号包裹 */
function quotePosix(text: string): string {
  if (text.length === 0) return "''";
  if (/^[A-Za-z0-9._/:=+@%^,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Windows 引号（CRT 规则）：反斜杠只在引号前 / 行尾才需要加倍 */
function quoteWindows(text: string): string {
  if (text.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(text)) return text;

  let out = '"';
  let backslashes = 0;
  for (const ch of text) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // 结尾的反斜杠必须加倍，否则会把收尾的引号转义掉
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

/** 只取文件名（前端显示 cwd 太长时用） */
export function baseNameOf(target: string): string {
  return path.basename(target) || target;
}
