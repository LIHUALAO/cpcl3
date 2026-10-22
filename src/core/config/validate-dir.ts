/**
 * 数据目录校验 —— 改数据目录前的全部把关都集中在这里。
 *
 * 三条硬要求（每条都对应一类真实事故）：
 *   1. **目标必须是目录**：选到某个文件（例如误选了 `javaw.exe`）时不能"看起来成功"。
 *   2. **必须可写**：不可写意味着装完什么都没落盘，用户会在半小时后才看到失败。
 *      用真实写入探测，不用 `fs.access` 猜（ACL / 只读挂载 / 杀软都会骗过 access）。
 *   3. **不能是「当前数据目录的子目录」**：那会让新旧数据互相嵌套，
 *      清理旧目录时顺手把新目录删掉；反过来「父目录」是允许的（用户常见操作）。
 *
 * 刻意**不**做的：迁移数据。几百 MB 到几 GB 的复制既慢又可能半途而废，
 * 一旦失败就是两份不完整的数据。只提示旧数据的位置与大小，由用户自己决定。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 认定「这是一个 PCL3 数据目录」的标志性子目录 */
export const DATA_ROOT_MARKERS: readonly string[] = ['versions', 'libraries', 'assets'];

export interface DataDirCheck {
  /** 规范化后的绝对路径 */
  dir: string;
  /** 是否可以直接用作数据目录（只读判断，不落盘） */
  ok: boolean;
  /** 一句人话结论／拒绝原因 */
  reason?: string;
  /** 补充提示（不阻塞，但要让人知道） */
  warnings: string[];
  /** 目标当前是否已存在 */
  exists: boolean;
  /** 目标已存在且看起来是 PCL3 数据目录（含 versions/libraries/assets 之一） */
  looksLikeDataRoot: boolean;
  /** 目标已存在时占用的大小（字节）。探测失败为 undefined */
  sizeBytes?: number;
  /** 目标是否在新旧关系上非法（自身 / 子目录 / 父目录） */
  relation: 'same' | 'inside-current' | 'parent-of-current' | 'unrelated';
}

export interface ValidateDataDirOptions {
  /** 当前生效的数据目录（用于比较「子目录 / 父目录」） */
  currentDataRoot?: string;
  /** 配置目录所在位置（不能把配置塞进数据目录，避免把 config.json 关进去） */
  configPath?: string;
  /** 允许把数据目录设成与当前完全相同（默认允许：等于不改变） */
  allowSame?: boolean;
  /** 跳过真实写入探测（仅测试用；生产路径永远要真写一次） */
  skipWriteProbe?: boolean;
}

/** 路径包含判定：`child` 是否在 `parent` 之内（含自身）。大小写按平台处理。 */
export function isInsideOrEqual(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c === p) return true;
  const sep = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
  return c.startsWith(sep);
}

/** 两个路径是否指的是同一位置（平台相关的大小写处理） */
export function pathEquals(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  // Windows 与 macOS 默认大小写不敏感；Linux 敏感
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/** 形态检查：空串 / 含空字节 / 相对路径形状可疑 */
function shapeProblem(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return '请填写一个目录路径。';
  if (raw.includes('\0')) return '路径里含空字节，这不是合法路径。';
  return undefined;
}

/**
 * 备份同一个数据目录是不是「PCL3 数据目录」。
 * 只认标志性子目录，不强求一定装满 —— 空目录也允许当数据目录。
 */
async function looksLikeDataRootDir(dir: string): Promise<boolean> {
  for (const marker of DATA_ROOT_MARKERS) {
    const stat = await fsp.stat(path.join(dir, marker)).catch(() => undefined);
    if (stat?.isDirectory() === true) return true;
  }
  return false;
}

/** 估算目录占用（只算一层深度，避免扫几万个文件卡住；超过 budgetMs 就放弃） */
export async function measureDirSize(dir: string, budgetMs = 800): Promise<number | undefined> {
  const started = Date.now();
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    if (Date.now() - started > budgetMs) return undefined;
    const current = stack.pop() as string;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(full).catch(() => undefined);
        if (stat !== undefined) total += stat.size;
      }
    }
  }
  return total;
}

