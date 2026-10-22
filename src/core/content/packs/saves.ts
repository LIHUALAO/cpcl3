/**
 * 数据结构包的存档（saves/<name>/）读取。
 *
 * 只做一件小事，但两处规则必须写死：
 *   1. **只认目录**。`saves/` 下散落的文件不是存档。
 *   2. **有 level.dat 才算有效存档**（新版本是 `level.dat`，个别整合包会缺它而只留 region/；
 *      契约明确「存在即可，不用解析」，所以不做 NBT 解析，也不看 level.dat 是否可读）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { SaveSummary } from './types.js';

/** 单个存档目录名上限（与 checkSaveName 同口径，这里只用来过滤脏数据） */
const MAX_SAVE_NAME = 128;

/**
 * 列出一个实例下所有有效存档，按最后修改时间倒序（最近玩的在前）。
 *
 * 目录不存在 → 空数组（这是新实例的正常状态，不是错误）。
 */
export async function listSaves(instanceDir: string): Promise<SaveSummary[]> {
  const savesDir = path.join(instanceDir, 'saves');
  const entries = await fsp.readdir(savesDir, { withFileTypes: true }).catch(() => []);

  const out: SaveSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.length > MAX_SAVE_NAME) continue;
    const dir = path.join(savesDir, entry.name);

    const levelDat = await fsp.stat(path.join(dir, 'level.dat')).catch(() => undefined);
    if (levelDat === undefined || !levelDat.isFile()) continue;

    const datapacks = path.join(dir, 'datapacks');
    const hasDatapacks = await fsp.stat(datapacks).then(
      (s) => s.isDirectory(),
      () => false,
    );

    out.push({
      name: entry.name,
      hasLevelDat: true,
      hasDatapacks,
      lastPlayed: levelDat.mtimeMs,
    });
  }

  out.sort((a, b) => {
    const at = a.lastPlayed ?? 0;
    const bt = b.lastPlayed ?? 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name, 'zh');
  });
  return out;
}

/** 同步版：给不需要异步的调用方（测试、CLI 列表） */
export function listSavesSync(instanceDir: string): SaveSummary[] {
  const savesDir = path.join(instanceDir, 'saves');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(savesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SaveSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.length > MAX_SAVE_NAME) continue;
    const dir = path.join(savesDir, entry.name);
    let levelDat: fs.Stats;
    try {
      levelDat = fs.statSync(path.join(dir, 'level.dat'));
    } catch {
      continue;
    }
    if (!levelDat.isFile()) continue;
    let hasDatapacks = false;
    try {
      hasDatapacks = fs.statSync(path.join(dir, 'datapacks')).isDirectory();
    } catch {
      hasDatapacks = false;
    }
    out.push({ name: entry.name, hasLevelDat: true, hasDatapacks, lastPlayed: levelDat.mtimeMs });
  }
  out.sort((a, b) => {
    const at = a.lastPlayed ?? 0;
    const bt = b.lastPlayed ?? 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name, 'zh');
  });
  return out;
}

/** 某个存档是否真实存在（level.dat 在） */
export async function saveExists(instanceDir: string, saveName: string): Promise<boolean> {
  const levelDat = await fsp.stat(path.join(instanceDir, 'saves', saveName, 'level.dat')).catch(() => undefined);
  return levelDat?.isFile() === true;
}
