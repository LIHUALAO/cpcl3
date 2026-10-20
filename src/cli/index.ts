/**
 * 命令行入口 —— `pcl3 <command>`
 *
 *   pcl3 versions [--limit N] [--all] [--type release|snapshot|all] [--json]
 *   pcl3 install <versionId> [--dry-run] [--json]
 *   pcl3 launch <versionId> [--username NAME] [--memory MB] [--java PATH] [--instance DIR] [--dry-run]
 *   pcl3 account login [--no-open] [--json]
 *   pcl3 account offline <name> [--json]
 *   pcl3 account list [--json]
 *   pcl3 doctor [--json] [--timeout SEC] [--no-network]
 *
 * 结构：
 *   - `COMMANDS` 是路由表（命令路径 → 定义），纯数据，便于测试。
 *   - `parseArgs` 只做解析，`runCli` 只做派发，业务在各 handler。
 *   - handler 通过 `CliContext` 拿依赖（versionRepo / downloader / 输出流 / 探测函数），
 *     测试可以塞 fake，不联网、不落盘、不启动进程。
 *
 * 对尚未交付的模块（auth / launch）采取「探测 → 明确提示 → 返回退出码 2」，
 * 不伪造结果，也不崩栈。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { Account, VersionManifest, VersionSummary } from '../core/types.js';
import { VanillaInstaller, type DetailInstallPlan } from '../core/install/index.js';
import { resolveDeps, type ResolvedDeps } from '../core/install/deps.js';
import { GameLauncher } from '../core/launch/index.js';
import { MicrosoftAuth, loadAccounts, offlineAccount, saveAccounts } from '../core/auth/index.js';
import {
  ASSET_PROBE_HASH,
  BMCLAPI_ASSET_PREFIX,
  BMCLAPI_ROOT,
  LIBRARY_PROBE_URL,
  MOJANG_LIBRARIES_ROOT,
  MOJANG_MANIFEST_URL,
  MOJANG_RESOURCES_ROOT,
  MS_DEVICE_CODE_URL,
  MS_TOKEN_URL,
  PISTON_DATA_PROBE_URL,
  PISTON_MANIFEST_URL,
} from '../core/install/endpoints.js';
import { UsageError, parseArgs, type FlagsSpec, type ParsedArgs } from './args.js';
import {
  ProgressBar,
  bold,
  cyan,
  dim,
  formatBytes,
  gray,
  green,
  red,
  renderTable,
  yellow,
} from './ansi.js';

// ───────────────────────────── 上下文 ─────────────────────────────

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

export interface CliContext {
  io: CliIO;
  deps: ResolvedDeps;
  env: NodeJS.ProcessEnv;
  openBrowser: (url: string) => Promise<boolean>;
  probe: (url: string, timeoutMs: number) => Promise<ProbeResult>;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export async function createContext(overrides: Partial<CliContext> = {}): Promise<CliContext> {
  return {
    io: overrides.io ?? defaultIO,
    deps: overrides.deps ?? (await resolveDeps()),
    env: overrides.env ?? process.env,
    openBrowser: overrides.openBrowser ?? openBrowserDefault,
    probe: overrides.probe ?? probeUrl,
  };
}

// ───────────────────────────── 路由表 ─────────────────────────────

export interface CommandDefinition {
  path: string[];
  summary: string;
  usage: string;
  flags: FlagsSpec;
  run: (args: ParsedArgs, ctx: CliContext) => Promise<number>;
}

// ───────────────────────────── versions ─────────────────────────────

export function selectVersions(
  manifest: VersionManifest,
  opts: { limit: number; all: boolean; type: string },
): VersionSummary[] {
  const wanted = opts.all || opts.type === 'all' ? undefined : opts.type;
  const filtered = wanted === undefined ? manifest.versions : manifest.versions.filter((v) => v.type === wanted);
  return opts.all ? filtered : filtered.slice(0, Math.max(0, Math.floor(opts.limit)));
}

const versionsCommand: CommandDefinition = {
  path: ['versions'],
  summary: '列出可用版本（默认最近 20 个 release）',
  usage: 'pcl3 versions [--limit N] [--all] [--type release|snapshot|all] [--json]',
  flags: {
    values: {
      limit: { type: 'number', default: 20 },
      type: { type: 'string', default: 'release' },
    },
    booleans: { all: { default: false }, json: { default: false } },
  },
  async run(args, ctx) {
    const repo = new ctx.deps.VersionRepository();
    const manifest = await repo.fetchManifest();
    const list = selectVersions(manifest, {
      limit: num(args.values['limit'], 20),
      all: bool(args.booleans['all']),
      type: String(args.values['type'] ?? 'release'),
    });

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify(list, null, 2)}\n`);
      return 0;
    }

    const rows = list.map((v) => [
      v.id,
      v.type,
      v.releaseTime.slice(0, 10),
      v.id === manifest.latest.release ? 'latest' : '',
    ]);
    ctx.io.out(
      `${renderTable(['版本', '类型', '发布时间', ''], rows)}\n\n` +
        `${dim(`共 ${String(manifest.versions.length)} 个版本，显示 ${String(list.length)} 个`)}\n`,
    );
    return 0;
  },
};

// ───────────────────────────── install ─────────────────────────────

const installCommand: CommandDefinition = {
  path: ['install'],
  summary: '安装指定版本，带进度条',
  usage: 'pcl3 install <versionId> [--dry-run] [--json]',
  flags: { booleans: { 'dry-run': { default: false }, json: { default: false } } },
  async run(args, ctx) {
    const versionId = args.positional[0];
    if (!versionId) throw new UsageError('缺少版本号，例如：pcl3 install 1.21', installCommand.usage);

    const installer = new VanillaInstaller({
      versionRepo: new ctx.deps.VersionRepository(),
      downloader: new ctx.deps.Downloader({ concurrency: 8, retries: 3 }),
    });

    const plan: DetailInstallPlan = await installer.plan(versionId);

    if (bool(args.booleans['json'])) {
      ctx.io.out(
        `${JSON.stringify(
          {
            versionId,
            versionDir: plan.versionDir,
            assetIndexId: plan.assetIndexId,
            tasks: plan.tasks.length,
            totalBytes: plan.totalBytes,
            natives: plan.natives.length,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      ctx.io.out(formatPlan(plan));
    }

    if (bool(args.booleans['dry-run'])) return 0;

    // 每个 phase 一条独立进度条，切 phase 时收掉旧的
    let bar: ProgressBar | undefined;
    let currentPhase = '';
    await installer.install(versionId, (p) => {
      if (p.phase === 'done') {
        bar?.finish();
        bar = undefined;
        return;
      }
      if (p.phase !== currentPhase) {
        bar?.finish();
        currentPhase = p.phase;
        bar = new ProgressBar({ total: p.total, label: p.phase });
      }
      (bar as ProgressBar).update(p.done, p.current ?? '');
    });
    bar?.finish();

    ctx.io.out(`${green('✔')} 安装完成: ${bold(versionId)}\n${dim('版本目录:')} ${plan.versionDir}\n`);
    return 0;
  },
};

/** 把计划渲染成人读的多行文本（抽出来便于测试断言） */
export function formatPlan(plan: DetailInstallPlan): string {
  const lines = [
    `${bold('安装计划')} ${cyan(plan.versionId)}`,
    `  ${dim('版本目录')}  ${plan.versionDir}`,
    `  ${dim('资源索引')}  ${plan.assetIndexId}`,
    `  ${dim('任务数')}    ${String(plan.tasks.length)}`,
    `  ${dim('总大小')}    ${formatBytes(plan.totalBytes)}`,
    `  ${dim('natives')}   ${String(plan.natives.length)} 个分类包`,
  ];
  if (plan.virtualAssets) {
    lines.push(
      `  ${dim('虚拟资源')}  ${plan.virtualAssets.dir}${plan.virtualAssets.mapToResources ? ' (map_to_resources)' : ''}`,
    );
  }
  return `${lines.join('\n')}\n\n`;
}

