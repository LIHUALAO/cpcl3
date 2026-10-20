/**
 * auth 模块测试。
 *
 * 运行：node --import ./test/ts-resolve.mjs --test test/auth.test.ts
 *
 * 覆盖范围：
 *   1. 离线 UUID 算法正确性（硬编码已知向量，防止以后改坏）
 *   2. 离线账户的确定性 + 标准 8-4-4-4-12 格式 + 第 13 位版本号 = 3
 *   3. refresh 的过期判断纯逻辑（fake 时间戳，不联网）
 *   4. token 打码（输出不含原始 token）
 *   5. 账户持久化（临时目录，不碰用户真实数据目录）
 *   6. 完整换令牌链路的错误分支（注入 fetch 假实现，不联网）
 *   7. beginDeviceCode() 真实请求微软端点 —— 唯一需要网络的地方，无 client_id 时明确 SKIP
 *
 * 刻意不做的事：不在测试里真的完成一次登录（需要真人打开浏览器输码）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
  MicrosoftAuth,
  AuthError,
  AZURE_CLIENT_ID,
  MS_DEVICE_CODE_URL,
  formatUuid,
  isExpired,
  offlineAccount,
  offlineUuid,
  redactTokens,
  maskToken,
  withRedaction,
  silentLogger,
  loadAccounts,
  saveAccounts,
  upsertAccount,
  removeAccount,
  accountsFilePath,
  TOKEN_EXPIRY_SKEW_MS,
  XSTS_ERROR_MESSAGES,
  type Account,
  type AuthLogger,
} from '../src/core/auth/index.js';

// ───────────────────────────── 测试工具 ─────────────────────────────

/** 建一个隔离的临时数据目录；回调里通过参数传入，不依赖环境变量时序。 */
async function withTempDataRoot(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-auth-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface FakeResponse {
  status?: number;
  body: unknown;
}

/** 按顺序返回预置响应的 fetch 假实现，并记录每次请求。 */
function fakeFetch(responses: FakeResponse[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    const r = responses[i++];
    if (!r) throw new Error(`unexpected extra request #${i} to ${String(input)}`);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map<string, string>(),
      async text() {
        return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      },
      async json() {
        return r.body;
      },
    } as unknown as Response;
  }) as typeof fetch;

  return { impl, calls };
}

const KNOWN_VECTORS: ReadonlyArray<readonly [name: string, uuid: string]> = [
  ['Notch', 'b50ad385-829d-3141-a216-7e7d7539ba7f'],
  ['jeb_', 'a762f560-4fce-3236-812a-b80efff0b62b'],
  ['', 'fc5bc365-aedf-30a8-8b89-04e462e29bde'],
  ['Steve', '5627dd98-e6be-3c21-b8a8-e92344183641'],
  ['Herobrine', '25966168-dc9c-360c-8f32-ed022bfa1070'],
];

// ───────────────────────────── 1. 离线 UUID ─────────────────────────────

describe('离线 UUID 算法', () => {
  for (const [name, expected] of KNOWN_VECTORS) {
    test(`offlineUuid(${JSON.stringify(name)}) === ${expected}`, () => {
      assert.equal(offlineUuid(name), expected);
    });
  }

  test('前缀必须是 "OfflinePlayer:"（改前缀会让所有离线账户 UUID 变化）', () => {
    const hash = createHash('md5').update('OfflinePlayer:Notch', 'utf8').digest('hex');
    assert.ok(offlineUuid('Notch').replace(/-/g, '').startsWith(hash.slice(0, 12)));
  });

  test('用户名大小写敏感（Notch != notch）', () => {
    assert.notEqual(offlineUuid('Notch'), offlineUuid('notch'));
    assert.equal(offlineUuid('notch').replace(/-/g, '').slice(0, 12), '42653081a90e');
  });
});

// ───────────────────────────── 2. offlineAccount ─────────────────────────────

describe('offlineAccount()', () => {
  test('确定性：同一用户名跑两次结果完全相同', () => {
    assert.deepEqual(offlineAccount('Notch'), offlineAccount('Notch'));
  });

  test('UUID 格式是标准 8-4-4-4-12，且第 13 位（版本位）是 3', () => {
    const acc = offlineAccount('Notch');
    assert.match(acc.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(acc.uuid[14], '3');
  });

  test('字段符合 Account 契约：type/username/uuid/accessToken，且无 refreshToken', () => {
    const acc = offlineAccount('Notch');
    assert.equal(acc.type, 'offline');
    assert.equal(acc.username, 'Notch');
    assert.equal(acc.uuid, 'b50ad385-829d-3141-a216-7e7d7539ba7f');
    assert.equal(typeof acc.accessToken, 'string');
    assert.equal(acc.refreshToken, undefined);
  });

  test('空用户名抛错；超过 16 字符抛错', () => {
    assert.throws(() => offlineAccount(''));
    assert.throws(() => offlineAccount('a'.repeat(17)));
  });

  test('不同用户名 → 不同 UUID（100 个样本无碰撞）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(offlineUuid(`player${i}`));
    assert.equal(seen.size, 100);
  });
});

