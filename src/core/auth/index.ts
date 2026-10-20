/**
 * PCL3 auth 模块统一出口。
 *
 * 对外契约（docs/ARCHITECTURE.md「auth 模块」）：
 *   - `interface Account` 来自 `src/core/types.ts`
 *   - `class MicrosoftAuth { beginDeviceCode; completeDeviceCode; refresh }`
 *   - `function offlineAccount(username): Account`
 *
 * 其余导出都是辅助能力（持久化、打码、常量），上层按需使用。
 */

// ── 契约三件套 ──
export { MicrosoftAuth } from './microsoft.js';
export type { MicrosoftAuthOptions, XboxChainResult } from './microsoft.js';
export { offlineAccount, offlineUuid, isOfflineAccount, OFFLINE_PLAYER_PREFIX } from './offline.js';

// ── 类型（从唯一真源转发，不重复定义） ──
export type { Account, AccountType, DeviceCodeSession } from '../types.js';

// ── 端点与常量 ──
export {
  AZURE_CLIENT_ID,
  AZURE_CLIENT_ID_IS_PLACEHOLDER,
  resolveClientId,
  isPlaceholderClientId,
  MS_DEVICE_CODE_URL,
  MS_TOKEN_URL,
  MS_SCOPE,
  XBL_AUTH_URL,
  XSTS_AUTH_URL,
  XSTS_RELYING_PARTY,
  MC_LOGIN_XBOX_URL,
  MC_PROFILE_URL,
  TOKEN_EXPIRY_SKEW_MS,
  DEFAULT_POLL_INTERVAL_SEC,
  SLOW_DOWN_INCREMENT_SEC,
  DEFAULT_DEVICE_CODE_TTL_SEC,
  OAUTH_ERRORS,
  XSTS_ERROR_MESSAGES,
} from './constants.js';

// ── 错误类型 ──
export {
  AuthError,
  AuthPendingError,
  AuthNetworkError,
  isExpired,
  formatUuid,
  randomState,
} from './microsoft.js';

// ── 持久化 ──
export {
  ACCOUNTS_FILE_NAME,
  accountsFilePath,
  loadAccounts,
  saveAccounts,
  upsertAccount,
  removeAccount,
} from './storage.js';
export type { AccountStore } from './storage.js';

// ── 脱敏 ──
export { redactTokens, maskToken, silentLogger, withRedaction, REDACTED } from './redact.js';
export type { AuthLogger } from './redact.js';

// ── 数据目录 ──
export { getDataRoot, warmUpDataRoot } from './dataRoot.js';
