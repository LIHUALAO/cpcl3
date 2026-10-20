/**
 * Microsoft OAuth 2.0 设备码登录 + Xbox Live / XSTS / Minecraft 三步换令牌。
 *
 * 背景：`authserver.mojang.com` 已废弃且 DNS 不再解析，yarn 认证彻底不可用；
 * 官方启动器现在走的就是这条链路，本文件的实现与官方一致：
 *
 *   devicecode ──(用户浏览器输码)──> token(MSA access_token + refresh_token)
 *     → POST https://user.auth.xboxlive.com/user/authenticate        (XBL)
 *     → POST https://xsts.auth.xboxlive.com/xsts/authorize           (XSTS)
 *     → POST https://api.minecraftservices.com/authentication/login_with_xbox
 *     → GET  https://api.minecraftservices.com/minecraft/profile     (uuid / name)
 *
 * 硬约束：
 * - 只用 Node 内置 fetch，零第三方依赖
 * - refreshToken 绝不进日志 / 错误信息；所有对外文案统一过 `redactTokens`
 * - 每一步都解析错误体并抛出可读信息
 */

import * as crypto from 'node:crypto';
import type { Account, DeviceCodeSession } from '../types.js';
import {
  DEFAULT_DEVICE_CODE_TTL_SEC,
  DEFAULT_POLL_INTERVAL_SEC,
  MC_LOGIN_XBOX_URL,
  MC_PROFILE_URL,
  MS_DEVICE_CODE_URL,
  MS_SCOPE,
  MS_TOKEN_URL,
  OAUTH_ERRORS,
  SLOW_DOWN_INCREMENT_SEC,
  TOKEN_EXPIRY_SKEW_MS,
  XBL_AUTH_URL,
  XSTS_AUTH_URL,
  XSTS_ERROR_MESSAGES,
  XSTS_RELYING_PARTY,
  isPlaceholderClientId,
  resolveClientId,
} from './constants.js';
import { getDataRoot, warmUpDataRoot } from './dataRoot.js';
import { type AuthLogger, REDACTED, redactTokens, silentLogger } from './redact.js';
import { upsertAccount } from './storage.js';

// ───────────────────────────── 错误类型 ─────────────────────────────

/** 认证链路错误基类：带机器可读 code，便于 UI 分支处理 */
export class AuthError extends Error {
  readonly code: string;
  /** 原始错误体（已脱敏），便于排障；不含 refresh_token */
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 设备码轮询过程中的临时状态（pending / slow_down），调用方应继续轮询 */
export class AuthPendingError extends AuthError {
  /** slow_down 后建议的轮询间隔（秒）；未指定则沿用原间隔 */
  readonly nextInterval?: number;

  constructor(code: string, message: string, nextInterval?: number) {
    super(code, message);
    this.name = 'AuthPendingError';
    if (nextInterval !== undefined) this.nextInterval = nextInterval;
  }
}

/** 网络层失败（DNS / 连接 / 超时） */
export class AuthNetworkError extends AuthError {
  constructor(url: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      'network_error',
      `连接微软 / Xbox 服务失败：${hostOf(url)} 无法访问（${redactTokens(reason)}）。` +
        '请检查网络、代理或 DNS 设置后重试。',
      redactTokens(reason),
    );
    this.name = 'AuthNetworkError';
  }
}

// ───────────────────────────── 内部工具 ─────────────────────────────

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 依次读取 error / error_description / XErr / redirect_uri 等字段，拼成一句话 */
function extractServerMessage(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 500);
  if (!body || typeof body !== 'object') return '';
  const o = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['error_description', 'errorMessage', 'message', 'Message', 'error', 'XErr', 'Redirect']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
    else if (typeof v === 'number') parts.push(String(v));
  }
  return parts.join(' | ').slice(0, 800);
}

/** 从错误体里取 XErr（XSTS 用它区分「没 Xbox 账户」等情况） */
function extractXErr(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>)['XErr'];
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

interface HttpResult {
  status: number;
  body: unknown;
  rawText: string;
}

