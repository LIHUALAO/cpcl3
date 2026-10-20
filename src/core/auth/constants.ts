/**
 * auth 模块的端点与常量真源。
 *
 * 契约见 docs/ARCHITECTURE.md「auth 模块」一节：
 * - 设备码端点 / 令牌端点 / scope 必须与此处一致
 * - client_id 集中在本文件，方便以后替换
 *
 * 设计说明：端点一律做成「可被环境变量覆盖」的 getter，方便以后接自建代理 / 镜像，
 * 但默认值就是官方地址，不做任何渠道妥协。
 */

// ───────────────────────────── Azure 应用（client_id） ─────────────────────────────

/**
 * Azure AD 应用（客户端）ID —— 占位符。
 *
 * 需要用户在 Azure 门户注册应用后替换（应用类型：公共客户端 / 允许设备码流），
 * 或使用公开的第三方 client_id。仓库里绝不留真实 client_id。
 *
 * 可通过环境变量 `PCL3_AZURE_CLIENT_ID` 覆盖，便于本地与 CI 切换。
 */
export const AZURE_CLIENT_ID = '00000000-0000-0000-0000-000000000000';

/** 是否仍在使用占位 client_id（用于在报错时给出「请先配置」的人话提示） */
export const AZURE_CLIENT_ID_IS_PLACEHOLDER = AZURE_CLIENT_ID === '00000000-0000-0000-0000-000000000000';

/** 实际生效的 client_id：环境变量优先 */
export function resolveClientId(): string {
  const fromEnv = process.env['PCL3_AZURE_CLIENT_ID'];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return AZURE_CLIENT_ID;
}

/** 判断某个 client_id 是否是占位符（00000000-...） */
export function isPlaceholderClientId(clientId: string): boolean {
  return /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(clientId.trim());
}

// ───────────────────────────── Microsoft OAuth 2.0 ─────────────────────────────

/** 消费者租户（个人微软账户）。Minecraft 只认 consumers，不能用 common/organizations。 */
const MS_TENANT = 'consumers';

/** 设备码端点 */
export const MS_DEVICE_CODE_URL = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/devicecode`;
/** 令牌端点（授权码 / 设备码换 token、refresh_token 换 token 都走这里） */
export const MS_TOKEN_URL = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`;

/** OAuth scope：XboxLive.signin 用于换取 Xbox 身份，offline_access 才会下发 refresh_token */
export const MS_SCOPE = 'XboxLive.signin offline_access';

// ───────────────────────────── Xbox Live / XSTS ─────────────────────────────

export const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
export const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';

/** 依赖方标识：Minecraft 的 Relying Party */
export const XSTS_RELYING_PARTY = 'rp://api.minecraftservices.com/';

// ───────────────────────────── Minecraft 服务端 ─────────────────────────────

export const MC_LOGIN_XBOX_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
export const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

// ───────────────────────────── 令牌生命周期 ─────────────────────────────

/** 过期判断余量：到期前 60 秒就认为已过期，避免边界上发出去的请求被拒 */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** 设备码轮询的默认/最小间隔（秒），与微软 devicecode 响应的 interval 对齐 */
export const DEFAULT_POLL_INTERVAL_SEC = 5;

/** slow_down 时每次增加的秒数（RFC 8628 要求 +5） */
export const SLOW_DOWN_INCREMENT_SEC = 5;

/** 设备码默认有效期（秒），devicecode 响应里没有 expires_in 时兜底 */
export const DEFAULT_DEVICE_CODE_TTL_SEC = 900;

// ───────────────────────────── 已知错误码 ─────────────────────────────

/** OAuth 轮询相关错误码（RFC 8628） */
export const OAUTH_ERRORS = {
  AUTHORIZATION_PENDING: 'authorization_pending',
  SLOW_DOWN: 'slow_down',
  EXPIRED_TOKEN: 'expired_token',
  AUTHORIZATION_DECLINED: 'authorization_declined',
  BAD_VERIFICATION_CODE: 'bad_verification_code',
  INVALID_GRANT: 'invalid_grant',
  INVALID_CLIENT: 'invalid_client',
  UNAUTHORIZED_CLIENT: 'unauthorized_client',
} as const;

/**
 * XSTS 常见 XErr 错误码 → 人话。
 * 参考 Xbox 身份验证错误码表。
 */
export const XSTS_ERROR_MESSAGES: Record<string, string> = {
  '2148916233': '该微软账户还没有 Xbox 账户。请先访问 https://xbox.com 登录一次，创建一个 Xbox 档案后再回来重试。',
  '2148916235': '该账户所在地区不支持 Xbox Live（受当地法规限制），无法登录 Minecraft。',
  '2148916236': '该账户需要在 Xbox 网页端完成年龄验证（地区性成人验证）后才能使用 Xbox Live。',
  '2148916237': '该账户完成年龄验证后仍受限，地区不支持 Xbox Live。',
  '2148916238': '该账户是未成年人账户，需要由家庭组管理员（家长账户）将其加入家庭组后才能使用 Xbox Live。',
  '2148916227': '该微软账户已被 Xbox Live 封禁。',
  '2148916229': '该微软账户已被 Xbox Live 封禁（违反服务条款）。',
  '2148916234': '该账户缺少 Xbox Live 的必要权限，请检查家庭组 / 隐私设置。',
};
