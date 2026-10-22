#!/usr/bin/env node
/**
 * PCL3 安装完整性审计 —— 排错工具。
 *
 * 它回答一个很朴素的问题：**「安装器说装好了，那文件到底在不在？」**
 * 不看 plan、不看下载日志、不看 UI 的「成功」，只认磁盘。
 *
 * 审计三组东西（对应 VersionJson 里声明的全部可下载物）：
 *   1. jar       —— <dataRoot>/versions/<id>/<id>.jar（版本 JSON 的 downloads.client）
 *   2. libraries —— libraries[].downloads.artifact.path，按 rules 过滤后
 *   3. assets    —— asset index 的 objects，落到 assets/objects/<hash[0:2]>/<hash>
 *
 * 「存在」的定义：文件在 **且** 大小与声明的 size 一致。
 * 大小不符单独记为「尺寸不符」，同样算缺失 —— 半截文件对启动器毫无价值，
 * 游戏读它时一样崩。
 *
 * 用法：
 *   node scripts/audit-install.mjs [versionId] [--data-root PATH]
 *   不带 versionId 时审计数据目录下所有已装版本。
 *
 * 退出码：
 *   0  全部齐全
 *   1  有缺失 / 尺寸不符 / 资源索引读不到
 *   2  用法错误或审计跑不起来（数据目录、版本文件不存在等）
 *
 * 设计约束：
 *   - 不 import src/ 下任何东西。src/core/install 正在被并行修改，
 *     审计工具必须能在源码半坏的状态下独立跑。rules 求值按 Mojang 语义自己实现一份。
 *   - 零依赖、只读、不写任何文件。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────── 常量 ─────────────────────────────

/** 缺失明细：开头必列多少条 */
const HEAD_LIMIT = 10;
/** 缺失明细：折叠后末尾再列多少条 */
const TAIL_LIMIT = 5;

/** 分组中文名 */
const GROUP_LABEL = {
  assets: 'assets 资源对象',
  libraries: 'libraries 依赖库',
  jar: 'jar 客户端本体',
};

// ───────────────────────────── 数据根 ─────────────────────────────

/**
 * 与 src/core/download/paths.ts 完全一致的解析顺序：
 *   PCL3_DATA_ROOT > %APPDATA%/PCL3 > ~/.pcl3
 * 保持一致很重要：审计工具读的必须是启动器真正用的那个目录。
 */
export function defaultDataRoot(env = process.env, platform = process.platform, home = homedir()) {
  const fromEnv = env['PCL3_DATA_ROOT'];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return path.resolve(fromEnv.trim());
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base = typeof appData === 'string' && appData.trim() !== '' ? appData : path.join(home, 'AppData', 'Roaming');
    return path.resolve(base, 'PCL3');
  }
  return path.resolve(home, '.pcl3');
}

// ───────────────────────────── rules（Mojang 语义） ─────────────────────────────

/** 当前运行环境 → Mojang os 语义（与 install/rules.ts 一致） */
export function currentOs(platform = process.platform, arch = process.arch, release = '') {
  const name = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
  const archKey = arch === 'x64' ? 'x86_64' : arch === 'ia32' ? 'x86' : arch;
  return { name, arch: archKey, version: release };
}

function normalizeArch(arch) {
  if (arch === 'x64' || arch === 'amd64' || arch === 'x86_64') return 'x86_64';
  if (arch === 'ia32' || arch === 'x86' || arch === 'i386') return 'x86';
  return arch;
}

const FEATURES = {
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
};

function ruleMatches(rule, osInfo) {
  if (rule.os) {
    const want = rule.os;
    if (want.name !== undefined && want.name !== osInfo.name) return false;
    if (want.arch !== undefined && normalizeArch(want.arch) !== normalizeArch(osInfo.arch)) return false;
    if (want.version !== undefined) {
      try {
        if (!new RegExp(want.version).test(osInfo.version ?? '')) return false;
      } catch {
        if (!(osInfo.version ?? '').startsWith(want.version)) return false;
      }
    }
  }
  if (rule.features) {
    for (const [feature, required] of Object.entries(rule.features)) {
      const actual = FEATURES[feature] ?? false;
      if (actual !== required) return false;
    }
  }
  return true;
}

/** 与 install/rules.ts 的 rulesAllow 同义：默认拒绝，按顺序取最后一条命中规则的 action */
export function rulesAllow(rules, osInfo) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, osInfo)) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

// ───────────────────────────── 文件判定 ─────────────────────────────

/**
 * 判定一个文件的状态。
 * @returns {{ state: 'ok'|'missing'|'size'|'dir', actualSize?: number }}
 *   ok      存在，且（若声明了 size）大小一致
 *   missing 根本不存在
 *   size    存在但大小不符
 *   dir     路径被目录占住（比缺失更诡异，单独标记）
 */
