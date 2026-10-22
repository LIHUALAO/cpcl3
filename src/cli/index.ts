/**
 * 命令行入口 —— `pcl3 <command>`
 *
 *   pcl3 versions [--limit N] [--all] [--type release|snapshot|all] [--json]
 *   pcl3 install <versionId> [--dry-run] [--json]
 *   pcl3 launch <versionId> [--username NAME] [--memory MB] [--java PATH] [--instance DIR] [--dry-run]
 *   pcl3 settings show <versionId> [--json]
 *   pcl3 settings set <versionId> [--memory MB] [--min-memory MB] [--jvm-arg ARG]...
 *                                  [--game-arg ARG]... [--java PATH] [--width N] [--height N] [--fullscreen]
 *   pcl3 settings reset <versionId>
 *   pcl3 account login [--no-open] [--json]
 *   pcl3 account offline <name> [--json]
 *   pcl3 account list [--json]
 *   pcl3 doctor [--json] [--timeout SEC] [--no-network]
 *   pcl3 loader list <kind> <gameVersion> [--limit N] [--json]
 *   pcl3 loader install <kind> <gameVersion> [loaderVersion] [--json]
 *
 * 全局配置（infra 追加）：
 *   pcl3 config [--json]                       查看当前全局配置（含配置文件路径）
 *   pcl3 config set-dir <dir>                  修改数据目录（校验 + 提示迁移，不自动搬数据）
 *   pcl3 config set-mirror <id|auto>           固定下载源 / 恢复自动测速
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
  LoaderInstaller,
  LoaderPreconditionError,
  LOADER_LABEL,
  type LoaderKind,
  type LoaderVersion,
} from '../core/loader/index.js';
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
// ── 基础设施（infra-dev 追加）：源测速 / 全局配置 ─────────────────────────
import { GlobalConfigStore, defaultConfigPath, installConfigHook } from '../core/config/index.js';
import { MIRROR_DEFINITIONS, MirrorSelector, type MirrorProbe } from '../core/net/index.js';
import {
  DEFAULT_MEMORY_MB,
  MEMORY_MAX_MB,
  MEMORY_MIN_MB,
  SettingsStore,
  SettingsValidationError,
  defaultSettings,
  toLaunchOptionFields,
  type InstanceSettings,
} from '../core/settings/index.js';
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
  /**
   * 加载器安装器工厂（测试可注入 fake，不联网）。
   * 不传时 loader 命令现场用真实 `LoaderInstaller` + deps 里的仓库/下载器装配。
   */
  loaderFactory?: (deps: ResolvedDeps) => LoaderInstaller;
  /**
   * 【infra 追加】源测速器（测试注入 fake，避免真实联网）。
   * 不传时 doctor 现场按全局配置装配真实 `MirrorSelector`。
   */
  mirrorSelector?: MirrorSelectorLike;
}

/** 源测速器的最小结构约束（doctor 只用这两个方法） */
export interface MirrorSelectorLike {
  probeAll(opts?: { timeoutMs?: number }): Promise<MirrorProbe[]>;
  best(opts?: { timeoutMs?: number }): Promise<MirrorProbe>;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export async function createContext(overrides: Partial<CliContext> = {}): Promise<CliContext> {
  const base: CliContext = {
    io: overrides.io ?? defaultIO,
    deps: overrides.deps ?? (await resolveDeps()),
    env: overrides.env ?? process.env,
    openBrowser: overrides.openBrowser ?? openBrowserDefault,
    probe: overrides.probe ?? probeUrl,
  };
  if (overrides.loaderFactory !== undefined) base.loaderFactory = overrides.loaderFactory;
  return base;
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
      memory: { type: 'number' },
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
    };

    // 内存 / JVM 参数 / Java 路径：默认取实例设置（没存过就是 2048）。
    // `--memory`、`--java` 显式给了就压过存储值 —— 临时试一次不必改设置文件。
    const store = new SettingsStore({ dataRoot });
    Object.assign(options, toLaunchOptionFields(store.resolve(versionId)));

