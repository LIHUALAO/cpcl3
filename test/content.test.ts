/**
 * content 模块测试：Modrinth 客户端 + facets 编码 + 版本挑选 + mod jar 元数据 + ModManager。
 *
 * 覆盖范围（与任务书对应）：
 *   1. search 真实网络拉 Modrinth（不可达则 SKIP 并说明原因，不算失败）
 *   2. facets 编码正确（含特殊字符的版本号不破坏查询）
 *   3. pickBestVersion 优先 primary + 匹配 gameVersion / loader
 *   4. mod jar 元数据解析（假 zip + fabric.mod.json / mods.toml）
 *   5. 禁用改名 `.disabled`、再启用改回
 *   6. 安装路径落在 `<dataRoot>/instances/<instanceId>/mods/`
 *
 * 原则：除了那一条真实网络测试，其余全部离线、可重复、不依赖外部服务。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';
import zlib from 'node:zlib';

import {
  ModrinthClient,
  ModrinthError,
  PROJECT_TYPE_LABEL,
  PROJECT_TYPES,
  SEARCH_MAX_LIMIT,
  buildFacets,
  checkGameVersion,
  checkLoader,
  encodeFacets,
  isProjectType,
  normalizeSort,
  parseProjectType,
  pickBestVersion,
  type ProjectVersion,
  type SearchOptions,
} from '../src/core/content/modrinth/index.js';
import {
  ModManager,
  ModValidationError,
  checkModFilename,
  diskNameOf,
  enabledNameOf,
  readMetaFromBuffer,
  readModJarMeta,
  sanitizeJarFilename,
  tomlString,
  type ModDownloaderLike,
} from '../src/core/content/mods/index.js';

// ───────────────────────────── 测试夹具 ─────────────────────────────

/**
 * 本次运行创建的所有临时目录。
 *
 * 为什么要有这个数组（而不是每个用例自己 `t.after` 删）：
 *   `t.after` 只在「那个用例」结束时跑；一旦断言在创建目录**之后、注册清理之前**失败，
 *   或者用例被 skip / 超时中断，目录就永久留在 %TEMP% 里。
 *   统一登记 + 文件级 `after()` 兜底，才能保证「不管怎么退出都不漏」。
 */
const createdRoots: string[] = [];

after(() => {
  for (const dir of createdRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 被占用（Windows 上文件句柄没释放）就下次清；不能让清理失败把测试判成失败 */
    }
  }
  createdRoots.length = 0;
});

/** 临时目录（登记到 createdRoots，文件级 after 统一删） */
async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pcl3-content-${prefix}-`));
  createdRoots.push(dir);
  // 立即删一次：大部分用例结束时目录已经空了，尽早释放比等文件级 after 更省空间
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return dir;
}

interface ZipInput {
  name: string;
  data?: Buffer | string;
  deflate?: boolean;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] as number;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 造一个最小 zip（jar 就是 zip）。
 *
 * 自带一份实现而不是 import launch 的 `launch.zip-fixer.ts`：
 * 那个文件是 launch-dev 的测试私有件，跨模块依赖别人的测试夹具迟早出事。
 */
function buildZip(inputs: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const input of inputs) {
    const nameBuf = Buffer.from(input.name, 'utf8');
    const raw = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data ?? `${input.name} payload`, 'utf8');
    const method = input.deflate === true ? 8 : 0;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

/** 造一个 Fabric 风格的 jar */
function fabricJar(meta: Record<string, unknown>): Buffer {
  return buildZip([
    { name: 'fabric.mod.json', data: JSON.stringify(meta, null, 2), deflate: true },
    { name: 'assets/mymod/lang/en_us.json', data: '{"item.mymod.thing":"Thing"}', deflate: true },
  ]);
}

/** 造一个 Forge 风格的 jar */
function forgeJar(toml: string): Buffer {
  return buildZip([
    { name: 'META-INF/mods.toml', data: toml, deflate: true },
    { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' },
  ]);
}

/** 版本夹具 */
function version(partial: Partial<ProjectVersion> & { id: string }): ProjectVersion {
  return {
    id: partial.id,
    versionNumber: partial.versionNumber ?? partial.id,
    gameVersions: partial.gameVersions ?? ['1.21'],
    loaders: partial.loaders ?? ['fabric'],
    dependencies: partial.dependencies ?? [],
    files: partial.files ?? [
      { url: `https://cdn.modrinth.com/${partial.id}.jar`, filename: `${partial.id}.jar`, size: 100, primary: false },
    ],
    datePublished: partial.datePublished ?? '2024-01-01T00:00:00Z',
  };
}

// ═════════════════════════════ 一、facets 编码 ═════════════════════════════

