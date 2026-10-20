/**
 * download 模块测试。
 *
 * 运行：node --import ./test/ts-resolve.mjs --test test/download.test.ts
 *
 * 覆盖：
 *   1. getDataRoot 的路径规则与目录创建
 *   2. 已就绪 → 跳过（SHA1 / size / 两者皆无三种判定）
 *   3. SHA1 不匹配 → 重下；服务器内容对不上 → failed 且不留半截文件
 *   4. 断点续传：请求带 Range，206 正确拼接；服务器忽略 Range 回 200 时回退整下
 *   5. 镜像回退与候选 URL 构造
 *   6. 重试退避、backoffDelay、parseContentRange
 *   7. 并发上限、进度节流
 *   8. 重定向跟随（BMCLAPI 302 → 第三方节点）与超限报错
 *   9. 真实网络：libraries.minecraft.net 上的 brigadier jar
 *
 * 所有断言都对齐 `src/core/download/*` 的真实签名；网络不可达时用 t.skip 明确跳过。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  Downloader,
  buildCandidates,
  DEFAULT_MAX_REDIRECTS,
  getDataRoot,
  isMirrorable,
  openRequest,
  parseContentRange,
  partPathFor,
  resetDataRootCache,
  TransportError,
} from '../src/core/download/index.js';
import { backoffDelay } from '../src/core/download/fetcher.js';
import type { DownloadProgress, DownloadTask } from '../src/core/types.js';

// ───────────────────────────── 测试工具 ─────────────────────────────

const sha1 = (buf: Buffer | string): string => createHash('sha1').update(buf).digest('hex');

const REAL_JAR_URL =
  'https://libraries.minecraft.net/com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar';
/** 本机实测值：77116 字节，SHA1 与 Mojang 官方发布物一致 */
const REAL_JAR_SHA1 = 'c1ef1234282716483c92183f49bef47b1a89bfa9';
const REAL_JAR_SIZE = 77116;

interface RequestRecord {
  url: string;
  range?: string;
}

interface FixtureServer {
  /** 根地址，形如 http://127.0.0.1:PORT */
  url: string;
  port: number;
  close: () => Promise<void>;
  /** 收到的请求记录，用于断言 Range 头与镜像路径 */
  requests: RequestRecord[];
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** 起一个本地 HTTP 服务。`routes` 是 path → handler 的映射，未命中回 404。 */
async function startServer(routes: Record<string, Handler>): Promise<FixtureServer> {
  const requests: RequestRecord[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const range = req.headers.range;
    requests.push(range ? { url, range } : { url });
    const pathname = url.split('?')[0] ?? url;
    const handler = routes[pathname] ?? routes[url];
    if (!handler) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** 一个总是返回固定内容的 handler。 */
function staticHandler(body: Buffer): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  };
}

/** 支持 Range 的 handler：按请求回 206 + Content-Range。 */
function rangeHandler(body: Buffer): Handler {
  return (req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const endText = m[2];
        const end = endText ? Number(endText) : body.length - 1;
        const chunk = body.subarray(start, end + 1);
        res.writeHead(206, {
          'content-length': String(chunk.length),
          'content-range': `bytes ${start}-${end}/${body.length}`,
        });
        res.end(chunk);
        return;
      }
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  };
}

/** 302 跳到 `location`，并把这个跳转记在 `hits` 里便于断言。 */
function redirectHandler(location: string, status = 302): Handler {
  return (_req, res) => {
    res.writeHead(status, { location, 'content-length': '0' });
    res.end();
  };
}

const dirsToClean: string[] = [];
after(async () => {
  for (const d of dirsToClean) await rm(d, { recursive: true, force: true });
});

async function makeDir(label: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), `pcl3-dl-${label}-`));
  dirsToClean.push(d);
  return d;
}

