/**
 * 实例设置：类型、默认值与校验规则。
 *
 * 设计要点：
 *   - 只描述「一个版本/实例自己的启动偏好」，不碰 LaunchOptions（共享类型归 version-dev）。
 *   - 默认值集中在这里，`SettingsStore.resolve()`、Web API、CLI 三处共用同一个数。
 *   - 校验函数是纯函数，不读磁盘、不抛业务异常，返回「清洗后的值 + 人话问题列表」，
 *     只有真的越过硬边界才进入 `errors`，可修的小问题（例如多余的空白）静默清洗。
 */

export interface InstanceSettings {
  /** 实例名（默认用 versionId） */
  id: string;
  versionId: string;
  /**
   * 显示名（用户给这个版本起的名字，例如「26.3 生存服」）。
   *
   * **只是显示名，不是目录名**：目录名（`instances/<versionId>`）永远不能改——
   * 改了会破坏所有引用（存档、mods、崩溃报告里的路径、任务记录）。
   * 前端一律用 `displayName || versionId` 显示，留空就等于没有显示名。
   */
  displayName?: string;
  /** 最大内存 MB。默认 2048 */
  memoryMB?: number;
  /** 最小内存 MB（-Xmn）。不填则由 launch 模块按 1/4 推导 */
  minMemoryMB?: number;
  /** 附加 JVM 参数 */
  extraJvmArgs?: string[];
  /** 附加游戏参数 */
  extraGameArgs?: string[];
  /** 覆盖 Java 路径；不填则自动查找/下载 */
  javaPath?: string;
  /** 窗口宽度/高度 */
  windowWidth?: number;
  windowHeight?: number;
  /** 是否全屏 */
  fullscreen?: boolean;
}

// ───────────────────────────── 常量 ─────────────────────────────

/** 默认最大内存（与 launch 模块的 DEFAULT_MEMORY_MB 一致） */
export const DEFAULT_MEMORY_MB = 2048;

/** 内存取值硬边界（MB）。低于 512 连原版都起不来，高于 64 GB 一定是乱填。 */
export const MEMORY_MIN_MB = 512;
export const MEMORY_MAX_MB = 65536;

/** 界面滑块的软上限（前端用，后端不据此拒绝） */
export const MEMORY_SLIDER_MAX_MB = 16384;

/** 单条附加参数的长度上限：真实 JVM 参数没有这么长的 */
export const ARG_MAX_LENGTH = 4096;

/** 附加参数条数上限：防止有人拿它当存储用 */
export const ARG_MAX_COUNT = 256;

/** 窗口尺寸边界（像素） */
export const WINDOW_MIN = 320;
export const WINDOW_MAX = 16384;

/** Java 路径长度上限 */
export const JAVA_PATH_MAX = 1024;

/** 显示名长度上限（够写「1.21 生存储备档（勿删）」这种了） */
export const DISPLAY_NAME_MAX = 48;

/** 单次保存的 settings.json 大小上限（1 MB 足够宽松，挡住病态输入） */
export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

/** 允许出现在参数里的一切控制字符（换行、空字节、制表符…） */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** instanceId 白名单：与版本号同口径（字母数字 . _ - +），另允许空格与中文 */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._+\-\u4e00-\u9fa5 ]+$/;

// ───────────────────────────── 默认值 ─────────────────────────────

/**
 * 未保存过设置时的默认值。
 *
 * 注意 `memoryMB` 一定给具体数字：调用方（Web / CLI）直接把它塞进 LaunchOptions，
 * 让 launch 模块走「显式内存」分支，-Xmx/-Xmn 才会按这里的值覆盖元数据。
 */
export function defaultSettings(versionId: string, instanceId?: string): InstanceSettings {
  const id = typeof instanceId === 'string' && instanceId.trim().length > 0 ? instanceId.trim() : versionId;
  return { id, versionId, memoryMB: DEFAULT_MEMORY_MB };
}

// ───────────────────────────── 校验 ─────────────────────────────

export interface ValidationResult {
  /** 清洗后的设置（未提供且不该给默认值的字段不会出现） */
  settings: InstanceSettings;
  /** 致命问题：非空表示请求应被拒（HTTP 400 / CLI 退出码 2） */
  errors: string[];
  /** 被静默忽略的字段名（未知字段、类型不对的可选字段），仅用于调试与日志 */
  ignored: string[];
}

const KNOWN_KEYS = new Set([
  'id',
  'versionId',
  'displayName',
  'memoryMB',
  'minMemoryMB',
  'extraJvmArgs',
  'extraGameArgs',
  'javaPath',
  'windowWidth',
  'windowHeight',
  'fullscreen',
]);

/**
 * 校验并归一化一份「用户提交的设置」。
 *
 * 规则（与任务书一致）：
 *   - `memoryMB` 必须在 512 ～ 65536，越界即 400 并说明；
 *   - `extraJvmArgs` / `extraGameArgs` 必须是字符串数组，**含换行/空字节的项直接拒绝**；
 *   - 未知字段忽略不报错（向前兼容）；
 *   - `versionId` 由 URL / 命令行决定，body 里的同名值一律以它为准。
 */