// ───────────────────────────── launch ─────────────────────────────

const launchCommand: CommandDefinition = {
  path: ['launch'],
  summary: '启动已安装的版本（默认为离线账户）',
  usage: 'pcl3 launch <versionId> [--username NAME] [--memory MB] [--java PATH] [--instance DIR] [--dry-run]',
  flags: {
    values: {
      username: { type: 'string', default: 'Steve' },
      memory: { type: 'number', default: 2048 },
      java: { type: 'string' },
      instance: { type: 'string' },
    },
    booleans: { 'dry-run': { default: false } },
  },
  async run(args, ctx) {
    const versionId = args.positional[0];
    if (!versionId) throw new UsageError('缺少版本号，例如：pcl3 launch 1.21', launchCommand.usage);

    const username = String(args.values['username'] ?? 'Steve');
    const account: Account = offlineAccount(username);
    const dataRoot = ctx.deps.getDataRoot();
    const options: Record<string, unknown> = {
      versionId,
      instanceDir: String(args.values['instance'] ?? path.join(dataRoot, 'instances', versionId)),
      account,
      memoryMB: num(args.values['memory'], 2048),
    };
    if (args.values['java'] !== undefined) options['javaPath'] = String(args.values['java']);

    const launcher = new GameLauncher({ versionRepo: new ctx.deps.VersionRepository() });
    const command = await launcher.buildCommand(options as never);

    if (bool(args.booleans['dry-run'])) {
      ctx.io.out(`${command.java} ${command.args.join(' ')}\n`);
      return 0;
    }
    const started = await launcher.launch(options as never);
    ctx.io.out(`${green('✔')} 已启动，PID ${String(started.pid)}\n`);
    return 0;
  },
};