/** 统一的请求封装：把网络异常统一转成 AuthNetworkError，并尽力解析 JSON 错误体 */
async function request(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  logger: AuthLogger = silentLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  const { timeoutMs = 30_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    logger.debug(`→ ${init.method ?? 'GET'} ${hostOf(url)}`);
    // 某些环境（如自建代理）不支持 undici 的全部特性，但标准 fetch 足够
    res = await fetchImpl(url, { ...rest, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      throw new AuthNetworkError(url, new Error(`请求超时（${timeoutMs}ms）`));
    }
    throw new AuthNetworkError(url, err);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text().catch(() => '');
  let body: unknown = rawText;
  if (rawText.length > 0) {
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      body = rawText;
    }
  }
  logger.debug(`← ${res.status} ${hostOf(url)}`);
  return { status: res.status, body, rawText };
}

function postForm(
  url: string,
  params: Record<string, string>,
  logger: AuthLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  return request(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    },
    logger,
    fetchImpl,
  );
}

function postJson(
  url: string,
  payload: unknown,
  logger: AuthLogger,
  extraHeaders: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  return request(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    },
    logger,
    fetchImpl,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 毫秒时间戳是否已过期（含 60 秒余量） */
export function isExpired(expiresAt: number | undefined, now: number = Date.now()): boolean {
  if (typeof expiresAt !== 'number' || Number.isNaN(expiresAt)) return true;
  if (!Number.isFinite(expiresAt)) return false; // +Infinity：永不过期
  return now + TOKEN_EXPIRY_SKEW_MS >= expiresAt;
}

// ───────────────────────────── HTTP 报文形状 ─────────────────────────────

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
  error?: string;
  error_description?: string;
}

interface MsaTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface XblResponse {
  Token?: string;
  DisplayClaims?: { xui?: { uhs?: string; xid?: string }[] };
  Identity?: string;
}

interface XstsResponse {
  Token?: string;
  DisplayClaims?: { xui?: { uhs?: string; xid?: string }[] };
  XErr?: number | string;
  Message?: string;
  Redirect?: string;
}

interface McLoginResponse {
  username?: string;
  access_token?: string;
  expires_in?: number;
  roles?: unknown[];
  token_type?: string;
  error?: string;
  errorMessage?: string;
}

interface McProfileResponse {
  id?: string;
  name?: string;
  error?: string;
  errorMessage?: string;
  errorType?: string;
}

// ───────────────────────────── 无 skins 的 UUID 格式化 ─────────────────────────────

/** 把 Minecraft 返回的 32 位无连字符 uuid 规范成 8-4-4-4-12 */
export function formatUuid(raw: string): string {
  const hex = raw.replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) return raw.toLowerCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// ───────────────────────────── 主体 ─────────────────────────────

export interface MicrosoftAuthOptions {
  /** 覆盖 client_id（默认读 `resolveClientId()`，即常量或 PCL3_AZURE_CLIENT_ID） */
  clientId?: string;
  /** 日志器，默认全静默 */
  logger?: AuthLogger;
  /** 是否把登录/刷新结果写进 `<dataRoot>/accounts.json`，默认 true */
  persist?: boolean;
  /** 数据根目录，默认走 `getDataRoot()` */
  dataRoot?: string;
  /** 允许注入 fetch 以便测试（默认全局 fetch） */
  fetchImpl?: typeof fetch;
}

/** 换令牌链路中间产物（便于测试与排障） */
export interface XboxChainResult {
  xblToken: string;
  xstsToken: string;
  userHash: string;
  xuid?: string;
  mcAccessToken: string;
  mcExpiresIn: number;
  profile: { id: string; name: string };
}

