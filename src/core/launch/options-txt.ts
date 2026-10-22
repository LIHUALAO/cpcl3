/**
 * `options.txt` 的「首次启动默认中文」处理。
 *
 * 背景（不是下载问题）：
 *   Minecraft 的 `assets/` 里本来就带全部语言文件（`minecraft/lang/zh_cn.json` 等），
 *   界面语言**只由 `options.txt` 里的 `lang:` 行决定**。首次启动时没有 `options.txt`，
 *   游戏按 JVM 报告的 locale 判断，经常判定失败落回 `en_us`。
 *
 * 本模块的铁律（按危险程度排序）：
 *   1. **这个文件是用户资产**。里面是画质、键位、音量、语言等全部设置，
 *      一旦写坏就是「用户几个月调好的配置没了」。所以：
 *      - 只在缺失时补，用户已有 `lang:` 就一个字都不写
 *      - **真要写之前先备份**（见 {@link backupOptions}）
 *      - 备份失败就**放弃写入**，绝不强行改
 *   2. **不跨实例**。路径一律由调用方给的 `instanceDir` 决定，
 *      本模块不做任何全局查找、不缓存、不回落到数据根 —— 两个实例天然互不相干。
 *   3. **原子写**（临时文件 + rename），避免写一半崩掉把配置弄坏。
 *
 * 文件格式：每行 `key:value`，冒号后**不加空格**，无 BOM，LF 换行。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** 默认语言（用户要求：首次启动中文界面） */
export const DEFAULT_LANG = 'zh_cn';

/** 同一实例最多保留几份 options.txt 备份（含本次新建的那份） */
export const MAX_BACKUPS = 3;

/** 备份文件名前缀（`options.txt.bak-<timestamp>`） */
export const BACKUP_PREFIX = 'options.txt.bak-';

/**
 * 生成的新 `options.txt` 内容（最小可用集）。
 * 刻意保持极简：多写字段容易与不同版本的键名/取值范围冲突。
 */
export const DEFAULT_OPTIONS_LINES: readonly string[] = Object.freeze([
  'version:1.0',
  `lang:${DEFAULT_LANG}`,
  'renderDistance:12',
  'guiScale:0',
  'autoJump:false',
]);

/** 处理结果，便于测试与日志核对 */
export interface OptionsEnsureResult {
  /** options.txt 绝对路径 */
  file: string;
  /** 本次实际做了什么 */
  action: 'created' | 'appended-lang' | 'unchanged' | 'skipped-backup-failed';
  /** 处理后的文件内容（换行统一成 \n）；跳过写入时为原内容 */
  content: string;
  /** 本次写盘前产生的备份文件绝对路径（只在真的要写、且文件已存在时才有） */
  backup?: string;
  /** 跳过的原因（action === 'skipped-backup-failed' 时给出） */
  skippedReason?: string;
}

/** `lang:` 行判定：行首 `lang:`（容忍前后空白与 CRLF 残留） */
function isLangLine(line: string): boolean {
  return /^\s*lang\s*:/.test(line);
}

/** 按行切分，去掉末尾连续空行（文件以换行结尾时 split 会多出一个空串） */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n+$/, '');
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 * rename 在同一分区上是原子的，中途崩溃不会留下半截文件。
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.options.txt.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8' });
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ───────────────────────────── 备份 ─────────────────────────────

/** 生成一个不会撞车的备份文件名（同毫秒多次调用也要唯一） */
function backupFileName(now: number, seq: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return seq === 0 ? `${BACKUP_PREFIX}${stamp}` : `${BACKUP_PREFIX}${stamp}-${String(seq)}`;
}

/**
 * 列出某实例目录下已有的备份（按文件名里的时间戳**从新到旧**排序）。
 *
 * 只认 `options.txt.bak-` 前缀，不碰用户自己的 `options.txt.bak`（无前缀横杠）。
 * 排序依据是文件名里的 ISO 时间戳，而不是 mtime —— 文件被复制/同步后 mtime 不可靠。
 */
export async function listBackups(instanceDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(instanceDir);
  } catch {
    return [];
  }
  const backups = names
    .filter((n) => n.startsWith(BACKUP_PREFIX))
    .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1)); // 文件名倒序 = 新的在前
  return backups.map((n) => path.join(instanceDir, n));
}