/** 收集一个 response body 的全部字节（重定向测试用）。 */
async function readAll(body: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

// ───────────────────────────── 1. getDataRoot ─────────────────────────────

describe('getDataRoot', () => {
  it('PCL3_DATA_ROOT 优先，且首次调用创建目录', async () => {
    const d = await makeDir('root');
    const target = path.join(d, 'nested', 'data');
    const prev = process.env['PCL3_DATA_ROOT'];
    process.env['PCL3_DATA_ROOT'] = target;
    resetDataRootCache();
    try {
      assert.equal(getDataRoot(), target);
      assert.ok(existsSync(target), '目录应被创建');
      // 缓存生效：再调一次拿到同一个字符串
      assert.equal(getDataRoot(), target);
    } finally {
      if (prev === undefined) delete process.env['PCL3_DATA_ROOT'];
      else process.env['PCL3_DATA_ROOT'] = prev;
      resetDataRootCache();
    }
  });

  it('未设环境变量时落在 %APPDATA%/PCL3 或 ~/.pcl3', () => {
    const prev = process.env['PCL3_DATA_ROOT'];
    delete process.env['PCL3_DATA_ROOT'];
    resetDataRootCache();
    try {
      const root = getDataRoot();
      assert.ok(root.length > 0);
      assert.ok(/PCL3$/.test(root) || /\.pcl3$/.test(root), root);
    } finally {
      if (prev !== undefined) process.env['PCL3_DATA_ROOT'] = prev;
      resetDataRootCache();
    }
  });

  it('空白值视为未设置，不回落到 cwd', () => {
    const prev = process.env['PCL3_DATA_ROOT'];
    process.env['PCL3_DATA_ROOT'] = '   ';
    resetDataRootCache();
    try {
      const root = getDataRoot();
      assert.ok(/PCL3$/.test(root) || /\.pcl3$/.test(root), root);
    } finally {
      if (prev === undefined) delete process.env['PCL3_DATA_ROOT'];
      else process.env['PCL3_DATA_ROOT'] = prev;
      resetDataRootCache();
    }
  });
});

// ───────────────────────────── 2. 跳过已就绪文件 ─────────────────────────────

describe('跳过已存在且校验通过的文件', () => {
  it('SHA1 匹配 → skipped +1、downloaded 0，且零网络请求', async () => {
    const content = Buffer.from('hello pcl3');
    const server = await startServer({ '/a.bin': staticHandler(content) });
    const dir = await makeDir('skip');
    try {
      const dest = path.join(dir, 'a.bin');
      await writeFile(dest, content);

      const dl = new Downloader({ concurrency: 2, mirrors: [] });
      const res = await dl.downloadAll([
        { url: `${server.url}/a.bin`, dest, sha1: sha1(content), size: content.length },
      ]);

      assert.equal(res.ok, true);
      assert.equal(res.skipped, 1);
      assert.equal(res.downloaded, 0);
      assert.equal(res.failed.length, 0);
      assert.equal(server.requests.length, 0, '不应发起任何请求');
    } finally {
      await server.close();
    }
  });

  it('只给 size 时按长度跳过', async () => {
    const content = Buffer.from('size-only check');
    const server = await startServer({ '/b.bin': staticHandler(content) });
    const dir = await makeDir('skip-size');
    try {
      const dest = path.join(dir, 'b.bin');
      await writeFile(dest, content);

      const dl = new Downloader({ concurrency: 1, mirrors: [] });
      const res = await dl.downloadAll([{ url: `${server.url}/b.bin`, dest, size: content.length }]);

      assert.equal(res.ok, true);
      assert.equal(res.skipped, 1);
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });

  it('既无 sha1 也无 size 时不跳过，直接重下', async () => {
    const content = Buffer.from('redownload me');
    const server = await startServer({ '/c.bin': staticHandler(content) });
    const dir = await makeDir('redl');
    try {
      const dest = path.join(dir, 'c.bin');
      await writeFile(dest, content);

      const dl = new Downloader({ concurrency: 1, mirrors: [] });
      const res = await dl.downloadAll([{ url: `${server.url}/c.bin`, dest }]);

      assert.equal(res.ok, true);
      assert.equal(res.downloaded, 1);
      assert.equal(res.skipped, 0);
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });
});

// ───────────────────────────── 3. SHA1 不匹配 ─────────────────────────────

describe('SHA1 不匹配时删除并重下', () => {
  it('目标文件内容错但长度相同 → 重下正确内容', async () => {
    const good = Buffer.from('correct-content');
    const bad = Buffer.from('incorrect-conte'); // 与 good 同长度（均为 15 字节）
    assert.equal(bad.length, good.length);
    const server = await startServer({ '/d.bin': staticHandler(good) });
    const dir = await makeDir('mismatch');
    try {
      const dest = path.join(dir, 'd.bin');
      await writeFile(dest, bad);

      const dl = new Downloader({ concurrency: 1, mirrors: [] });
      const res = await dl.downloadAll([
        { url: `${server.url}/d.bin`, dest, sha1: sha1(good), size: good.length },
      ]);

      assert.equal(res.ok, true);
      assert.equal(res.downloaded, 1);
      assert.equal(await readFile(dest, 'utf8'), good.toString());
    } finally {
      await server.close();
    }
  });

  it('服务器内容与声明的 sha1 不符 → 进 failed，目标路径与 .part 都不残留', async () => {
    const served = Buffer.from('server-served-content');
    const expected = sha1('totally-different');
    const server = await startServer({ '/e.bin': staticHandler(served) });
    const dir = await makeDir('badsha');
    try {
      const dest = path.join(dir, 'e.bin');
      const dl = new Downloader({ concurrency: 1, retries: 1, mirrors: [] });
      const res = await dl.downloadAll([{ url: `${server.url}/e.bin`, dest, sha1: expected }]);

      assert.equal(res.ok, false);
      assert.equal(res.failed.length, 1);
      assert.equal(existsSync(dest), false, '目标路径不应存在');
      assert.equal(existsSync(partPathFor(dest)), false, '.part 应被清理');
    } finally {
      await server.close();
    }
  });
});

// ───────────────────────────── 4. 断点续传 ─────────────────────────────

describe('断点续传（Range / 206）', () => {
  it('已有部分 .part → 请求带 bytes=N-，返回 206 后正确拼接', async () => {
    const content = Buffer.from('0123456789abcdefghij'); // 20 字节
    const prefix = content.subarray(0, 8);
    const server = await startServer({ '/f.bin': rangeHandler(content) });
    const dir = await makeDir('resume');
    try {
      const dest = path.join(dir, 'f.bin');
      await writeFile(partPathFor(dest), prefix);

      const dl = new Downloader({ concurrency: 1, mirrors: [] });
      const res = await dl.downloadAll([
        { url: `${server.url}/f.bin`, dest, sha1: sha1(content), size: content.length },
      ]);

      assert.equal(res.ok, true);
      assert.equal(res.downloaded, 1);
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0]?.range, 'bytes=8-', '应从断点续传');
      assert.equal(await readFile(dest, 'utf8'), content.toString());
    } finally {
      await server.close();
    }
  });

  it('服务器忽略 Range 回 200 → 回退整下，结果仍正确', async () => {
    const content = Buffer.from('abcdefghijklmnop');
    const server = await startServer({ '/g.bin': staticHandler(content) });
    const dir = await makeDir('range200');
    try {
      const dest = path.join(dir, 'g.bin');
      await writeFile(partPathFor(dest), content.subarray(0, 5));

      const dl = new Downloader({ concurrency: 1, mirrors: [] });
      const res = await dl.downloadAll([{ url: `${server.url}/g.bin`, dest, sha1: sha1(content) }]);

      assert.equal(res.ok, true);
      assert.equal(await readFile(dest, 'utf8'), content.toString());
      assert.equal(server.requests[0]?.range, 'bytes=5-', '仍会先尝试续传');
    } finally {
      await server.close();
    }
  });

  it('.part 已完整且校验通过 → 零网络直接落地', async () => {
    const content = Buffer.from('already-complete');
    const server = await startServer({ '/h.bin': staticHandler(content) });
    const dir = await makeDir('partfull');
    try {
      const dest = path.join(dir, 'h.bin');
      await writeFile(partPathFor(dest), content);

      const dl = new Downloader({ concurrency: 1, mirrors: [] });
      const res = await dl.downloadAll([
        { url: `${server.url}/h.bin`, dest, sha1: sha1(content), size: content.length },
      ]);

      assert.equal(res.ok, true);
      assert.equal(server.requests.length, 0);
      assert.equal(await readFile(dest, 'utf8'), content.toString());
      assert.equal(existsSync(partPathFor(dest)), false, '.part 应已 rename 掉');
    } finally {
      await server.close();
    }
  });
});

// ───────────────────────────── 5. 镜像回退 ─────────────────────────────

describe('镜像前缀回退', () => {
  it('主 URL 必定失败，可用镜像前缀接管下载', async () => {
    const content = Buffer.from('mirror-fallback-body');
    const server = await startServer({ '/real.bin': staticHandler(content) });
    const dir = await makeDir('mirror');
    try {
      const dest = path.join(dir, 'm.bin');
      const dl = new Downloader({
        concurrency: 1,
        retries: 1,
        mirrors: [server.url],
        mirrorPolicy: 'always',
      });
      const res = await dl.downloadAll([
        { url: 'http://127.0.0.1:1/real.bin', dest, sha1: sha1(content) },
      ]);

      assert.equal(res.ok, true);
      assert.equal(res.downloaded, 1);
      assert.equal(await readFile(dest, 'utf8'), content.toString());
    } finally {
      await server.close();
    }
  });

  it('libraries 路径经 BMCLAPI 风格镜像：mirror + 原 path', async () => {
    const content = Buffer.from('lib-jar');
    const server = await startServer({ '/com/example/a/1.0/a-1.0.jar': staticHandler(content) });
    const dir = await makeDir('mirror-path');
    try {
      const dest = path.join(dir, 'a.jar');
      const dl = new Downloader({ concurrency: 1, retries: 1, mirrors: [server.url] });
      const res = await dl.downloadAll([
        {
          url: 'https://libraries.minecraft.net/com/example/a/1.0/a-1.0.jar',
          dest,
          sha1: sha1(content),
        },
      ]);

      assert.equal(res.ok, true);
      assert.equal(server.requests[0]?.url, '/com/example/a/1.0/a-1.0.jar');
    } finally {
      await server.close();
    }
  });

  it('isMirrorable 只认白名单域（含子域，按标签边界）', () => {
    assert.equal(isMirrorable('https://libraries.minecraft.net/x.jar'), true);
    assert.equal(isMirrorable('https://resources.download.minecraft.net/ab/abcd'), true);
    assert.equal(isMirrorable('https://piston-data.mojang.com/v1/objects/ab/abcd'), true);
    assert.equal(isMirrorable('https://example.com/whatever.jar'), false);
    // 标签边界：伪造域名不算子域
    assert.equal(isMirrorable('https://libraries.minecraft.net.evil.com/x.jar'), false);
    assert.equal(isMirrorable('not a url'), false);
  });

  it('buildCandidates：原 URL 恒为第 0 个，resources 映射 /assets，去尾部斜杠', () => {
    const origin = 'https://resources.download.minecraft.net/ab/abcdef';
    const cands = buildCandidates(origin, ['https://mirror.example/'], 'whitelist');

    assert.equal(cands.length, 2);
    assert.equal(cands[0], origin);
    assert.equal(cands[1], 'https://mirror.example/assets/ab/abcdef');
  });

  it('buildCandidates：libraries 不额外加前缀，query 原样保留', () => {
    const cands = buildCandidates(
      'https://libraries.minecraft.net/com/x/y.jar?a=1&b=2',
      ['https://bmclapi2.bangbang93.com'],
      'whitelist',
    );
    assert.deepEqual(cands, [
      'https://libraries.minecraft.net/com/x/y.jar?a=1&b=2',
      'https://bmclapi2.bangbang93.com/com/x/y.jar?a=1&b=2',
    ]);
  });

  it('buildCandidates：policy 三档行为', () => {
    const third = 'https://example.com/x.jar';
    assert.deepEqual(buildCandidates(third, ['https://m.example'], 'whitelist'), [third]);
    assert.equal(buildCandidates(third, ['https://m.example'], 'always').length, 2);
    const official = 'https://libraries.minecraft.net/x.jar';
    assert.deepEqual(buildCandidates(official, ['https://m.example'], 'never'), [official]);
    // 没有镜像时永远只有原 URL
    assert.deepEqual(buildCandidates(official, [], 'always'), [official]);
  });
});

// ───────────────────────────── 6. 重试与退避 ─────────────────────────────

describe('重试与指数退避', () => {
  it('前两次 500、第三次成功 → 最终成功', async () => {
    const content = Buffer.from('retry-body');
    let count = 0;
    const server = await startServer({
      '/i.bin': (_req, res) => {
        count += 1;
        if (count < 3) {
          res.writeHead(500, { 'content-length': '4' });
          res.end('boom');
          return;
        }
        res.writeHead(200, { 'content-length': String(content.length) });
        res.end(content);
      },
    });
    const dir = await makeDir('retry');
    try {
      const dest = path.join(dir, 'i.bin');
      const dl = new Downloader({
        concurrency: 1,
        retries: 3,
        mirrors: [],
        backoffBaseMs: 1,
        backoffMaxMs: 4,
      });
      const res = await dl.downloadAll([{ url: `${server.url}/i.bin`, dest, sha1: sha1(content) }]);

      assert.equal(res.ok, true);
      assert.equal(count, 3);
      assert.equal(await readFile(dest, 'utf8'), content.toString());
    } finally {
      await server.close();
    }
  });

  it('backoffDelay 指数增长、有抖动、有上限（4 个参数）', () => {
    // random() 固定 0.5 → 抖动为 0，正好等于理论指数值
    const mid = (): number => 0.5;
    assert.equal(backoffDelay(0, 500, 8_000, mid), 500);
    assert.equal(backoffDelay(1, 500, 8_000, mid), 1_000);
    assert.equal(backoffDelay(2, 500, 8_000, mid), 2_000);
    // 封顶
    assert.equal(backoffDelay(20, 500, 8_000, mid), 8_000);

    // 抖动范围：±25%
    const lo = backoffDelay(2, 500, 8_000, () => 0); // 2000 * 0.75
    const hi = backoffDelay(2, 500, 8_000, () => 1); // 2000 * 1.25
    assert.equal(lo, 1_500);
    assert.equal(hi, 2_500);
    assert.ok(lo < hi);
  });

  it('parseContentRange 解析 206 头，非法输入返回 undefined', () => {
    assert.deepEqual(parseContentRange('bytes 100-199/500'), { start: 100, end: 199, total: 500 });
    // total 是**可选字段**：`*` / `/` 后缺失时值为 `undefined`，
    // 但对象上仍会带上 `total` 这个键，所以用逐字段断言而不是 deepEqual。
    const star = parseContentRange('bytes 100-199/*');
    assert.equal(star?.start, 100);
    assert.equal(star?.end, 199);
    assert.equal(star?.total, undefined);

    assert.equal(parseContentRange(undefined), undefined);
    assert.equal(parseContentRange(''), undefined);
    assert.equal(parseContentRange('garbage'), undefined);
    assert.equal(parseContentRange('bytes abc-def/500'), undefined);
    assert.equal(parseContentRange('bytes 100-199'), undefined);
  });
});

// ───────────────────────────── 7. 并发与进度 ─────────────────────────────

describe('并发与进度回调', () => {
  it('并发度不超过构造参数，且确实并行', async () => {
    const content = Buffer.from('concurrency');
    let active = 0;
    let peak = 0;
    const routes: Record<string, Handler> = {};
    for (let i = 0; i < 6; i++) {
      routes[`/c${i}.bin`] = (_req, res) => {
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
          res.writeHead(200, { 'content-length': String(content.length) });
          res.end(content);
        }, 30);
      };
    }
    const server = await startServer(routes);
    const dir = await makeDir('conc');
    try {
      const tasks: DownloadTask[] = [];
      for (let i = 0; i < 6; i++) {
        tasks.push({
          url: `${server.url}/c${i}.bin`,
          dest: path.join(dir, `c${i}.bin`),
          sha1: sha1(content),
        });
      }
      const dl = new Downloader({ concurrency: 3, mirrors: [] });
      const res = await dl.downloadAll(tasks);

      assert.equal(res.ok, true);
      assert.equal(res.downloaded, 6);
      assert.ok(peak <= 3, `峰值并发 ${peak} 超过 3`);
      assert.ok(peak >= 2, `峰值并发 ${peak} 没有真正并行`);
    } finally {
      await server.close();
    }
  });

  it('进度回调被节流；done/total 是任务计数，bytesDone/bytesTotal 是字节数', async () => {
    // 任务本身带 size 时 bytesTotal 才有值（见 Downloader.downloadAll），
    // 同时给 40 个大 chunk，让「按 2% 增量」的节流真正有机会触发。
    const chunk = Buffer.alloc(4096, 0x61);
    const parts = 40;
    const totalBytes = chunk.length * parts;
    const server = await startServer({
      '/p.bin': (_req, res) => {
        res.writeHead(200, { 'content-length': String(totalBytes) });
        let n = 0;
        const tick = (): void => {
          if (n < parts) {
            n += 1;
            res.write(chunk);
            setTimeout(tick, 5);
          } else {
            res.end();
          }
        };
        tick();
      },
    });
    const dir = await makeDir('progress');
    try {
      const dest = path.join(dir, 'p.bin');
      const events: DownloadProgress[] = [];
      const dl = new Downloader({ concurrency: 1, mirrors: [] });
      const res = await dl.downloadAll([{ url: `${server.url}/p.bin`, dest, size: totalBytes }], (p) => {
        events.push({ ...p });
      });

      assert.equal(res.ok, true);
      assert.ok(events.length > 0, '至少要有一次进度');
      assert.ok(events.length < parts, `回调应被节流，实际 ${events.length} 次`);

      // 首事件不节流，调用方一定能拿到 total
      assert.equal(events[0]?.total, 1);
      assert.equal(events[0]?.done, 0);

      const last = events[events.length - 1];
      assert.ok(last);
      assert.equal(last.done, 1);
      assert.equal(last.total, 1);
      assert.equal(last.bytesTotal, totalBytes);
      assert.equal(last.bytesDone, totalBytes, 'bytesDone 应收敛到 totalBytes');
    } finally {
      await server.close();
    }
  });
});