export class MicrosoftAuth {
  private readonly clientId: string;
  private readonly logger: AuthLogger;
  private readonly persist: boolean;
  private readonly dataRoot: string | undefined;
  /**
   * 可注入的 fetch 实现。
   *
   * `MicrosoftAuthOptions.fetchImpl` 早就声明了这个可选字段，但构造函数此前没有把它
   * 接进来 —— 于是测试或代理场景注入的 fetch 被静默忽略，实际仍走全局 fetch（真实网络）。
   * 这里补上赋值；未注入时 undefined，`request()` 会回落到全局 fetch。
   */
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: MicrosoftAuthOptions = {}) {
    this.clientId = (opts.clientId ?? resolveClientId()).trim();
    this.logger = opts.logger ?? silentLogger;
    this.persist = opts.persist ?? true;
    this.dataRoot = opts.dataRoot;
    this.fetchImpl = opts.fetchImpl;
    // fire-and-forget：download 模块就绪时把它的 getDataRoot 接过来
    void warmUpDataRoot();
  }

  /** 当前生效的 client_id（占位符时给出警告） */
  getClientId(): string {
    return this.clientId;
  }

  private assertClientIdUsable(): void {
    if (isPlaceholderClientId(this.clientId)) {
      this.logger.warn(
        'AZURE_CLIENT_ID 仍是占位符 00000000-0000-0000-0000-000000000000。' +
          '请先在 Azure 门户注册应用（允许设备码公共客户端）并把 client_id 填进 src/core/auth/constants.ts，' +
          '或设置环境变量 PCL3_AZURE_CLIENT_ID。',
      );
    }
  }

  // ─────────────── 1. 设备码 ───────────────

  /**
   * 发起设备码登录：返回给用户展示的 `userCode` 与 `verificationUri`。
   * 用户须在浏览器打开 `verificationUri` 输入 `userCode`，之后调用 `completeDeviceCode()` 轮询。
   */
  async beginDeviceCode(): Promise<DeviceCodeSession> {
    this.assertClientIdUsable();

    const { status, body } = await postForm(
      MS_DEVICE_CODE_URL,
      { client_id: this.clientId, scope: MS_SCOPE },
      this.logger,
      this.fetchImpl ?? fetch,
    );
    const o = (body ?? {}) as DeviceCodeResponse;

    if (status >= 400 || o.error || !o.device_code) {
      throw new AuthError(
        o.error ?? `http_${status}`,
        deviceCodeErrorMessage(o.error, o.error_description, status, this.clientId),
        redactTokens(extractServerMessage(body)),
      );
    }

    if (!o.user_code || !o.verification_uri) {
      throw new AuthError(
        'malformed_devicecode',
        '微软设备码接口返回了不完整的响应（缺少 user_code 或 verification_uri），请稍后重试。',
        redactTokens(extractServerMessage(body)),
      );
    }

    const session: DeviceCodeSession = {
      userCode: o.user_code,
      verificationUri: o.verification_uri,
      deviceCode: o.device_code,
      interval: typeof o.interval === 'number' && o.interval > 0 ? o.interval : DEFAULT_POLL_INTERVAL_SEC,
      expiresIn: typeof o.expires_in === 'number' && o.expires_in > 0 ? o.expires_in : DEFAULT_DEVICE_CODE_TTL_SEC,
    };
    if (typeof o.message === 'string') session.message = o.message;

    this.logger.info(
      `设备码登录已开始：请在浏览器打开 ${session.verificationUri} 并输入 ${session.userCode}（${Math.round(session.expiresIn / 60)} 分钟内有效）`,
    );
    return session;
  }

  // ─────────────── 2. 轮询 + 三步换令牌 ───────────────

  /**
   * 轮询 token 端点直到用户完成授权，然后一路换到 Minecraft 令牌并拉 profile。
   *
   * @param deviceCode `beginDeviceCode()` 返回的 deviceCode
   * @param interval   轮询间隔（秒），来自 `beginDeviceCode()` 的 interval
   */
  async completeDeviceCode(deviceCode: string, interval: number): Promise<Account> {
    const token = await this.pollForMsaToken(deviceCode, interval);
    const account = await this.exchangeMsaToken(token.access_token, token.refresh_token, token.expires_in);
    this.persistAccount(account, '登录');
    this.logger.info(`登录成功：${account.username}（${account.uuid}）`);
    return account;
  }

  /** 轮询直到拿到 MSA access_token；pending 继续、slow_down +5s、expired 报错退出 */
  private async pollForMsaToken(
    deviceCode: string,
    interval: number,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    let pollInterval = Math.max(1, Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_SEC);
    // 设备码总有效期：默认 15 分钟，实际以服务端 expired_token 为准
    const deadline = Date.now() + DEFAULT_DEVICE_CODE_TTL_SEC * 1000;

    for (;;) {
      if (Date.now() > deadline) {
        throw new AuthError(
          OAUTH_ERRORS.EXPIRED_TOKEN,
          '设备码已过期（等待超时）。请重新开始登录流程，获取新的验证码。',
        );
      }

      const { status, body } = await postForm(
        MS_TOKEN_URL,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: this.clientId,
          device_code: deviceCode,
        },
        this.logger,
        this.fetchImpl ?? fetch,
      );
      const o = (body ?? {}) as MsaTokenResponse & { error?: string };
      const errCode = typeof o.error === 'string' ? o.error : '';
      const errDesc = typeof o.error_description === 'string' ? o.error_description : '';

      if (status < 400 && o.access_token) {
        return {
          access_token: o.access_token,
          ...(typeof o.refresh_token === 'string' ? { refresh_token: o.refresh_token } : {}),
          expires_in: typeof o.expires_in === 'number' ? o.expires_in : 3600,
        };
      }

      switch (errCode) {
        case OAUTH_ERRORS.AUTHORIZATION_PENDING:
          this.logger.debug('等待用户在浏览器完成授权…');
          await sleep(pollInterval * 1000);
          continue;

        case OAUTH_ERRORS.SLOW_DOWN:
          pollInterval += SLOW_DOWN_INCREMENT_SEC;
          this.logger.warn(`微软要求降低轮询频率，间隔调整为 ${pollInterval} 秒。`);
          await sleep(pollInterval * 1000);
          continue;

        case OAUTH_ERRORS.EXPIRED_TOKEN:
          throw new AuthError(
            OAUTH_ERRORS.EXPIRED_TOKEN,
            '设备码已过期。请重新开始登录流程（重新获取验证码），旧验证码不能再使用。',
            redactTokens(errDesc),
          );

        case OAUTH_ERRORS.AUTHORIZATION_DECLINED:
          throw new AuthError(
            OAUTH_ERRORS.AUTHORIZATION_DECLINED,
            '你在浏览器中取消了这次登录授权。如需登录请重新开始流程。',
            redactTokens(errDesc),
          );

        case OAUTH_ERRORS.BAD_VERIFICATION_CODE:
          throw new AuthError(
            OAUTH_ERRORS.BAD_VERIFICATION_CODE,
            '设备码无效或已被使用过。请重新开始登录流程。',
            redactTokens(errDesc),
          );

        default:
          throw new AuthError(
            errCode || `http_${status}`,
            `获取微软令牌失败：${redactTokens(errDesc || extractServerMessage(body) || `HTTP ${status}`)}`,
            redactTokens(extractServerMessage(body)),
          );
      }
    }
  }

  // ─────────────── 3. 刷新 ───────────────

  /**
   * 用 refresh_token 换新令牌。
   *
   * - 刷新前先判断是否真的过期（60 秒余量）；未过期直接返回原账户
   * - 刷新成功拿到新 MSA access_token 后，仍然要重走 XBL → XSTS → MC，
   *   因为 Minecraft 的 access_token 是另一套令牌，不会随 MSA 刷新自动续期
   * - 新 expiresAt = now + expires_in * 1000
   */
  async refresh(account: Account): Promise<Account> {
    if (account.type !== 'microsoft') {
      // 离线账户没有刷新概念，原样返回
      return { ...account };
    }
    if (!isExpired(account.expiresAt)) {
      this.logger.debug('令牌尚未过期，跳过刷新。');
      return { ...account };
    }
    if (!account.refreshToken) {
      throw new AuthError(
        'missing_refresh_token',
        '该账户没有 refresh token，无法自动续期，请重新登录。',
      );
    }

    this.assertClientIdUsable();

    const { status, body } = await postForm(
      MS_TOKEN_URL,
      {
        grant_type: 'refresh_token',
        client_id: this.clientId,
        refresh_token: account.refreshToken,
        scope: MS_SCOPE,
      },
      this.logger,
      this.fetchImpl ?? fetch,
    );
    const o = (body ?? {}) as MsaTokenResponse;
    if (status >= 400 || !o.access_token) {
      const errCode = typeof o.error === 'string' ? o.error : '';
      if (errCode === OAUTH_ERRORS.INVALID_GRANT || status === 400) {
        throw new AuthError(
          errCode || 'invalid_grant',
          'refresh token 已失效（可能被改密码、撤销授权或长期未使用）。请重新走设备码登录。',
          redactTokens(extractServerMessage(body)),
        );
      }
      throw new AuthError(
        errCode || `http_${status}`,
        `刷新微软令牌失败：${redactTokens(typeof o.error_description === 'string' ? o.error_description : extractServerMessage(body) || `HTTP ${status}`)}`,
        redactTokens(extractServerMessage(body)),
      );
    }

    // 微软可能轮换 refresh_token；没给就沿用旧的
    const refreshToken = typeof o.refresh_token === 'string' && o.refresh_token.length > 0 ? o.refresh_token : account.refreshToken;
    const refreshed = await this.exchangeMsaToken(o.access_token, refreshToken, o.expires_in, account);
    this.persistAccount(refreshed, '刷新');
    this.logger.info(`令牌已刷新：${refreshed.username}，到期时间 ${new Date(refreshed.expiresAt ?? 0).toISOString()}`);
    return refreshed;
  }

  // ─────────────── 4. MSA → XBL → XSTS → MC ───────────────

  /**
   * 完整的三步换令牌链路 + profile 拉取。
   *
   * @param msaAccessToken 微软 OAuth 的 access_token
   * @param refreshToken   持久化用的 refresh_token（可为空，空则不写）
   * @param expiresIn      微软令牌有效期（秒）
   * @param previous       刷新场景下的旧账户，用于在 profile 失败时保留旧用户名
   */
  private async exchangeMsaToken(
    msaAccessToken: string,
    refreshToken: string | undefined,
    expiresIn: number | undefined,
    previous?: Account,
  ): Promise<Account> {
    const chain = await this.authenticateXboxChain(msaAccessToken);

    const account: Account = {
      type: 'microsoft',
      username: chain.profile.name,
      uuid: formatUuid(chain.profile.id),
      accessToken: chain.mcAccessToken,
      expiresAt: Date.now() + (chain.mcExpiresIn || (expiresIn ?? 3600)) * 1000,
    };
    if (refreshToken) account.refreshToken = refreshToken;
    if (chain.xuid) account.xuid = chain.xuid;
    if (!account.username && previous?.username) account.username = previous.username;

    this.logger.debug(`Minecraft profile 已获取：${account.username} / ${account.uuid}`);
    return account;
  }

  /**
   * Xbox 换令牌链路（可单独调用，便于测试与「只换 MC token」的场景）。
   *
   * 1. MSA access_token → XBL   `user.auth.xboxlive.com/user/authenticate`
   * 2. XBL token → XSTS         `xsts.auth.xboxlive.com/xsts/authorize`
   * 3. XSTS → Minecraft token   `api.minecraftservices.com/authentication/login_with_xbox`
   * 4. GET profile              拿 uuid 与 username
   */
  async authenticateXboxChain(msaAccessToken: string): Promise<XboxChainResult> {
    // ── 第一步：XBL ──
    const xblRes = await postJson(
      XBL_AUTH_URL,
      {
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `d=${msaAccessToken}`,
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
      },
      this.logger,
      { 'x-xbl-contract-version': '1' },
      this.fetchImpl ?? fetch,
    );
    const xbl = (xblRes.body ?? {}) as XblResponse;
    if (xblRes.status >= 400 || !xbl.Token) {
      throw new AuthError(
        'xbl_auth_failed',
        `Xbox Live 认证失败（第一步换令牌，HTTP ${xblRes.status}）：${redactTokens(extractServerMessage(xblRes.body) || '微软账户令牌可能已失效，请重新登录。')}`,
        redactTokens(extractServerMessage(xblRes.body)),
      );
    }

    // ── 第二步：XSTS ──
    const xstsRes = await postJson(
      XSTS_AUTH_URL,
      {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
        RelyingParty: XSTS_RELYING_PARTY,
        TokenType: 'JWT',
      },
      this.logger,
      { 'x-xbl-contract-version': '1' },
      this.fetchImpl ?? fetch,
    );
    const xsts = (xstsRes.body ?? {}) as XstsResponse;
    const xerr = extractXErr(xstsRes.body) ?? (typeof xsts.XErr === 'number' ? String(xsts.XErr) : undefined);

    if (xstsRes.status >= 400 || xerr || !xsts.Token) {
      const mapped = xerr ? XSTS_ERROR_MESSAGES[xerr] : undefined;
      const human = mapped
        ? mapped
        : `Xbox 授权（XSTS）失败（HTTP ${xstsRes.status}${xerr ? `，XErr ${xerr}` : ''}）：${redactTokens(extractServerMessage(xstsRes.body) || '未知原因')}`;
      // 明确标注错误码，UI 可据 code 做引导（xbox.com 注册 / 地区不支持 / 家庭组）
      throw new AuthError(xerr ? `xsts_${xerr}` : 'xsts_failed', human, redactTokens(extractServerMessage(xstsRes.body)));
    }

    const xui = xsts.DisplayClaims?.xui?.[0];
    const userHash = xui?.uhs;
    if (!userHash) {
      throw new AuthError(
        'xsts_missing_uhs',
        'Xbox 授权响应里缺少 user hash（uhs），无法继续登录 Minecraft。请稍后重试。',
        redactTokens(extractServerMessage(xstsRes.body)),
      );
    }

    // ── 第三步：XSTS → Minecraft ──
    const mcRes = await postJson(
      MC_LOGIN_XBOX_URL,
      { identityToken: `XBL3.0 x=${userHash};${xsts.Token}` },
      this.logger,
      {},
      this.fetchImpl ?? fetch,
    );
    const mc = (mcRes.body ?? {}) as McLoginResponse;
    if (mcRes.status >= 400 || !mc.access_token) {
      throw new AuthError(
        'mc_login_failed',
        `登录 Minecraft 服务端失败（HTTP ${mcRes.status}）：${redactTokens(extractServerMessage(mcRes.body) || 'Xbox 身份未被 Minecraft 接受')}`,
        redactTokens(extractServerMessage(mcRes.body)),
      );
    }

    // ── 第四步：profile ──
    const profileRes = await request(
      MC_PROFILE_URL,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${mc.access_token}`, accept: 'application/json' },
      },
      this.logger,
      this.fetchImpl ?? fetch,
    );
    const profile = (profileRes.body ?? {}) as McProfileResponse;

    if (profileRes.status === 404) {
      throw new AuthError(
        'no_minecraft_profile',
        '登录成功，但该微软账户没有购买 Minecraft（Java 版）。' +
          '请在 https://www.minecraft.net 购买后再登录；如果确认已购买，请稍等几分钟（资料同步有延迟）后重试。',
        redactTokens(extractServerMessage(profileRes.body)),
      );
    }
    if (profileRes.status >= 400 || !profile.id || !profile.name) {
      throw new AuthError(
        'mc_profile_failed',
        `获取 Minecraft 资料失败（HTTP ${profileRes.status}）：${redactTokens(extractServerMessage(profileRes.body) || '响应缺少 id / name')}`,
        redactTokens(extractServerMessage(profileRes.body)),
      );
    }

    return {
      xblToken: xbl.Token,
      xstsToken: xsts.Token,
      userHash,
      ...(xui?.xid ? { xuid: xui.xid } : {}),
      mcAccessToken: mc.access_token,
      mcExpiresIn: typeof mc.expires_in === 'number' ? mc.expires_in : 86_400,
      profile: { id: profile.id, name: profile.name },
    };
  }

  // ─────────────── 5. 持久化 ───────────────

  /** 写盘（persist=false 时跳过）。写盘失败只记 warn，不让登录整体失败 */
  private persistAccount(account: Account, reason: string): void {
    if (!this.persist) return;
    try {
      const root = this.dataRoot;
      if (root !== undefined) upsertAccount(account, root, this.logger);
      else upsertAccount(account, getDataRoot(), this.logger);
    } catch (err) {
      this.logger.warn(`账户写盘失败（${reason}），本次登录仍可继续使用：${redactTokens((err as Error).message)}`);
    }
  }
}

/** 设备码阶段的错误 → 人话 */
function deviceCodeErrorMessage(
  error: string | undefined,
  errorDescription: string | undefined,
  status: number,
  clientId: string,
): string {
  const desc = redactTokens(errorDescription ?? '');
  switch (error) {
    case OAUTH_ERRORS.UNAUTHORIZED_CLIENT:
    case OAUTH_ERRORS.INVALID_CLIENT:
      return (
        `client_id 无效（${clientId}）。请在 Azure 门户注册一个允许「移动和桌面应用程序 / 设备码流」的公共客户端应用，` +
        '把 Application (client) ID 填进 src/core/auth/constants.ts 的 AZURE_CLIENT_ID，' +
        '或设置环境变量 PCL3_AZURE_CLIENT_ID 后重试。' +
        (desc ? `（微软原文：${desc}）` : '')
      );
    default:
      return `获取设备码失败（HTTP ${status}）${error ? `：${error}` : ''}${desc ? ` —— ${desc}` : ''}`;
  }
}

/** 供测试 / 上层复用：把 refresh_token 打掉的通用脱敏 */
export { redactTokens, REDACTED };

/** 生成随机 state（预留：以后接 Web 端回调流程时用） */
export function randomState(): string {
  return crypto.randomBytes(16).toString('hex');
}