test('facets：三种过滤条件各占一组（AND），组内是 OR', () => {
  const facets = buildFacets({ projectType: 'mod', gameVersion: '1.21', loader: 'fabric' });
  assert.deepEqual(facets, [
    ['project_type:mod'],
    ['versions:1.21'],
    ['categories:fabric'],
  ]);
});

test('facets：空条件不出组（不会发出 ["versions:"] 这种空条件）', () => {
  assert.deepEqual(buildFacets({}), []);
  assert.deepEqual(buildFacets({ gameVersion: '   ', loader: '' }), []);
  assert.deepEqual(buildFacets({ projectType: 'shader' }), [['project_type:shader']]);
});

test('facets：整段 JSON 被正确编码，特殊字符不破坏查询串', () => {
  // 真实世界里出现过的怪版本号：快照、带 + 的构建号、带 & 的名字
  const cases = ['1.20.5-pre1', '1.20.1+pre', '23w45a', '1.21 & 1.22', '1.21"quoted"'];
  for (const gameVersion of cases) {
    const facets = buildFacets({ projectType: 'mod', gameVersion, loader: 'forge' });
    const encoded = encodeFacets(facets);
    // 编码后不该出现裸的 & # + 空白 " —— 这些在 query 里都会被误解
    assert.doesNotMatch(encoded, /[&#+\s"]/, `编码结果里不该有裸字符：${encoded}`);

    // 解码回来必须与原始 facets 完全一致（这是「不破坏」的硬判据）
    const decoded = JSON.parse(decodeURIComponent(encoded)) as string[][];
    assert.deepEqual(decoded[1], [`versions:${gameVersion}`]);
  }

  // 首尾空白被 trim 掉（不是错误，是归一化）：服务端存的是不带空白的版本号
  assert.deepEqual(buildFacets({ gameVersion: ' 1.21 ' }), [['versions:1.21']]);
});

test('facets：客户端发请求时，URL 里的 facets 参数解码后与 buildFacets 一致', async () => {
  const seen: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ hits: [], total_hits: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const client = new ModrinthClient({ fetchImpl: fakeFetch });
  await client.search({ query: 'sodium', projectType: 'mod', gameVersion: '1.20.1+pre', loader: 'fabric' });

  assert.equal(seen.length, 1);
  const url = new URL(seen[0] as string);
  assert.equal(url.origin + url.pathname, 'https://api.modrinth.com/v2/search');
  const facetsParam = url.searchParams.get('facets');
  assert.ok(facetsParam !== null, '请求里必须带 facets');
  assert.deepEqual(JSON.parse(facetsParam), [
    ['project_type:mod'],
    ['versions:1.20.1+pre'],
    ['categories:fabric'],
  ]);
  assert.equal(url.searchParams.get('query'), 'sodium');
  assert.equal(url.searchParams.get('index'), 'relevance');
});

test('客户端会按契约发 User-Agent（PCL3/<version> + 仓库地址）', async () => {
  let ua = '';
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    ua = headers['User-Agent'] ?? '';
    return new Response(JSON.stringify({ project_id: 'x', slug: 'x', title: 'X' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await new ModrinthClient({ fetchImpl: fakeFetch }).getProject('sodium');
  assert.match(ua, /^PCL3\/\d+\.\d+\.\d+ \(github\.com\/LIHUALAO\/cpcl3\)$/);
});

// ═════════════════════════════ 二、版本挑选 ═════════════════════════════

test('pickBestVersion：优先 primary 文件 + 匹配 gameVersion 与 loader', () => {
  const versions: ProjectVersion[] = [
    version({
      id: 'a',
      gameVersions: ['1.21'],
      loaders: ['fabric'],
      datePublished: '2024-01-01T00:00:00Z',
      files: [{ url: 'https://x/a.jar', filename: 'a.jar', size: 1, primary: false }],
    }),
    version({
      id: 'b',
      gameVersions: ['1.21'],
      loaders: ['fabric', 'quilt'],
      datePublished: '2024-02-01T00:00:00Z',
      files: [
        { url: 'https://x/b-sources.jar', filename: 'b-sources.jar', size: 1, primary: false },
        { url: 'https://x/b.jar', filename: 'b.jar', size: 1, primary: true },
      ],
    }),
  ];

  const picked = pickBestVersion(versions, { gameVersion: '1.21', loader: 'fabric' });
  assert.equal(picked?.id, 'b', 'primary 文件 + 单一来源的构建应当胜出');
});

test('pickBestVersion：不匹配 gameVersion 的版本被硬过滤掉', () => {
  const versions = [
    version({ id: 'old', gameVersions: ['1.20.1'], loaders: ['fabric'] }),
    version({ id: 'new', gameVersions: ['1.21'], loaders: ['fabric'] }),
  ];
  assert.equal(pickBestVersion(versions, { gameVersion: '1.21' })?.id, 'new');
  // 全都不匹配 → undefined（绝不硬凑）
  assert.equal(pickBestVersion(versions, { gameVersion: '1.19' }), undefined);
});

test('pickBestVersion：给了 loader 就必须命中；版本没声明加载器时不硬算匹配', () => {
  const versions = [
    version({ id: 'forge', gameVersions: ['1.21'], loaders: ['forge'] }),
    version({ id: 'fabric', gameVersions: ['1.21'], loaders: ['fabric'] }),
    version({ id: 'none', gameVersions: ['1.21'], loaders: [] }),
  ];
  assert.equal(pickBestVersion(versions, { gameVersion: '1.21', loader: 'fabric' })?.id, 'fabric');
  assert.equal(pickBestVersion(versions, { gameVersion: '1.21', loader: 'neoforge' }), undefined);
  assert.equal(pickBestVersion(versions, { gameVersion: '1.21' })?.id, 'forge', '不给 loader 时取第一个可用');
});

test('pickBestVersion：同分取更新的（datePublished 降序）', () => {
  const versions = [
    version({
      id: 'older',
      datePublished: '2024-01-01T00:00:00Z',
      files: [{ url: 'https://x/o.jar', filename: 'o.jar', size: 1, primary: true }],
    }),
    version({
      id: 'newer',
      datePublished: '2024-06-01T00:00:00Z',
      files: [{ url: 'https://x/n.jar', filename: 'n.jar', size: 1, primary: true }],
    }),
  ];
  assert.equal(pickBestVersion(versions, { gameVersion: '1.21', loader: 'fabric' })?.id, 'newer');
});

test('pickBestVersion：没有文件的版本一律不考虑', () => {
  const versions = [
    version({ id: 'nofiles', files: [] }),
    version({ id: 'ok', files: [{ url: 'https://x/ok.jar', filename: 'ok.jar', size: 1, primary: true }] }),
  ];
  assert.equal(pickBestVersion(versions, { gameVersion: '1.21' })?.id, 'ok');
  assert.equal(pickBestVersion([versions[0] as ProjectVersion], { gameVersion: '1.21' }), undefined);
});

// ═════════════════════════════ 三、参数归一化 ═════════════════════════════

test('类型 / 排序参数的归一化：认不出的不猜', () => {
  for (const type of PROJECT_TYPES) {
    assert.equal(parseProjectType(type), type);
    assert.ok(PROJECT_TYPE_LABEL[type].length > 0);
  }
  assert.equal(parseProjectType('MOD'), 'mod');
  assert.equal(parseProjectType('whatever'), undefined);
  assert.equal(parseProjectType(null), undefined);
  assert.equal(isProjectType('mod'), true);
  assert.equal(isProjectType('m0d'), false);

  assert.equal(normalizeSort('downloads'), 'downloads');
  assert.equal(normalizeSort('DOWNLOADS'), 'downloads');
  assert.equal(normalizeSort('bogus'), 'relevance');
  assert.equal(normalizeSort(undefined), 'relevance');
});

test('非法 gameVersion / loader 在本地就被拒（不发出「永远 0 结果」的请求）', async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ hits: [], total_hits: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new ModrinthClient({ fetchImpl: fakeFetch });

  // 首尾空白会被 trim（归一化，不是错误）；真正会被拼坏的字符才拒
  for (const bad of ['1.21"', '1 21', '1/21', '1.21\\', 'v1,21']) {
    await assert.rejects(
      () => client.search({ query: 'x', gameVersion: bad }),
      (error: unknown) => error instanceof ModrinthError && error.kind === 'invalid',
      `应当拒绝 gameVersion=${JSON.stringify(bad)}`,
    );
  }
  await assert.rejects(
    () => client.search({ query: 'x', loader: 'fab ric' }),
    (error: unknown) => error instanceof ModrinthError && error.kind === 'invalid',
  );
  await assert.rejects(
    () => client.listVersions('sodium', { gameVersion: '../etc' }),
    (error: unknown) => error instanceof ModrinthError && error.kind === 'invalid',
  );
  assert.equal(calls, 0, '参数非法时一次网络请求都不该发出去');

  // 合法形状照常通过（快照、带 + 的构建号、rc）
  for (const good of ['1.21', '1.20.1+pre', '23w45a', '26.2-rc-1']) {
    assert.equal(checkGameVersion(good), null);
  }
  assert.equal(checkLoader('neoforge'), null);
  assert.ok(checkGameVersion('1.21"') !== null);
  assert.ok(checkLoader('fab ric') !== null);
});

test('search 的 limit / offset 会被夹到合法范围（服务端否则会 400）', async () => {  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ hits: [], total_hits: 0 }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new ModrinthClient({ fetchImpl: fakeFetch });
  await client.search({ query: 'x', limit: 9999, offset: -5 });
  await client.search({ query: 'x', limit: Number.NaN });

  const first = new URL(urls[0] as string);
  assert.equal(Number(first.searchParams.get('limit')), SEARCH_MAX_LIMIT);
  assert.equal(Number(first.searchParams.get('offset')), 0);
  const second = new URL(urls[1] as string);
  assert.equal(Number(second.searchParams.get('limit')), 20, '非法 limit 回落到默认 20');
});

test('getProject 带 5 分钟内存缓存（重复调用只发一次请求）', async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        id: 'AANobbMI',
        slug: 'sodium',
        title: 'Sodium',
        description: 'fast',
        downloads: 1,
        project_type: 'mod',
        categories: ['optimization'],
        game_versions: ['1.21'],
        icon_url: 'https://cdn.modrinth.com/x.webp',
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const client = new ModrinthClient({ fetchImpl: fakeFetch });
  const a = await client.getProject('sodium');
  const b = await client.getProject('SODIUM'); // 大小写不该造成二次请求
  assert.equal(calls, 1);
  assert.equal(a.title, 'Sodium');
  assert.equal(b.slug, 'sodium');

  // 缓存返回的是副本：改坏它不影响下一次
  a.categories.push('mutated');
  const c = await client.getProject('sodium');
  assert.deepEqual(c.categories, ['optimization']);
});

test('getProject 缓存过期后会重新请求', async () => {
  let calls = 0;
  let now = 1_000_000;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ slug: 'sodium', title: 'Sodium' }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new ModrinthClient({ fetchImpl: fakeFetch, now: () => now, projectCacheTtlMs: 60_000 });
  await client.getProject('sodium');
  now += 59_000;
  await client.getProject('sodium');
  assert.equal(calls, 1, '5 分钟内命中缓存');
  now += 2_000;
  await client.getProject('sodium');
  assert.equal(calls, 2, '过期后重新请求');
});

test('网络失败被人话化，不抛裸 fetch 异常', async () => {
  const fakeFetch = (async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.modrinth.com'), { code: 'ENOTFOUND' }) } as never);
  }) as unknown as typeof fetch;

  const client = new ModrinthClient({ fetchImpl: fakeFetch });
  await assert.rejects(
    () => client.search({ query: 'sodium' }),
    (error: unknown) => {
      assert.ok(error instanceof ModrinthError);
      assert.equal(error.kind, 'network');
      assert.match(error.message, /域名|连不上|网络/);
      assert.doesNotMatch(error.message, /^TypeError/);
      return true;
    },
  );
});