// ───────────────────────────── account ─────────────────────────────

const accountLoginCommand: CommandDefinition = {
  path: ['account', 'login'],
  summary: '微软设备码登录（会尝试打开浏览器）',
  usage: 'pcl3 account login [--no-open] [--json]',
  flags: { booleans: { 'no-open': { default: false }, json: { default: false } } },
  async run(args, ctx) {
    const client = new MicrosoftAuth();
    const session = await client.beginDeviceCode();

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify(session, null, 2)}\n`);
    } else {
      ctx.io.out(
        `\n${bold('在浏览器中打开')} ${cyan(session.verificationUri)}\n` +
          `输入代码 ${bold(session.userCode)}（${String(Math.round(session.expiresIn / 60))} 分钟内有效）\n\n`,
      );
      if (!bool(args.booleans['no-open'])) {
        const opened = await ctx.openBrowser(session.verificationUri);
        if (!opened) ctx.io.out(`${dim('（自动打开浏览器失败，请手动访问上面的链接）')}\n`);
      }
    }

    const account = await client.completeDeviceCode(session.deviceCode, session.interval);

    // 落盘交给 auth 模块（它内部已用原子写 + 收紧权限）
    const dataRoot = ctx.deps.getDataRoot();
    const store = loadAccounts(dataRoot);
    const others = store.accounts.filter(
      (a) => a.uuid.toLowerCase() !== account.uuid.toLowerCase() && a.username !== account.username,
    );
    saveAccounts([...others, account], dataRoot);

    ctx.io.out(`${green('✔')} 登录成功: ${bold(account.username)} ${dim(account.uuid)}\n`);
    return 0;
  },
};

const accountOfflineCommand: CommandDefinition = {
  path: ['account', 'offline'],
  summary: '创建离线账户并写入 accounts.json',
  usage: 'pcl3 account offline <name> [--json]',
  flags: { booleans: { json: { default: false } } },
  async run(args, ctx) {
    const name = args.positional[0];
    if (!name) throw new UsageError('缺少玩家名，例如：pcl3 account offline Steve', accountOfflineCommand.usage);

    const account = offlineAccount(name);
    const dataRoot = ctx.deps.getDataRoot();

    // 复用 auth 模块的存储层：字段校验、原子写、0o600 权限都在那边
    const store = loadAccounts(dataRoot);
    const others = store.accounts.filter((a) => a.username !== name);
    saveAccounts([...others, account], dataRoot);

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify(account, null, 2)}\n`);
    } else {
      ctx.io.out(`${green('✔')} 离线账户已保存: ${bold(name)}\n${dim(path.join(dataRoot, 'accounts.json'))}\n`);
    }
    return 0;
  },
};

