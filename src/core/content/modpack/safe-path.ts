/**
 * 整合包里的路径安全（防 zip-slip）—— 本模块的安全底线。
 *
 * 威胁模型：`.mrpack` 是用户从网上下来的文件，里面的条目名完全由打包者控制。
 * 一个叫 `overrides/../../../../Users/x/.ssh/authorized_keys`（或 `C:\\Windows\\...`、
 * 或带 NUL 的奇怪串）的条目如果被直接 `path.join(instanceDir, name)` 落盘，
 * 就等于「下载一个整合包 = 任意文件写入」。
 *
 * 所以所有来自 zip 的路径都必须先过这里：
 *   1. 反斜杠统一成 `/`（zip 规范用 `/`，但现实里有打包器写 `\\`）
 *   2. 拒绝绝对路径、盘符路径（`C:`、`\\\\server\\share`）、NUL、控制字符
 *   3. 拒绝任何 `..` 段
 *   4. 拒绝 Windows 保留名（CON / NUL / COM1 …）与非法字符，否则落盘必失败
 *   5. 最后再对拼好的绝对路径做一次「必须仍在根目录内」的复核 —— 纵深防御，
 *      不单靠字符串判断
 */

import * as path from 'node:path';

import { ModpackError } from './types.js';

/** Windows 上的保留设备名（不区分大小写，带扩展名也算） */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul', 'clock$',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** 盘符路径：`C:xxx` / `C:/xxx` */
const DRIVE_LETTER = /^[a-zA-Z]:/;

/** 控制字符（含 NUL） */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]/;

/**
 * 把 zip 里的条目名洗成「安全的相对路径段数组」。
 *
 * 返回 `[]` 表示这个条目代表根目录本身（应跳过）。
 * 任何可疑输入都抛 `ModpackError('unsafe-path')`，由调用方决定是中止还是丢弃该条目。
 */
export function splitSafeZipPath(raw: string): string[] {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw unsafePath(raw, '条目名为空');
  }
  if (CONTROL_CHARS.test(raw)) {
    throw unsafePath(raw, '条目名含控制字符（含 NUL）');
  }

  // zip 规范是 `/`；反斜杠是 Windows 打包器的写法，一律当分隔符看待，
  // 否则 `..\\..\\evil` 会绕过 .. 检查
  const normalized = raw.replace(/\\/g, '/');

  if (normalized.startsWith('/')) {
    throw unsafePath(raw, '是绝对路径');
  }
  if (DRIVE_LETTER.test(normalized)) {
    throw unsafePath(raw, '带盘符（Windows 绝对路径）');
  }
  if (normalized.startsWith('//')) {
    throw unsafePath(raw, '是 UNC 网络路径');
  }

  const segments: string[] = [];
  const parts = normalized.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const segment = parts[i] as string;
    if (segment === '') {
      // 中间的 `//` 一律拒绝：`overrides//etc/x` 这种写法在不同解压器上语义不一
      // （有的按绝对路径处理、有的直接拼），属于必须拒绝的模糊地带。
      // 结尾的空段只是目录条目的尾斜杠，允许。
      if (i === parts.length - 1) continue;
      throw unsafePath(raw, '含连续分隔符');
    }
    if (segment === '.') continue;
    if (segment === '..') {
      throw unsafePath(raw, '含 ".." 路径段');
    }
    // `a.` / `a ` 在 Windows 上会被静默去掉后缀，可能把 `..` 变回来
    const bare = segment.replace(/[. ]+$/, '');
    if (bare === '') {
      throw unsafePath(raw, '含仅由点/空格组成的路径段');
    }
    const stem = (bare.split('.')[0] ?? '').toLowerCase();
    if (WINDOWS_RESERVED.has(stem)) {
      throw unsafePath(raw, `含 Windows 保留名「${stem}」`);
    }
    if (/[<>:"|?*]/.test(bare)) {
      throw unsafePath(raw, '含 Windows 文件名非法字符');
    }
    segments.push(bare);
  }
  return segments;
}

/**
 * 把「相对路径」解析到一个根目录下，并复核结果确实在根目录内。
 *
 * 这是最后一道闸门：即使上面的字符串检查被某种编码花样绕过，
 * 这里也会因为 `path.resolve` 出了根目录而拒绝。
 */
export function resolveInside(root: string, relative: string): string {
  const segments = splitSafeZipPath(relative);
  const rootAbs = path.resolve(root);
  const dest = path.resolve(rootAbs, ...segments);
  // 用 relative 复核而不是 startsWith：`/a/b` 与 `/a/bc` 的前缀关系会误判
  const rel = path.relative(rootAbs, dest);
  if (rel === '') return rootAbs;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw unsafePath(relative, `解析后逃出了目标目录 ${rootAbs}`);
  }
  return dest;
}

/** 路径是否为 `root` 内（含 root 本身）的路径 */
export function isInside(root: string, candidate: string): boolean {
  const rootAbs = path.resolve(root);
  const dest = path.resolve(candidate);
  const rel = path.relative(rootAbs, dest);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 实例名 → 实例 id（同时就是目录名）。
 *
 * 规则刻意保守：整合包名里常见的中文 / 空格 / 括号都允许，
 * 但路径分隔符、`..`、Windows 非法字符、保留名一律拒绝 —— 实例 id 是要拼进路径的。
 */
export function checkInstanceName(raw: unknown): { ok: true; id: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: '实例名必须是字符串。' };
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length === 0) return { ok: false, reason: '实例名不能为空。' };
  if (name.length > 64) return { ok: false, reason: '实例名太长（最多 64 个字符）。' };
  if (name === '.' || name === '..') return { ok: false, reason: '实例名不能是 "." 或 ".."。' };
  if (/[\\/:*?"<>|]/.test(name)) {
    return { ok: false, reason: '实例名不能含 \\ / : * ? " < > | 这些字符（它们会被拼进目录路径）。' };
  }
  if (CONTROL_CHARS.test(name)) return { ok: false, reason: '实例名含控制字符。' };
  if (/[. ]$/.test(name)) return { ok: false, reason: '实例名不能以点或空格结尾。' };
  const stem = (name.split('.')[0] ?? '').toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) {
    return { ok: false, reason: `实例名「${stem}」是 Windows 保留名，换一个名字。` };
  }
  return { ok: true, id: name };
}

function unsafePath(raw: string, why: string): ModpackError {
  const shown = typeof raw === 'string' ? raw.slice(0, 120) : String(raw).slice(0, 120);
  return new ModpackError(
    'unsafe-path',
    `整合包里有不安全的文件路径（${why}）：${shown}`,
    '这类条目通常是打包错误或被恶意改过的整合包。为防它写到实例目录外面，已中止。',
  );
}