test('超时 / 404 分别映射成 network 与 not-found', async () => {
  const timeoutFetch = (async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => new ModrinthClient({ fetchImpl: timeoutFetch }).search({ query: 'x' }),
    (error: unknown) => error instanceof ModrinthError && error.kind === 'network' && /超时/.test(error.message),
  );

  const notFoundFetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    () => new ModrinthClient({ fetchImpl: notFoundFetch }).getProject('no-such-mod'),
    (error: unknown) => error instanceof ModrinthError && error.kind === 'not-found',
  );
});

test('search：hits 里的脏数据被跳过，不影响其它条目', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        total_hits: 3,
        hits: [
          { slug: 'good', title: 'Good', description: 'd', downloads: 10, project_type: 'mod', categories: [], versions: ['1.21'] },
          { title: '缺少 slug 和 project_id' },
          null,
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const result = await new ModrinthClient({ fetchImpl: fakeFetch }).search({ query: 'x' });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.slug, 'good');
  assert.equal(result.totalHits, 3, 'totalHits 以服务端为准');
});

test('listVersions：服务端忽略过滤参数时本地再兜一层', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify([
        { id: 'v1', version_number: '1.0', game_versions: ['1.21'], loaders: ['fabric'], files: [], dependencies: [] },
        { id: 'v2', version_number: '0.9', game_versions: ['1.20'], loaders: ['fabric'], files: [], dependencies: [] },
        { id: 'v3', version_number: '1.0-forge', game_versions: ['1.21'], loaders: ['forge'], files: [], dependencies: [] },
      ]),
      { status: 200 },
    )) as unknown as typeof fetch;

  const versions = await new ModrinthClient({ fetchImpl: fakeFetch }).listVersions('x', {
    gameVersion: '1.21',
    loader: 'fabric',
  });
  assert.deepEqual(versions.map((v) => v.id), ['v1']);
});