const accountListCommand: CommandDefinition = {
  path: ['account', 'list'],
  summary: '列出已保存的账户',
  usage: 'pcl3 account list [--json]',
  flags: { booleans: { json: { default: false } } },
  async run(args, ctx) {
    const dataRoot = ctx.deps.getDataRoot();
    const accounts = loadAccounts(dataRoot).accounts;

    if (accounts.length === 0) {
      ctx.io.out(`${dim('还没有账户，试试：pcl3 account offline Steve')}\n`);
      return 0;
    }
    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify(accounts, null, 2)}\n`);
      return 0;
    }
    ctx.io.out(
      `${renderTable(
        ['玩家名', '类型', 'UUID'],
        accounts.map((a) => [a.username, a.type, a.uuid]),
      )}\n`,
    );
    return 0;
  },
};

// ───────────────────────────── doctor ─────────────────────────────

export interface DoctorRow {
  name: string;
  target: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface DoctorReport {
  dataRoot: string;
  node: string;
  platform: string;
  modules: ResolvedDeps['real'];
  java: JavaInfo;
  checks: DoctorRow[];
}

const doctorCommand: CommandDefinition = {
  path: ['doctor'],
  summary: '环境自检：Node 版本、数据目录、网络端点、Java',
  usage: 'pcl3 doctor [--json] [--timeout SEC] [--no-network]',
  flags: {
    values: { timeout: { type: 'number', default: 8 } },
    booleans: { json: { default: false }, 'no-network': { default: false } },
  },
  async run(args, ctx) {
    const report = await buildDoctorReport(ctx, {
      timeoutMs: Math.max(1, num(args.values['timeout'], 8)) * 1000,
      skipNetwork: bool(args.booleans['no-network']),
    });

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify(report, null, 2)}\n`);
      return report.checks.every((r) => r.ok) ? 0 : 1;
    }

    const table = report.checks.map((r) => [
      r.name,
      r.ok ? green('✔ OK') : red('✘ FAIL'),
      r.detail,
      r.ms > 0 ? `${String(r.ms)} ms` : '',
      shorten(r.target, 44),
    ]);

    ctx.io.out(`${bold('PCL3 环境自检')}\n\n`);
    ctx.io.out(`${renderTable(['检查项', '状态', '详情', '耗时', '目标'], table)}\n\n`);

    const failed = report.checks.filter((r) => !r.ok);
    if (failed.length === 0) {
      ctx.io.out(`${green('✔')} 全部通过，可以开始装了：${bold('pcl3 install 1.21')}\n`);
      return 0;
    }
    ctx.io.out(`${red('✘')} ${String(failed.length)} 项异常：\n`);
    for (const row of failed) {
      ctx.io.out(`  - ${bold(row.name)}：${row.detail}\n`);
    }
    if (failed.some((r) => r.name.startsWith('Mojang') || r.name.startsWith('Piston'))) {
      ctx.io.out(`\n${dim('提示：官方端点不通时，install 会优先使用 BMCLAPI 镜像。')}\n`);
    }
    return 1;
  },
};

/** 汇总所有自检项（纯逻辑，便于单测喂 fake probe） */
export async function buildDoctorReport(
  ctx: CliContext,
  opts: { timeoutMs: number; skipNetwork: boolean },
): Promise<DoctorReport> {
  const checks: DoctorRow[] = [];
  const dataRoot = ctx.deps.getDataRoot();

  const major = Number(process.versions['node']?.split('.')[0] ?? 0);
  checks.push({
    name: 'Node 运行时',
    target: process.execPath,
    ok: major >= 20,
    detail: `v${process.versions['node'] ?? '?'} (${process.platform}/${process.arch})`,
    ms: 0,
  });

  const writable = await probeDataDir(dataRoot);
  checks.push({ name: '数据目录', target: dataRoot, ok: writable.ok, detail: writable.detail, ms: 0 });

  checks.push({
    name: '模块 version',
    target: 'src/core/version',
    ok: ctx.deps.real.versionRepo,
    detail: ctx.deps.real.versionRepo ? '真实实现' : '缺失（VersionRepository 不可用）',
    ms: 0,
  });
  checks.push({
    name: '模块 download',
    target: 'src/core/download',
    ok: ctx.deps.real.downloader,
    detail: ctx.deps.real.downloader ? '真实实现' : '缺失（串行回退下载器）',
    ms: 0,
  });

  const java = await detectJava(ctx.env);
  checks.push({ name: 'Java', target: java.path ?? 'JAVA_HOME / PATH', ok: java.found, detail: java.detail, ms: 0 });

  if (!opts.skipNetwork) {
    const targets: { name: string; url: string }[] = [
      { name: 'Mojang 清单', url: MOJANG_MANIFEST_URL },
      { name: 'Piston 清单', url: PISTON_MANIFEST_URL },
      { name: 'BMCLAPI 清单', url: `${BMCLAPI_ROOT}mc/game/version_manifest_v2.json` },
      { name: 'BMCLAPI 资源', url: `${BMCLAPI_ASSET_PREFIX}${ASSET_PROBE_HASH.slice(0, 2)}/${ASSET_PROBE_HASH}` },
      { name: '官方资源', url: `${MOJANG_RESOURCES_ROOT}${ASSET_PROBE_HASH.slice(0, 2)}/${ASSET_PROBE_HASH}` },
      { name: '官方库', url: LIBRARY_PROBE_URL },
      { name: 'libraries 根', url: MOJANG_LIBRARIES_ROOT },
      { name: 'client.jar', url: PISTON_DATA_PROBE_URL },
      { name: '微软设备码', url: MS_DEVICE_CODE_URL },
    ];
    for (const target of targets) {
      const res = await ctx.probe(target.url, opts.timeoutMs);
      // 4xx 也算「通」：TCP/TLS/HTTP 都正常，只是缺参数或缺对象
      const reachable = res.status !== null && res.status < 500;
      checks.push({
        name: target.name,
        target: target.url,
        ok: reachable,
        detail: res.status === null ? (res.error ?? '无法连接') : `HTTP ${String(res.status)}`,
        ms: res.ms,
      });
    }
  }

  return {
    dataRoot,
    node: process.versions['node'] ?? '?',
    platform: `${process.platform}/${process.arch}`,
    modules: ctx.deps.real,
    java,
    checks,
  };
}

