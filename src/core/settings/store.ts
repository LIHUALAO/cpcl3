/**
 * 实例设置的磁盘存储。
 *
 * 位置：`<dataRoot>/instances/<id>/settings.json`
 *
 * 三条硬要求（都是踩过的坑）：
 *   1. **原子写**：先写 `settings.json.tmp`，再 rename 覆盖。断电/崩溃只会留下临时文件，
 *      不会留下一份半截 JSON 把整个实例作废。
 *   2. **坏文件不崩**：JSON 解析失败 → 备份成 `settings.json.bad-<时间戳>`，然后当「没设置过」
 *      返回默认值。用户看得见文件去哪了，程序照常能用。
 *   3. **id 即目录名**：`..` / 分隔符这类形状在入库前就被 `checkInstanceId` 拒掉，绝不让它拼进路径。
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveDataRoot } from '../launch/data-root.js';

import {
  DEFAULT_MEMORY_MB,
  SETTINGS_FILE_MAX_BYTES,
  checkInstanceId,
  defaultSettings,
  normalizeStored,
  validateSettings,
  type InstanceSettings,
} from './types.js';

export { DEFAULT_MEMORY_MB, MEMORY_MAX_MB, MEMORY_MIN_MB, MEMORY_SLIDER_MAX_MB } from './types.js';
export type { InstanceSettings } from './types.js';

const SETTINGS_FILE = 'settings.json';
const TMP_SUFFIX = '.tmp';

/**
 * 原子写的两个步骤单独导出成函数，只为可测：
 * ESM 的 `node:fs` 命名空间是只读的，测试没法给 `fs.writeFileSync` 打桩，
 * 于是把「顺序」这件事放在这两个函数上，测试直接调用它们观察落盘形态。
 */