export function inspectFile(absPath, expectedSize) {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return { state: 'missing' };
  }
  if (st.isDirectory()) return { state: 'dir' };
  if (typeof expectedSize === 'number' && Number.isFinite(expectedSize) && st.size !== expectedSize) {
    return { state: 'size', actualSize: st.size };
  }
  return { state: 'ok', actualSize: st.size };
}

// ───────────────────────────── 审计主体 ─────────────────────────────

function emptyGroup() {
  return { declared: 0, ok: 0, missing: 0, failures: [] };
}

/**
 * 纯数据审计：给定版本 JSON + 数据根，产出分组统计与缺失清单。
 * 不打印任何东西，方便测试直接断言。
 */
export function auditVersion({ versionId, dataRoot, versionJson, osInfo = currentOs(), assetIndexOverride }) {
  const report = {
    versionId,
    dataRoot,
    versionJsonPath: path.join(dataRoot, 'versions', versionId, `${versionId}.json`),
    assetIndexId: undefined,
    assetIndexPath: undefined,
    assetIndexMissing: false,
    assetIndexRawCount: null,
    groups: { assets: emptyGroup(), libraries: emptyGroup(), jar: emptyGroup() },
    skippedLibraries: 0,
    warnings: [],
  };
  const libs = report.groups.libraries;
  const jar = report.groups.jar;
  const assets = report.groups.assets;

  // ── 1) libraries ────────────────────────────────────────────────
  const librariesRoot = path.join(dataRoot, 'libraries');
  for (const lib of Array.isArray(versionJson.libraries) ? versionJson.libraries : []) {
    const artifact = lib?.downloads?.artifact;
    if (!artifact) continue;

    // rules 不过 → 这个平台本来就不该有它，不算缺失
    if (!rulesAllow(lib.rules, osInfo)) {
      report.skippedLibraries += 1;
      continue;
    }

    libs.declared += 1;
    const rel = typeof artifact.path === 'string' && artifact.path !== '' ? artifact.path : undefined;
    if (rel === undefined) {
      libs.missing += 1;
      libs.failures.push({
        kind: 'missing',
        name: lib.name ?? '(未命名)',
        relPath: '(downloads.artifact 没有 path 字段)',
        expectedSize: artifact.size,
      });
      continue;
    }

    const res = inspectFile(path.join(librariesRoot, rel), artifact.size);
    if (res.state === 'ok') {
      libs.ok += 1;
    } else {
      libs.missing += 1;
      libs.failures.push({
        kind: res.state,
        name: lib.name ?? '(未命名)',
        relPath: rel,
        expectedSize: artifact.size,
        actualSize: res.actualSize,
      });
    }
  }

  // ── 2) 版本 jar ────────────────────────────────────────────────
  const client = versionJson.downloads?.['client'];
  if (client) {
    jar.declared += 1;
    const rel = `versions/${versionId}/${versionId}.jar`;
    const res = inspectFile(path.join(dataRoot, 'versions', versionId, `${versionId}.jar`), client.size);
    if (res.state === 'ok') {
      jar.ok += 1;
    } else {
      jar.missing += 1;
      jar.failures.push({
        kind: res.state,
        name: `${versionId}.jar`,
        relPath: rel,
        expectedSize: client.size,
        actualSize: res.actualSize,
      });
    }
  } else {
    // 没有 downloads.client 的版本（极老 / 自定义）不判失败，只提示
    report.warnings.push('版本 JSON 没有 downloads.client，跳过 jar 检查。');
  }

  // ── 3) assets ──────────────────────────────────────────────────
  const assetIndexId = versionJson.assetIndex?.id ?? versionJson.assets ?? 'legacy';
  report.assetIndexId = assetIndexId;
  const indexPath = path.join(dataRoot, 'assets', 'indexes', `${assetIndexId}.json`);
  report.assetIndexPath = indexPath;

  let assetIndex = assetIndexOverride;
  if (assetIndex === undefined) {
    try {
      assetIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      assetIndex = undefined;
    }
  }

  if (assetIndex === undefined || typeof assetIndex !== 'object') {
    report.assetIndexMissing = true;
    report.warnings.push(
      `资源索引 ${assetIndexId}.json 读不到（${indexPath}）：索引本身缺失，无法核对任何资源对象。`,
    );
    const declared = versionJson.assetIndex;
    if (declared && typeof declared.size === 'number') {
      assets.declared += 1;
      const res = inspectFile(indexPath, declared.size);
      if (res.state === 'ok') {
        assets.ok += 1;
      } else {
        assets.missing += 1;
        assets.failures.push({
          kind: res.state,
          name: `资源索引 ${assetIndexId}.json`,
          relPath: `assets/indexes/${assetIndexId}.json`,
          expectedSize: declared.size,
          actualSize: res.actualSize,
        });
      }
    }
  } else {
    const objectsRoot = path.join(dataRoot, 'assets', 'objects');
    const entries = Object.entries(assetIndex.objects ?? {});
    report.assetIndexRawCount = entries.length;

    for (const [logicalName, obj] of entries) {
      assets.declared += 1;
      const hash = typeof obj?.hash === 'string' ? obj.hash : '';
      if (!/^[0-9a-f]{40}$/i.test(hash)) {
        assets.missing += 1;
        assets.failures.push({
          kind: 'missing',
          name: logicalName,
          relPath: `(非法 hash：${String(obj?.hash)})`,
          expectedSize: obj?.size,
        });
        continue;
      }
      const res = inspectFile(path.join(objectsRoot, hash.slice(0, 2), hash), obj.size);
      if (res.state === 'ok') {
        assets.ok += 1;
      } else {
        assets.missing += 1;
        assets.failures.push({
          kind: res.state,
          name: logicalName,
          relPath: `${hash.slice(0, 2)}/${hash}`,
          expectedSize: obj.size,
          actualSize: res.actualSize,
        });
      }
    }
  }

  // ── 汇总 ───────────────────────────────────────────────────────
  const groups = Object.values(report.groups);
  report.total = {
    declared: groups.reduce((a, g) => a + g.declared, 0),
    ok: groups.reduce((a, g) => a + g.ok, 0),
    missing: groups.reduce((a, g) => a + g.missing, 0),
  };
  report.total.ratio = report.total.declared > 0 ? report.total.missing / report.total.declared : 0;
  report.hasProblems = report.total.missing > 0 || report.assetIndexMissing;

  return report;
}