test('版本里没 url / filename 的文件被丢弃（留着只会在安装阶段炸）', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify([
        {
          id: 'v1',
          version_number: '1.0',
          game_versions: ['1.21'],
          loaders: ['fabric'],
          dependencies: [{ project_id: 'abc', dependency_type: 'required' }, { dependency_type: 'required' }],
          files: [
            // 两条都必须带 url：真实 API 的每个文件都有 url，没有 url 的条目才是要丢的那种
            { url: 'https://x/no-name.jar', size: 1, primary: true },
            { url: 'https://x/ok.jar', filename: 'ok.jar', size: 2, primary: false, hashes: { sha1: 'abc123' } },
          ],
        },
      ]),
      { status: 200 },
    )) as unknown as typeof fetch;

  const [v] = await new ModrinthClient({ fetchImpl: fakeFetch }).listVersions('x');
  assert.ok(v !== undefined);
  assert.equal(v.files.length, 1);
  assert.equal(v.files[0]?.filename, 'ok.jar');
  assert.equal(v.files[0]?.sha1, 'abc123');
  // 没有 project_id / version_id 的那条才丢；只有 project_id、缺 dependency_type 的必须保留（合法形状）
  assert.equal(v.dependencies.length, 1);
  assert.equal(v.dependencies[0]?.projectId, 'abc');
  assert.equal(v.dependencies[0]?.dependencyType, 'required');
});

