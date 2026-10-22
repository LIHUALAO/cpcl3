/**
 * 崩溃日志分析器 —— **基础版**，只做模式匹配 + 人话结论，不解析堆栈。
 *
 * 明确的能力边界（写在最前面，免得后来人以为它有多聪明）：
 *   - 不建栈帧、不追调用链、不读 class 文件
 *   - 不做「根因推断」：同一条日志里出现两条特征就给两条 finding，
 *     由人决定哪条才是真凶（我们给出严重程度与先后顺序，但不假装确定）
 *   - 识别不出来就老实说「没看懂」，把原始日志摘要交出去，**绝不编造结论**
 *
 * 每条 finding 必须带 `evidence`（日志里的真实行）。空口白话的结论比没有结论更糟。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { getDataRoot } from '../download/paths.js';

/** 分类 */
export type CrashKind =
  | 'java-version'
  | 'missing-file'
  | 'out-of-memory'
  | 'mod-conflict'
  | 'gl-driver'
  | 'unknown';

/** 一条分析结论 */
export interface CrashFinding {
  /** 分类 */
  kind: CrashKind;
  /** 一句话人话结论 */
  title: string;
  /** 详细说明与建议 */
  detail: string;
  /** 从日志里摘出的证据行（最多 5 条） */
  evidence: string[];
  /** 严重程度 */
  severity: 'error' | 'warn';
}

export interface AnalyzeInstanceResult {
  /** 找到的崩溃报告路径（相对数据目录时为绝对路径） */
  reportPath?: string;
  findings: CrashFinding[];
  /** 没找到报告时的原因（人话），有报告时为 undefined */
  reason?: string;
  /** 报告最后修改时间（毫秒），有报告时给 */
  mtimeMs?: number;
}

export interface CrashAnalyzerOptions {
  /** 数据根（默认 getDataRoot()） */
  dataRoot?: string;
  /** 每次最多读多少字节的日志（防止用户选了上百 MB 的 latest.log 卡死） */
  maxBytes?: number;
}

/** 每类最多留几条证据 */
export const MAX_EVIDENCE = 5;

/** 默认读取上限：8 MB 足够覆盖任何真实崩溃报告（正常几 KB ~ 几百 KB） */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 内存建议：日志里读不出 -Xmx 时的建议值 */
const DEFAULT_XMX_ADVICE_MB = 4096;

// ───────────────────────────── 规则定义 ─────────────────────────────

interface RuleContext {
  /** 全部日志行 */
  lines: string[];
  /** 全文（小写），给不区分大小写的匹配用 */
  lower: string;
}

interface Rule {
  kind: Exclude<CrashKind, 'unknown'>;
  severity: 'error' | 'warn';
  /** 命中判定：返回命中的行号（0 基）；不命中返回 null */
  match: (ctx: RuleContext) => number | null;
  /** 生成结论 */
  build: (ctx: RuleContext, hits: number[]) => Pick<CrashFinding, 'title' | 'detail'>;
  /** 额外证据行号（可选） */
  extra?: (ctx: RuleContext) => number[];
}

function findLine(ctx: RuleContext, pattern: RegExp): number {
  for (let i = 0; i < ctx.lines.length; i += 1) {
    if (pattern.test(ctx.lines[i] as string)) return i;
  }
  return -1;
}

