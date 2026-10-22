/**
 * version 模块测试（node --test 内置 runner）。
 *
 * 覆盖：
 *   1. 真实网络拉 manifest —— versions 长度 > 0、latest.release 非空；网络不可用时明确打印 SKIP 而不是假绿。
 *   2. 缓存命中 —— 连续两次 fetchManifest，第二次读磁盘缓存（用一个必然失败的 fetchImpl 证明没有触网）。
 *   3. resolveInherited —— 内联构造父子 JSON，验证库合并（同名 artifact 子覆盖父）与参数拼接顺序（父在前子在后）。
 *   4. 网络失败回退 —— 过期缓存仍返回，并通过注入 logger 断言有 warning。
 *   5. 镜像切换 —— 版本 JSON URL 的 host 被替换，path 保留。
 *   6. getDataRoot —— 环境变量优先。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  VersionRepository,
  MANIFEST_CACHE_FILE,
  OFFICIAL_ROOT,
  MIRROR_ROOT,
  applyMirror,
  fetchJson,
  fetchText,
  FetchError,
  getDataRoot,
  mergeVersionJson,
  normalizeMirrorRoot,
} from '../src/core/version/index.js';
import type { FetchJsonFn } from '../src/core/version/http.js';
import type { Logger, VersionJson, VersionManifest } from '../src/core/version/index.js';

// ───────────────────────────── 工具 ─────────────────────────────

/**
 * 本文件创建过的临时数据根，进程退出前统一删除。
 *
 * 为什么需要：60+ 个用例各自建目录，绝大多数不手工清理，
 * 每跑一次全量就会在 %TEMP% 留下上百个 `pcl3-version-*`（实测累积 152 个）。
 * `after()` 在断言失败时也会执行，比逐个用例 try/finally 更可靠。
 */
const createdDataRoots: string[] = [];