// ───────────────────────────── 路由 ─────────────────────────────

export const COMMANDS: CommandDefinition[] = [
  versionsCommand,
  installCommand,
  launchCommand,
  accountLoginCommand,
  accountOfflineCommand,
  accountListCommand,
  doctorCommand,
];

export function commandTokens(): string[][] {
  return COMMANDS.map((c) => c.path);
}

export function findCommand(command: string[]): CommandDefinition | undefined {
  return COMMANDS.find((c) => c.path.length === command.length && c.path.every((seg, i) => seg === command[i]));
}

/** 主入口：解析 + 派发，返回退出码 */
export async function runCli(argv: string[], ctx?: CliContext): Promise<number> {
  const context = ctx ?? (await createContext());

  if (argv.length === 0 || ['--help', '-h', 'help'].includes(argv[0] ?? '')) {
    printHelp(context);
    return 0;
  }
  if (['--version', '-v'].includes(argv[0] ?? '')) {
    context.io.out(`${await readProductVersion()}\n`);
    return 0;
  }

  let parsed: ParsedArgs;
  try {
    // 第一趟只为拿命令路径：不声明任何 flag，遇到 --foo 一律忽略，
    // 否则 --limit 会在判定命令前就报「未知选项」。
    parsed = parseArgs(argv, { values: {}, booleans: {}, lenientUnknown: true }, {
      commandTokens: commandTokens(),
    });
  } catch (error) {
    return reportError(context, error);
  }

  const def = findCommand(parsed.command);
  if (!def) {
    if (parsed.command.length === 1 && parsed.command[0] === 'account') {
      printHelp(context);
      return 0;
    }
    context.io.err(`${red('✘')} 未知命令: ${parsed.command.join(' ') || argv.join(' ')}\n\n`);
    printHelp(context);
    return 2;
  }

  let full: ParsedArgs;
  try {
    full = parseArgs(argv, def.flags, { commandTokens: commandTokens(), usage: def.usage });
  } catch (error) {
    return reportError(context, error);
  }

  if (full.booleans['help'] === true) {
    context.io.out(`${def.usage}\n  ${def.summary}\n`);
    return 0;
  }

  try {
    return await def.run(full, context);
  } catch (error) {
    return reportError(context, error);
  }
}

// ───────────────────────────── 帮助 ─────────────────────────────

export function printHelp(ctx: CliContext): void {
  const lines = [
    `${bold('PCL3')} — Minecraft 启动器（直接对接 Mojang 官方元数据）`,
    '',
    `${bold('用法')}  pcl3 <command> [options]`,
    '',
  ];
  for (const cmd of COMMANDS) {
    lines.push(`  ${cyan(cmd.path.join(' ').padEnd(22))} ${cmd.summary}`);
  }
  lines.push('', `${dim('查看某条命令的参数：pcl3 <command> --help')}`);
  ctx.io.out(`${lines.join('\n')}\n`);
}

// ───────────────────────────── 工具函数 ─────────────────────────────

