/**
 * 命令行参数解析 —— 手写，零依赖。
 *
 * 支持的形式：
 *   pcl3 versions
 *   pcl3 versions --limit 5
 *   pcl3 versions --limit=5 --all
 *   pcl3 install 1.21 --yes
 *   pcl3 account offline Steve
 *   pcl3 account login --open false
 *
 * 设计要点：
 * - 解析结果是一个纯数据对象（`ParsedArgs`），handler 只吃这个对象，
 *   所以测试可以直接构造 argv 数组，不会碰网络、不启动进程、不读磁盘。
 * - 未知选项**报错**而不是静默忽略（用户拼错 `--limt` 应当立刻看到提示）。
 * - 位置参数按命令 schema 收集到 `positional`。
 */

export interface FlagsSpec {
  /** 取值选项：--limit 5 / --limit=5 */
  values?: Record<string, { type: 'number' | 'string'; default?: number | string; alias?: string }>;
  /** 布尔开关：--all / --yes */
  booleans?: Record<string, { default?: boolean; alias?: string }>;
  /**
   * 宽松模式：未知 `--xxx` 不报错而是跳过（连带跳过它的取值）。
   * 只给「第一趟只解析命令路径」用，真正的解析必须严格。
   */
  lenientUnknown?: boolean;
}

export interface ParsedArgs {
  /** 已经解析出的命令路径，例如 ['account', 'offline'] */
  command: string[];
  /** 位置参数 */
  positional: string[];
  /** 取值选项 */
  values: Record<string, string | number>;
  /** 布尔选项 */
  booleans: Record<string, boolean>;
}

export class UsageError extends Error {
  readonly usage: string | undefined;
  constructor(message: string, usage?: string) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

/**
 * 从 argv 里切出命令路径：消费开头连续的非选项 token。
 * `tokens`（子命令清单）用来决定消费几层，避免把版本号当成子命令。
 *
 * 例：tokens = ['versions','install','launch','account','doctor']，depth map 由调用方给。
 */
export function parseArgs(
  argv: string[],
  spec: FlagsSpec,
  opts: { commandTokens: string[][]; usage?: string } = { commandTokens: [] },
): ParsedArgs {
  const values: Record<string, string | number> = {};
  const booleans: Record<string, boolean> = {};

  // 先把默认值铺上
  for (const [name, def] of Object.entries(spec.values ?? {})) {
    if (def.default !== undefined) values[name] = def.default;
  }
  for (const [name, def] of Object.entries(spec.booleans ?? {})) {
    if (def.default !== undefined) booleans[name] = def.default;
  }

  // 反查别名
  const valueByToken = new Map<string, string>();
  for (const [name, def] of Object.entries(spec.values ?? {})) {
    valueByToken.set(name, name);
    if (def.alias) valueByToken.set(def.alias, name);
  }
  const boolByToken = new Map<string, string>();
  for (const [name, def] of Object.entries(spec.booleans ?? {})) {
    boolByToken.set(name, name);
    if (def.alias) boolByToken.set(def.alias, name);
  }

  const positional: string[] = [];
  const command: string[] = [];
  let i = 0;

  // ── 命令路径 ──
  // 按最长匹配依次吃掉开头 token
  if (opts.commandTokens.length > 0) {
    while (i < argv.length) {
      const token = argv[i];
      if (token === undefined) break;
      if (token.startsWith('-')) break;
      const candidate = [...command, token];
      const matches = opts.commandTokens.some(
        (path) => path.length === candidate.length && path.every((seg, idx) => seg === candidate[idx]),
      );
      const canExtend = opts.commandTokens.some(
        (path) => path.length > candidate.length && candidate.every((seg, idx) => path[idx] === seg),
      );
      if (matches && !canExtend) {
        command.push(token);
        i += 1;
        break;
      }
      if (canExtend) {
        command.push(token);
        i += 1;
        continue;
      }
      // 这一层不匹配任何命令：若已确定命令则以位置参数对待，否则报未知命令
      if (command.length === 0) {
        throw new UsageError(`未知命令: ${token}`, opts.usage);
      }
      break;
    }
  }

  // ── 选项与位置参数 ──
  for (; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) break;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token === '-h' || token === '--help') {
      booleans['help'] = true;
      continue;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const rawName = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;

      const boolName = boolByToken.get(rawName);
      if (boolName !== undefined) {
        if (inlineValue !== undefined) {
          const lowered = inlineValue.toLowerCase();
          if (['true', '1', 'yes'].includes(lowered)) booleans[boolName] = true;
          else if (['false', '0', 'no'].includes(lowered)) booleans[boolName] = false;
          else throw new UsageError(`--${rawName} 只接受 true/false`, opts.usage);
        } else {
          booleans[boolName] = true;
        }
        continue;
      }

      const valueName = valueByToken.get(rawName);
      if (valueName !== undefined) {
        const def = spec.values?.[valueName];
        let raw = inlineValue;
        if (raw === undefined) {
          raw = argv[i + 1];
          if (raw === undefined || raw.startsWith('--')) {
            throw new UsageError(`--${rawName} 需要一个值`, opts.usage);
          }
          i += 1;
        }
        values[valueName] = coerce(raw, def?.type ?? 'string', rawName, opts.usage);
        continue;
      }

      if (spec.lenientUnknown === true) {
        // 宽松模式：跳过未知选项，若它后面跟的是一个非选项 token，也一并跳过（大概是它的取值）
        if (inlineValue === undefined) {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith('-')) i += 1;
        }
        continue;
      }

      throw new UsageError(`未知选项: --${rawName}`, opts.usage);
    }

    if (token.startsWith('-') && token.length > 1) {
      if (spec.lenientUnknown === true) continue;
      throw new UsageError(`未知选项: ${token}（本工具只支持长选项）`, opts.usage);
    }

    positional.push(token);
  }

  return { command, positional, values, booleans };
}

function coerce(raw: string, type: 'number' | 'string', name: string, usage?: string): string | number {
  if (type === 'string') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} 需要一个数字，收到 "${raw}"`, usage);
  return n;
}