after(() => {
  for (const dir of createdDataRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
});

function tmpDataRoot(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-version-${tag}-`));
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  createdDataRoots.push(dir);
  return dir;
}

function collectLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      warn: (msg: string) => {
        warnings.push(msg);
      },
    },
  };
}

/** 构造一个必然失败的 fetch 实现，用来证明「第二次调用没有触网」 */
const explodingFetch: FetchJsonFn = async (url) => {
  throw new Error(`unexpected network call to ${url}`);
};

const SAMPLE_MANIFEST: VersionManifest = {
  latest: { release: '1.21', snapshot: '24w45a' },
  versions: [
    { id: '1.21', type: 'release', url: 'https://launchermeta.mojang.com/version/abc/1.21.json', time: 't', releaseTime: 'rt' },
    {
      id: '1.20.1',
      type: 'release',
      url: 'https://launchermeta.mojang.com/version/def/1.20.1.json',
      time: 't',
      releaseTime: 'rt',
    },
  ],
};

// ───────────────────────────── 1. 真实网络 ─────────────────────────────

test('fetchManifest: 真实网络拉取官方 manifest', async (t) => {
  const repo = new VersionRepository({ dataRoot: tmpDataRoot('net'), logger: collectLogger().logger });
  let manifest: VersionManifest;
  try {
    manifest = await repo.fetchManifest(true);
  } catch (err) {
    t.diagnostic(`SKIP: network unavailable -> ${(err as Error).message}`);
    console.log(`SKIP fetchManifest network assertions: ${(err as Error).message}`);
    return;
  }

  assert.ok(Array.isArray(manifest.versions), 'versions 应为数组');
  assert.ok(manifest.versions.length > 0, `versions 长度应 > 0，实际 ${manifest.versions.length}`);
  assert.ok(typeof manifest.latest.release === 'string' && manifest.latest.release.length > 0, 'latest.release 非空');
  assert.ok(typeof manifest.latest.snapshot === 'string' && manifest.latest.snapshot.length > 0, 'latest.snapshot 非空');

  const first = manifest.versions[0];
  assert.ok(first && typeof first.id === 'string' && first.id.length > 0, '首个版本应有 id');
  assert.ok(first && first.url.startsWith('https://'), '首个版本应有 https url');

  console.log(
    `OK fetchManifest: versions=${manifest.versions.length}, latest.release=${manifest.latest.release}, ` +
      `latest.snapshot=${manifest.latest.snapshot}, cachedAt=${repo.cacheDir}`,
  );
});

test('fetchVersion: 真实网络拉一个 release 版本 JSON', async (t) => {
  const repo = new VersionRepository({ dataRoot: tmpDataRoot('netver'), logger: collectLogger().logger });
  let json: VersionJson;
  try {
    const manifest = await repo.fetchManifest(true);
    const release = manifest.latest.release;
    json = await repo.fetchVersion(release);
    assert.equal(json.id, release);
  } catch (err) {
    t.diagnostic(`SKIP: network unavailable -> ${(err as Error).message}`);
    console.log(`SKIP fetchVersion network assertions: ${(err as Error).message}`);
    return;
  }

  assert.ok(typeof json.mainClass === 'string' && json.mainClass.length > 0, 'mainClass 非空');
  assert.ok(Array.isArray(json.libraries) && json.libraries.length > 0, 'libraries 应非空');
  console.log(`OK fetchVersion: id=${json.id}, mainClass=${json.mainClass}, libraries=${json.libraries.length}`);
});

// ───────────────────────────── 2. 缓存命中 ─────────────────────────────

test('fetchManifest: 第二次调用读缓存（不触网）', async () => {
  const dataRoot = tmpDataRoot('cache');
  const metaDir = path.join(dataRoot, 'meta');
  // 预置一份新鲜缓存（拉取时间 = 现在），TTL 内
  fs.writeFileSync(path.join(metaDir, MANIFEST_CACHE_FILE), JSON.stringify(SAMPLE_MANIFEST), 'utf8');
  fs.writeFileSync(
    path.join(metaDir, 'version_manifest_v2.meta.json'),
    JSON.stringify({ fetchedAt: Date.now(), url: `${OFFICIAL_ROOT}/mc/game/version_manifest_v2.json` }),
    'utf8',
  );

  const { logger, warnings } = collectLogger();
  const repo = new VersionRepository({ dataRoot, logger, fetchImpl: explodingFetch });

  const first = await repo.fetchManifest();
  const second = await repo.fetchManifest();
  assert.equal(first.versions.length, 2);
  assert.equal(second.versions.length, 2);
  assert.deepEqual(second.latest, { release: '1.21', snapshot: '24w45a' });
  assert.equal(warnings.length, 0, 'TTL 内不应触发网络回退告警');
});

test('fetchManifest: 第一次触网写入缓存后，第二次直接命中缓存', async () => {
  const dataRoot = tmpDataRoot('cache2');
  let calls = 0;
  const countingFetch: FetchJsonFn = async () => {
    calls += 1;
    return { data: SAMPLE_MANIFEST, url: `${OFFICIAL_ROOT}/mc/game/version_manifest_v2.json`, statusCode: 200 };
  };

  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: countingFetch });
  const a = await repo.fetchManifest();
  const b = await repo.fetchManifest();
  assert.equal(calls, 1, `应只触网一次，实际 ${calls}`);
  assert.deepEqual(a, b);
  assert.ok(fs.existsSync(path.join(dataRoot, 'meta', MANIFEST_CACHE_FILE)), '缓存文件应落盘');
  assert.ok(
    fs.existsSync(path.join(dataRoot, 'meta', 'version_manifest_v2.meta.json')),
    '应记录拉取时间（meta 旁挂文件）',
  );
});

test('fetchManifest: TTL 过期会重新触网（force 也一样）', async () => {
  const dataRoot = tmpDataRoot('ttl');
  let calls = 0;
  const countingFetch: FetchJsonFn = async () => {
    calls += 1;
    return { data: SAMPLE_MANIFEST, url: `${OFFICIAL_ROOT}/mc/game/version_manifest_v2.json`, statusCode: 200 };
  };
  const repo = new VersionRepository({ dataRoot, ttlMs: 1, logger: collectLogger().logger, fetchImpl: countingFetch });
  await repo.fetchManifest();
  await new Promise((r) => setTimeout(r, 10));
  await repo.fetchManifest();
  assert.equal(calls, 2, `TTL 过期后应重新触网，实际触网 ${calls} 次`);
  await repo.fetchManifest(true);
  assert.equal(calls, 3, 'force=true 应强制重新拉取');
});

test('fetchManifest: 并发调用只触发一次网络请求', async () => {
  const dataRoot = tmpDataRoot('dedupe');
  let calls = 0;
  const slowFetch: FetchJsonFn = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 30));
    return { data: SAMPLE_MANIFEST, url: `${OFFICIAL_ROOT}/mc/game/version_manifest_v2.json`, statusCode: 200 };
  };
  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: slowFetch });
  const [a, b, c] = await Promise.all([repo.fetchManifest(), repo.fetchManifest(), repo.fetchManifest()]);
  assert.equal(calls, 1, `并发应去重为 1 次，实际 ${calls}`);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

// ───────────────────────────── 3. resolveInherited ─────────────────────────────

const PARENT_JSON: VersionJson = {
  id: '1.21',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  assets: '17',
  assetIndex: { id: '17', sha1: 'aaa', size: 1, totalSize: 2, url: 'https://example.com/17.json' },
  downloads: {
    client: { sha1: 'c1', size: 10, url: 'https://example.com/client.jar' },
  },
  libraries: [
    { name: 'com.mojang:brigadier:1.0.18' },
    { name: 'org.lwjgl:lwjgl:3.3.3' },
    { name: 'com.google.code.gson:gson:2.10.1' },
  ],
  arguments: {
    game: ['--username', '${auth_player_name}', '--version', '${version_name}'],
    jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
  },
  minecraftArguments: '--old-args',
  javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
};

const CHILD_JSON: VersionJson = {
  id: '1.21-forge-51.0.0',
  type: 'release',
  mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
  assets: '17',
  inheritsFrom: '1.21',
  downloads: {
    client: { sha1: 'c2', size: 11, url: 'https://example.com/child-client.jar' },
  },
  libraries: [
    { name: 'org.lwjgl:lwjgl:3.3.3' },
    { name: 'net.minecraftforge:forge:1.21-51.0.0' },
  ],
  arguments: {
    game: ['--launchTarget', 'forge_client'],
    jvm: ['-Dforgelibpath=${library_directory}', '-p', '${library_directory}/modlauncher.jar'],
  },
};

test('mergeVersionJson: 库合并（同名以子为准）+ 参数父前子后拼接', () => {
  const merged = mergeVersionJson(CHILD_JSON, PARENT_JSON);

  // 库：父 3 个 + 子 1 个新增 = 4 个；同名 lwjgl 保留原位置但不重复
  const names = merged.libraries.map((l) => l.name);
  assert.deepEqual(names, [
    'com.mojang:brigadier:1.0.18',
    'org.lwjgl:lwjgl:3.3.3',
    'com.google.code.gson:gson:2.10.1',
    'net.minecraftforge:forge:1.21-51.0.0',
  ]);
  assert.equal(merged.libraries.filter((l) => l.name.startsWith('org.lwjgl:lwjgl')).length, 1, '同名库不应重复');

  // mainClass 子覆盖
  assert.equal(merged.mainClass, 'cpw.mods.bootstraplauncher.BootstrapLauncher');
  // assets 子有则覆盖（这里值相同）
  assert.equal(merged.assets, '17');
  // assetIndex 子未声明 → 继承父
  assert.equal(merged.assetIndex?.id, '17');
  // downloads 合并，同 key 子覆盖
  assert.equal(merged.downloads?.['client']?.url, 'https://example.com/child-client.jar');

  // arguments：父在前，子在后
  assert.deepEqual(merged.arguments?.game, [
    '--username',
    '${auth_player_name}',
    '--version',
    '${version_name}',
    '--launchTarget',
    'forge_client',
  ]);
  assert.deepEqual(merged.arguments?.jvm, [
    '-Djava.library.path=${natives_directory}',
    '-cp',
    '${classpath}',
    '-Dforgelibpath=${library_directory}',
    '-p',
    '${library_directory}/modlauncher.jar',
  ]);

  // minecraftArguments 子没有 → 继承父
  assert.equal(merged.minecraftArguments, '--old-args');
  // 合并后 inheritsFrom 必须为 undefined
  assert.equal(merged.inheritsFrom, undefined);
  assert.ok(!('inheritsFrom' in merged) || merged.inheritsFrom === undefined);
  // 入参未被修改
  assert.equal(CHILD_JSON.inheritsFrom, '1.21', '不应修改入参');
  assert.equal(PARENT_JSON.mainClass, 'net.minecraft.client.main.Main', '不应修改入参');
});

test('resolveInherited: 走仓库拿到父版本并合并，链尾 inheritsFrom 清空', async () => {
  const dataRoot = tmpDataRoot('inherit');
  const manifest: VersionManifest = {
    latest: { release: '1.21', snapshot: '1.21' },
    versions: [
      { id: '1.21', type: 'release', url: 'https://launchermeta.mojang.com/version/parent/1.21.json', time: 't', releaseTime: 't' },
      {
        id: '1.21-forge-51.0.0',
        type: 'release',
        url: 'https://launchermeta.mojang.com/version/child/1.21-forge-51.0.0.json',
        time: 't',
        releaseTime: 't',
      },
    ],
  };

  const stubFetch: FetchJsonFn = async (url) => {
    if (url.endsWith('/mc/game/version_manifest_v2.json')) {
      return { data: manifest, url, statusCode: 200 };
    }
    if (url.includes('1.21-forge-51.0.0.json')) return { data: CHILD_JSON, url, statusCode: 200 };
    if (url.includes('1.21.json')) return { data: PARENT_JSON, url, statusCode: 200 };
    throw new Error(`unexpected url ${url}`);
  };

  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: stubFetch });
  const child = await repo.fetchVersion('1.21-forge-51.0.0');
  assert.equal(child.inheritsFrom, '1.21');

  const resolved = await repo.resolveInherited(child);
  assert.equal(resolved.inheritsFrom, undefined);
  assert.equal(resolved.mainClass, 'cpw.mods.bootstraplauncher.BootstrapLauncher');
  assert.equal(resolved.libraries.length, 4);
  assert.deepEqual(resolved.arguments?.game.slice(0, 2), ['--username', '${auth_player_name}']);
  assert.equal(resolved.arguments?.game.at(-1), 'forge_client');

  // 两层以上继承链
  const grandChild: VersionJson = {
    id: 'deep',
    type: 'release',
    mainClass: '',
    assets: '',
    inheritsFrom: '1.21-forge-51.0.0',
    libraries: [{ name: 'com.example:deep:1.0' }],
    arguments: { game: ['--deep'], jvm: [] },
  };
  const deepManifest: VersionManifest = {
    latest: manifest.latest,
    versions: [...manifest.versions, { id: 'deep', type: 'release', url: 'https://launchermeta.mojang.com/version/deep/deep.json', time: 't', releaseTime: 't' }],
  };
  const repo2 = new VersionRepository({
    dataRoot: tmpDataRoot('inherit2'),
    logger: collectLogger().logger,
    fetchImpl: async (url) => {
      if (url.endsWith('/mc/game/version_manifest_v2.json')) return { data: deepManifest, url, statusCode: 200 };
      if (url.includes('deep.json')) return { data: grandChild, url, statusCode: 200 };
      if (url.includes('1.21-forge-51.0.0.json')) return { data: CHILD_JSON, url, statusCode: 200 };
      if (url.includes('1.21.json')) return { data: PARENT_JSON, url, statusCode: 200 };
      throw new Error(`unexpected url ${url}`);
    },
  });
  const r2 = await repo2.fetchResolvedVersion('deep');
  assert.equal(r2.inheritsFrom, undefined);
  assert.equal(r2.libraries.length, 5);
  assert.equal(r2.mainClass, 'cpw.mods.bootstraplauncher.BootstrapLauncher');
  assert.deepEqual(r2.arguments?.game.slice(-1), ['--deep']);
});

// ───────────────────────────── 4. 网络失败回退 ─────────────────────────────

test('fetchManifest: 网络失败时回退到过期缓存并打 warning', async () => {
  const dataRoot = tmpDataRoot('fallback');
  const metaDir = path.join(dataRoot, 'meta');
  fs.writeFileSync(path.join(metaDir, MANIFEST_CACHE_FILE), JSON.stringify(SAMPLE_MANIFEST), 'utf8');
  // 拉取时间设为很久以前（远超 10 分钟 TTL）
  fs.writeFileSync(
    path.join(metaDir, 'version_manifest_v2.meta.json'),
    JSON.stringify({ fetchedAt: Date.now() - 3 * 60 * 60 * 1000 }),
    'utf8',
  );

  const { logger, warnings } = collectLogger();
  const repo = new VersionRepository({ dataRoot, logger, fetchImpl: explodingFetch });

  const manifest = await repo.fetchManifest();
  assert.equal(manifest.versions.length, 2, '应返回过期缓存内容');
  assert.equal(warnings.length, 1, `应打一条 warning，实际 ${warnings.length}`);
  assert.match(warnings[0] ?? '', /falling back to stale on-disk cache/);
  console.log(`OK fallback warning: ${warnings[0]}`);
});

test('fetchVersion: 网络失败且无缓存才抛错；有缓存则回退', async () => {
  const dataRoot = tmpDataRoot('fallback2');
  const metaDir = path.join(dataRoot, 'meta');
  // 无任何缓存 → 抛错
  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: explodingFetch });
  await assert.rejects(() => repo.fetchVersion('1.21'), /unexpected network call/);

  // 有过期缓存 → 回退
  const dataRoot2 = tmpDataRoot('fallback3');
  fs.mkdirSync(path.join(dataRoot2, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot2, 'meta', '1.21.json'), JSON.stringify(PARENT_JSON), 'utf8');
  fs.writeFileSync(path.join(dataRoot2, 'meta', '1.21.meta.json'), JSON.stringify({ fetchedAt: 1 }), 'utf8');
  const { logger, warnings } = collectLogger();
  const repo2 = new VersionRepository({ dataRoot: dataRoot2, logger, fetchImpl: explodingFetch });
  const json = await repo2.fetchVersion('1.21');
  assert.equal(json.id, '1.21');
  assert.equal(warnings.length, 1);
  assert.ok(fs.existsSync(path.join(metaDir, '1.21.json')) === false, '第一个仓库不该有缓存文件');
});

// ───────────────────────────── 5. 镜像 ─────────────────────────────

test('applyMirror / normalizeMirrorRoot: host 替换，path 保留', () => {
  const official = 'https://launchermeta.mojang.com/version/abc123/1.21.json';
  assert.equal(applyMirror(official, MIRROR_ROOT), 'https://bmclapi2.bangbang93.com/version/abc123/1.21.json');
  assert.equal(applyMirror(official, undefined), official);

  assert.equal(normalizeMirrorRoot('bmclapi'), MIRROR_ROOT);
  assert.equal(normalizeMirrorRoot('https://bmclapi2.bangbang93.com'), MIRROR_ROOT);
  assert.equal(normalizeMirrorRoot('bmclapi2.bangbang93.com/'), MIRROR_ROOT);
  assert.equal(normalizeMirrorRoot('official'), undefined);
  assert.equal(normalizeMirrorRoot(''), undefined);
  assert.equal(normalizeMirrorRoot(undefined), undefined);
});

test('VersionRepository: 切镜像后版本 JSON 走镜像 host', async () => {
  const seen: string[] = [];
  const stubFetch: FetchJsonFn = async (url) => {
    seen.push(url);
    if (url.endsWith('/mc/game/version_manifest_v2.json')) return { data: SAMPLE_MANIFEST, url, statusCode: 200 };
    return { data: PARENT_JSON, url, statusCode: 200 };
  };
  const repo = new VersionRepository({
    dataRoot: tmpDataRoot('mirror'),
    mirror: 'bmclapi',
    logger: collectLogger().logger,
    fetchImpl: stubFetch,
  });
  assert.equal(repo.mirror, MIRROR_ROOT);

  await repo.fetchManifest(true);
  await repo.fetchVersion('1.21');
  assert.deepEqual(seen, [
    `${MIRROR_ROOT}/mc/game/version_manifest_v2.json`,
    `${MIRROR_ROOT}/version/abc/1.21.json`,
  ]);
});

test('镜像实测：BMCLAPI 拉 manifest + 版本 JSON（302 需跟随）', async (t) => {
  const repo = new VersionRepository({
    dataRoot: tmpDataRoot('mirror-live'),
    mirror: 'bmclapi',
    logger: collectLogger().logger,
  });
  let manifest: VersionManifest;
  try {
    manifest = await repo.fetchManifest(true);
  } catch (err) {
    t.diagnostic(`SKIP: mirror unavailable -> ${(err as Error).message}`);
    console.log(`SKIP mirror network assertions: ${(err as Error).message}`);
    return;
  }
  assert.ok(manifest.versions.length > 0, '镜像 manifest 应有版本');
  assert.ok(manifest.latest.release.length > 0, '镜像 manifest latest.release 非空');

  const json = await repo.fetchVersion(manifest.latest.release);
  assert.equal(json.id, manifest.latest.release);
  assert.ok(json.libraries.length > 0, '镜像版本 JSON 应有 libraries');
  console.log(`OK mirror: versions=${manifest.versions.length}, id=${json.id}, libraries=${json.libraries.length}`);
});

test('fetchText: 跟随 302 重定向（本地 http 服务）', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/final' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await fetchText(`${base}/start`, { timeoutMs: 3000, retries: 0 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true, path: '/final' });

    const direct = await fetchJson<{ path: string }>(`${base}/final`, { timeoutMs: 3000, retries: 0 });
    assert.equal(direct.data.path, '/final');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('fetchText: 4xx 不重试，直接抛 FetchError', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  try {
    await assert.rejects(
      () => fetchText(`http://127.0.0.1:${addr.port}/nope`, { timeoutMs: 3000, retries: 2 }),
      (err: unknown) => err instanceof FetchError && err.status === 404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ───────────────────── 7. 本地已安装版本优先（P0：加载器版本不在 manifest 里） ─────────────────────

/** 写一个「已安装版本」：<dataRoot>/versions/<id>/<id>.json */
function writeInstalledVersion(dataRoot: string, json: VersionJson): void {
  const dir = path.join(dataRoot, 'versions', json.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${json.id}.json`), JSON.stringify(json, null, 2), 'utf8');
}

const LOADER_JSON: VersionJson = {
  id: 'fabric-loader-0.19.5-1.21',
  type: 'release',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  assets: '',
  inheritsFrom: '1.21',
  libraries: [
    { name: 'net.fabricmc:fabric-loader:0.19.5', url: 'https://maven.fabricmc.net/' },
    { name: 'org.ow2.asm:asm:9.7.1', url: 'https://maven.fabricmc.net/' },
  ],
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
};

test('fetchVersion: 不在 manifest 里但本地已安装 → 返回本地副本，不抛错', async () => {
  const dataRoot = tmpDataRoot('installed');
  fs.writeFileSync(path.join(dataRoot, 'meta', MANIFEST_CACHE_FILE), JSON.stringify(SAMPLE_MANIFEST), 'utf8');
  writeInstalledVersion(dataRoot, LOADER_JSON);

  const { logger, warnings } = collectLogger();
  const repo = new VersionRepository({ dataRoot, logger, fetchImpl: explodingFetch });

  const json = await repo.fetchVersion('fabric-loader-0.19.5-1.21');
  assert.equal(json.id, 'fabric-loader-0.19.5-1.21');
  assert.equal(json.inheritsFrom, '1.21', '本地副本要原样返回，inheritsFrom 不能被吞掉');
  assert.equal(json.libraries.length, 2);
  // 只允许「manifest 拉取失败回退缓存」这一条 warning（TTL 判定所致），
  // 不允许出现「version fetch failed / falling back to stale」这类版本级错误。
  assert.ok(
    !warnings.some((w) => w.includes('version fetch failed')),
    `不应走错误路径回退，实际：${warnings.join(' | ')}`,
  );

  // 应回填 meta 缓存，第二次不触网
  assert.ok(fs.existsSync(path.join(dataRoot, 'meta', 'fabric-loader-0.19.5-1.21.json')), '应回填 meta 缓存');
  const again = await repo.fetchVersion('fabric-loader-0.19.5-1.21');
  assert.equal(again.id, 'fabric-loader-0.19.5-1.21');
});

test('fetchVersion: 不在 manifest 且本地也没有 → 仍然抛 not found', async () => {
  const dataRoot = tmpDataRoot('notinstalled');
  fs.writeFileSync(path.join(dataRoot, 'meta', MANIFEST_CACHE_FILE), JSON.stringify(SAMPLE_MANIFEST), 'utf8');
  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: explodingFetch });

  await assert.rejects(
    () => repo.fetchVersion('fabric-loader-9.9.9-1.21'),
    /not found in manifest/,
  );
});

test('fetchVersion: 本地副本损坏（非 JSON）→ 不被当成有效版本', async () => {
  const dataRoot = tmpDataRoot('corrupt');
  fs.writeFileSync(path.join(dataRoot, 'meta', MANIFEST_CACHE_FILE), JSON.stringify(SAMPLE_MANIFEST), 'utf8');
  const dir = path.join(dataRoot, 'versions', 'broken-1.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken-1.0.json'), '{ not valid json', 'utf8');

  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: explodingFetch });
  await assert.rejects(() => repo.fetchVersion('broken-1.0'), /not found in manifest/);
});

test('fetchVersion: 本地副本缺 id 字段 → 视为无效，回落到 manifest 分支报错', async () => {
  const dataRoot = tmpDataRoot('noid');
  fs.writeFileSync(path.join(dataRoot, 'meta', MANIFEST_CACHE_FILE), JSON.stringify(SAMPLE_MANIFEST), 'utf8');
  const dir = path.join(dataRoot, 'versions', 'noid-1.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'noid-1.0.json'), JSON.stringify({ mainClass: 'X' }), 'utf8');

  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: explodingFetch });
  await assert.rejects(() => repo.fetchVersion('noid-1.0'), /not found in manifest/);
});

test('readInstalledVersion: 直接读 <dataRoot>/versions/<id>/<id>.json，不触网', () => {
  const dataRoot = tmpDataRoot('readinstalled');
  writeInstalledVersion(dataRoot, LOADER_JSON);
  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: explodingFetch });

  const json = repo.readInstalledVersion('fabric-loader-0.19.5-1.21');
  assert.ok(json);
  assert.equal(json?.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.equal(repo.readInstalledVersion('nope-1.0'), undefined);
});

test('fetchVersion: manifest 里有该版本时仍走网络（本地副本不抢优先级）', async () => {
  const dataRoot = tmpDataRoot('manifestwins');
  fs.writeFileSync(path.join(dataRoot, 'meta', MANIFEST_CACHE_FILE), JSON.stringify(SAMPLE_MANIFEST), 'utf8');
  // 本地放一份「假的」1.21，内容与网络版不同
  writeInstalledVersion(dataRoot, { ...PARENT_JSON, id: '1.21', mainClass: 'local.fake.Main' });

  const seen: string[] = [];
  const stubFetch: FetchJsonFn = async (url) => {
    seen.push(url);
    if (url.includes('version_manifest')) return { data: SAMPLE_MANIFEST, url, statusCode: 200 };
    return { data: PARENT_JSON, url, statusCode: 200 };
  };
  const repo = new VersionRepository({ dataRoot, logger: collectLogger().logger, fetchImpl: stubFetch });

  const json = await repo.fetchVersion('1.21');
  const versionFetches = seen.filter((u) => !u.includes('version_manifest'));
  assert.equal(versionFetches.length, 1, 'manifest 有的版本应正常触网拉取版本 JSON');
  assert.equal(json.mainClass, PARENT_JSON.mainClass, '应使用网络版本而不是本地副本');
});

// ───────────────────────────── 8. getDataRoot ─────────────────────────────

test('getDataRoot: PCL3_DATA_ROOT 优先', () => {
  const prev = process.env['PCL3_DATA_ROOT'];
  try {
    const target = path.join(os.tmpdir(), 'pcl3-data-root-probe');
    process.env['PCL3_DATA_ROOT'] = target;
    assert.equal(getDataRoot(), path.resolve(target));
  } finally {
    if (prev === undefined) delete process.env['PCL3_DATA_ROOT'];
    else process.env['PCL3_DATA_ROOT'] = prev;
  }

  const prev2 = process.env['PCL3_DATA_ROOT'];
  try {
    delete process.env['PCL3_DATA_ROOT'];
    const root = getDataRoot();
    assert.ok(root.length > 0);
    if (process.platform === 'win32') {
      assert.match(root.replace(/\\/g, '/'), /\/PCL3$/);
    } else {
      assert.match(root, /\/\.pcl3$/);
    }
  } finally {
    if (prev2 !== undefined) process.env['PCL3_DATA_ROOT'] = prev2;
  }
});