function findAllLines(ctx: RuleContext, pattern: RegExp, limit = 40): number[] {
  const out: number[] = [];
  for (let i = 0; i < ctx.lines.length; i += 1) {
    if (pattern.test(ctx.lines[i] as string)) {
      out.push(i);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** mod 冲突的相关行（`build` 里用来跨行收集 mod 名） */
const MOD_CONFLICT_EXTRA_RE =
  /Duplicate mods|Found a duplicate mod|Mixin apply failed|NoSuchMethodError|NoClassDefFoundError|Incompatible mod set|Missing dependencies/i;

function RULES_MOD_CONFLICT_EXTRA(ctx: RuleContext): number[] {
  return findAllLines(ctx, MOD_CONFLICT_EXTRA_RE, 6);
}

/** 行号去重（保序，丢掉负数） */
function dedupeIndexes(indexes: readonly number[]): number[] {
  const out: number[] = [];
  for (const i of indexes) {
    if (i >= 0 && !out.includes(i)) out.push(i);
  }
  return out;
}

/** `UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 52.0` */
const CLASS_FILE_RE = /class file version ([\d.]+)/i;
const REQUIRES_JAVA_RE = /requires (?:Java|java|java\.runtime\.version)[^\d]{0,12}(\d{1,3})/;

/** class file version → Java 大版本（JDK 的对应表，8 之后是 44 + N - 8，即 v + 44 - 8 = v + 36） */
export function javaVersionOfClassFile(classFileVersion: number): number | undefined {
  if (!Number.isFinite(classFileVersion) || classFileVersion <= 0) return undefined;
  if (classFileVersion === 45) return 1; // JDK 1.1
  if (classFileVersion >= 48) return classFileVersion - 44; // 52 → 8, 61 → 17, 65 → 21, 66 → 22
  if (classFileVersion >= 46) return classFileVersion - 44; // 46 → 2 …（历史值）
  return undefined;
}

/** 从日志里找「当前 Java 大版本」：`java version "17.0.9"` / `Java Version: 21.0.1` */
export function detectJavaMajor(ctx: RuleContext): number | undefined {
  const patterns = [
    /(?:java|jvm) version:\s*(\d{1,3})/i,
    /java version "(\d{1,3})/i,
    /openjdk(?: version)?\s*"?(\d{1,3})/i,
  ];
  for (const pattern of patterns) {
    const at = findLine(ctx, pattern);
    if (at < 0) continue;
    const m = pattern.exec(ctx.lines[at] as string);
    const major = m === null ? Number.NaN : Number(m[1]);
    if (Number.isFinite(major) && major > 0) return major;
  }
  return undefined;
}

/** 从 `-Xmx4G` / `-Xmx4096M` 里读出 MB 数 */
export function parseXmxMb(text: string): number | undefined {
  const m = /-Xmx(\d+)([kKmMgG])?/i.exec(text);
  if (m === null) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] ?? 'M').toLowerCase();
  if (unit === 'g') return n * 1024;
  if (unit === 'k') return Math.max(1, Math.round(n / 1024));
  return n;
}

/** 从日志里找 jvm 参数行（崩溃报告头部的 `JVM Flags:` 或 stdout 回显） */
function detectXmx(ctx: RuleContext): number | undefined {
  for (const line of ctx.lines) {
    if (!/-Xmx/i.test(line)) continue;
    const mb = parseXmxMb(line);
    if (mb !== undefined) return mb;
  }
  return undefined;
}

const RULES: Rule[] = [
  // ── 1. Java 版本不对 ────────────────────────────────────────────
  {
    kind: 'java-version',
    severity: 'error',
    match: (ctx) => {
      const at = findLine(ctx, /UnsupportedClassVersionError/i);
      if (at >= 0) return at;
      return findLine(ctx, /requires (?:Java|java)\s*\d/i);
    },
    build: (ctx, hits) => {
      const text = ctx.lines[hits[0] as number] ?? '';
      const classFile = CLASS_FILE_RE.exec(ctx.lower);
      const requiredFromClass = classFile === null
        ? undefined
        : javaVersionOfClassFile(Number(classFile[1]));
      const requiresMatch = REQUIRES_JAVA_RE.exec(ctx.lower);
      const requiredFromText = requiresMatch === null ? undefined : Number(requiresMatch[1]);
      const required = requiredFromText ?? requiredFromClass;
      const current = detectJavaMajor(ctx);

      if (required !== undefined && current !== undefined) {
        return {
          title: `这个版本需要 Java ${String(required)}，你当前是 Java ${String(current)}`,
          detail:
            `游戏用 Java ${String(current)} 启动，但里面有 class 是给 Java ${String(required)} 以上编译的，`
            + `JVM 直接拒绝加载（UnsupportedClassVersionError）。\n`
            + `建议：在「设置 → 实例设置」里把 Java 路径指向 Java ${String(required)}（或更高的 64 位 JDK），`
            + '或者在本启动器的数据目录 java/ 下放一份对应版本的 JRE，让自动查找命中。',
        };
      }
      if (required !== undefined) {
        return {
          title: `这个版本需要 Java ${String(required)}，当前 Java 版本偏低`,
          detail:
            `日志里明确写了需要 Java ${String(required)}，当前使用的 Java 版本不能满足它。\n`
            + `建议：在「设置 → 实例设置」里把 Java 路径指向 Java ${String(required)} 或更高版本。`,
        };
      }
      return {
        title: 'Java 版本与游戏要求不匹配',
        detail:
          '日志里有 UnsupportedClassVersionError，说明某个 class 是新版 Java 编译的，而当前 JVM 太旧。\n'
          + '建议：换用更新的 64 位 JDK（1.20.5 以上通常要 Java 21；1.17 ~ 1.20.4 要 Java 17；1.16 及以下要 Java 8）。',
      };
    },
    extra: (ctx) => {
      const out: number[] = [];
      for (const pattern of [/UnsupportedClassVersionError/i, /class file version/i, /(?:java|jvm) version/i, /Java Version:/i]) {
        const at = findLine(ctx, pattern);
        if (at >= 0) out.push(at);
      }
      return out;
    },
  },

  // ── 2. 缺文件（资源 / 依赖库 / 游戏本体） ───────────────────────
  {
    kind: 'missing-file',
    severity: 'error',
    match: (ctx) => {
      const at = findLine(ctx, /java\.nio\.file\.NoSuchFileException/i);
      if (at >= 0) return at;
      const fnf = findLine(ctx, /java\.io\.FileNotFoundException/i);
      if (fnf >= 0) return fnf;
      return findLine(ctx, /FileNotFoundException|NoSuchFileException/);
    },
    build: (ctx, hits) => {
      const evidenceLine = ctx.lines[hits[0] as number] ?? '';
      const missingPath = extractMissingPath(evidenceLine, ctx.lines);
      const isAsset = /assets|objects|indexes/i.test(missingPath ?? evidenceLine);
      const isLib = /libraries/i.test(missingPath ?? evidenceLine);
      const what = isAsset ? '游戏资源（assets）' : isLib ? '依赖库（libraries）' : '游戏文件';

      const sample = missingPath === undefined ? '' : `\n缺失的具体路径：${missingPath}`;
      return {
        title: `游戏文件不完整：缺少${what}`,
        detail:
          `游戏启动时找不到必需的${what}，通常是下载中断、被清理软件删掉，或者手动动过数据目录。${sample}\n`
          + '建议：在这个版本卡片上点「重装 / 修复文件」，让启动器重新校验并补齐缺失项（已存在的文件不会重复下载）。',
      };
    },
    extra: (ctx) => {
      const out = findAllLines(ctx, /NoSuchFileException|FileNotFoundException/i, 3);
      return out;
    },
  },

  // ── 3. 内存不足 ────────────────────────────────────────────────
  {
    kind: 'out-of-memory',
    severity: 'error',
    match: (ctx) => {
      const oom = findLine(ctx, /java\.lang\.OutOfMemoryError/i);
      if (oom >= 0) return oom;
      return findLine(ctx, /OutOfMemoryError|GC overhead limit exceeded/i);
    },
    build: (ctx, hits) => {
      const text = ctx.lines[hits[0] as number] ?? '';
      const heapKind = /OutOfMemoryError:\s*Java heap space/i.test(text) ? 'Java 堆' : undefined;
      const currentXmx = detectXmx(ctx);
      const advice = currentXmx === undefined
        ? DEFAULT_XMX_ADVICE_MB
        : Math.min(65536, Math.max(currentXmx + 2048, Math.round((currentXmx * 1.5) / 512) * 512));

      const current = currentXmx === undefined ? '未知（日志里没找到 -Xmx）' : `${String(currentXmx)} MB`;
      return {
        title: `内存不足（${heapKind ?? '堆/元空间'}耗尽）`,
        detail:
          `JVM 已经用光分配给游戏的堆内存。当前 -Xmx：${current}。\n`
          + `建议：在「设置 → 实例设置」里把最大内存调到 ${String(advice)} MB 以上`
          + '（整合包普遍需要 4 ~ 8 GB；但不要超过物理内存的 60%，给系统留出余量）。\n'
          + '如果已经给了 8 GB 还爆，多半是某个 mod 在泄内存 —— 这种情况加到 16 GB 也只是拖时间。',
      };
    },
    extra: (ctx) => findAllLines(ctx, /OutOfMemoryError|GC overhead limit exceeded|-Xmx/i, 3),
  },

  // ── 4. Mod 冲突 ────────────────────────────────────────────────
  {
    kind: 'mod-conflict',
    severity: 'error',
    match: (ctx) => {
      const dup = findLine(ctx, /Duplicate mods/i);
      if (dup >= 0) return dup;
      const mixin = findLine(ctx, /Mixin apply failed|MixinApplyError|MixinTransformerError/i);
      if (mixin >= 0) return mixin;
      const nosuch = findLine(ctx, /java\.lang\.NoSuchMethodError/i);
      if (nosuch >= 0) return nosuch;
      const mismatch = findLine(ctx, /Incompatible mod set|Missing dependencies|mod resolution/i);
      if (mismatch >= 0) return mismatch;
      return findLine(ctx, /java\.lang\.NoClassDefFoundError/i);
    },
    build: (ctx, hits) => {
      // 从**所有**命中的行里收集 mod 名，而不只是第一条 ——
      // Forge 的 `Duplicate mods found` 那一行只有一句话，真正带 jar 名的在下一行
      // （`Found a duplicate mod jei at [C:\...\jei-1.20.1-15.2.0.27.jar, ...]`）。
      // 只认第一条命中就会得到"可能是某两个 mod"这种没用的结论。
      const hitIndexes = dedupeIndexes([hits[0] as number, ...(RULES_MOD_CONFLICT_EXTRA(ctx) ?? [])]);
      const scopeLines = hitIndexes.map((i) => ctx.lines[i] ?? '').join('\n');
      const mods = extractModIds(ctx, scopeLines.length > 0 ? scopeLines : (ctx.lines[hits[0] as number] ?? ''));
      const hitLine = ctx.lines[hits[0] as number] ?? '';
      const [a, b] = [mods[0], mods[1]];
      const suspicion = a !== undefined
        ? (b !== undefined ? `可能是「${a}」和「${b}」` : `可能是「${a}」`)
        : '可能是某两个 mod 之间冲突';

      const isMixin = /Mixin apply failed|MixinApplyError|MixinTransformerError/i.test(hitLine);
      const isDup = /Duplicate mods/i.test(hitLine);
      const isNoSuchMethod = /NoSuchMethodError|NoClassDefFoundError/i.test(hitLine);
      const lead = isDup
        ? '日志里有 Duplicate mods：同一个 mod 装了多份（常见于 jar 和文件夹两份，或新旧两个版本同时在 mods/ 里）。'
        : isMixin
          ? '日志里有 Mixin apply failed：某个 mod 试图改写游戏/其它 mod 的方法，但那里已经变了（版本不匹配）。'
          : isNoSuchMethod
            ? '日志里有 NoSuchMethodError / NoClassDefFoundError：某个 mod 按旧版本 API 编译，运行时的类已经不在了。'
            : hitLine.length > 0
              ? `日志里报的是：${hitLine.slice(0, 200)}`
              : '日志里出现了 mod 加载期的链接错误。';

      return {
        title: `疑似 mod 冲突，${suspicion}`,
        detail:
          `${lead}\n`
          + `线索：${suspicion}。\n`
          + '建议：① 先把 mods/ 里重复的那份删掉（同名不同版本只留一个）；'
          + '② 还是崩就二分排查 —— 移走一半 mod 再试，逐步缩小范围；'
          + '③ 确认 Forge / Fabric 加载器与 mod 的大版本对应（例如 Fabric API 要跟着加载器走）。',
      };
    },
    extra: (ctx) =>
      findAllLines(
        ctx,
        /Duplicate mods|Mixin apply failed|NoSuchMethodError|NoClassDefFoundError|Incompatible mod set|Missing dependencies/i,
        3,
      ),
  },

  // ── 5. 显卡 / OpenGL ──────────────────────────────────────────
  {
    kind: 'gl-driver',
    severity: 'error',
    match: (ctx) => {
      const pixel = findLine(ctx, /Pixel format not accelerated/i);
      if (pixel >= 0) return pixel;
      const window = findLine(ctx, /Failed to create window|GLFW error|Failed to create GL context/i);
      if (window >= 0) return window;
      const gl = findLine(ctx, /OpenGL|GL_ERROR|org\.lwjgl\.opengl|IllegalStateException: GL/i);
      if (gl >= 0) return gl;
      return findLine(ctx, /The game crashed whilst initializing the game|Init Failed: Pixel format/i);
    },
    build: (ctx, hits) => {
      const text = ctx.lines[hits[0] as number] ?? '';
      const renderer = /(?:OpenGL|GL) (?:version|Version)[:\s]+([^\r\n,]{1,40})/.exec(text)?.[1];
      const vendor = /(?:Vendor|vendor)[:\s]+([^\r\n,]{1,60})/.exec(text)?.[1];
      const glHint = renderer === undefined && vendor === undefined
        ? ''
        : `\n日志里的图形信息：${[vendor, renderer].filter((x) => x !== undefined).join(' / ')}`;

      const pixelFormat = /Pixel format not accelerated/i.test(text)
        ? '\n「Pixel format not accelerated」几乎只有一个含义：显卡驱动没给出硬件加速的像素格式，'
          + '游戏拿不到 OpenGL 上下文。'
        : '';

      return {
        title: '显卡驱动 / OpenGL 问题，游戏无法初始化画面',
        detail:
          '游戏在创建窗口或初始化 OpenGL 时失败。'
          + glHint
          + pixelFormat
          + '\n建议：① 更新显卡驱动到官方最新版（NVIDIA / AMD / Intel 官网，别用系统自带的通用驱动）；'
          + '② 双显卡笔记本请强制 java(javaw.exe) 用独显运行；'
          + '③ 远程桌面 / 虚拟机里通常没有可用的 OpenGL，换到物理机试；'
          + '④ 还不行就换一个更轻量的渲染后端（例如装 Sodium / OptiFine，或降低「图形」设置）。',
      };
    },
    extra: (ctx) =>
      findAllLines(ctx, /Pixel format not accelerated|Failed to create window|GLFW error|OpenGL|Vendor:/i, 3),
  },
];

// ───────────────────────────── 证据抽取 ─────────────────────────────

/**
 * 从 NoSuchFileException 那一行捞缺失路径。
 *
 * 三种常见形态：
 *   java.nio.file.NoSuchFileException: C:\...\assets\objects\ab\abcdef
 *   Caused by: java.io.FileNotFoundException: .\libraries\... (系统找不到指定的路径。)
 *   java.io.FileNotFoundException: assets/indexes/17.json (No such file or directory)
 */
export function extractMissingPath(line: string, allLines: readonly string[] = []): string | undefined {
  const source = [line, ...allLines.slice(0, 0)].join('\n');
  const inline = /(?:NoSuchFileException|FileNotFoundException)(?::\s*)(.+)$/i.exec(source);
  if (inline !== null) {
    const raw = (inline[1] as string).trim();
    // 去掉尾部的 "(No such file or directory)" / "(系统找不到指定的路径。)"
    const cleaned = raw.replace(/\s*\((?:No such file or directory|系统找不到指定的[^)]*)\)\s*$/i, '').trim();
    if (cleaned.length > 0) return cleaned;
  }
  // 有些栈里路径在下一行（`at java.base/...`），尽力找一条像路径的行
  for (const candidate of allLines) {
    const m = /([A-Za-z]:\\[^\s"']+|\/(?:[^\s"']+\/[^\s"']+))/.exec(candidate);
    if (m !== null) return m[1];
  }
  return undefined;
}

