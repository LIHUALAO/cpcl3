/**
 * natives 解压。
 *
 * - 目标目录：`<instanceDir>/natives`
 * - 排除 `extract.exclude` 里的前缀（官方元数据里就是 `META-INF/`）
 * - 幂等：目标目录里已有同名文件、且不旧于 jar 时跳过（按 mtime 判断），
 *   另外维护一个 `.state.json` 记录每个 jar 的 {size, mtimeMs}，未变化则整包跳过。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Library } from '../types.js';
import { nativeClassifier, nativeRelativePath } from './command.js';
import type { Platform } from './rules.js';
import { openZip } from './zip.js';

export interface NativeExtractJob {
  /** 库名（Maven 坐标），仅用于日志 */
  name: string;
  /** natives jar 的绝对路径 */
  jarPath: string;
  /** 解压目标目录（绝对路径） */
  extractTo: string;
  /** 需要排除的路径前缀 */
  exclude: string[];
}

export interface NativeExtractResult {
  /** 本次真正解压的 job 数 */
  extracted: number;
  /** 命中断点跳过的 job 数 */
  skipped: number;
  /** 文件不存在等无法解压的 job（不抛错，交给上层决定） */
  missing: NativeExtractJob[];
  /** 实际写出的文件数 */
  files: number;
}

interface StateFile {
  jars: Record<string, { size: number; mtimeMs: number; files: number }>;
}

const STATE_NAME = '.pcl3-natives.json';

/** 从版本 JSON 的 libraries 里挑出当前平台的 natives 解压任务 */
export function collectNativeJobs(
  libraries: readonly Library[],
  platform: Platform,
  librariesRoot: string,
  nativesDir: string,
): NativeExtractJob[] {
  const jobs: NativeExtractJob[] = [];
  for (const lib of libraries) {
    const classifier = nativeClassifier(lib, platform);
    if (!classifier) continue;
    const rel = nativeRelativePath(lib, classifier);
    if (!rel) continue;
    jobs.push({
      name: lib.name,
      jarPath: path.join(librariesRoot, ...rel.split('/')),
      extractTo: nativesDir,
      exclude: lib.extract?.exclude ?? ['META-INF/'],
    });
  }
  return jobs;
}

function isExcluded(entryName: string, exclude: readonly string[]): boolean {
  const normalized = entryName.replace(/\\/g, '/');
  return exclude.some((prefix) => {
    const p = prefix.replace(/\\/g, '/');
    return p.length > 0 && normalized.startsWith(p);
  });
}

async function readState(dir: string): Promise<StateFile> {
  try {
    const raw = await fsp.readFile(path.join(dir, STATE_NAME), 'utf8');
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed && typeof parsed === 'object' && parsed.jars && typeof parsed.jars === 'object') {
      return parsed;
    }
  } catch {
    /* 没有状态文件是正常情况 */
  }
  return { jars: {} };
}

async function writeState(dir: string, state: StateFile): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, STATE_NAME), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 解压一批 natives jar。缺失的 jar 会被记录到 `missing`，由调用方决定是否报错。
 */
export async function extractNatives(jobs: readonly NativeExtractJob[]): Promise<NativeExtractResult> {
  const result: NativeExtractResult = { extracted: 0, skipped: 0, missing: [], files: 0 };

  // 状态文件在 nativesDir 下；同一批 job 的目标目录可能相同
  const dirs = new Set(jobs.map((j) => j.extractTo));
  const states = new Map<string, StateFile>();
  for (const dir of dirs) {
    states.set(dir, await readState(dir));
  }

  for (const job of jobs) {
    if (!fs.existsSync(job.jarPath)) {
      result.missing.push(job);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(job.jarPath);
    } catch {
      result.missing.push(job);
      continue;
    }

    const state = states.get(job.extractTo) as StateFile;
    const key = path.basename(job.jarPath);
    const known = state.jars[key];
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
      result.skipped++;
      continue;
    }

    const buf = await fsp.readFile(job.jarPath);
    const zip = openZip(buf);
    await fsp.mkdir(job.extractTo, { recursive: true });

    let written = 0;
    for (const entry of zip.entries) {
      if (entry.name.endsWith('/')) continue; // 目录条目
      if (isExcluded(entry.name, job.exclude)) continue;
      const target = path.join(job.extractTo, ...entry.name.replace(/\\/g, '/').split('/'));
      const rel = path.relative(job.extractTo, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // 防 zip-slip

      // 单个文件级别的新鲜度判断：目标比 jar 新则跳过（mtime 粒度不足 1s 时用 size 兜底）
      if (fs.existsSync(target)) {
        try {
          const tStat = await fsp.stat(target);
          if (tStat.mtimeMs >= stat.mtimeMs && tStat.size === entry.uncompressedSize) continue;
        } catch {
          /* 忽略，走覆盖写 */
        }
      }
      const data = zip.read(entry);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
      written++;
    }

    state.jars[key] = { size: stat.size, mtimeMs: stat.mtimeMs, files: written };
    result.extracted++;
    result.files += written;
  }

  for (const [dir, state] of states) {
    await writeState(dir, state);
  }
  return result;
}