// ═════════════════════════════ 四、jar 元数据 ═════════════════════════════

test('jar 元数据：fabric.mod.json 读出 id / name / version', async (t) => {
  const dir = await tempDir(t, 'fabric');
  const file = path.join(dir, 'sodium-fabric-0.5.8.jar');
  await fsp.writeFile(
    file,
    fabricJar({
      schemaVersion: 1,
      id: 'sodium',
      name: 'Sodium',
      version: '0.5.8+mc1.20.1',
      entrypoints: { main: ['net.caffeinemc.mods.sodium.client.SodiumClientMod'] },
    }),
  );

  const meta = await readModJarMeta(file);
  assert.equal(meta.source, 'fabric.mod.json');
  assert.equal(meta.id, 'sodium');
  assert.equal(meta.name, 'Sodium');
  assert.equal(meta.version, '0.5.8+mc1.20.1');
  assert.equal(meta.error, undefined);
});

test('jar 元数据：fabric.mod.json 只有 id 时 name 回落到 id', async (t) => {
  const dir = await tempDir(t, 'fabric-min');
  const file = path.join(dir, 'x.jar');
  await fsp.writeFile(file, fabricJar({ id: 'mymod', version: '1.0.0' }));

  const meta = await readModJarMeta(file);
  assert.equal(meta.id, 'mymod');
  assert.equal(meta.name, 'mymod');
  assert.equal(meta.version, '1.0.0');
});

test('jar 元数据：Forge 的 META-INF/mods.toml 用正则提取', async (t) => {
  const dir = await tempDir(t, 'forge');
  const file = path.join(dir, 'jei-forge.jar');
  await fsp.writeFile(
    file,
    forgeJar(
      [
        'modLoader="javafml"',
        'loaderVersion="[47,)"',
        'license="MIT"',
        '[[mods]]',
        'modId="jei"',
        'displayName="Just Enough Items"',
        'version="15.2.0.27"',
      ].join('\n'),
    ),
  );

  const meta = await readModJarMeta(file);
  assert.equal(meta.source, 'mods.toml');
  assert.equal(meta.id, 'jei');
  assert.equal(meta.name, 'Just Enough Items');
  assert.equal(meta.version, '15.2.0.27');
});

test('jar 元数据：mods.toml 里的 ${file.jarVersion} 占位符被丢弃（不显示伪版本号）', async (t) => {
  const dir = await tempDir(t, 'forge-ph');
  const file = path.join(dir, 'y.jar');
  await fsp.writeFile(
    file,
    forgeJar(['[[mods]]', "modId='placeholder'", "displayName='Placeholder'", 'version="${file.jarVersion}"'].join('\n')),
  );

  const meta = await readModJarMeta(file);
  assert.equal(meta.id, 'placeholder');
  assert.equal(meta.version, undefined, '占位符不是版本号');
});

test('jar 元数据：坏 jar / 不是 jar / 没有元数据 → 返回 source:none 而不是抛错', async (t) => {
  const dir = await tempDir(t, 'bad');
  const notZip = path.join(dir, 'notzip.jar');
  await fsp.writeFile(notZip, 'this is definitely not a zip file');
  const bad = await readModJarMeta(notZip);
  assert.equal(bad.source, 'none');
  assert.ok(typeof bad.error === 'string' && bad.error.length > 0);

  const noMeta = path.join(dir, 'plain.jar');
  await fsp.writeFile(noMeta, buildZip([{ name: 'META-INF/MANIFEST.MF', data: 'x' }]));
  const plain = await readModJarMeta(noMeta);
  assert.equal(plain.source, 'none');
  assert.match(plain.error ?? '', /fabric\.mod\.json|mods\.toml/);

  const missing = await readModJarMeta(path.join(dir, 'does-not-exist.jar'));
  assert.equal(missing.source, 'none');
  assert.ok(missing.error !== undefined);
});