    if (args.values['memory'] !== undefined) options['memoryMB'] = num(args.values['memory'], DEFAULT_MEMORY_MB);
    if (args.values['java'] !== undefined) options['javaPath'] = String(args.values['java']);

    const launcher = new GameLauncher({ versionRepo: new ctx.deps.VersionRepository(), dataRoot });
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

// ───────────────────────────── settings ─────────────────────────────

/** 一次 `--jvm-arg` / `--game-arg` 的累积器（args.ts 的 values 只留最后一个，重复项得自己扫） */
export function collectRepeated(argv: readonly string[], names: readonly string[]): Record<string, string[]> {
  const wanted = new Set(names);
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const rawName = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    if (!wanted.has(rawName)) continue;
    const value = eq >= 0 ? token.slice(eq + 1) : argv[i + 1];
    if (value === undefined) continue;
    if (eq < 0) i += 1;
    const bucket = out[rawName] ?? [];
    bucket.push(value);
    out[rawName] = bucket;
  }
  return out;
}

const settingsShowCommand: CommandDefinition = {
  path: ['settings', 'show'],
  summary: '查看某个版本/实例的内存与 JVM 设置（没设过就显示默认值）',
  usage: 'pcl3 settings show <versionId> [--json]',
  flags: { booleans: { json: { default: false } } },
  async run(args, ctx) {
    const versionId = args.positional[0];
    if (!versionId) throw new UsageError('缺少版本号，例如：pcl3 settings show 1.21', settingsShowCommand.usage);

    const store = new SettingsStore({ dataRoot: ctx.deps.getDataRoot() });
    const settings = store.resolve(versionId);
    const stored = store.load(versionId) !== undefined;

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify({ ...settings, source: stored ? 'stored' : 'default' }, null, 2)}\n`);
      return 0;
    }

    const rows: [string, string][] = [
      ['版本', settings.versionId],
      ['最大内存', `${String(settings.memoryMB ?? DEFAULT_MEMORY_MB)} MB`],
      [
        '最小内存',
        settings.minMemoryMB === undefined
          ? `${dim('自动（Xmx 的 1/4）')}`
          : `${String(settings.minMemoryMB)} MB`,
      ],
      ['JVM 参数', renderArgs(settings.extraJvmArgs)],
      ['游戏参数', renderArgs(settings.extraGameArgs)],
      ['Java 路径', settings.javaPath ?? `${dim('自动查找 / 下载')}`],
      [
        '窗口',
        settings.windowWidth !== undefined && settings.windowHeight !== undefined
          ? `${String(settings.windowWidth)} × ${String(settings.windowHeight)}`
          : `${dim('跟随游戏默认')}`,
      ],
      ['全屏', settings.fullscreen === true ? '是' : '否'],
    ];
    ctx.io.out(`${bold('实例设置')} ${cyan(versionId)}\n`);
    for (const [key, value] of rows) ctx.io.out(`  ${dim(key.padEnd(10))} ${value}\n`);
    ctx.io.out(
      `\n${stored ? dim(`来源：${store.settingsPath(versionId)}`) : dim(`还没保存过，以上是默认值；保存：pcl3 settings set ${versionId} --memory 4096`)}\n`,
    );
    return 0;
  },
};

const settingsSetCommand: CommandDefinition = {
  path: ['settings', 'set'],
  summary: '保存某个版本/实例的内存与 JVM 设置',
  usage:
    'pcl3 settings set <versionId> [--memory MB] [--min-memory MB] '
    + '[--jvm-arg ARG]... [--game-arg ARG]... [--java PATH] [--width N] [--height N] [--fullscreen] [--reset]',
  flags: {
    values: {
      memory: { type: 'number' },
      'min-memory': { type: 'number' },
      java: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
      'jvm-arg': { type: 'string' },
      'game-arg': { type: 'string' },
    },
    booleans: { fullscreen: { default: false }, reset: { default: false }, json: { default: false } },
  },
  async run(args, ctx) {
    const versionId = args.positional[0];
    if (!versionId) throw new UsageError('缺少版本号，例如：pcl3 settings set 1.21 --memory 4096', settingsSetCommand.usage);

    const store = new SettingsStore({ dataRoot: ctx.deps.getDataRoot() });

    if (bool(args.booleans['reset'])) {
      store.remove(versionId);
      const back = store.resolve(versionId);
      if (bool(args.booleans['json'])) ctx.io.out(`${JSON.stringify({ ...back, source: 'default' }, null, 2)}\n`);
      else ctx.io.out(`${green('✔')} 已重置 ${bold(versionId)} 的设置（内存回到默认 ${String(DEFAULT_MEMORY_MB)} MB）\n`);
      return 0;
    }

    const repeated = collectRepeated(args.raw, ['jvm-arg', 'game-arg']);
    const jvmFlags = repeated['jvm-arg'] ?? [];
    const gameFlags = repeated['game-arg'] ?? [];

    const patch: InstanceSettings = { id: versionId, versionId };

    const memory = optionalNumber(args.values['memory']);
    if (memory !== undefined) patch.memoryMB = memory;
    const minMemory = optionalNumber(args.values['min-memory']);
    if (minMemory !== undefined) patch.minMemoryMB = minMemory;
    if (jvmFlags.length > 0) patch.extraJvmArgs = jvmFlags;
    if (gameFlags.length > 0) patch.extraGameArgs = gameFlags;
    const javaArg = args.values['java'];
    if (typeof javaArg === 'string' && javaArg.trim().length > 0) patch.javaPath = javaArg.trim();
    const width = optionalNumber(args.values['width']);
    if (width !== undefined) patch.windowWidth = width;
    const height = optionalNumber(args.values['height']);
    if (height !== undefined) patch.windowHeight = height;
    if (bool(args.booleans['fullscreen'])) patch.fullscreen = true;

    // 一个字都没给就别假装保存了什么：沿用已有设置（没有就是默认值），并明确告知
    const touched = Object.keys(patch).filter((k) => k !== 'id' && k !== 'versionId');
    const base = touched.length === 0 ? store.resolve(versionId) : patch;
    const merged: InstanceSettings = { ...base, id: versionId, versionId };

    try {
      store.save(merged);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        throw new UsageError(error.problems.join('\n'), settingsSetCommand.usage);
      }
      throw error;
    }

    const saved = store.resolve(versionId);
    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify(saved, null, 2)}\n`);
      return 0;
    }
    if (touched.length === 0) {
      ctx.io.out(`${yellow('!')} 没有给出任何要修改的项，沿用当前设置。\n`);
      ctx.io.out(`${dim('例子：')} pcl3 settings set ${versionId} --memory 4096 --jvm-arg "-XX:+UseG1GC"\n`);
      return 0;
    }
    ctx.io.out(`${green('✔')} 已保存 ${bold(versionId)} 的设置\n`);
    ctx.io.out(`  ${dim('最大内存')} ${String(saved.memoryMB ?? DEFAULT_MEMORY_MB)} MB\n`);
    if (saved.minMemoryMB !== undefined) ctx.io.out(`  ${dim('最小内存')} ${String(saved.minMemoryMB)} MB\n`);
    if (saved.extraJvmArgs !== undefined) ctx.io.out(`  ${dim('JVM 参数')} ${renderArgs(saved.extraJvmArgs)}\n`);
    if (saved.javaPath !== undefined) ctx.io.out(`  ${dim('Java 路径')} ${saved.javaPath}\n`);
    ctx.io.out(`  ${dim('文件')} ${store.settingsPath(versionId)}\n`);
    return 0;
  },
};