/** 只保留最近 {@link MAX_BACKUPS} 份，其余删除。删除失败静默（不影响主流程）。 */
async function pruneBackups(instanceDir: string): Promise<string[]> {
  const all = await listBackups(instanceDir);
  const stale = all.slice(MAX_BACKUPS);
  const removed: string[] = [];
  for (const file of stale) {
    try {
      await fsp.rm(file, { force: true });
      removed.push(file);
    } catch {
      /* 删不掉就留着，不影响用户配置 */
    }
  }
  return removed;
}

/**
 * 把现有 `options.txt` 备份一份，并清理超量旧备份。
 *
 * @returns 备份文件绝对路径；备份失败时抛错（调用方据此**放弃写入**）
 */
export async function backupOptions(instanceDir: string, now = Date.now()): Promise<string> {
  const source = path.join(instanceDir, 'options.txt');
  // 用 COPYFILE_EXCL 语义：文件名撞了就换下一个序号，绝不覆盖旧备份
  let target = '';
  for (let seq = 0; seq < 100; seq += 1) {
    const candidate = path.join(instanceDir, backupFileName(now, seq));
    try {
      await fsp.copyFile(source, candidate, fs.constants.COPYFILE_EXCL);
      target = candidate;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      throw err;
    }
  }
  if (target === '') throw new Error('生成备份文件名失败（连续撞名 100 次）');

  await pruneBackups(instanceDir);
  return target;
}

// ───────────────────────────── 主流程 ─────────────────────────────

/**
 * 确保 `<instanceDir>/options.txt` 存在且含 `lang:`。
 *
 * 四种结果：
 *   - 文件不存在                 → 写默认配置（无需备份，没有东西可丢）
 *   - 存在但没有任何 `lang:` 行  → **先备份**，再追加一行 `lang:zh_cn`
 *   - 已含 `lang:`               → 一个字都不写，**也不备份**
 *   - 需要写但备份失败           → **放弃写入**，action = 'skipped-backup-failed'
 *
 * 所有路径都只由 `instanceDir` 决定：不会跨实例读写任何文件。
 */
export async function ensureChineseOptions(
  instanceDir: string,
  now = Date.now(),
): Promise<OptionsEnsureResult> {
  const file = path.join(instanceDir, 'options.txt');

  let existing: string | undefined;
  try {
    existing = await fsp.readFile(file, 'utf8');
  } catch {
    existing = undefined;
  }

  // ── 情况 1：不存在 → 生成默认配置（没什么可备份的：文件本来就不存在）──
  if (existing === undefined) {
    const content = `${DEFAULT_OPTIONS_LINES.join('\n')}\n`;
    await writeAtomic(file, content);
    return { file, action: 'created', content: stripTrailingNewline(content) };
  }

  const lines = splitLines(existing);
  const hasLang = lines.some((line) => isLangLine(line));

  // ── 情况 3：已有 lang → 绝对不动，也不留备份（没写就没有可回滚的东西）──
  if (hasLang) {
    return { file, action: 'unchanged', content: stripTrailingNewline(existing) };
  }

  // ── 情况 2：要追加 → **先备份**，备份失败就放弃写入 ──
  let backup: string;
  try {
    backup = await backupOptions(instanceDir, now);
  } catch (err) {
    return {
      file,
      action: 'skipped-backup-failed',
      content: stripTrailingNewline(existing),
      skippedReason: `备份失败，已放弃修改 options.txt：${(err as Error).message}`,
    };
  }

  // 保留原有换行风格：原文件用 CRLF 就继续用 CRLF（这是用户文件，改动应尽量小）
  const usesCrlf = /\r\n/.test(existing);
  const eol = usesCrlf ? '\r\n' : '\n';
  const base = stripTrailingNewline(existing.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  const content =
    base.length === 0 ? `${`lang:${DEFAULT_LANG}`}${eol}` : `${base}${eol}lang:${DEFAULT_LANG}${eol}`;

  await writeAtomic(file, content);
  return {
    file,
    action: 'appended-lang',
    content: stripTrailingNewline(content),
    backup,
  };
}

/**
 * 同步版本的「是否已有 lang」判断（只读，不写盘）。
 * 给需要提前判断的调用方用（比如日志里说明「会不会补语言」）。
 */
export function hasLangAlready(instanceDir: string): boolean {
  const file = path.join(instanceDir, 'options.txt');
  try {
    const text = fs.readFileSync(file, 'utf8');
    return splitLines(text).some((line) => isLangLine(line));
  } catch {
    return false;
  }
}