export function validateSettings(raw: unknown, versionId: string, instanceId?: string): ValidationResult {
  const errors: string[] = [];
  const ignored: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      settings: defaultSettings(versionId, instanceId),
      errors: ['请求体必须是 JSON 对象，形如 {"memoryMB":4096}'],
      ignored,
    };
  }

  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) ignored.push(key);
  }

  const id = pickId(input, versionId, instanceId, errors);
  const settings: InstanceSettings = { id, versionId };

  const displayName = pickDisplayName(input['displayName'], errors);
  if (displayName !== undefined) settings.displayName = displayName;

  const memoryMB = pickInt(input['memoryMB'], 'memoryMB', MEMORY_MIN_MB, MEMORY_MAX_MB, '内存', errors);
  if (memoryMB !== undefined) settings.memoryMB = memoryMB;

  const minMemoryMB = pickInt(input['minMemoryMB'], 'minMemoryMB', MEMORY_MIN_MB, MEMORY_MAX_MB, '最小内存', errors);
  if (minMemoryMB !== undefined) settings.minMemoryMB = minMemoryMB;

  if (
    memoryMB !== undefined &&
    minMemoryMB !== undefined &&
    minMemoryMB > memoryMB
  ) {
    errors.push(`最小内存（${String(minMemoryMB)} MB）不能大于最大内存（${String(memoryMB)} MB）。`);
  }

  const jvmArgs = pickArgList(input['extraJvmArgs'], 'extraJvmArgs', 'JVM 参数', errors);
  if (jvmArgs !== undefined) settings.extraJvmArgs = jvmArgs;

  const gameArgs = pickArgList(input['extraGameArgs'], 'extraGameArgs', '游戏参数', errors);
  if (gameArgs !== undefined) settings.extraGameArgs = gameArgs;

  const javaPath = pickJavaPath(input['javaPath'], errors);
  if (javaPath !== undefined) settings.javaPath = javaPath;

  const windowWidth = pickInt(input['windowWidth'], 'windowWidth', WINDOW_MIN, WINDOW_MAX, '窗口宽度', errors);
  if (windowWidth !== undefined) settings.windowWidth = windowWidth;

  const windowHeight = pickInt(input['windowHeight'], 'windowHeight', WINDOW_MIN, WINDOW_MAX, '窗口高度', errors);
  if (windowHeight !== undefined) settings.windowHeight = windowHeight;

  // fullscreen 是布尔，写错了不值得报错——宁可当没填，也不让用户因为一个 true/"true" 卡住
  const fullscreen = input['fullscreen'];
  if (typeof fullscreen === 'boolean') settings.fullscreen = fullscreen;
  else if (fullscreen !== undefined) ignored.push('fullscreen');

  return { settings, errors, ignored };
}

/**
 * 显示名：只存给人看的那串字，**不参与任何路径拼接**。
 *
 * 所以校验比 id 宽松得多：允许中文、空格、emoji、括号；只挡三件会造成实际后果的事：
 *   1. 换行 / 控制字符 —— 会把一行 UI 文本劈成两行，也会污染日志；
 *   2. 空字节 —— JSON 里合法但下游各种字符串操作会截断；
 *   3. 超长 —— 48 字符以上在卡片里根本显示不下。
 * 空串等于「没有显示名」（用户清空了输入框），直接当作 undefined，让前端回落到 versionId。
 */
function pickDisplayName(raw: unknown, errors: string[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    errors.push('displayName（显示名）必须是字符串。');
    return undefined;
  }
  const text = raw.trim();
  if (text.length === 0) return undefined;
  if (text.length > DISPLAY_NAME_MAX) {
    errors.push(`显示名过长（${String(text.length)} 个字符，上限 ${String(DISPLAY_NAME_MAX)}）。`);
    return undefined;
  }
  if (text.includes('\u0000') || CONTROL_CHARS.test(text)) {
    errors.push('显示名里不能有换行或控制字符。');
    return undefined;
  }
  return text;
}

/**
 * javaPath 只做形状检查：留空 = 自动；真正的存在性检查留给 launch 模块（它会给出人话错误）。
 * 这里挡的是「路径里带引号/控制字符」这种明显的注入形状。
 */
function pickJavaPath(raw: unknown, errors: string[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    errors.push('javaPath 必须是字符串（指向 java/javaw 可执行文件或 java home 目录）。');
    return undefined;
  }
  const text = raw.trim();
  if (text.length === 0) return undefined;
  if (text.length > JAVA_PATH_MAX) {
    errors.push(`javaPath 过长（上限 ${String(JAVA_PATH_MAX)} 个字符）。`);
    return undefined;
  }
  if (CONTROL_CHARS.test(text) || text.includes('"')) {
    errors.push('javaPath 含非法字符（不允许引号或换行/控制字符）。');
    return undefined;
  }
  return text;
}