test('jar 元数据：fabric.mod.json 是坏 JSON 时给出 error，但如实标注来源', () => {
  const buf = buildZip([{ name: 'fabric.mod.json', data: '{ not json' }]);
  const meta = readMetaFromBuffer(buf);
  assert.equal(meta.source, 'fabric.mod.json');
  assert.match(meta.error ?? '', /JSON/);
});

test('tomlString：单引号 / 双引号 / 前后空白都认', () => {
  const text = ['  modId = "a"', "displayName='b'", 'version   =   "1.2.3"'].join('\n');
  assert.equal(tomlString(text, 'modId'), 'a');
  assert.equal(tomlString(text, 'displayName'), 'b');
  assert.equal(tomlString(text, 'version'), '1.2.3');
  assert.equal(tomlString(text, 'missing'), undefined);
});

// ═════════════════════════════ 五、文件名工具 ═════════════════════════════

test('文件名：禁用后缀的往返变换', () => {
  assert.equal(enabledNameOf('foo.jar'), 'foo.jar');
  assert.equal(enabledNameOf('foo.jar.disabled'), 'foo.jar');
  assert.equal(diskNameOf('foo.jar', true), 'foo.jar');
  assert.equal(diskNameOf('foo.jar', false), 'foo.jar.disabled');
  // 已经是禁用态再传 false，不该叠加第二个 .disabled
  assert.equal(diskNameOf('foo.jar.disabled', false), 'foo.jar.disabled');
});

test('文件名校验：拒绝穿越 / 盘符 / 控制字符，接受中文', () => {
  assert.equal(checkModFilename('sodium-fabric-0.5.8.jar'), null);
  assert.equal(checkModFilename('更快的树叶.jar'), null);
  assert.ok(checkModFilename('../evil.jar') !== null);
  assert.ok(checkModFilename('a/b.jar') !== null);
  assert.ok(checkModFilename('C:\\evil.jar') !== null);
  assert.ok(checkModFilename('bad\u0000.jar') !== null);
  assert.ok(checkModFilename('trailing-space.jar ') !== null);
  assert.ok(checkModFilename('con.jar') !== null, 'Windows 保留设备名必须拒绝');
  assert.ok(checkModFilename('') !== null);
  assert.ok(checkModFilename('x'.repeat(300) + '.jar') !== null);
});

test('sanitizeJarFilename：URL 形状的名字被打扫成合法 jar 文件名', () => {
  assert.equal(sanitizeJarFilename('https://cdn.modrinth.com/data/X/versions/Y/sodium%20fabric.jar?x=1'), 'sodium fabric.jar');
  assert.equal(sanitizeJarFilename('noext'), 'noext.jar');
  assert.equal(sanitizeJarFilename('../../evil'), 'evil.jar');
  assert.equal(sanitizeJarFilename('', 'fallback.jar'), 'fallback.jar');
});

// ═════════════════════════════ 六、ModManager ═════════════════════════════

/** 假的下载器：把给定内容写到 dest，并可选地触发一次进度 */
function fakeDownloader(
  content: Buffer | ((dest: string) => Promise<Buffer>),
  options: { fail?: boolean; progress?: boolean } = {},
): ModDownloaderLike & { calls: { url: string; dest: string; sha1?: string }[] } {
  const calls: { url: string; dest: string; sha1?: string }[] = [];
  return {
    calls,
    async downloadAll(tasks, onProgress) {
      const task = tasks[0];
      if (task === undefined) return { ok: true, skipped: 0, downloaded: 0, failed: [] };
      calls.push({ url: task.url, dest: task.dest, ...(task.sha1 === undefined ? {} : { sha1: task.sha1 }) });

      if (options.fail === true) {
        return { ok: false, skipped: 0, downloaded: 0, failed: [{ url: task.url, error: 'boom' }] };
      }

      const data = typeof content === 'function' ? await content(task.dest) : content;
      await fsp.mkdir(path.dirname(task.dest), { recursive: true });
      await fsp.writeFile(task.dest, data);
      if (options.progress === true) {
        onProgress?.({
          done: 1,
          total: 1,
          current: task.dest,
          bytesDone: data.byteLength,
          bytesTotal: data.byteLength,
        });
      }
      return { ok: true, skipped: 0, downloaded: 1, failed: [] };
    },
  };
}

