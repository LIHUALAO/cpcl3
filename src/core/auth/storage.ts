/**
 * 账户持久化：`<dataRoot>/accounts.json`。
 *
 * 契约：refreshToken 落盘到 `<dataRoot>/accounts.json`，文件权限收紧。
 * 结构刻意保持简单、可人工阅读（但里面是敏感数据，权限 0o600）：
 *
 * ```json
 * {
 *   "version": 1,
 *   "updatedAt": 1712345678901,
 *   "accounts": [ { "type": "microsoft", "username": "...", ... } ]
 * }
 * ```
 *
 * - 写入走「临时文件 + rename」，避免半截文件把账户库写坏
 * - Windows 上 `fs.chmod` 对 ACL 基本无效，尽力而为，失败不抛错
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Account } from '../types.js';
import { getDataRoot } from './dataRoot.js';
import type { AuthLogger } from './redact.js';
import { silentLogger, withRedaction } from './redact.js';

/** 账户库文件名 */
export const ACCOUNTS_FILE_NAME = 'accounts.json';

/** 账户库格式版本 */
const STORE_VERSION = 1;

/** 落盘结构 */
export interface AccountStore {
  version: number;
  updatedAt: number;
  accounts: Account[];
}

/** 账户库文件绝对路径 */
export function accountsFilePath(dataRoot: string = getDataRoot()): string {
  return path.join(dataRoot, ACCOUNTS_FILE_NAME);
}

function emptyStore(): AccountStore {
  return { version: STORE_VERSION, updatedAt: 0, accounts: [] };
}

/** 校验并规范化一条账户记录，丢弃字段缺失/类型不对的脏数据 */
function normalizeAccount(raw: unknown): Account | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const type = o['type'];
  if (type !== 'microsoft' && type !== 'offline') return null;
  if (typeof o['username'] !== 'string' || typeof o['uuid'] !== 'string') return null;
  if (typeof o['accessToken'] !== 'string') return null;

  const account: Account = {
    type,
    username: o['username'],
    uuid: o['uuid'],
    accessToken: o['accessToken'],
  };
  if (typeof o['refreshToken'] === 'string') account.refreshToken = o['refreshToken'];
  if (typeof o['xuid'] === 'string') account.xuid = o['xuid'];
  if (typeof o['expiresAt'] === 'number' && Number.isFinite(o['expiresAt'])) {
    account.expiresAt = o['expiresAt'];
  }
  return account;
}

/**
 * 读取账户库。文件不存在 / 损坏时返回空库并不抛错
 * （损坏时把原文件备份成 `accounts.json.broken-<时间戳>`，用户还能自己捞回来）。
 */
export function loadAccounts(dataRoot: string = getDataRoot(), logger: AuthLogger = silentLogger): AccountStore {
  const log = withRedaction(logger);
  const file = accountsFilePath(dataRoot);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn(`读取账户库失败（${code ?? 'unknown'}），按空账户库处理：${file}`);
    }
    return emptyStore();
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const rawList = Array.isArray(parsed['accounts']) ? (parsed['accounts'] as unknown[]) : [];
    const accounts = rawList.map(normalizeAccount).filter((a): a is Account => a !== null);
    return {
      version: typeof parsed['version'] === 'number' ? parsed['version'] : STORE_VERSION,
      updatedAt: typeof parsed['updatedAt'] === 'number' ? parsed['updatedAt'] : 0,
      accounts,
    };
  } catch {
    const backup = `${file}.broken-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      log.warn(`账户库 JSON 解析失败，已备份为 ${path.basename(backup)}，按空账户库处理。`);
    } catch {
      log.warn('账户库 JSON 解析失败且备份失败，按空账户库处理。');
    }
    return emptyStore();
  }
}

/** 收紧文件权限：POSIX 0o600；Windows 上 chmod 只影响只读位，尽力而为 */
function tightenPermissions(file: string, logger: AuthLogger): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    // Windows 与部分容器文件系统不支持 POSIX 权限，不视为错误
    logger.debug(`chmod 0600 失败（可忽略）：${(err as Error).message}`);
  }
}

/** 原子写入账户库，写完收紧权限 */
export function saveAccounts(
  accounts: readonly Account[],
  dataRoot: string = getDataRoot(),
  logger: AuthLogger = silentLogger,
): void {
  const log = withRedaction(logger);
  const dir = dataRoot;
  fs.mkdirSync(dir, { recursive: true });

  const store: AccountStore = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    accounts: accounts.map((a) => ({ ...a })),
  };
  const file = accountsFilePath(dir);
  const tmp = path.join(dir, `.${ACCOUNTS_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);

  const json = `${JSON.stringify(store, null, 2)}\n`;
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
  tightenPermissions(tmp, log);
  fs.renameSync(tmp, file);
  tightenPermissions(file, log);
  log.info(`账户库已写入：${file}（共 ${accounts.length} 个账户）`);
}

/**
 * 按 uuid 插入或更新一条账户（同一 uuid 视为同一账户），返回写入后的完整列表。
 * 刷新令牌后调用这个，避免出现重复条目。
 */
export function upsertAccount(
  account: Account,
  dataRoot: string = getDataRoot(),
  logger: AuthLogger = silentLogger,
): Account[] {
  const store = loadAccounts(dataRoot, logger);
  const key = account.uuid.toLowerCase();
  const idx = store.accounts.findIndex((a) => a.uuid.toLowerCase() === key || a.username === account.username);
  const next = store.accounts.slice();
  if (idx >= 0) next[idx] = { ...account };
  else next.push({ ...account });
  saveAccounts(next, dataRoot, logger);
  return next;
}

/** 按 uuid 删除一条账户，返回剩余列表 */
export function removeAccount(
  uuidOrName: string,
  dataRoot: string = getDataRoot(),
  logger: AuthLogger = silentLogger,
): Account[] {
  const store = loadAccounts(dataRoot, logger);
  const key = uuidOrName.toLowerCase();
  const next = store.accounts.filter((a) => a.uuid.toLowerCase() !== key && a.username !== uuidOrName);
  saveAccounts(next, dataRoot, logger);
  return next;
}