/** 真实写入探测：写一个小文件再删掉。比 `fs.access(W_OK)` 可信得多。 */
export async function probeWritable(dir: string): Promise<{ ok: boolean; reason?: string }> {
  const probeFile = path.join(dir, `.pcl3-write-probe-${String(process.pid)}-${String(Date.now())}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(probeFile, 'ok', 'utf8');
    await fsp.rm(probeFile, { force: true });
    return { ok: true };
  } catch (error) {
    await fsp.rm(probeFile, { force: true }).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, reason: `没有写入权限：${dir}。请换一个目录，或以管理员身份运行。` };
    }
    if (code === 'ENOSPC') {
      return { ok: false, reason: `磁盘空间不足，无法写入：${dir}` };
    }
    if (code === 'EROFS') {
      return { ok: false, reason: `这是只读磁盘／只读挂载点：${dir}` };
    }
    if (code === 'ENOTDIR') {
      return { ok: false, reason: `路径中间夹了一个文件，不是目录：${dir}` };
    }
    return { ok: false, reason: `目录不可写：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 校验一个路径能否作为数据目录。
 *
 * 只读判断 + 一次真实写入探测；**不创建任何持久文件**（写探测文件会立刻删掉）。
 */
export async function validateDataDir(
  raw: string,
  opts: ValidateDataDirOptions = {},
): Promise<DataDirCheck> {
  const warnings: string[] = [];
  const shape = shapeProblem(raw);
  if (shape !== undefined) {
    return {
      dir: typeof raw === 'string' ? raw : '',
      ok: false,
      reason: shape,
      warnings,
      exists: false,
      looksLikeDataRoot: false,
      relation: 'unrelated',
    };
  }

  const dir = path.resolve(raw.trim());

  // ── 1. 目标已存在时的形态检查 ─────────────────────────────────────
  let exists = false;
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(dir);
    exists = true;
  } catch {
    exists = false;
  }

  if (stat !== undefined && !stat.isDirectory()) {
    return {
      dir,
      ok: false,
      reason: `${dir} 是一个文件，不是目录。请选一个目录（或填一个还不存在的目录）。`,
      warnings,
      exists,
      looksLikeDataRoot: false,
      relation: 'unrelated',
    };
  }

  // ── 2. 与当前数据目录的关系 ───────────────────────────────────────
  //
  // 只有「新目录嵌在旧目录里面」是**禁止**的：清理旧目录时会连新目录一起删，
  // 而且两套 versions/libraries 会互相覆盖。
  // 「新目录是旧目录的父级」是允许的（用户常这么写，例如把 .../PCL3 改成 D:\PCL3），
  // 但会给出提醒：游戏文件从此和这一层原有的东西混在一起。
  let relation: DataDirCheck['relation'] = 'unrelated';
  if (typeof opts.currentDataRoot === 'string' && opts.currentDataRoot.trim() !== '') {
    const current = path.resolve(opts.currentDataRoot.trim());
    if (pathEquals(dir, current)) {
      relation = 'same';
    } else if (isInsideOrEqual(dir, current)) {
      relation = 'inside-current';
    } else if (isInsideOrEqual(current, dir)) {
      relation = 'parent-of-current';
    }
  }

  if (relation === 'inside-current') {
    return {
      dir,
      ok: false,
      reason:
        `${dir} 在当前位置 ${opts.currentDataRoot ?? ''} 里面，`
        + '新旧数据会互相嵌套（清理旧目录时会连新目录一起删）。请选一个平级的目录。',
      warnings,
      exists,
      looksLikeDataRoot: await looksLikeDataRootDir(dir),
      relation,
    };
  }

  if (relation === 'parent-of-current') {
    warnings.push(
      `目标目录是「当前位置」的上级目录：${dir}。`
      + '游戏文件会直接落在这一层，可能和这个目录里的其它文件混在一起，建议新建一个专属子目录。',
    );
  }

  if (relation === 'same') {
    warnings.push('新目录与当前目录相同，保存后不会发生任何变化。');
  }

  // ── 3. 配置目录不能被卷进数据目录 ─────────────────────────────────
  if (typeof opts.configPath === 'string' && opts.configPath.trim() !== '') {
    const configDir = path.resolve(path.dirname(path.resolve(opts.configPath)));
    if (isInsideOrEqual(configDir, dir)) {
      warnings.push(
        `配置文件（${opts.configPath}）就在这个数据目录里。`
        + '日后整体迁移数据目录时，请记得把 config.json 一起带走，否则启动器会回到默认路径。',
      );
    }
  }

  const looksLike = exists ? await looksLikeDataRootDir(dir) : false;

  // ── 4. 真实写入探测 ───────────────────────────────────────────────
  if (opts.skipWriteProbe !== true) {
    // ⚠️ 顺序：先记下「探测前是否存在」，因为 probeWritable 内部会 mkdir -p。
    // 否则一个全新的路径会在探测后被误报成「已存在」。
    const existedBefore = exists;
    const writable = await probeWritable(dir);
    if (!writable.ok) {
      return {
        dir,
        ok: false,
        reason: writable.reason,
        warnings,
        exists: existedBefore,
        looksLikeDataRoot: looksLike,
        relation,
      };
    }
    exists = existedBefore;
  }

  // ── 5. 体积提示（不阻塞） ─────────────────────────────────────────
  let sizeBytes: number | undefined;
  if (exists) {
    sizeBytes = await measureDirSize(dir);
    if (sizeBytes !== undefined && sizeBytes > 0 && !looksLike) {
      warnings.push(
        `${dir} 里已经有 ${formatSize(sizeBytes)} 其它文件，`
        + 'PCL3 会在里面新建 versions / libraries / assets 等子目录，注意别误删。',
      );
    }
  }

  return {
    dir,
    ok: true,
    warnings,
    exists,
    looksLikeDataRoot: looksLike,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    relation,
  };
}

/** 迁移提示文案（**不自动迁移**，只把事实说清楚） */
export function migrationNotice(input: {
  from: string;
  to: string;
  sizeBytes?: number;
}): string {
  const size = input.sizeBytes === undefined ? '未知大小' : formatSize(input.sizeBytes);
  return (
    `新目录已生效：${input.to}\n`
    + `原有数据仍在旧目录：${input.from}（约 ${size}），不会自动移动。\n`
    + '可以手动把旧目录里的 versions / libraries / assets / instances / java 剪贴到新目录；'
    + '移动完成后旧目录可以直接删除。'
  );
}

/** 人类可读的字节数（与 web 的 formatBytes 同口径，但本模块不依赖 web 层） */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[i] as string}`;
}