/** 数据目录下所有「有 <id>.json」的版本目录 */
export function listVersionIds(dataRoot) {
  const dir = path.join(dataRoot, 'versions');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (existsSync(path.join(dir, name, `${name}.json`))) out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b, 'en'));
  return out;
}

// ───────────────────────────── 输出 ─────────────────────────────

function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${String(n)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function pct(x) {
  return `${(x * 100).toFixed(2)}%`;
}

/**
 * 按「东亚宽字符算 2 列」补齐宽度。
 * padEnd 只数码点，中文标签会整体右移，分组统计就对不齐了。
 */
function padDisplay(text, width) {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - w));
}

/** 一条失败记录 → 人话 */
export function formatFailure(f) {
  const kindLabel = f.kind === 'size' ? '尺寸不符' : f.kind === 'dir' ? '被目录占用' : '缺失';
  const sizeText =
    f.kind === 'size'
      ? `声明 ${fmtBytes(f.expectedSize)}，实际 ${fmtBytes(f.actualSize)}`
      : f.kind === 'dir'
        ? `应为 ${fmtBytes(f.expectedSize)} 的文件，实际是目录`
        : `大小 ${fmtBytes(f.expectedSize)}`;
  return `[${kindLabel}] ${f.name}  →  ${f.relPath}（${sizeText}）`;
}

function printFailures(key, group) {
  if (group.failures.length === 0) return;
  const all = group.failures;
  console.log(`  ${GROUP_LABEL[key]} 缺失明细（共 ${String(all.length)} 条）：`);
  for (const f of all.slice(0, HEAD_LIMIT)) console.log(`    ${formatFailure(f)}`);
  const hidden = all.length - HEAD_LIMIT - TAIL_LIMIT;
  if (hidden > 0) console.log(`    … 中间省略 ${String(hidden)} 条 …`);
  if (all.length > HEAD_LIMIT) {
    for (const f of all.slice(-TAIL_LIMIT)) console.log(`    ${formatFailure(f)}`);
  }
  console.log('');
}