test('安装路径落在 <dataRoot>/instances/<instanceId>/mods/', async (t) => {
  const dataRoot = await tempDir(t, 'install');
  const jar = fabricJar({ id: 'sodium', name: 'Sodium', version: '0.5.8' });
  const downloader = fakeDownloader(jar, { progress: true });
  const mgr = new ModManager({ dataRoot, downloader });

  const progress: { done: number; total: number }[] = [];
  const dest = await mgr.install(
    'fabric-loader-0.16.9-1.21',
    { url: 'https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar', filename: 'sodium-fabric-0.5.8.jar', sha1: 'ABCDEF' },
    (p) => progress.push({ done: p.done, total: p.total }),
  );

  const expected = path.join(dataRoot, 'instances', 'fabric-loader-0.16.9-1.21', 'mods', 'sodium-fabric-0.5.8.jar');
  assert.equal(path.resolve(dest), path.resolve(expected));

  const stat = await fsp.stat(dest);
  assert.equal(stat.size, jar.byteLength);

  // 目录里不该残留 .part
  const entries = await fsp.readdir(path.dirname(dest));
  assert.deepEqual(entries, ['sodium-fabric-0.5.8.jar']);

  // 下载器收到的是「下到 .part」的临时目标，且 sha1 被小写化
  assert.equal(downloader.calls.length, 1);
  assert.match(downloader.calls[0]?.dest ?? '', /\.jar\.part$/);
  assert.equal(downloader.calls[0]?.sha1, 'abcdef');

  // 进度被换算成字节数透传出来
  assert.deepEqual(progress.at(-1), { done: jar.byteLength, total: jar.byteLength });

  // 装完立刻能在列表里看到元数据
  const mods = await mgr.list('fabric-loader-0.16.9-1.21');
  assert.equal(mods.length, 1);
  assert.equal(mods[0]?.id, 'sodium');
  assert.equal(mods[0]?.version, '0.5.8');
  assert.equal(mods[0]?.enabled, true);
});

test('安装失败时不留下正式文件与 .part', async (t) => {
  const dataRoot = await tempDir(t, 'install-fail');
  const mgr = new ModManager({ dataRoot, downloader: fakeDownloader(Buffer.alloc(0), { fail: true }) });

  await assert.rejects(
    () => mgr.install('1.21', { url: 'https://x/a.jar', filename: 'a.jar' }),
    /下载 a\.jar 失败/,
  );

  const dir = path.join(dataRoot, 'instances', '1.21', 'mods');
  const entries = await fsp.readdir(dir).catch(() => []);
  assert.deepEqual(entries, []);
});

test('安装会覆盖同名文件（启用态与禁用态都不留重复项）', async (t) => {
  const dataRoot = await tempDir(t, 'overwrite');
  const mgr = new ModManager({ dataRoot, downloader: fakeDownloader(fabricJar({ id: 'a', version: '1' })) });
  const dir = path.join(dataRoot, 'instances', 'i1', 'mods');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'a.jar.disabled'), 'old');
  await fsp.writeFile(path.join(dir, 'a.jar'), 'old');

  const dest = await mgr.install('i1', { url: 'https://x/a.jar', filename: 'a.jar' });
  assert.equal(path.basename(dest), 'a.jar');
  assert.deepEqual(await fsp.readdir(dir), ['a.jar']);
});

test('禁用改名 .disabled，再启用改回原名（幂等）', async (t) => {
  const dataRoot = await tempDir(t, 'toggle');
  const mgr = new ModManager({ dataRoot, downloader: fakeDownloader(Buffer.from('jar')) });
  const dir = path.join(dataRoot, 'instances', 'i1', 'mods');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'foo.jar'), 'x');

  await mgr.setEnabled('i1', 'foo.jar', false);
  assert.deepEqual(await fsp.readdir(dir), ['foo.jar.disabled']);

  let mods = await mgr.list('i1');
  assert.equal(mods.length, 1);
  assert.equal(mods[0]?.filename, 'foo.jar');
  assert.equal(mods[0]?.enabled, false);

  // 幂等：再禁用一次不报错也不改名
  await mgr.setEnabled('i1', 'foo.jar', false);
  assert.deepEqual(await fsp.readdir(dir), ['foo.jar.disabled']);

  await mgr.setEnabled('i1', 'foo.jar', true);
  assert.deepEqual(await fsp.readdir(dir), ['foo.jar']);

  mods = await mgr.list('i1');
  assert.equal(mods[0]?.enabled, true);
});

test('禁用 / 删除不存在的模组要如实报错（不假装成功）', async (t) => {
  const dataRoot = await tempDir(t, 'missing');
  const mgr = new ModManager({ dataRoot, downloader: fakeDownloader(Buffer.alloc(0)) });

  await assert.rejects(() => mgr.setEnabled('i1', 'ghost.jar', false), ModValidationError);
  await assert.rejects(() => mgr.remove('i1', 'ghost.jar'), ModValidationError);
});

test('删除会同时清掉启用态、禁用态与残留的 .part', async (t) => {
  const dataRoot = await tempDir(t, 'remove');
  const mgr = new ModManager({ dataRoot, downloader: fakeDownloader(Buffer.alloc(0)) });
  const dir = path.join(dataRoot, 'instances', 'i1', 'mods');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'foo.jar'), 'x');
  await fsp.writeFile(path.join(dir, 'foo.jar.disabled'), 'y');
  await fsp.writeFile(path.join(dir, 'foo.jar.part'), 'z');
  await fsp.writeFile(path.join(dir, 'other.jar'), 'keep');

  await mgr.remove('i1', 'foo.jar');
  assert.deepEqual(await fsp.readdir(dir), ['other.jar']);
});