// ───────────────────────────── 8. 重定向 ─────────────────────────────

describe('重定向跟随', () => {
  it('302 → 302 → 200：最终拿到内容（相对 Location 也能解析）', async () => {
    const content = Buffer.from('redirected-payload');
    // 第一跳用相对路径，第二跳用绝对路径 —— 两种 Location 写法都覆盖。
    // 绝对路径那跳需要本服务器自己的地址，listener 起来之后才能填，故用可变变量。
    const self: { url: string } = { url: '' };
    const srv = await startServer({
      '/start.bin': redirectHandler('/mid.bin'),
      '/mid.bin': (_req, res) => {
        res.writeHead(302, { location: `${self.url}/final.bin`, 'content-length': '0' });
        res.end();
      },
      '/final.bin': staticHandler(content),
    });
    self.url = srv.url;
    try {
      const res = await openRequest(`${srv.url}/start.bin`, {});
      assert.equal(res.status, 200);
      assert.equal(res.redirects, 2);
      assert.equal(res.url, `${srv.url}/final.bin`);
      const body = await readAll(res.body);
      assert.equal(body.toString(), content.toString());
      assert.equal(srv.requests.length, 3, '应发出 3 次请求');
    } finally {
      await srv.close();
    }
  });

  it('Downloader 端到端：镜像 302 到另一台服务器仍能落地', async () => {
    const content = Buffer.from('via-redirect');
    const target = await startServer({ '/blob': staticHandler(content) });
    const front = await startServer({
      '/assets/ab/abcdef': redirectHandler(`${target.url}/blob`),
    });
    const dir = await makeDir('redir-dl');
    try {
      const dest = path.join(dir, 'asset.bin');
      const dl = new Downloader({ concurrency: 1, retries: 1, mirrors: [front.url] });
      const res = await dl.downloadAll([
        {
          url: 'https://resources.download.minecraft.net/ab/abcdef',
          dest,
          sha1: sha1(content),
          size: content.length,
        },
      ]);

      assert.equal(res.ok, true);
      assert.equal(res.downloaded, 1);
      assert.equal(await readFile(dest, 'utf8'), content.toString());
      // 镜像请求走的是 /assets 前缀
      assert.equal(front.requests[0]?.url, '/assets/ab/abcdef');
    } finally {
      await front.close();
      await target.close();
    }
  });

  it('重定向后保留 Range 头', async () => {
    const content = Buffer.from('0123456789abcdefghij');
    let seenRange: string | undefined;
    const target = await startServer({
      '/final': (req, res) => {
        seenRange = req.headers.range;
        rangeHandler(content)(req, res);
      },
    });
    const front = await startServer({ '/start': redirectHandler(`${target.url}/final`) });
    try {
      const res = await openRequest(`${front.url}/start`, { Range: 'bytes=10-' });
      assert.equal(res.status, 206);
      assert.equal(seenRange, 'bytes=10-', 'Range 必须跟到最终一跳');
      const body = await readAll(res.body);
      assert.equal(body.toString(), content.subarray(10).toString());
    } finally {
      await front.close();
      await target.close();
    }
  });

  it('超过跳数上限 → TransportError(TOO_MANY_REDIRECTS)', async () => {
    let hits = 0;
    const server = await startServer({
      // 无限自我循环，永远到不了终点
      '/loop': (_req, res) => {
        hits += 1;
        res.writeHead(302, { location: '/loop', 'content-length': '0' });
        res.end();
      },
    });
    try {
      await assert.rejects(
        () => openRequest(`${server.url}/loop`, {}, { maxRedirects: 5 }),
        (err: unknown) => {
          assert.ok(err instanceof TransportError);
          assert.equal(err.code, 'TOO_MANY_REDIRECTS');
          assert.match(err.message, /too many redirects/);
          return true;
        },
      );
      // 首次请求 + 5 跳 = 6 次；第 6 次不再跟随
      assert.equal(hits, 6, `实际发出 ${hits} 次请求`);
      assert.equal(DEFAULT_MAX_REDIRECTS, 5);
    } finally {
      await server.close();
    }
  });

  it('maxRedirects: 0 时任何 3xx 都直接报 TOO_MANY_REDIRECTS（不做跟随）', async () => {
    const server = await startServer({
      '/r': redirectHandler('/nowhere'),
    });
    try {
      await assert.rejects(
        () => openRequest(`${server.url}/r`, {}, { maxRedirects: 0 }),
        (err: unknown) => {
          assert.ok(err instanceof TransportError);
          assert.equal(err.code, 'TOO_MANY_REDIRECTS');
          return true;
        },
      );
      assert.equal(server.requests.length, 1, '只应发出原始那一次请求');
    } finally {
      await server.close();
    }
  });

  it('TOO_MANY_REDIRECTS 在 Downloader 层被折算成 failed（而不是静默成功）', async () => {
    const server = await startServer({
      '/loop': (_req, res) => {
        res.writeHead(302, { location: '/loop', 'content-length': '0' });
        res.end();
      },
    });
    const dir = await makeDir('redir-fail');
    try {
      const dest = path.join(dir, 'z.bin');
      const dl = new Downloader({ concurrency: 1, retries: 1, mirrors: [], maxRedirects: 2 });
      const res = await dl.downloadAll([{ url: `${server.url}/loop`, dest }]);
      assert.equal(res.ok, false);
      assert.equal(res.failed.length, 1);
      assert.equal(existsSync(dest), false);
    } finally {
      await server.close();
    }
  });

  it('301 / 303 / 307 / 308 同样跟随', async () => {
    const content = Buffer.from('any-3xx');
    for (const status of [301, 303, 307, 308]) {
      const target = await startServer({ '/t': staticHandler(content) });
      const front = await startServer({ '/s': redirectHandler(`${target.url}/t`, status) });
      try {
        const res = await openRequest(`${front.url}/s`, {});
        assert.equal(res.status, 200, `status ${status} 应被跟随`);
        assert.equal(res.redirects, 1);
        const body = await readAll(res.body);
        assert.equal(body.toString(), content.toString());
      } finally {
        await front.close();
        await target.close();
      }
    }
  });
});