const settingsResetCommand: CommandDefinition = {
  path: ['settings', 'reset'],
  summary: '删除某个版本/实例的设置文件（内存回到默认值）',
  usage: 'pcl3 settings reset <versionId> [--json]',
  flags: { booleans: { json: { default: false } } },
  async run(args, ctx) {
    const versionId = args.positional[0];
    if (!versionId) throw new UsageError('缺少版本号，例如：pcl3 settings reset 1.21', settingsResetCommand.usage);

    const store = new SettingsStore({ dataRoot: ctx.deps.getDataRoot() });
    const existed = store.load(versionId) !== undefined;
    store.remove(versionId);
    const back = store.resolve(versionId);

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify({ ...back, source: 'default', removed: existed }, null, 2)}\n`);
      return 0;
    }
    ctx.io.out(
      existed
        ? `${green('✔')} 已删除 ${bold(versionId)} 的设置，内存回到默认 ${String(DEFAULT_MEMORY_MB)} MB\n`
        : `${dim(`${versionId} 本来就没有保存过设置，内存就是默认 ${String(DEFAULT_MEMORY_MB)} MB`)}\n`,
    );
    return 0;
  },
};

function renderArgs(list: readonly string[] | undefined): string {
  if (list === undefined || list.length === 0) return dim('（无）');
  return list.join(' ');
}

function optionalNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

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
  /** 【infra 追加】各下载源实测延迟（`--no-network` 时为空数组） */
  mirrors: MirrorProbe[];
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

    // 【infra 追加】源测速表：各源延迟 + 最终选谁
    if (report.mirrors.length > 0) {
      const mirrorRows = report.mirrors.map((m, i) => [
        `${i === 0 && m.ok ? '★ ' : '  '}${m.id}`,
        m.ok ? green('✔ 可用') : red('✘ 不可用'),
        m.ok ? `${String(Math.round(m.latencyMs))} ms` : '超时 / 失败',
        shorten(m.base, 42),
        i === 0 && m.ok ? '← 当前选用' : '',
      ]);
      ctx.io.out(`${bold('下载源测速')} ${dim('（同一文件，每个源测 2 次取最小值，超时 5 秒）')}\n\n`);
      ctx.io.out(`${renderTable(['源', '状态', '延迟', '地址', ''], mirrorRows)}\n\n`);
      const best = report.mirrors[0];
      if (best !== undefined && best.ok) {
        ctx.io.out(`${dim('自动换源会选：')} ${cyan(best.id)}${dim(`（${String(Math.round(best.latencyMs))} ms）`)}\n\n`);
      } else {
        ctx.io.out(`${red('✘')} 所有下载源都测不通。安装/更新会失败，先检查网络与代理。\n\n`);
      }
    } else {
      ctx.io.out(`${dim('（--no-network：跳过源测速）')}\n\n`);
    }

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

  // 【infra 追加】源测速：与上面的「端点可达」是两件事 ——
  // 上面回答「这个 URL 通不通」，这里回答「哪个源最快、该不该换源」。
  // --no-network 时整段跳过（不发任何请求，也不读缓存里的旧结果冒充新数据）。
  let mirrors: MirrorProbe[] = [];
  if (!opts.skipNetwork) {
    mirrors = await probeMirrors(ctx, opts.timeoutMs);
    const best = mirrors.find((m) => m.ok);
    checks.push({
      name: '源测速',
      target: best?.base ?? '（无可用源）',
      ok: best !== undefined,
      detail:
        best === undefined
          ? '所有下载源都不可用'
          : `最快 ${best.id} ${String(Math.round(best.latencyMs))} ms`
            + `（共 ${String(mirrors.filter((m) => m.ok).length)}/${String(mirrors.length)} 个可用）`,
      ms: best?.ok === true ? Math.round(best.latencyMs) : 0,
    });
  }

  return {
    dataRoot,
    node: process.versions['node'] ?? '?',
    platform: `${process.platform}/${process.arch}`,
    modules: ctx.deps.real,
    java,
    checks,
    mirrors,
  };
}

/**
 * 【infra 追加】跑一次源测速。
 *
 * 失败语义：测速器本身抛错（配置坏、构造失败）时**不让 doctor 崩**——
 * 返回空数组，由调用方显示「跳过」。真实 `MirrorSelector` 自己就把网络失败
 * 折算成 `ok:false` 的结果，不会抛。
 */
export async function probeMirrors(ctx: CliContext, timeoutMs: number): Promise<MirrorProbe[]> {
  // 超时沿用 doctor 的 --timeout（默认 8 秒），但单源上限就是 5 秒，取小值
  const perSourceTimeout = Math.max(500, Math.min(5_000, timeoutMs));
  try {
    const selector = ctx.mirrorSelector ?? buildMirrorSelector(ctx);
    return await selector.probeAll({ timeoutMs: perSourceTimeout });
  } catch {
    return [];
  }
}

/** 现场装配真实测速器：按全局配置决定固定源 / 自动测速 */
function buildMirrorSelector(ctx: CliContext): MirrorSelectorLike {
  const store = new GlobalConfigStore();
  installConfigHook(store);
  const cfg = store.load();
  const fixed = cfg.autoProbeMirror === false && typeof cfg.preferredMirror === 'string'
    && cfg.preferredMirror.trim() !== '';
  return new MirrorSelector({
    dataRoot: ctx.deps.getDataRoot(),
    ...(fixed ? { preferredId: cfg.preferredMirror?.trim() } : {}),
    // 所有已知源都参与测速（即使设置了固定源，doctor 也要把真实情况摆出来）
    mirrors: MIRROR_DEFINITIONS,
  });
}

// ───────────────────────────── loader ─────────────────────────────

/** 只接受 fabric / quilt；其余给 UsageError（退出码 2），错误信息里列清可用值 */
export function parseLoaderKindArg(raw: string | undefined): LoaderKind {
  const text = (raw ?? '').trim().toLowerCase();
  if (text === 'fabric' || text === 'quilt') return text;
  throw new UsageError(
    `加载器类型只能是 fabric 或 quilt，收到「${raw ?? ''}」。`,
    'pcl3 loader <list|install> <fabric|quilt> <gameVersion> [loaderVersion]',
  );
}

/**
 * 装配加载器安装器。
 *
 * 直接用 deps 里的 VersionRepository / Downloader —— 它们已经在 `resolveDeps()`
 * 收敛过，测试注入 fake 时这里天然就是 fake，不会偷偷联网。
 */
function makeLoaderInstaller(ctx: CliContext): LoaderInstaller {
  if (ctx.loaderFactory !== undefined) return ctx.loaderFactory(ctx.deps);
  const dataRoot = ctx.deps.getDataRoot();
  return new LoaderInstaller({
    versionRepo: new ctx.deps.VersionRepository(),
    downloader: new ctx.deps.Downloader({ concurrency: 8, retries: 3 }),
    dataRoot,
  });
}

const loaderListCommand: CommandDefinition = {
  path: ['loader', 'list'],
  summary: '列出某个游戏版本可用的加载器版本（fabric / quilt）',
  usage: 'pcl3 loader list <fabric|quilt> <gameVersion> [--limit N] [--json]',
  flags: {
    values: { limit: { type: 'number', default: 20 } },
    booleans: { json: { default: false } },
  },
  async run(args, ctx) {
    const kind = parseLoaderKindArg(args.positional[0]);
    const gameVersion = (args.positional[1] ?? '').trim();
    if (gameVersion === '') {
      throw new UsageError(
        '缺少游戏版本，例如：pcl3 loader list fabric 1.21',
        loaderListCommand.usage,
      );
    }
    const limit = Math.max(1, Math.floor(num(args.values['limit'], 20)));

    const installer = makeLoaderInstaller(ctx);
    let all: LoaderVersion[];
    try {
      all = await installer.listVersions(kind, gameVersion);
    } catch (error) {
      return reportLoaderError(ctx, error);
    }
    const shown = all.slice(0, limit);
    const label = LOADER_LABEL[kind];

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify({ kind, gameVersion, total: all.length, versions: shown }, null, 2)}\n`);
      return 0;
    }

    if (all.length === 0) {
      ctx.io.out(`${yellow('!')} ${label} 没有返回任何版本，稍后重试。\n`);
      return 0;
    }

    const rows = shown.map((v) => [
      v.version,
      v.stable ? green('stable') : yellow('非稳定'),
      v.version === firstStable(all) ? '← 默认安装这条' : '',
    ]);
    ctx.io.out(`${bold(`${label} 可用版本`)} ${dim(`（游戏 ${gameVersion}）`)}\n\n`);
    ctx.io.out(`${renderTable(['版本', '稳定性', ''], rows)}\n\n`);
    ctx.io.out(
      `${dim(
        `共 ${String(all.length)} 个版本，显示 ${String(shown.length)} 个。` +
          `${kind === 'quilt' ? '（Quilt 的 stable 是按版本号推断的，官方 meta 没有这个字段）' : ''}`,
      )}\n`,
    );
    ctx.io.out(`${dim('安装：')} pcl3 loader install ${kind} ${gameVersion} <版本>\n`);
    return 0;
  },
};