function num(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function bool(value: boolean | undefined): boolean {
  return value === true;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

function reportError(ctx: CliContext, error: unknown): number {
  if (error instanceof UsageError) {
    ctx.io.err(`${red('✘')} ${error.message}\n`);
    if (error.usage !== undefined) ctx.io.err(`${dim(`用法: ${error.usage}`)}\n`);
    return 2;
  }
  const message = error instanceof Error ? error.message : String(error);
  ctx.io.err(`${red('✘')} ${message}\n`);
  if (process.env['PCL3_DEBUG'] === '1' && error instanceof Error && error.stack !== undefined) {
    ctx.io.err(`${gray(error.stack)}\n`);
  }
  return 1;
}

/** 动态 import 一个「可能还没交付」的模块，取它导出的构造器（保留给可选能力） */
async function importOptional<T>(specifier: string, exported: string): Promise<T | undefined> {
  try {
    const mod = (await import(specifier)) as Record<string, unknown>;
    const target = mod[exported];
    return typeof target === 'function' ? (target as T) : undefined;
  } catch {
    return undefined;
  }
}

export async function probeUrl(url: string, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 5xx / 429 视为「没探成功」，重试两次：CDN 偶尔抖一下不该被当成服务挂了
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 521, 522, 523, 524]);
  let last: ProbeResult = { ok: false, status: null, ms: 0, error: '未探测' };
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
        await res.body?.cancel().catch(() => undefined);
        last = { ok: res.ok, status: res.status, ms: Date.now() - started };
        if (!RETRY_STATUSES.has(res.status)) return last;
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        last = {
          ok: false,
          status: null,
          ms: Date.now() - started,
          error: aborted ? `超时 ${String(timeoutMs)}ms` : error instanceof Error ? error.message : String(error),
        };
        if (aborted) return last;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
    }
    return last;
  } finally {
    clearTimeout(timer);
  }
}

async function probeDataDir(dir: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probeFile = path.join(dir, '.pcl3-write-test');
    await fs.writeFile(probeFile, 'ok', 'utf8');
    await fs.rm(probeFile, { force: true });
    return { ok: true, detail: '存在且可写' };
  } catch (error) {
    return { ok: false, detail: `不可写：${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface JavaInfo {
  found: boolean;
  path?: string;
  detail: string;
}

/** 探测 Java：JAVA_HOME → PATH → 常见安装目录。找不到就如实报「未检测到」。 */
export async function detectJava(env: NodeJS.ProcessEnv): Promise<JavaInfo> {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates: string[] = [];

  const javaHome = env['JAVA_HOME'];
  if (javaHome !== undefined && javaHome.trim().length > 0) {
    candidates.push(path.join(javaHome.trim(), 'bin', exe));
  }

  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathVar.split(sep)) {
    if (dir.trim().length === 0) continue;
    candidates.push(path.join(dir.trim(), exe));
  }

  for (const candidate of candidates) {
    const isFile = await fs.stat(candidate).then(
      (s) => s.isFile(),
      () => false,
    );
    if (isFile) return { found: true, path: candidate, detail: '已检测到' };
  }

  if (process.platform === 'win32') {
    for (const base of [
      'C:\\Program Files\\Java',
      'C:\\Program Files (x86)\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
    ]) {
      const found = await findUnder(base, 'java.exe', 3);
      if (found) return { found: true, path: found, detail: '已检测到（常见安装目录）' };
    }
  }

  return { found: false, detail: '未检测到 Java（启动前需 JRE/JDK 21+，或等待自动下载功能）' };
}

async function findUnder(dir: string, fileName: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return undefined;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const nested = await findUnder(full, fileName, depth - 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

async function readProductVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { productName?: string; version?: string };
    return `${pkg.productName ?? 'PCL3'} ${pkg.version ?? '0.0.0'}`;
  } catch {
    return 'PCL3';
  }
}

/** 打开浏览器：Windows 用 `cmd /c start`，macOS 用 `open`，Linux 用 `xdg-open` */
export async function openBrowserDefault(url: string): Promise<boolean> {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command.file, command.args, { stdio: 'ignore', detached: true, shell: false });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

// ───────────────────────────── 进程入口 ─────────────────────────────

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const normalized = path.resolve(entry).replace(/\\/g, '/');
  return import.meta.url.endsWith(normalized) || import.meta.url.endsWith(path.basename(entry));
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${red('✘')} ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