// ───────────────────────────── 9. 真实网络 ─────────────────────────────

describe('真实网络下载（libraries.minecraft.net）', () => {
  it('下载 brigadier-1.0.18.jar，断言字节数 / SHA1 / zip 魔数，第二遍 skipped', async (t) => {
    const dir = await makeDir('real');
    const dest = path.join(dir, 'brigadier-1.0.18.jar');

    const dl = new Downloader({ concurrency: 1, retries: 2, mirrors: [] });
    let res;
    try {
      res = await dl.downloadAll([{ url: REAL_JAR_URL, dest, sha1: REAL_JAR_SHA1 }]);
    } catch (e) {
      t.skip(`网络不可达：${(e as Error).message}`);
      return;
    }
    if (!res.ok) {
      t.skip(`网络不可达（failed=${res.failed.length}）`);
      return;
    }

    assert.equal(res.downloaded, 1);
    const buf = await readFile(dest);
    assert.equal(buf.length, REAL_JAR_SIZE);
    assert.equal(sha1(buf), REAL_JAR_SHA1);
    assert.equal(buf.subarray(0, 2).toString('hex'), '504b', 'zip 魔数');

    // 第二遍应命中 skipped，零网络
    const again = await dl.downloadAll([{ url: REAL_JAR_URL, dest, sha1: REAL_JAR_SHA1 }]);
    assert.equal(again.skipped, 1);
    assert.equal(again.downloaded, 0);
  });
});

// ───────────────────────────── 10. 工具函数 ─────────────────────────────

describe('工具函数', () => {
  it('partPathFor 是同目录下的隐藏 .part：<dir>/.<basename>.part', () => {
    const dir = path.join(os.tmpdir(), 'pcl3-part-shape');
    const p = partPathFor(path.join(dir, 'file.jar'));
    assert.equal(path.dirname(p), dir);
    assert.equal(path.basename(p), '.file.jar.part');
  });
});