export function printReport(report) {
  const line = '─'.repeat(78);
  console.log('');
  console.log(line);
  console.log('PCL3 安装完整性审计');
  console.log(line);
  console.log(`数据目录  ：${report.dataRoot}`);
  console.log(`版本      ：${report.versionId}`);
  console.log(`版本 JSON ：${report.versionJsonPath}`);
  console.log(
    `资源索引  ：${report.assetIndexId}` +
      (report.assetIndexMissing
        ? '（!! 读不到）'
        : `（声明 ${String(report.assetIndexRawCount)} 个对象）`),
  );
  if (report.skippedLibraries > 0) {
    console.log(`跳过的库  ：${String(report.skippedLibraries)} 个（rules 判定不属于本平台，不算缺失）`);
  }
  console.log('');

  console.log('分组统计：');
  for (const [key, g] of Object.entries(report.groups)) {
    const rate = g.declared > 0 ? pct(g.missing / g.declared) : '—';
    const flag = g.missing > 0 ? '✗' : '✓';
    console.log(
      `  ${flag} ${padDisplay(GROUP_LABEL[key], 18)}  声明 ${String(g.declared).padStart(6)}` +
        `  存在 ${String(g.ok).padStart(6)}  缺失 ${String(g.missing).padStart(6)}  缺失率 ${rate.padStart(7)}`,
    );
  }
  console.log('');

  for (const [key, g] of Object.entries(report.groups)) printFailures(key, g);

  if (report.warnings.length > 0) {
    console.log('提示：');
    for (const w of report.warnings) console.log(`  ! ${w}`);
    console.log('');
  }

  console.log(line);
  console.log(
    `总计：声明 ${String(report.total.declared)} 个文件，存在 ${String(report.total.ok)}，` +
      `缺失 ${String(report.total.missing)}，缺失率 ${pct(report.total.ratio)}`,
  );
  if (report.hasProblems) {
    console.log('');
    console.log('结论：安装不完整 —— 此时启动游戏很可能 NoSuchFileException / 崩溃。');
    if (report.groups.assets.missing > 0 && report.assetIndexId !== undefined) {
      console.log(
        `      可先删掉 ${path.join(report.dataRoot, 'assets', 'indexes', `${report.assetIndexId}.json`)}` +
          ' 再重跑安装，让资源对象重新入队。',
      );
    }
  } else {
    console.log('');
    console.log('结论：全部文件齐全，大小与声明一致。');
  }
  console.log(line);
  console.log('');
}

// ───────────────────────────── 命令行 ─────────────────────────────

export const USAGE = `用法：node scripts/audit-install.mjs [versionId] [--data-root PATH]

  versionId        要审计的版本（例如 26.3、1.21、1.8.9）。省略则审计数据目录下所有已装版本。
  --data-root PATH 数据目录，默认 %APPDATA%\\PCL3（非 Windows 为 ~/.pcl3）。
                   环境变量 PCL3_DATA_ROOT 也认，但本参数优先级更高。
  -h, --help       显示本说明。

退出码：0 = 全部齐全，1 = 有缺失，2 = 审计跑不起来（用法或路径错误）。`;

export function parseArgs(argv) {
  const out = { versionId: undefined, dataRoot: undefined, help: false, errors: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--data-root') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.errors.push('--data-root 后面要跟一个路径。');
      } else {
        out.dataRoot = next;
        i += 1;
      }
    } else if (arg.startsWith('--data-root=')) {
      out.dataRoot = arg.slice('--data-root='.length);
    } else if (arg.startsWith('-') && arg !== '-') {
      out.errors.push(`不认识的参数：${arg}`);
    } else {
      rest.push(arg);
    }
  }
  if (rest.length > 1) {
    out.errors.push(`只接受一个 versionId，收到 ${String(rest.length)} 个：${rest.join(', ')}`);
  }
  out.versionId = rest[0];
  return out;
}

/**
 * 主流程。返回退出码（不直接 exit，方便测试调用）。
 * @param {string[]} argv          不含 node 与脚本名的参数
 * @param {{ log?: (s: string) => void, error?: (s: string) => void }} io 输出通道（测试注入）
 */
export function runAudit(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const error = io.error ?? ((s) => process.stderr.write(`${s}\n`));

  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) error(`错误：${e}`);
    error('');
    error(USAGE);
    return 2;
  }

  const dataRoot = path.resolve(args.dataRoot ?? defaultDataRoot());
  if (!existsSync(dataRoot)) {
    error(`错误：数据目录不存在：${dataRoot}`);
    error('      请确认路径，或用 --data-root 指定。');
    return 2;
  }

  const versionIds = args.versionId !== undefined ? [args.versionId] : listVersionIds(dataRoot);
  if (versionIds.length === 0) {
    error(`错误：${dataRoot} 下没有任何已安装版本（versions/<id>/<id>.json 都不存在）。`);
    return 2;
  }

  let anyProblem = false;
  for (const versionId of versionIds) {
    const jsonPath = path.join(dataRoot, 'versions', versionId, `${versionId}.json`);
    if (!existsSync(jsonPath)) {
      error(`错误：找不到版本文件 ${jsonPath}`);
      return 2;
    }
    let versionJson;
    try {
      versionJson = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      error(`错误：版本文件不是合法 JSON：${jsonPath}`);
      error(`      ${String(err?.message ?? err)}`);
      return 2;
    }
    const report = auditVersion({ versionId, dataRoot, versionJson });
    // printReport 直接写 stdout；把它的输出也走 io.log 以便测试捕获
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      printReport(report);
    } finally {
      console.log = origLog;
    }
    for (const line of lines) log(line);
    if (report.hasProblems) anyProblem = true;
  }

  return anyProblem ? 1 : 0;
}

// 仅在被当作脚本执行时跑；被测试 import 时不执行
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exitCode = runAudit(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`审计脚本自身出错：${String(err?.stack ?? err)}\n`);
    process.exitCode = 2;
  }
}