export function writeTempFile(file: string, text: string): string {
  const tmp = `${file}${TMP_SUFFIX}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8' });
  return tmp;
}

/** rename 在同一分区内是原子的：读方要么看到旧文件，要么看到完整的新文件 */
export function commitTempFile(tmp: string, file: string): void {
  fs.renameSync(tmp, file);
}

export interface SettingsStoreOptions {
  /** 数据根；不传则按 download 模块的 getDataRoot（取不到走目录规则兜底） */
  dataRoot?: string;
}

export class SettingsStore {
  private readonly root: string;

  constructor(opts: SettingsStoreOptions = {}) {
    this.root = path.resolve(opts.dataRoot ?? resolveDataRoot());
  }

  /** 数据根（测试与排障用，不属于契约面） */
  get dataRoot(): string {
    return this.root;
  }

  /** 实例设置文件路径 */
  settingsPath(instanceId: string): string {
    return path.join(this.root, 'instances', instanceId, SETTINGS_FILE);
  }

  /** 读设置；没存过、文件坏了、id 非法，一律返回 undefined */
  load(instanceId: string): InstanceSettings | undefined {
    if (typeof instanceId !== 'string' || checkInstanceId(instanceId) !== null) return undefined;

    const file = this.settingsPath(instanceId);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return undefined; // 没有文件 = 没设置过，这是正常路径
    }
    if (!stat.isFile()) return undefined;

    let text: string;
    try {
      if (stat.size > SETTINGS_FILE_MAX_BYTES) {
        throw new Error(`settings.json 过大（${String(stat.size)} 字节）`);
      }
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      this.quarantine(file, `读取失败：${messageOf(error)}`);
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.quarantine(file, `JSON 解析失败：${messageOf(error)}`);
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.quarantine(file, '内容不是 JSON 对象');
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const versionId =
      typeof record['versionId'] === 'string' && record['versionId'].trim().length > 0
        ? record['versionId'].trim()
        : instanceId;

    const settings = normalizeStored(record, versionId);
    // 文件里的 id 与目录名不一致时以目录名为准：目录名才是真正的实例身份
    settings.id = instanceId;
    if (typeof settings.versionId !== 'string' || settings.versionId.length === 0) {
      settings.versionId = instanceId;
    }
    return settings;
  }

  /**
   * 保存设置（原子写）。
   *
   * 非法输入抛 `SettingsValidationError`，其余 IO 错误原样抛出——
   * 调用方（HTTP / CLI）必须知道「没存进去」，绝不能假装成功。
   */
  save(settings: InstanceSettings): void {
    if (typeof settings !== 'object' || settings === null) {
      throw new SettingsValidationError(['设置必须是对象。'], []);
    }

    const instanceId = typeof settings.id === 'string' && settings.id.trim().length > 0
      ? settings.id.trim()
      : settings.versionId;
    const idProblem = checkInstanceId(instanceId);
    if (idProblem !== null) throw new SettingsValidationError([idProblem], []);

    const versionId =
      typeof settings.versionId === 'string' && settings.versionId.trim().length > 0
        ? settings.versionId.trim()
        : instanceId;

    const probe = validateSettings(settings, versionId, instanceId);
    if (probe.errors.length > 0) throw new SettingsValidationError(probe.errors, probe.ignored);

    const clean: InstanceSettings = { ...probe.settings, id: instanceId, versionId };
    if (clean.memoryMB === undefined) clean.memoryMB = DEFAULT_MEMORY_MB;
    // 空数组合法但没意义，落盘时直接省略，保持文件干净
    if (Array.isArray(clean.extraJvmArgs) && clean.extraJvmArgs.length === 0) delete clean.extraJvmArgs;
    if (Array.isArray(clean.extraGameArgs) && clean.extraGameArgs.length === 0) delete clean.extraGameArgs;

    const file = this.settingsPath(instanceId);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    const text = `${JSON.stringify(clean, null, 2)}\n`;
    // rename 在同一分区内是原子的；先写临时文件再替换，读方永远看不到半截内容
    const tmp = writeTempFile(file, text);
    try {
      commitTempFile(tmp, file);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清理失败不影响主错误 */
      }
      throw error;
    }
  }

  /** 列出所有已保存的设置（按 id 排序；坏文件跳过而不是让整个列表失败） */
  list(): InstanceSettings[] {
    const dir = path.join(this.root, 'instances');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: InstanceSettings[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const settings = this.load(entry.name);
      if (settings !== undefined) out.push(settings);
    }
    out.sort((a, b) => a.id.localeCompare(b.id, 'en'));
    return out;
  }

  /** 删除设置（连同实例目录下那份临时文件）。目录空了也不删——里面有游戏文件的可能性太大。 */
  remove(instanceId: string): void {
    if (typeof instanceId !== 'string' || checkInstanceId(instanceId) !== null) return;
    const file = this.settingsPath(instanceId);
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}${TMP_SUFFIX}`, { force: true });
  }

  /**
   * 给启动用：没存过时返回默认值。
   *
   * `instanceId` 与 `versionId` 相同时（最常见的情况）直接复用默认 id；
   * 不同则说明调用方在同一个版本下开了独立实例（例如「生存」「创造」各一份设置）。
   */
  resolve(versionId: string, instanceId?: string): InstanceSettings {
    const id = typeof instanceId === 'string' && instanceId.trim().length > 0 ? instanceId.trim() : versionId;
    const stored = this.load(id);
    if (stored !== undefined) {
      // 实例目录名就是 versionId 时，以调用方传入的 versionId 为准（防手改文件写错版本）
      return { ...stored, versionId };
    }
    return defaultSettings(versionId, id);
  }

  /**
   * 把坏掉的 settings.json 挪到 `settings.json.bad-<时间戳>`。
   *
   * 为什么不直接删：用户可能是手改坏的，直接删等于毁证据。备份文件也不参与任何解析。
   */
  private quarantine(file: string, reason: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.bad-${stamp}`;
    try {
      fs.renameSync(file, backup);
      process.emitWarning(`PCL3：${file} 无法解析（${reason}），已备份为 ${path.basename(backup)}，按默认设置处理。`);
    } catch (error) {
      process.emitWarning(
        `PCL3：${file} 无法解析（${reason}），备份也失败了（${messageOf(error)}），按默认设置处理。`,
      );
    }
  }
}

/** 设置不合法（HTTP 层映射成 400，CLI 层映射成退出码 2） */
export class SettingsValidationError extends Error {
  readonly problems: string[];
  readonly ignored: string[];

  constructor(problems: string[], ignored: string[] = []) {
    super(problems.join(' '));
    this.name = 'SettingsValidationError';
    this.problems = problems;
    this.ignored = ignored;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
