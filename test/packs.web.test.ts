/**
 * web 层：资源包 / 数据包 / 光影包 API 测试（真起 HTTP 服务，真落盘，不联网）。
 *
 * 为什么不用 fake PackManager：`server.ts` 的 WebServerOptions 没有 packManagerFactory
 * （那个文件我只加了一处上传放行），硬塞 fake 要动别人的接口。
 * 用真实现反而更强：断言的是「文件真的在 resourcepacks/ 下」而不是「fake 收到了什么参数」。
 *
 * 覆盖（与派单要求一一对应）：
 *   1. GET 列表：元数据 / 目录 / kind 校验 400
 *   2. 数据包 save 参数 → saves/<存档>/datapacks/，并附带存档列表
 *   3. GET /saves 只认含 level.dat 的目录
 *   4. 路径穿越：instanceId / save / filename（../、..\、绝对路径、盘符）全部被拒
 *   5. URL 安装：202 + jobId → 后台 → 任务 done / failed
 *   6. 上传：multipart 与直接二进制两种 body，非法文件名被清洗
 *   7. toggle / DELETE：落盘改名、删除、幂等
 *   8. multipart 解析：文件段末尾 CRLF 必须被裁掉（否则 zip 尾多两字节）
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createServer, type WebServerHandle } from '../src/web/server.js';
import { parseMultipart } from '../src/web/api.js';

import { resourcePackZip, dataPackZip, shaderPackZip } from './packs.zip-fixtures.js';
import { cleanupTempDirs, makeTempDir, removeTempDir } from './packs.temp.js';

after(() => {
  cleanupTempDirs();
});

// ───────────────────────────── 夹具 ─────────────────────────────

function tmpRoot(tag: string): string {
  return makeTempDir(`packsweb-${tag}`);
}

const FAKE_MANIFEST = {
  latest: { release: '1.21', snapshot: '24w45a' },
  versions: [
    { id: '1.21', type: 'release' as const, url: 'u', time: 't', releaseTime: '2024-06-13T00:00:00+00:00' },
  ],
};

async function startServer(tag: string): Promise<{ handle: WebServerHandle; root: string }> {
  const root = tmpRoot(tag);
  const handle = await createServer({
    port: 0,
    dataRoot: root,
    versionRepo: {
      fetchManifest: async () => FAKE_MANIFEST,
      fetchVersion: async () => {
        throw new Error('测试不下载版本');
      },
      resolveInherited: async (json: never) => json,
    },
  });
  return { handle, root };
}

/** 实例目录（真实落盘断言的基准） */
function instanceDir(root: string): string {
  return path.join(root, 'instances', '1.21');
}

function dirOf(root: string, kind: 'resourcepack' | 'datapack' | 'shader', saveName?: string): string {
  const base = kind === 'resourcepack' ? 'resourcepacks' : kind === 'shader' ? 'shaderpacks' : 'datapacks';
  return saveName === undefined
    ? path.join(instanceDir(root), base)
    : path.join(instanceDir(root), 'saves', saveName, base);
}

/** 预置一个已安装的包（模拟「以前装过」） */
function seedPack(
  root: string,
  kind: 'resourcepack' | 'datapack' | 'shader',
  diskName: string,
  data: Buffer,
  saveName?: string,
): string {
  const dir = dirOf(root, kind, saveName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, diskName);
  fs.writeFileSync(file, data);
  return file;
}

/** 造一个有效存档（有 level.dat 才算） */
function seedSave(root: string, name: string): void {
  const dir = path.join(instanceDir(root), 'saves', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), Buffer.from([0x0a, 0x00, 0x00]));
}

interface JsonResponse {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

async function request(url: string, init: RequestInit = {}): Promise<JsonResponse> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
  }
  return { status: res.status, json, text };
}

function jsonPost(url: string, body: unknown): Promise<JsonResponse> {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 轮询任务直到不是 running */
async function waitJob(base: string, jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8000;
  let snap: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    snap = (await request(`${base}api/jobs/${jobId}`)).json;
    if (snap['status'] !== 'running') return snap;
    await new Promise((r) => setTimeout(r, 20));
  }
  return snap;
}

// ───────────────────────────── 1. 列表 ─────────────────────────────

