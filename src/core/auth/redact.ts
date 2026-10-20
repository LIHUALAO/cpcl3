/**
 * 令牌打码 / 日志脱敏。
 *
 * 硬约束：refreshToken 绝不进日志或错误信息。任何要落日志、要抛给用户的字符串
 * 都必须先过 `redactTokens()`。
 */

/** 打码后的替代文本 */
export const REDACTED = '[REDACTED]';

/** 值本身短于这个长度就不当成 token 处理（避免把普通短词误伤） */
const MIN_SECRET_LENGTH = 8;

/**
 * 已知敏感字段名。`key=value` / `key: value` / `"key":"value"` 三种形式都会命中。
 * 含 access_token、refresh_token、client_secret、id_token（JWT 里带身份信息）。
 */
const SECRET_KEYS = [
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'authorization',
  'minecraft_access_token',
] as const;

/** JWT 形态：eyJxxx.yyy.zzz（MSA 的 id_token 就是 JWT） */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?\b/g;

/**
 * Minecraft access token 形态：JWT 去掉 JWT 前缀 `eyJ` 后的 `xxxx.yyyy`（两段）。
 * MS 换 MC 后给的是 `header.payload` 结构，没有签名段。
 */
const MC_TOKEN_RE = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g;

/** Xbox Live / XSTS token 的常见前缀（XBL3.0、XBL2.0、t=、d=） */
const XBL_TOKEN_RE = /\b(?:XBL3?\.0\s+)?(?:x|X|t|d)=[A-Za-z0-9+/=_-]{30,}/g;

/** 十六进制/长 base64 串，长度 ≥ 40 一律当密钥处理 */
const LONG_OPAQUE_RE = /\b[A-Za-z0-9+/=_-]{40,}\b/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 对任意字符串做 token 脱敏：`key=value` 按字段名命中，再加几类形态兜底。
 *
 * @param input 原始字符串（可能含 token）
 * @param extraSecrets 调用方已知的具体 token 值（例如 account.accessToken），
 *        这些值即使形态不匹配也会被精确替换掉。
 */
export function redactTokens(input: string, extraSecrets: readonly string[] = []): string {
  let out = String(input);

  // 1) 调用方显式给的具体 token 值，最可靠
  for (const secret of extraSecrets) {
    if (typeof secret !== 'string') continue;
    const s = secret.trim();
    if (s.length < MIN_SECRET_LENGTH) continue;
    out = out.split(s).join(REDACTED);
  }

  // 2) 已知字段名：key=value / key: value / "key":"value"
  for (const key of SECRET_KEYS) {
    const k = escapeRegExp(key);
    const re = new RegExp(`(["']?\\b${k}\\b["']?\\s*[=:]\\s*)(["']?)([^"'\\s,&}]+)(\\2)`, 'gi');
    out = out.replace(re, (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`);
  }

  // 3) 形态兜底
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(XBL_TOKEN_RE, (m) => {
    // 保留前缀（XBL3.0 x=）便于排障，只打码值
    const idx = m.indexOf('=');
    return idx >= 0 ? `${m.slice(0, idx + 1)}${REDACTED}` : REDACTED;
  });
  out = out.replace(MC_TOKEN_RE, REDACTED);
  out = out.replace(LONG_OPAQUE_RE, REDACTED);

  return out;
}

/**
 * 对 token 本身做掩码展示：保留头尾几位便于人眼区分，中间打码。
 * 只用于「必须显示一点特征」的场景，日志默认用 `[REDACTED]`。
 */
export function maskToken(token: string | undefined | null): string {
  if (!token) return '';
  const t = String(token);
  if (t.length <= 12) return REDACTED;
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/** 一个极简的脱敏 logger：任何参数先 stringify 再过 redactTokens */
export interface AuthLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** 默认 logger：全静默，避免把 token 或用户信息印到 stdout（CLI/Web 可注入自己的） */
export const silentLogger: AuthLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 把 logger 包一层自动脱敏 */
export function withRedaction(logger: AuthLogger, extraSecrets: readonly string[] = []): AuthLogger {
  const wrap = (fn: (m: string) => void) => (m: string) => fn(redactTokens(m, extraSecrets));
  return {
    debug: wrap((m) => logger.debug(m)),
    info: wrap((m) => logger.info(m)),
    warn: wrap((m) => logger.warn(m)),
    error: wrap((m) => logger.error(m)),
  };
}
