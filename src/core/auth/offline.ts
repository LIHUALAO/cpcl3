/**
 * 离线账户与离线 UUID。
 *
 * Minecraft 的离线 UUID 规则（服务端 `UUID.nameUUIDFromBytes` 用的是 MD5 + UUID v3 变体）：
 *   1. name = "OfflinePlayer:" + username
 *   2. md5 = MD5(utf8(name))                  → 16 字节
 *   3. md5[6] = (md5[6] & 0x0F) | 0x30         → 版本位 = 3
 *   4. md5[8] = (md5[8] & 0x3F) | 0x80         → 变体位 = RFC 4122（10xx）
 *   5. 按 3-2-3-4-3 的十六进制分组（8-4-4-4-12）插入连字符
 *
 * 注意：`java.util.UUID.nameUUIDFromBytes` 用的正是 MD5 + `0x30` / `0x80`，
 * 但它是「大端转 long」，对 MD5 摘要而言与「直接按字节 hex」结果相同 —— 已用已知向量核对：
 *   offlineAccount('Notch').uuid === 'b50ad385-829d-3141-a216-7e7d7539ba7f'
 * 这个值必须与服务器端一致，否则正版服务器会把你当成另一个玩家（冲突/重复登录）。
 */

import { createHash } from 'node:crypto';
import type { Account } from '../types.js';

/** 离线 UUID 的命名空间前缀，改动会让所有离线账户 UUID 变化，禁止改 */
export const OFFLINE_PLAYER_PREFIX = 'OfflinePlayer:';

/** 计算离线 UUID（小写、带连字符的标准 8-4-4-4-12 形式） */
export function offlineUuid(username: string): string {
  const hash = createHash('md5').update(`${OFFLINE_PLAYER_PREFIX}${username}`, 'utf8').digest();

  // 版本 = 3（MD5 名字型 UUID）
  hash[6] = (hash[6]! & 0x0f) | 0x30;
  // 变体 = RFC 4122（10xx）；服务端 nameUUIDFromBytes 同样是 0x80
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  const hex = hash.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * 构造离线账户。
 *
 * - uuid 由用户名确定性地推导（同名校同 UUID）
 * - accessToken 用 `offline` 占位：离线模式下启动参数里的 `${auth_access_token}` 不会被服务端校验，
 *   但需要非空，否则部分客户端版本会在初始化阶段报错
 * - 不产生 refreshToken / xuid / expiresAt（离线账户不存在刷新概念）
 */
export function offlineAccount(username: string): Account {
  const name = String(username ?? '');
  if (name.trim().length === 0) {
    throw new Error('离线账户的用户名不能为空。');
  }
  if (name.length > 16) {
    throw new Error(`离线账户的用户名「${name}」超过 16 个字符，Minecraft 不允许。`);
  }
  return {
    type: 'offline',
    username: name,
    uuid: offlineUuid(name),
    accessToken: 'offline',
  };
}

/** 是否是离线账户 */
export function isOfflineAccount(account: Account): boolean {
  return account.type === 'offline';
}