/** 从一行里抽取 mod 名（`modid "create"` / `create-0.5.1.jar` / `[jei, jei]`） */
export function extractModIds(ctx: RuleContext, hitLine: string): string[] {
  const out: string[] = [];
  const push = (value: string | undefined): void => {
    if (value === undefined) return;
    const clean = value.trim().replace(/^["'[]|["'\]]$/g, '');
    if (clean.length === 0 || clean.length > 60) return;
    // 时间戳 / 版本号 / 纯数字不是 mod 名 —— 宁可少说一个，也不要点错名
    if (/^\d+$/.test(clean)) return;
    if (/^\d{1,2}:\d{2}:\d{2}$/.test(clean)) return;
    if (/^\d+(\.\d+)+$/.test(clean)) return;
    if (out.includes(clean)) return;
    out.push(clean);
  };

  // 1) 命中行里的 jar 文件名（最可靠：`jei-1.20.1-forge-15.2.0.27.jar` → jei）
  for (const m of hitLine.matchAll(/([A-Za-z][A-Za-z0-9_.+-]{1,80})\.jar\b/g)) {
    const raw = m[1] as string;
    // 去掉尾部的 -<版本号>（含 mc 版本段），保留 mod 名
    const name = raw.replace(/-\d[\w.+-]*$/i, '');
    push(name.length > 0 ? name : raw);
  }

  // 2) 显式的 modid 声明（` modid "create"` / `modId=create`）
  for (const m of hitLine.matchAll(/mod[_ ]?id\s*[:=]?\s*["']?([A-Za-z0-9_.-]{2,60})/gi)) push(m[1]);

  // 3) 方括号里的列表（`Duplicate mods found: [jei, jei]`），优先取以逗号分隔的短词
  const bracket = /\[([^\]]{2,300})\]/.exec(hitLine);
  if (bracket !== null) {
    for (const part of (bracket[1] as string).split(/[,;]/)) {
      const piece = part.trim();
      // 已经是路径时取文件名主干
      const file = /([^\\/]+)\.jar$/i.exec(piece);
      if (file !== null) {
        push((file[1] as string).replace(/-\d[\w.+-]*$/i, ''));
        continue;
      }
      push(piece);
      if (out.length >= 4) break;
    }
  }

  // 4) `Mixin apply failed <modid>.mixins.json:<Mixin> -> <target>`
  for (const m of hitLine.matchAll(/([A-Za-z][A-Za-z0-9_]{1,40})\.mixins\.json/gi)) push(m[1]);

  // 5) 还没凑够 2 个：去邻近几行里找 mod id 声明 / 可疑 jar 名
  if (out.length < 2) {
    for (const line of ctx.lines) {
      const m = /\bmod[_ ]?id\s*[:=]\s*["']?([A-Za-z0-9_.-]{2,60})/i.exec(line);
      if (m !== null) push(m[1]);
      if (out.length >= 2) break;
    }
  }
  return out.slice(0, 4);
}

// ───────────────────────────── 主体 ─────────────────────────────

export class CrashAnalyzer {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(opts: CrashAnalyzerOptions = {}) {
    this.root = path.resolve(opts.dataRoot ?? safeDataRoot());
    this.maxBytes = Math.max(1024, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES));
  }

  /** 数据根（排障用） */
  get dataRoot(): string {
    return this.root;
  }

  /**
   * 从日志文本分析。
   *
   * 永不抛错：任何输入（空串、乱码、二进制垃圾）都会得到至少一条 finding。
   * 识别不出就给 `unknown`，`evidence` 里放原始日志摘要，**不编造结论**。
   */
  analyze(logText: string): CrashFinding[] {
    const text = typeof logText === 'string' ? logText : '';
    const lines = text.split(/\r\n|\r|\n/);
    const ctx: RuleContext = { lines, lower: text.toLowerCase() };

    const findings: CrashFinding[] = [];
    for (const rule of RULES) {
      const at = rule.match(ctx);
      // 约定：命中返回行号（>=0），不命中返回 null（见 Rule.match 的注释）
      if (at === null || at < 0) continue;

      const hitList: number[] = [at, ...(rule.extra?.(ctx) ?? [])];
      const evidence = collectEvidence(lines, hitList);
      // 铁律：没有证据就不下结论
      if (evidence.length === 0) continue;

      const { title, detail } = rule.build(ctx, [at]);
      findings.push({ kind: rule.kind, severity: rule.severity, title, detail, evidence });
    }

    if (findings.length === 0) return [unknownFinding(lines)];
    return findings;
  }

  /**
   * 从实例目录读最新 crash-report 并分析。
   *
   * 查找顺序（第一个找到就用）：
   *   1. `<dataRoot>/instances/<id>/crash-reports/*.txt`（最新）
   *   2. `<dataRoot>/instances/<id>/logs/latest.log`
   *   3. `<dataRoot>/instances/<id>/crash-report.txt`
   *
   * 找不到不抛错：返回 `findings: []` + `reason`，让界面能说「还没有崩溃记录」。
   */
  async analyzeInstance(instanceId: string, opts: { dataRoot?: string } = {}): Promise<AnalyzeInstanceResult> {
    const id = typeof instanceId === 'string' ? instanceId.trim() : '';
    if (id === '' || id === '.' || id === '..' || /[\\/]/.test(id)) {
      return { findings: [], reason: `实例 id 不合法：${instanceId ?? ''}` };
    }

    const root = path.resolve(opts.dataRoot ?? this.root);
    const instanceDir = path.join(root, 'instances', id);

    const crashDir = path.join(instanceDir, 'crash-reports');
    const latestCrash = await newestFile(crashDir, /\.txt$/i);
    if (latestCrash !== undefined) {
      const read = await this.readFile(latestCrash.path);
      return {
        reportPath: latestCrash.path,
        findings: this.analyze(read),
        mtimeMs: latestCrash.mtimeMs,
      };
    }

    const latestLog = path.join(instanceDir, 'logs', 'latest.log');
    const logStat = await fsp.stat(latestLog).catch(() => undefined);
    if (logStat?.isFile() === true) {
      const read = await this.readFile(latestLog);
      return {
        reportPath: latestLog,
        findings: this.analyze(read),
        mtimeMs: logStat.mtimeMs,
      };
    }

    const legacy = path.join(instanceDir, 'crash-report.txt');
    const legacyStat = await fsp.stat(legacy).catch(() => undefined);
    if (legacyStat?.isFile() === true) {
      const read = await this.readFile(legacy);
      return {
        reportPath: legacy,
        findings: this.analyze(read),
        mtimeMs: legacyStat.mtimeMs,
      };
    }

    return {
      findings: [],
      reason: `实例 ${id} 还没有崩溃报告（${crashDir} 与 logs/latest.log 都不存在），说明它可能还没崩过。`,
    };
  }

  /** 读文件（带上限；超长只读尾部，崩溃结论几乎总在尾部） */
  private async readFile(file: string): Promise<string> {
    try {
      const stat = await fsp.stat(file);
      if (stat.size > this.maxBytes) {
        const handle = await fsp.open(file, 'r');
        try {
          const length = this.maxBytes;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
          return buffer.toString('utf8');
        } finally {
          await handle.close();
        }
      }
      return await fsp.readFile(file, 'utf8');
    } catch {
      return '';
    }
  }
}

// ───────────────────────────── 辅助 ─────────────────────────────

/** 从命中行号收集证据：最多 MAX_EVIDENCE 条，保序去重，长行截断 */
function collectEvidence(lines: readonly string[], hitIndexes: readonly number[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const index of hitIndexes) {
    const raw = lines[index];
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text.length === 0) continue;
    // 截断超长行（有的 mod 会把整个 classpath 打一行）
    const clipped = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

/** 兜底：识别不出来就交原始摘要，不编造任何结论 */
function unknownFinding(lines: readonly string[]): CrashFinding {
  const useful = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // 优先挑「看起来像错误」的行；没有就取最后几行（崩溃总在尾部）
    .filter((l) => /error|exception|crash|fail|fatal|崩溃|异常/i.test(l));
  const picked = (useful.length > 0 ? useful.slice(-MAX_EVIDENCE) : lines.map((l) => l.trim()).filter((l) => l.length > 0).slice(-MAX_EVIDENCE))
    .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));

  return {
    kind: 'unknown',
    severity: 'warn',
    title: '没看懂这条崩溃日志（已附原文摘要）',
    detail:
      '基础版分析没匹配到已知的崩溃特征。这不是「没问题」，而是我们暂时不认识这个错误。\n'
      + '下一步：把下面的原文摘要（或整个 crash-report 文件）发到问题反馈里，'
      + '并附上「游戏版本 + 加载器版本 + 最近的 Java 版本」这三样信息。\n'
      + '自己排查的快捷路径：先只留原版启动 —— 能进就是 mod 的问题；进不去就查 Java 与显卡驱动。',
    evidence: picked,
  };
}

/** 目录里按 mtime 最新的那个匹配文件 */
async function newestFile(dir: string, pattern: RegExp): Promise<{ path: string; mtimeMs: number } | undefined> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  let best: { path: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.stat(full).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) continue;
    if (best === undefined || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
  }
  return best;
}

function safeDataRoot(): string {
  try {
    return getDataRoot();
  } catch {
    return process.cwd();
  }
}