test('GET /packs: 返回元数据与目录，kind 缺失 / 不认识 → 400', async () => {
  const { handle, root } = await startServer('list');
  try {
    seedPack(root, 'resourcepack', '更好的树叶.zip', resourcePackZip());
    seedPack(root, 'resourcepack', '高清材质.zip.disabled', resourcePackZip());

    const res = await request(`${handle.url}api/instances/1.21/packs?kind=resourcepack`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json['kind'], 'resourcepack');
    assert.equal(res.json['kindLabel'], '资源包');
    assert.equal(res.json['total'], 2);
    assert.ok(String(res.json['dir']).endsWith(path.join('instances', '1.21', 'resourcepacks')));

    const list = res.json['packs'] as Record<string, unknown>[];
    const byName = new Map(list.map((p) => [String(p['filename']), p]));
    assert.equal(byName.get('更好的树叶.zip')?.['enabled'], true);
    assert.equal(byName.get('高清材质.zip')?.['enabled'], false, '.disabled 必须被识别成禁用');
    assert.equal(byName.get('高清材质.zip')?.['packFormat'], 15);

    const missing = await request(`${handle.url}api/instances/1.21/packs`);
    assert.equal(missing.status, 400);
    assert.match(String(missing.json['error']), /kind/);

    const bad = await request(`${handle.url}api/instances/1.21/packs?kind=mod`);
    assert.equal(bad.status, 400);
    assert.match(String(bad.json['error']), /resourcepack/);
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('GET /packs?kind=datapack&save=：落到 saves/<存档>/datapacks/，并附带存档列表', async () => {
  const { handle, root } = await startServer('datapack');
  try {
    seedSave(root, '新的世界');
    seedPack(root, 'datapack', '全局包.zip', dataPackZip());
    seedPack(root, 'datapack', '存档包.zip', dataPackZip(), '新的世界');

    const global = await request(`${handle.url}api/instances/1.21/packs?kind=datapack`);
    assert.equal(global.status, 200, global.text);
    assert.equal(global.json['saveName'], null);
    assert.deepEqual(
      (global.json['packs'] as { filename: string }[]).map((p) => p.filename),
      ['全局包.zip'],
    );
    assert.ok(String(global.json['dir']).endsWith(path.join('1.21', 'datapacks')));

    const saved = await request(
      `${handle.url}api/instances/1.21/packs?kind=datapack&save=${encodeURIComponent('新的世界')}`,
    );
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json['saveName'], '新的世界');
    assert.deepEqual(
      (saved.json['packs'] as { filename: string }[]).map((p) => p.filename),
      ['存档包.zip'],
    );
    assert.match(String(saved.json['dir']), /saves[\\/]新的世界[\\/]datapacks$/);
    assert.equal((saved.json['saves'] as unknown[]).length, 1, '数据包列表要带存档让前端选');
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('GET /saves: 只认含 level.dat 的目录', async () => {
  const { handle, root } = await startServer('saves');
  try {
    seedSave(root, '创造');
    seedSave(root, '生存');
    fs.mkdirSync(path.join(instanceDir(root), 'saves', '半成品'), { recursive: true });
    fs.writeFileSync(path.join(instanceDir(root), 'saves', 'desktop.ini'), '');

    const res = await request(`${handle.url}api/instances/1.21/saves`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json['total'], 2);
    const names = (res.json['saves'] as { name: string }[]).map((s) => s.name).sort();
    assert.deepEqual(names, ['创造', '生存'].sort());
    assert.ok(String(res.json['dir']).endsWith(path.join('instances', '1.21', 'saves')));
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

// ───────────────────────────── 2. 路径穿越 ─────────────────────────────

test('路径穿越: instanceId / save 里的 ../ 一律被拒', async () => {
  const { handle, root } = await startServer('traversal');
  try {
    for (const bad of ['%2e%2e', 'a%2Fb', 'a%5Cb', '..']) {
      const res = await request(`${handle.url}api/instances/${bad}/packs?kind=resourcepack`);
      assert.ok(res.status === 400 || res.status === 404, `${bad} 必须被拒（实际 ${res.status}）`);
      assert.equal(typeof res.json['error'], 'string');
    }

    const saveTraversal = await request(
      `${handle.url}api/instances/1.21/packs?kind=datapack&save=${encodeURIComponent('../..')}`,
    );
    assert.equal(saveTraversal.status, 400);
    assert.match(String(saveTraversal.json['error']), /存档名/);

    // 什么也没被写到实例目录之外
    assert.equal(fs.existsSync(path.join(root, 'resourcepacks')), false);
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('路径穿越: filename 含分隔符 / .. / 盘符 → 400，且磁盘上没有任何变化', async () => {
  const { handle, root } = await startServer('filename-traversal');
  try {
    seedPack(root, 'resourcepack', 'ok.zip', resourcePackZip());

    for (const bad of ['..%2Fevil.zip', '..%5Cevil.zip', '%2e%2e%2fevil.zip', encodeURIComponent('C:\\Windows\\evil.zip')]) {
      const toggle = await jsonPost(`${handle.url}api/instances/1.21/packs/${bad}/toggle`, {
        kind: 'resourcepack',
        enabled: false,
      });
      assert.ok(toggle.status === 400 || toggle.status === 404, `toggle ${bad} 必须被拒（实际 ${toggle.status}）`);

      const del = await request(`${handle.url}api/instances/1.21/packs/${bad}?kind=resourcepack`, { method: 'DELETE' });
      assert.ok(del.status === 400 || del.status === 404, `delete ${bad} 必须被拒（实际 ${del.status}）`);
    }

    // 原有的包还在，外面没多出文件
    assert.deepEqual(fs.readdirSync(dirOf(root, 'resourcepack')).sort(), ['ok.zip']);
    assert.equal(fs.existsSync(path.join(root, 'evil.zip')), false);
    assert.equal(fs.existsSync(path.join(instanceDir(root), 'evil.zip')), false);
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

// ───────────────────────────── 3. URL 安装 ─────────────────────────────

test('POST /packs/install: 缺 url / kind 错 / 非 .zip / 文件名带路径 → 400', async () => {
  const { handle, root } = await startServer('install-bad');
  try {
    const noUrl = await jsonPost(`${handle.url}api/instances/1.21/packs/install`, {
      kind: 'resourcepack',
      filename: 'a.zip',
    });
    assert.equal(noUrl.status, 400);
    assert.match(String(noUrl.json['error']), /url/);

    const badKind = await jsonPost(`${handle.url}api/instances/1.21/packs/install`, {
      kind: 'mod',
      url: 'https://example.invalid/a.zip',
      filename: 'a.zip',
    });
    assert.equal(badKind.status, 400);
    assert.match(String(badKind.json['error']), /resourcepack/);

    const badExt = await jsonPost(`${handle.url}api/instances/1.21/packs/install`, {
      kind: 'resourcepack',
      url: 'https://example.invalid/a.jar',
      filename: 'a.jar',
    });
    assert.equal(badExt.status, 400);
    assert.match(String(badExt.json['error']), /\.zip/);

    const badName = await jsonPost(`${handle.url}api/instances/1.21/packs/install`, {
      kind: 'resourcepack',
      url: 'https://example.invalid/a.zip',
      filename: '../evil.zip',
    });
    assert.equal(badName.status, 400);
    assert.match(String(badName.json['error']), /文件名/);
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('POST /packs/install: 202 + jobId，后台失败时任务为 failed 且错误是人话', async () => {
  const { handle, root } = await startServer('install-fail');
  try {
    // example.invalid 是保留域名，DNS 必然失败（不联网也不依赖外部状态）
    const res = await jsonPost(`${handle.url}api/instances/1.21/packs/install`, {
      kind: 'resourcepack',
      url: 'https://example.invalid/a.zip',
      filename: 'a.zip',
    });
    assert.equal(res.status, 202, res.text);
    const jobId = String(res.json['jobId']);
    assert.ok(jobId.length > 0);

    const snap = await waitJob(handle.url, jobId);
    assert.equal(snap['kind'], 'packs');
    assert.equal(snap['status'], 'failed', JSON.stringify(snap));
    assert.match(String(snap['error']), /安装资源包失败/);

    // 失败不能留下半个文件
    const dir = dirOf(root, 'resourcepack');
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

// ───────────────────────────── 4. 上传 ─────────────────────────────

test('POST /packs/upload: multipart 上传 → 201，字节与文件名都正确落盘', async () => {
  const { handle, root } = await startServer('upload');
  try {
    const zip = resourcePackZip();
    const form = new FormData();
    form.append('kind', 'resourcepack');
    form.append('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), '更好的树叶.zip');

    const res = await request(`${handle.url}api/instances/1.21/packs/upload`, { method: 'POST', body: form });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json['filename'], '更好的树叶.zip');
    assert.equal(res.json['kind'], 'resourcepack');
    assert.equal(res.json['size'], zip.byteLength);
    assert.equal(res.json['warning'], null);

    const onDisk = path.join(dirOf(root, 'resourcepack'), '更好的树叶.zip');
    assert.ok(fs.existsSync(onDisk), '必须真的写进 resourcepacks/');
    assert.ok(fs.readFileSync(onDisk).equals(zip), '内容必须逐字节一致');

    const listed = await request(`${handle.url}api/instances/1.21/packs?kind=resourcepack`);
    const first = (listed.json['packs'] as Record<string, unknown>[])[0];
    assert.equal(first?.['filename'], '更好的树叶.zip');
    assert.equal(first?.['packFormat'], 15, '上传后立刻能读出 mcmeta');
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('POST /packs/upload: 直接二进制 body + query 参数 → 201', async () => {
  const { handle, root } = await startServer('upload-raw');
  try {
    const zip = shaderPackZip();
    const url = `${handle.url}api/instances/1.21/packs/upload?kind=shader&filename=${encodeURIComponent('光影.zip')}`;
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(zip),
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json['filename'], '光影.zip');
    assert.equal((res.json['pack'] as Record<string, unknown>)['hasShaders'], true);
    assert.ok(fs.existsSync(path.join(dirOf(root, 'shader'), '光影.zip')));
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('POST /packs/upload: 数据包带存档 → 只进 saves/<存档>/datapacks/', async () => {
  const { handle, root } = await startServer('upload-save');
  try {
    seedSave(root, '新的世界');
    const res = await request(
      `${handle.url}api/instances/1.21/packs/upload?kind=datapack&saveName=${encodeURIComponent('新的世界')}&filename=专用.zip`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(dataPackZip()),
      },
    );
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json['saveName'], '新的世界');
    assert.ok(fs.existsSync(path.join(dirOf(root, 'datapack', '新的世界'), '专用.zip')));
    assert.equal(fs.existsSync(path.join(dirOf(root, 'datapack'), '专用.zip')), false, '不能同时落进全局目录');
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('POST /packs/upload: 流氓文件名被清洗而不是 500；空 body → 400；kind 非法 → 400', async () => {
  const { handle, root } = await startServer('upload-name');
  try {
    const cleaned = await request(
      `${handle.url}api/instances/1.21/packs/upload?kind=resourcepack&filename=${encodeURIComponent('../../etc/passwd')}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(dataPackZip()) },
    );
    assert.equal(cleaned.status, 201, cleaned.text);
    assert.equal(cleaned.json['filename'], 'passwd.zip');
    assert.deepEqual(fs.readdirSync(dirOf(root, 'resourcepack')), ['passwd.zip']);

    const empty = await request(`${handle.url}api/instances/1.21/packs/upload?kind=shader&filename=a.zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(0),
    });
    assert.equal(empty.status, 400);

    const badKind = await request(`${handle.url}api/instances/1.21/packs/upload?kind=mod&filename=a.zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(dataPackZip()),
    });
    assert.equal(badKind.status, 400);
    assert.match(String(badKind.json['error']), /resourcepack/);
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('上传之外的接口仍然只收 JSON（415）——放行范围没有扩大', async () => {
  const { handle, root } = await startServer('content-type');
  try {
    const res = await request(`${handle.url}api/instances/1.21/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 415, '只有 /packs/upload 被放行，其它写接口必须继续要求 JSON');
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

// ───────────────────────────── 5. toggle / delete ─────────────────────────────

test('POST /packs/:filename/toggle: 真的把 .zip 改名成 .zip.disabled 再改回来', async () => {
  const { handle, root } = await startServer('toggle');
  try {
    seedPack(root, 'resourcepack', '材质.zip', resourcePackZip());
    const dir = dirOf(root, 'resourcepack');

    const off = await jsonPost(`${handle.url}api/instances/1.21/packs/${encodeURIComponent('材质.zip')}/toggle`, {
      kind: 'resourcepack',
      enabled: false,
    });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json['enabled'], false);
    assert.equal(fs.existsSync(path.join(dir, '材质.zip')), false, '禁用后不能还留着 .zip');
    assert.ok(fs.existsSync(path.join(dir, '材质.zip.disabled')));

    const listed = await request(`${handle.url}api/instances/1.21/packs?kind=resourcepack`);
    const pack = (listed.json['packs'] as Record<string, unknown>[])[0];
    assert.equal(pack?.['filename'], '材质.zip');
    assert.equal(pack?.['enabled'], false);

    const on = await jsonPost(`${handle.url}api/instances/1.21/packs/${encodeURIComponent('材质.zip')}/toggle`, {
      kind: 'resourcepack',
      enabled: true,
    });
    assert.equal(on.status, 200, on.text);
    assert.ok(fs.existsSync(path.join(dir, '材质.zip')));
    assert.equal(fs.existsSync(path.join(dir, '材质.zip.disabled')), false);

    const noEnabled = await jsonPost(`${handle.url}api/instances/1.21/packs/材质.zip/toggle`, { kind: 'resourcepack' });
    assert.equal(noEnabled.status, 400);
    assert.match(String(noEnabled.json['error']), /enabled/);

    const missingFile = await jsonPost(`${handle.url}api/instances/1.21/packs/missing.zip/toggle`, {
      kind: 'resourcepack',
      enabled: true,
    });
    assert.equal(missingFile.status, 400);
    assert.match(String(missingFile.json['error']), /无法切换状态/);
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('DELETE /packs/:filename: 删除成功 200；本来就不在 → 200 removed=false；缺 kind → 400', async () => {
  const { handle, root } = await startServer('delete');
  try {
    seedPack(root, 'resourcepack', '要删的.zip', resourcePackZip());
    seedPack(root, 'resourcepack', '已禁用的.zip.disabled', resourcePackZip());

    const ok = await request(
      `${handle.url}api/instances/1.21/packs/${encodeURIComponent('要删的.zip')}?kind=resourcepack`,
      { method: 'DELETE' },
    );
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json['removed'], true);
    assert.deepEqual(fs.readdirSync(dirOf(root, 'resourcepack')), ['已禁用的.zip.disabled']);

    // 禁用态用原文件名删也可以
    const disabled = await request(
      `${handle.url}api/instances/1.21/packs/${encodeURIComponent('已禁用的.zip')}?kind=resourcepack`,
      { method: 'DELETE' },
    );
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json['removed'], true);
    assert.deepEqual(fs.readdirSync(dirOf(root, 'resourcepack')), []);

    const gone = await request(`${handle.url}api/instances/1.21/packs/gone.zip?kind=resourcepack`, { method: 'DELETE' });
    assert.equal(gone.status, 200, '幂等：不存在也回 200');
    assert.equal(gone.json['removed'], false);

    const noKind = await request(`${handle.url}api/instances/1.21/packs/a.zip`, { method: 'DELETE' });
    assert.equal(noKind.status, 400);
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

test('方法不符：PUT /packs → 405；GET /packs/install → 405（不是 404）', async () => {
  const { handle, root } = await startServer('methods');
  try {
    const put = await request(`${handle.url}api/instances/1.21/packs?kind=shader`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(put.status, 405);

    const get = await request(`${handle.url}api/instances/1.21/packs/install?kind=shader`);
    assert.equal(get.status, 405, '/packs/install 是 POST 专用，GET 应回 405 而不是把它当文件名');
  } finally {
    await handle.close();
    removeTempDir(root);
  }
});

// ───────────────────────────── 6. multipart 解析（纯函数） ─────────────────────────────

test('parseMultipart: 文件段末尾的 CRLF 被裁掉（否则 zip 尾会多两字节）', () => {
  const payload = resourcePackZip();
  const boundary = '----pcl3test';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nresourcepack\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, payload, tail]);

  const parsed = parseMultipart(body, boundary);
  assert.equal(parsed.fields['kind'], 'resourcepack');
  assert.ok(parsed.file !== undefined);
  assert.equal(parsed.file.filename, 'a.zip');
  assert.equal(parsed.file.data.byteLength, payload.byteLength, '字节数必须与原始 zip 完全一致');
  assert.ok(parsed.file.data.equals(payload), '内容必须逐字节相同（EOCD 不能被 CRLF 污染）');
});

test('parseMultipart: 没有文件段 → file 为 undefined；找不到 boundary → 抛 400', () => {
  const boundary = 'xyz';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nshader\r\n--${boundary}--\r\n`,
  );
  const parsed = parseMultipart(body, boundary);
  assert.equal(parsed.file, undefined);
  assert.equal(parsed.fields['kind'], 'shader');

  assert.throws(() => parseMultipart(Buffer.from('no boundary here'), 'zzz'), /找不到 boundary/);
});