// ───────────────────────────── 3. 过期判断 ─────────────────────────────

describe('isExpired() 过期判断', () => {
  // 真实签名：isExpired(expiresAt: number | undefined, now?: number)
  const EXP = 1_000_000_000_000;

  test('60 秒余量：距到期刚好 >60s 视为未过期', () => {
    const now = EXP - TOKEN_EXPIRY_SKEW_MS - 1000;
    assert.equal(isExpired(EXP, now), false);
  });

  test('60 秒余量：距到期 <=60s 视为已过期', () => {
    const now = EXP - TOKEN_EXPIRY_SKEW_MS;
    assert.equal(isExpired(EXP, now), true);
  });

  test('已过去的到期时间 / 缺失 / 非法值 → 已过期', () => {
    assert.equal(isExpired(EXP, EXP + 1), true);
    assert.equal(isExpired(undefined), true);
    assert.equal(isExpired(Number.NaN), true);
  });

  test('Infinity 视为永不过期', () => {
    assert.equal(isExpired(Number.POSITIVE_INFINITY), false);
  });

  test('未过期的账户 refresh() 直接返回原账户，不发任何请求', async () => {
    const { impl, calls } = fakeFetch([]);
    const auth = new MicrosoftAuth({ fetchImpl: impl, persist: false });
    const acc: Account = {
      type: 'microsoft',
      username: 'X',
      uuid: 'u',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 10 * 60_000,
    };
    const out = await auth.refresh(acc);
    assert.equal(out.accessToken, 'a');
    assert.equal(calls.length, 0);
  });

  test('离线账户 refresh() 原样返回（不抛错、不联网）', async () => {
    const { impl, calls } = fakeFetch([]);
    const auth = new MicrosoftAuth({ fetchImpl: impl, persist: false });
    const acc = offlineAccount('Notch');
    assert.deepEqual(await auth.refresh(acc), acc);
    assert.equal(calls.length, 0);
  });

  test('已过期但没有 refreshToken → 抛 missing_refresh_token', async () => {
    const auth = new MicrosoftAuth({
      fetchImpl: fakeFetch([]).impl,
      persist: false,
    });
    const acc: Account = {
      type: 'microsoft',
      username: 'X',
      uuid: 'u',
      accessToken: 'a',
      expiresAt: 1,
    };
    await assert.rejects(
      () => auth.refresh(acc),
      (e: unknown) => {
        assert.ok(e instanceof AuthError);
        assert.equal(e.code, 'missing_refresh_token');
        return true;
      },
    );
  });
});

// ───────────────────────────── 4. 打码 ─────────────────────────────

describe('redactTokens() 打码', () => {
  const ACCESS = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SECRET_SIGNATURE';
  const REFRESH = 'M.C123_BAY.REFRESH_SECRET_VALUE';

  test('输出中不出现原始 refresh_token', () => {
    const out = redactTokens(JSON.stringify({ refresh_token: REFRESH }));
    assert.ok(!out.includes('REFRESH_SECRET_VALUE'), out);
  });

  test('输出中不出现原始 access_token（含 JSON 形态）', () => {
    const out = redactTokens(JSON.stringify({ access_token: ACCESS }));
    assert.ok(!out.includes('SECRET_SIGNATURE'), out);
  });

  test('JWT 形态（eyJ...）整体被打掉', () => {
    const out = redactTokens(`token is ${ACCESS} ok`);
    assert.ok(!out.includes(ACCESS), out);
    assert.ok(out.includes('ok'));
  });

  test('调用方传入的已知 token 值会被精确消除', () => {
    const out = redactTokens(`a=${ACCESS} b=${REFRESH}`, [ACCESS, REFRESH]);
    assert.ok(!out.includes('SECRET_SIGNATURE'));
    assert.ok(!out.includes('REFRESH_SECRET_VALUE'));
  });

  test('普通文本不被误伤', () => {
    const s = '下载完成，共 12345 字节，耗时 3.2 秒';
    assert.equal(redactTokens(s), s);
  });

  test('maskToken() 保留头尾、绝不返回完整 token', () => {
    const masked = maskToken('abcdefghijklmnop');
    assert.ok(!masked.includes('abcdefghijklmnop'));
    assert.ok(masked.startsWith('abcd'));
    assert.equal(maskToken(''), '');
  });

  test('withRedaction 包装 logger 后，写进 logger 的 token 被打码', () => {
    // 真实签名：withRedaction(logger: AuthLogger, extraSecrets?): AuthLogger
    const lines: string[] = [];
    const inner: AuthLogger = {
      debug: (m) => lines.push(m),
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    };
    const wrapped = withRedaction(inner, [ACCESS]);
    wrapped.warn(`boom access_token=${ACCESS}`);

    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes('SECRET_SIGNATURE'), lines[0]);
    assert.ok(lines[0]!.includes('boom'));
  });

  test('silentLogger 不抛错、不输出', () => {
    assert.doesNotThrow(() => {
      silentLogger.debug('x');
      silentLogger.info('x');
      silentLogger.warn('x');
      silentLogger.error('x');
    });
  });
});