/** 第一条 stable（没有就第一条），供列表高亮与 install 默认值共用 */
function firstStable(list: LoaderVersion[]): string | undefined {
  return (list.find((v) => v.stable) ?? list[0])?.version;
}

const loaderInstallCommand: CommandDefinition = {
  path: ['loader', 'install'],
  summary: '安装 Fabric / Quilt 加载器（不给版本则用最新稳定版）',
  usage: 'pcl3 loader install <fabric|quilt> <gameVersion> [loaderVersion] [--json]',
  flags: { booleans: { json: { default: false } } },
  async run(args, ctx) {
    const kind = parseLoaderKindArg(args.positional[0]);
    const gameVersion = (args.positional[1] ?? '').trim();
    if (gameVersion === '') {
      throw new UsageError(
        '缺少游戏版本，例如：pcl3 loader install fabric 1.21',
        loaderInstallCommand.usage,
      );
    }

    const label = LOADER_LABEL[kind];
    const installer = makeLoaderInstaller(ctx);

    let loaderVersion = (args.positional[2] ?? '').trim();
    if (loaderVersion === '') {
      // 不给版本 → 用最新稳定版；列表是 meta 顺序（新 → 旧）
      let list: LoaderVersion[];
      try {
        list = await installer.listVersions(kind, gameVersion);
      } catch (error) {
        return reportLoaderError(ctx, error);
      }
      const picked = firstStable(list);
      if (picked === undefined) {
        ctx.io.err(`${red('✘')} ${label} meta 没有返回任何版本，无法确定默认版本。\n`);
        return 1;
      }
      loaderVersion = picked;
      ctx.io.out(`${dim(`未指定版本，使用最新稳定版 ${picked}`)}\n`);
    }

    const json = bool(args.booleans['json']);
    if (!json) {
      ctx.io.out(`${bold(`安装 ${label}`)} ${cyan(loaderVersion)} ${dim(`→ 原版 ${gameVersion}`)}\n`);
    }

    // 每个 phase 一条独立进度条（与 install 命令同一套范式）
    let bar: ProgressBar | undefined;
    let currentPhase = '';
    let result: { versionId: string };
    try {
      result = await installer.install(kind, gameVersion, loaderVersion, (p) => {
        if (json) return;
        if (p.phase === 'done') {
          bar?.finish();
          bar = undefined;
          return;
        }
        if (p.phase !== currentPhase) {
          bar?.finish();
          currentPhase = p.phase;
          bar = new ProgressBar({
            total: p.total,
            label: p.phase === 'libraries' ? '依赖库' : p.phase,
          });
        }
        (bar as ProgressBar).update(p.done);
      });
    } catch (error) {
      bar?.finish();
      return reportLoaderError(ctx, error);
    } finally {
      bar?.finish();
    }

    const dataRoot = ctx.deps.getDataRoot();
    if (json) {
      ctx.io.out(
        `${JSON.stringify(
          {
            kind,
            gameVersion,
            loaderVersion,
            versionId: result.versionId,
            versionDir: path.join(dataRoot, 'versions', result.versionId),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    ctx.io.out(`${green('✔')} ${label} 安装完成: ${bold(result.versionId)}\n`);
    ctx.io.out(`${dim('版本目录:')} ${path.join(dataRoot, 'versions', result.versionId)}\n`);
    ctx.io.out(`\n${dim('直接启动：')} ${cyan(`pcl3 launch ${result.versionId}`)}\n`);
    return 0;
  },
};

/** 把加载器相关异常翻成人话（前置条件错误要带 hint） */
function reportLoaderError(ctx: CliContext, error: unknown): number {
  if (error instanceof LoaderPreconditionError) {
    ctx.io.err(`${red('✘')} ${error.message}\n`);
    ctx.io.err(`${dim(error.hint)}\n`);
    return 1;
  }
  return reportError(ctx, error);
}

// ───────────────────────────── config（infra 追加） ─────────────────────────────

/**
 * `pcl3 config` —— 查看 / 修改全局配置。
 *
 * 为什么要一个 CLI 入口：数据目录落在哪决定了「我的游戏装在哪」，
 * 这是排障时第一个要确认的东西。GUI 之外留一条命令行路径，
 * 用户可以把输出直接贴给别人（或者脚本里读 --json）。
 */
const configCommand: CommandDefinition = {
  path: ['config'],
  summary: '查看全局配置（数据目录 / 默认下载源）',
  usage: 'pcl3 config [--json]',
  flags: { booleans: { json: { default: false } } },
  async run(args, ctx) {
    const store = new GlobalConfigStore();
    installConfigHook(store);
    const cfg = store.load();
    const dataRoot = ctx.deps.getDataRoot();

    if (bool(args.booleans['json'])) {
      ctx.io.out(
        `${JSON.stringify(
          {
            config: cfg,
            configPath: store.configPath,
            dataRoot,
            dataRootSource: dataRootSourceOf(cfg),
            ...(store.loadProblem === undefined ? {} : { warning: store.loadProblem }),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    const source = dataRootSourceOf(cfg);
    ctx.io.out(`${bold('全局配置')}\n`);
    ctx.io.out(`  ${dim('配置文件')}   ${store.configPath}\n`);
    ctx.io.out(`  ${dim('数据目录')}   ${dataRoot} ${dim(`（来源：${source}）`)}\n`);
    if (source === 'env') {
      ctx.io.out(`  ${yellow('!')} 环境变量 PCL3_DATA_ROOT 覆盖了配置，改配置文件不会生效。\n`);
    }
    ctx.io.out(
      `  ${dim('下载源')}     ${
        cfg.autoProbeMirror === false && cfg.preferredMirror !== undefined
          ? `${cfg.preferredMirror}${dim('（固定，不测速）')}`
          : `${dim('自动测速')}${cfg.preferredMirror === undefined ? '' : dim(`（偏好 ${cfg.preferredMirror}）`)}`
      }\n`,
    );
    if (store.loadProblem !== undefined) ctx.io.err(`${yellow('!')} ${store.loadProblem}\n`);
    ctx.io.out(`\n${dim('改数据目录：')} pcl3 config set-dir D:\\PCL3\n`);
    return 0;
  },
};

/** 数据目录来源（与 download/paths.ts 的解析顺序一一对应） */
export function dataRootSourceOf(cfg: { dataRoot?: string }): 'env' | 'config' | 'default' {
  const fromEnv = process.env['PCL3_DATA_ROOT'];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return 'env';
  if (typeof cfg.dataRoot === 'string' && cfg.dataRoot.trim() !== '') return 'config';
  return 'default';
}

const configSetDirCommand: CommandDefinition = {
  path: ['config', 'set-dir'],
  summary: '修改数据目录（校验可写；不自动迁移旧数据）',
  usage: 'pcl3 config set-dir <目录> [--json]',
  flags: { booleans: { json: { default: false } } },
  async run(args, ctx) {
    const dir = args.positional[0];
    if (!dir) throw new UsageError('缺少目录，例如：pcl3 config set-dir D:\\PCL3', configSetDirCommand.usage);

    const store = new GlobalConfigStore();
    installConfigHook(store);
    const result = await store.setDataRoot(dir);

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }

    if (!result.ok) {
      ctx.io.err(`${red('✘')} ${result.reason ?? '这个目录不能用作数据目录。'}\n`);
      for (const warning of result.warnings) ctx.io.err(`  ${dim(warning)}\n`);
      return 1;
    }

    for (const warning of result.warnings) ctx.io.out(`${yellow('!')} ${warning}\n`);
    ctx.io.out(`${green('✔')} 数据目录已改为 ${bold(result.dataRoot ?? dir)}\n`);
    if (result.notice !== undefined) ctx.io.out(`${result.notice}\n`);
    if (result.notice === undefined) ctx.io.out(`${dim('（与当前目录相同，没有变化。）')}\n`);
    return 0;
  },
};

const configSetMirrorCommand: CommandDefinition = {
  path: ['config', 'set-mirror'],
  summary: '固定下载源，或 auto 恢复自动测速',
  usage: `pcl3 config set-mirror <${MIRROR_DEFINITIONS.map((m) => m.id).join('|')}|auto> [--json]`,
  flags: { booleans: { json: { default: false } } },
  async run(args, ctx) {
    const raw = (args.positional[0] ?? '').trim().toLowerCase();
    if (raw === '') {
      throw new UsageError(
        `缺少源 id。可选：${MIRROR_DEFINITIONS.map((m) => m.id).join(' / ')} / auto`,
        configSetMirrorCommand.usage,
      );
    }

    const store = new GlobalConfigStore();
    installConfigHook(store);

    let saved;
    try {
      saved =
        raw === 'auto'
          ? store.update({ preferredMirror: null, autoProbeMirror: true })
          : store.update({ preferredMirror: raw, autoProbeMirror: false });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error), configSetMirrorCommand.usage);
    }

    if (bool(args.booleans['json'])) {
      ctx.io.out(`${JSON.stringify(saved.config, null, 2)}\n`);
      return 0;
    }
    ctx.io.out(
      raw === 'auto'
        ? `${green('✔')} 已恢复自动测速（每次按实测延迟选源）\n`
        : `${green('✔')} 已固定使用 ${bold(raw)}，不再自动测速。恢复：pcl3 config set-mirror auto\n`,
    );
    return 0;
  },
};

// ───────────────────────────── web ─────────────────────────────

const webCommand: CommandDefinition = {
  path: ['web'],
  summary: '启动本地 Web UI（只监听 127.0.0.1）',
  usage: 'pcl3 web [--port N] [--no-open]',
  flags: {
    values: { port: { type: 'number', default: 37421 } },
    booleans: { 'no-open': { default: false } },
  },
  async run(args, ctx) {
    // 动态 import：不启动 Web UI 时不必加载整套 HTTP 层
    const { startWebServer } = await import('../web/server.js');
    const port = num(args.values['port'], 37421);

    let handle;
    try {
      handle = await startWebServer({ port, dataRoot: ctx.deps.getDataRoot() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.io.err(`${red('启动失败')}：${msg}\n`);
      if (msg.includes('EADDRINUSE')) {
        ctx.io.err(`${dim(`端口 ${port} 已被占用，换个端口：pcl3 web --port ${port + 1}`)}\n`);
      }
      return 1;
    }

    ctx.io.out(`${bold('PCL3 Web UI')} 已启动\n`);
    ctx.io.out(`  ${handle.url}\n`);
    ctx.io.out(`  ${dim('只监听 127.0.0.1，数据不出本机。按 Ctrl+C 退出。')}\n`);

    if (!bool(args.booleans['no-open'])) {
      const opened = await ctx.openBrowser(handle.url);
      if (!opened) {
        ctx.io.out(`  ${dim('（没能自动打开浏览器，请手动访问上面的地址）')}\n`);
      }
    }

    // 阻塞到 Ctrl+C，保证进程不退出、端口一直可用
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        ctx.io.out(`\n${dim('正在关闭…')}\n`);
        void handle.close().then(resolve, resolve);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  },
};

// ───────────────────────────── 路由 ─────────────────────────────

export const COMMANDS: CommandDefinition[] = [
  webCommand,
  versionsCommand,
  installCommand,
  launchCommand,
  settingsShowCommand,
  settingsSetCommand,
  settingsResetCommand,
  accountLoginCommand,
  accountOfflineCommand,
  accountListCommand,
  loaderListCommand,
  loaderInstallCommand,
  doctorCommand,
  // infra 追加：全局配置（数据目录 / 下载源）
  configCommand,
  configSetDirCommand,
  configSetMirrorCommand,
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
    // 只给了命令组名（account / loader / settings）→ 打印帮助，不当成错误
    if (
      parsed.command.length === 1 &&
      (parsed.command[0] === 'account' || parsed.command[0] === 'loader' || parsed.command[0] === 'settings')
    ) {
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