test('列表：目录不存在 → 空数组；非 jar 文件不列出；坏 jar 仍列出但带 metaError', async (t) => {
  const dataRoot = await tempDir(t, 'list');
  const mgr = new ModManager({ dataRoot, downloader: fakeDownloader(Buffer.alloc(0)) });

  assert.deepEqual(await mgr.list('nope'), []);

  const dir = path.join(dataRoot, 'instances', 'i1', 'mods');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'good.jar'), fabricJar({ id: 'good', name: 'Good', version: '1.0' }));
  await fsp.writeFile(path.join(dir, 'broken.jar'), 'not a zip at all');
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'ignore me');
  await fsp.writeFile(path.join(dir, 'pending.jar.part'), 'partial download');

  const mods = await mgr.list('i1');
  const names = mods.map((m) => m.filename).sort();
  assert.deepEqual(names, ['broken.jar', 'good.jar']);

  const broken = mods.find((m) => m.filename === 'broken.jar');
  assert.ok(broken !== undefined);
  assert.equal(broken.name, 'broken', '元数据读不到时用文件名兜底');
  assert.ok(typeof broken.metaError === 'string' && broken.metaError.length > 0);
  assert.equal(broken.id, undefined);
});

test('实例 id / 文件名非法时安装被拒（不拼出越界路径）', async (t) => {
  const dataRoot = await tempDir(t, 'guard');
  const mgr = new ModManager({ dataRoot, downloader: fakeDownloader(Buffer.from('x')) });

  await assert.rejects(() => mgr.install('../evil', { url: 'https://x/a.jar', filename: 'a.jar' }), ModValidationError);
  await assert.rejects(() => mgr.install('i1', { url: 'https://x/a.jar', filename: '../a.jar' }), ModValidationError);
  await assert.rejects(() => mgr.install('i1', { url: 'ftp://x/a.jar', filename: 'a.jar' }), ModValidationError);
  await assert.rejects(() => mgr.install('i1', { url: 'https://x/a.zip', filename: 'a.zip' }), ModValidationError);
});

// ═════════════════════════════ 七、真实网络（不可达则 SKIP） ═════════════════════════════

test('真实网络：搜索 sodium 返回非空项目（不可达则 SKIP）', async (t) => {
  const client = new ModrinthClient({ timeoutMs: 20_000 });

  let result: { hits: { slug: string; title: string; description: string }[]; totalHits: number };
  try {
    result = await client.search({ query: 'sodium', projectType: 'mod', limit: 5 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    t.skip(`连不上 Modrinth（${reason}），跳过真实网络断言`);
    return;
  }

  assert.ok(result.hits.length > 0, 'Modrinth 应该能搜到 sodium');
  assert.ok(result.totalHits > 0);

  const sodium = result.hits.find((h) => h.slug === 'sodium');
  assert.ok(sodium !== undefined, `结果里应当有 slug=sodium，实际：${result.hits.map((h) => h.slug).join(',')}`);
  assert.equal(sodium.title, 'Sodium');
  assert.ok(sodium.description.length > 0);

  // 顺手验一遍 getProject + listVersions（这两条也走真实网络）
  const detail = await client.getProject('sodium');
  assert.equal(detail.slug, 'sodium');
  assert.ok(Array.isArray(detail.gameVersions) && detail.gameVersions.length > 0);

  const versions = await client.listVersions('sodium', { loader: 'fabric' });
  assert.ok(versions.length > 0);
  const best = client.pickBestVersion(versions, { gameVersion: versions[0]?.gameVersions[0] ?? '1.21', loader: 'fabric' });
  assert.ok(best !== undefined);
  assert.ok(best.files.length > 0);
});

test('真实网络：facets 过滤能收敛结果（1.21 + fabric）', async (t) => {
  const client = new ModrinthClient({ timeoutMs: 20_000 });
  const options: SearchOptions = { query: '', projectType: 'mod', gameVersion: '1.21', loader: 'fabric', limit: 3 };

  let filtered: { hits: { latestGameVersions: string[] }[]; totalHits: number };
  try {
    filtered = await client.search(options);
  } catch (error) {
    t.skip(`连不上 Modrinth（${error instanceof Error ? error.message : String(error)}），跳过 facets 过滤断言`);
    return;
  }

  assert.ok(filtered.totalHits > 0, '1.21 + fabric 下必然有结果');
  for (const hit of filtered.hits) {
    assert.ok(
      hit.latestGameVersions.includes('1.21'),
      `结果应当适配 1.21：${JSON.stringify(hit.latestGameVersions)}`,
    );
  }
});