/**
 * 附加参数数组：必须是「字符串数组」。
 *
 * 这里拒绝的两类东西都是真的会造成后果的：
 *   - 换行：Windows 命令行拼接后能把一个参数劈成两条命令；
 *   - 空字节 U+0000：Node 的 spawn 会直接抛 ERR_INVALID_ARG_VALUE，且极易被用来做参数截断。
 * 空字符串项直接丢弃（用户在多行输入框里敲出的空行，不是错误）。
 */
function pickArgList(
  raw: unknown,
  field: string,
  label: string,
  errors: string[],
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${field} 必须是字符串数组，例如 ["-XX:+UseG1GC"]。`);
    return undefined;
  }
  if (raw.length > ARG_MAX_COUNT) {
    errors.push(`${label}条数过多（${String(raw.length)} 条，上限 ${String(ARG_MAX_COUNT)} 条）。`);
    return undefined;
  }

  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item: unknown = raw[i];
    if (typeof item !== 'string') {
      errors.push(`${field} 第 ${String(i + 1)} 项不是字符串（收到 ${describeType(item)}）。`);
      return undefined;
    }
    if (item.length > ARG_MAX_LENGTH) {
      errors.push(`${field} 第 ${String(i + 1)} 项过长（上限 ${String(ARG_MAX_LENGTH)} 个字符）。`);
      return undefined;
    }
    if (item.includes('\n') || item.includes('\r')) {
      errors.push(
        `${field} 第 ${String(i + 1)} 项含换行符：一条参数里不允许换行（否则会被命令行切开，等于注入新参数）。`,
      );
      return undefined;
    }
    if (item.includes('\u0000')) {
      errors.push(`${field} 第 ${String(i + 1)} 项含空字节（\\u0000），这是非法参数。`);
      return undefined;
    }
    if (CONTROL_CHARS.test(item)) {
      errors.push(`${field} 第 ${String(i + 1)} 项含控制字符（如制表符 \t），请去掉后再保存。`);
      return undefined;
    }
    const text = item.trim();
    if (text.length === 0) continue; // 空行：丢掉，不算错
    out.push(text);
  }
  return out;
}

function pickInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  label: string,
  errors: string[],
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push(`${field}（${label}）必须是数字，收到 ${describeType(raw)}。`);
    return undefined;
  }
  if (!Number.isInteger(raw)) {
    errors.push(`${field}（${label}）必须是整数，收到 ${String(raw)}。`);
    return undefined;
  }
  if (raw < min || raw > max) {
    errors.push(`${field}（${label}）必须在 ${String(min)} ～ ${String(max)} 之间，收到 ${String(raw)}。`);
    return undefined;
  }
  return raw;
}

/** id：优先用调用方给的实例名，其次 body.id，最后退回 versionId */
function pickId(
  input: Record<string, unknown>,
  versionId: string,
  instanceId: string | undefined,
  errors: string[],
): string {
  const candidates: string[] = [];
  if (typeof instanceId === 'string' && instanceId.trim().length > 0) candidates.push(instanceId.trim());
  const rawId = input['id'];
  if (typeof rawId === 'string' && rawId.trim().length > 0) candidates.push(rawId.trim());
  candidates.push(versionId);

  for (const candidate of candidates) {
    if (checkInstanceId(candidate) === null) return candidate;
  }
  errors.push(checkInstanceId(candidates[0] as string) ?? '实例 id 非法。');
  return versionId;
}

/**
 * 实例 id 检查：它会被拼进 `<dataRoot>/instances/<id>/settings.json`，
 * 所以「像不像路径」是唯一要紧的事——`..`、分隔符、盘符一律拒绝。
 */
export function checkInstanceId(id: string): string | null {
  if (typeof id !== 'string' || id.length === 0) return '实例 id 不能为空。';
  if (id.length > 64) return `实例 id 过长（${String(id.length)} 个字符，上限 64）。`;
  if (id === '.' || id === '..') return `实例 id 不能是「${id}」。`;
  if (/[/\\:]/.test(id)) return `实例 id 里不能出现路径分隔符或盘符：「${id}」。`;
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return `实例 id 只能包含字母、数字、中文、空格与 . _ + -：「${id}」。`;
  }
  return null;
}

/**
 * 从磁盘上读回来的对象 → InstanceSettings。
 *
 * 比 `validateSettings` 宽松：文件是被人手改过的，个别字段坏了不该让整份设置作废，
 * 二次校验会把越界的数字丢掉，最后补上默认内存。
 */
export function normalizeStored(raw: unknown, fallbackVersionId: string): InstanceSettings {
  const merged = validateSettings(raw, fallbackVersionId).settings;
  if (merged.memoryMB === undefined) merged.memoryMB = DEFAULT_MEMORY_MB;
  if (typeof merged.id !== 'string' || merged.id.length === 0) merged.id = fallbackVersionId;
  return merged;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value;
}