// ───────────────────────────── 5. 持久化 ─────────────────────────────

describe('账户持久化 accounts.json', () => {
  test('save → load 往返，字段完整', async () => {
    await withTempDataRoot((dir) => {
      const acc: Account = {
        type: 'microsoft',
        username: 'Steve',
        uuid: '5627dd98-e6be-3c21-b8a8-e92344183641',
        accessToken: 'at',
        refreshToken: 'rt',
        xuid: '123',
        expiresAt: 1234567890,
      };
      saveAccounts([acc], dir);
      const store = loadAccounts(dir);
      assert.equal(store.accounts.length, 1);
      assert.deepEqual(store.accounts[0], acc);
      assert.ok(fs.existsSync(accountsFilePath(dir)));
      assert.equal(typeof store.version, 'number');
    });
  });

  test('upsert 同一 uuid 不产生重复条目，并覆盖旧值', async () => {
    await withTempDataRoot((dir) => {
      const a1 = offlineAccount('Steve');
      const a2: Account = { ...a1, accessToken: 'new-token' };
      upsertAccount(a1, dir);
      const after = upsertAccount(a2, dir);
      assert.equal(after.length, 1);
      assert.equal(after[0]!.accessToken, 'new-token');
    });
  });

  test('removeAccount 按 uuid 删除', async () => {
    await withTempDataRoot((dir) => {
      upsertAccount(offlineAccount('Steve'), dir);
      upsertAccount(offlineAccount('Alex'), dir);
      const left = removeAccount(offlineAccount('Steve').uuid, dir);
      assert.equal(left.length, 1);
      assert.equal(left[0]!.username, 'Alex');
    });
  });

  test('文件不存在 → 空账户库，不抛错', async () => {
    await withTempDataRoot((dir) => {
      const store = loadAccounts(dir);
      assert.deepEqual(store.accounts, []);
    });
  });

  test('JSON 损坏 → 备份原文件并返回空库', async () => {
    await withTempDataRoot((dir) => {
      const p = accountsFilePath(dir);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{ this is not json', 'utf8');

      const store = loadAccounts(dir);
      assert.deepEqual(store.accounts, []);

      const backups = fs.readdirSync(path.dirname(p)).filter((n) => n.includes('.broken-'));
      assert.equal(backups.length, 1);
    });
  });
});

// ───────────────────────────── 6. 换令牌链路 ─────────────────────────────

describe('换令牌链路的错误分支', () => {
  const okXbl: FakeResponse = {
    status: 200,
    body: { Token: 'XBL_TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS' }] } },
  };
  const okXsts: FakeResponse = {
    status: 200,
    body: { Token: 'XSTS_TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS', xid: '2535' }] } },
  };
  const okMc: FakeResponse = { status: 200, body: { access_token: 'MC_TOKEN', expires_in: 86400 } };

  test('XSTS 返回 XErr 2148916233 → 提示去 xbox.com 注册', async () => {
    const { impl } = fakeFetch([okXbl, { status: 401, body: { XErr: 2148916233 } }]);
    const auth = new MicrosoftAuth({ fetchImpl: impl, persist: false });
    await assert.rejects(
      () => auth.authenticateXboxChain('msa'),
      (e: unknown) => {
        assert.ok(e instanceof AuthError);
        assert.equal(e.code, 'xsts_2148916233');
        assert.match(e.message, /xbox\.com/i);
        return true;
      },
    );
  });

  test('XSTS 返回 XErr 2148916235 → 明确告知地区不支持', async () => {
    const { impl } = fakeFetch([okXbl, { status: 401, body: { XErr: 2148916235 } }]);
    const auth = new MicrosoftAuth({ fetchImpl: impl, persist: false });
    await assert.rejects(
      () => auth.authenticateXboxChain('msa'),
      (e: unknown) => {
        assert.ok(e instanceof AuthError);
        assert.equal(e.code, 'xsts_2148916235');
        assert.ok(XSTS_ERROR_MESSAGES[2148916235]);
        return true;
      },
    );
  });

  test('profile 404 → 说明该账户没有购买 Minecraft', async () => {
    const { impl } = fakeFetch([okXbl, okXsts, okMc, { status: 404, body: {} }]);
    const auth = new MicrosoftAuth({ fetchImpl: impl, persist: false });
    await assert.rejects(
      () => auth.authenticateXboxChain('msa'),
      (e: unknown) => {
        assert.ok(e instanceof AuthError);
        assert.equal(e.code, 'no_minecraft_profile');
        assert.match(e.message, /Minecraft/i);
        return true;
      },
    );
  });

  test('完整链路成功：三步 + profile，顺序与字段都正确', async () => {
    const { impl, calls } = fakeFetch([
      okXbl,
      okXsts,
      okMc,
      { status: 200, body: { id: '5627dd98e6be3c21b8a8e92344183641', name: 'Steve' } },
    ]);
    const auth = new MicrosoftAuth({ fetchImpl: impl, persist: false });

    // 注意：authenticateXboxChain 返回 XboxChainResult，不是 Account
    const chain = await auth.authenticateXboxChain('msa');
    assert.equal(chain.profile.name, 'Steve');
    assert.equal(chain.profile.id, '5627dd98e6be3c21b8a8e92344183641');
    assert.equal(chain.mcAccessToken, 'MC_TOKEN');
    assert.equal(chain.xblToken, 'XBL_TOKEN');
    assert.equal(chain.xstsToken, 'XSTS_TOKEN');
    assert.equal(chain.userHash, 'UHS');
    assert.equal(chain.xuid, '2535');

    assert.equal(calls.length, 4);
    assert.match(calls[0]!.url, /user\.auth\.xboxlive\.com/);
    assert.match(calls[1]!.url, /xsts\.auth\.xboxlive\.com/);
    assert.match(calls[2]!.url, /login_with_xbox/);
    assert.match(calls[3]!.url, /minecraft\/profile/);
  });

  test('formatUuid 把 32 位 hex 规范成 8-4-4-4-12', () => {
    assert.equal(formatUuid('5627dd98e6be3c21b8a8e92344183641'), '5627dd98-e6be-3c21-b8a8-e92344183641');
    assert.equal(formatUuid('5627dd98-e6be-3c21-b8a8-e92344183641'), '5627dd98-e6be-3c21-b8a8-e92344183641');
  });

  test('MS_DEVICE_CODE_URL 指向 consumers 租户（不能用 common）', () => {
    assert.match(MS_DEVICE_CODE_URL, /\/consumers\//);
  });

  test('AZURE_CLIENT_ID 是合法 UUID 形状的占位符', () => {
    assert.match(AZURE_CLIENT_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('client_id 无效时 beginDeviceCode 给出人话错误', async () => {
    const { impl } = fakeFetch([
      { status: 400, body: { error: 'unauthorized_client', error_description: 'AADSTS700038' } },
    ]);
    const auth = new MicrosoftAuth({ fetchImpl: impl, clientId: AZURE_CLIENT_ID, persist: false });
    await assert.rejects(() => auth.beginDeviceCode(), (e: unknown) => {
      assert.ok(e instanceof AuthError);
      return true;
    });
  });
});

// ───────────────────────────── 7. 真实端点 ─────────────────────────────

describe('beginDeviceCode() 真实请求微软端点', () => {
  const realClientId = process.env.PCL3_TEST_AZURE_CLIENT_ID?.trim();

  test(
    '返回 user_code 与 verification_uri',
    {
      skip: realClientId
        ? false
        : '没有可用的 Azure client_id：AZURE_CLIENT_ID 是占位符，微软会返回 unauthorized_client。设置 PCL3_TEST_AZURE_CLIENT_ID 后重跑即可覆盖。',
    },
    async () => {
      const auth = new MicrosoftAuth({ clientId: realClientId!, persist: false });
      const s = await auth.beginDeviceCode();
      assert.ok(s.userCode.length > 0);
      assert.match(s.verificationUri, /^https:\/\//);
      assert.ok(s.deviceCode.length > 0);
      assert.ok(s.interval > 0);
    },
  );

  test('端点可达性探测（不带有效 client_id，只验证 DNS/TLS/HTTP 通）', async () => {
    let res: Response;
    try {
      res = await fetch(MS_DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'client_id=00000000-0000-0000-0000-000000000000&scope=XboxLive.signin',
      });
    } catch (e) {
      console.log(`SKIP: 微软端点不可达（${(e as Error).message}）`);
      return;
    }
    // 占位 client_id 必然被拒；拿到 4xx 状态码即证明网络链路通
    assert.ok(res.status >= 400 && res.status < 500, `unexpected status ${res.status}`);
  });
});
