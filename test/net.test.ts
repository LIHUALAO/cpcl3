/**
 * net 模块（下载源测速 / 自动换源）测试。
 *
 * 全部用注入的 fake fetch：不联网、不等待、结果确定。
 * 真机延迟验证交给 `pcl3 doctor` 与本文件末尾的「真实验证」说明。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_FAILURE_THRESHOLD,
  MIRROR_DEFINITIONS,
  MirrorSelector,
  PROBE_CACHE_FILE,
  findMirror,
  mirrorLabel,
  orderedMirrorBases,
  type MirrorDefinition,
} from '../src/core/net/index.js';
import { Downloader } from '../src/core/download/index.js';
import { fallbackMirrorFromUrl } from '../src/core/download/mirror.js';
import type { DownloadResult, DownloadTask } from '../src/core/types.js';

// ───────────────────────────── 脚手架 ─────────────────────────────

const FAST: MirrorDefinition = {
  id: 'fast',
  label: '快源',
  base: 'https://fast.example',
  probeUrl: 'https://fast.example/mc/game/version_manifest_v2.json',
  note: '测试用快源',
};

const SLOW: MirrorDefinition = {
  id: 'slow',
  label: '慢源',
  base: 'https://slow.example',
  probeUrl: 'https://slow.example/mc/game/version_manifest_v2.json',
  note: '测试用慢源',
};

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-net-${tag}-`));
}

/** 一个带 body 流的最小 Response 替身（probe 会读第一块数据） */
function fakeResponse(ok: boolean, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      controller.close();
    },
  });
  return { ok, status, body } as unknown as Response;
}

interface FetchCall {
  url: string;
  at: number;
}

/**
 * 造一个 fake fetch：
 *   · 每个 URL 前 n 次「慢」→ 抛 AbortError（模拟超时）
 *   · 之后「快」→ 等待 delayMs 后返回 200
 */
function makeFetch(opts: {
  delays: Record<string, { delayMs: number; failFirst?: number }>;
  calls?: FetchCall[];
}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = opts.calls ?? [];
  const attempts = new Map<string, number>();

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, at: Date.now() });
    const config = opts.delays[url] ?? { delayMs: 5 };
    const seen = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, seen);

    if (config.failFirst !== undefined && seen <= config.failFirst) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    if (init?.signal?.aborted === true) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    return fakeResponse(true);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

// ───────────────────────────── 测速与选源 ─────────────────────────────

describe('MirrorSelector: 测速与选源', () => {
  it('一快一慢时 best() 选快的，probeAll() 按延迟升序', async () => {
    const root = tmpDir('best');
    try {
      const { fetchImpl } = makeFetch({
        delays: {
          [FAST.probeUrl]: { delayMs: 10 },
          [SLOW.probeUrl]: { delayMs: 80 },
        },
      });
      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [SLOW, FAST],
        disableDiskCache: true,
      });

      const probes = await selector.probeAll({ timeoutMs: 2_000 });
      assert.equal(probes.length, 2);
      assert.equal(probes[0]?.id, 'fast', '快的必须排在第一个');
      assert.equal(probes[1]?.id, 'slow');
      assert.ok(probes.every((p) => p.ok === true));
      assert.ok((probes[1]?.latencyMs ?? 0) > (probes[0]?.latencyMs ?? 0), '慢源延迟必须更大');

      const best = await selector.best();
      assert.equal(best.id, 'fast');
      assert.equal(best.ok, true);
      assert.equal(best.base, FAST.base);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('每个源测 2 次取最小值（第一次抖动的慢值不生效）', async () => {
    const root = tmpDir('min');
    try {
      // slow 源：第 1 次慢 120ms，第 2 次快 5ms → 取 5ms
      const calls: FetchCall[] = [];
      let seen = 0;
      const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        calls.push({ url, at: Date.now() });
        if (url === SLOW.probeUrl) {
          seen += 1;
          await new Promise((r) => setTimeout(r, seen === 1 ? 120 : 5));
        } else {
          await new Promise((r) => setTimeout(r, 100));
        }
        return fakeResponse(true);
      }) as unknown as typeof fetch;

      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [FAST, SLOW],
        disableDiskCache: true,
      });

      const probes = await selector.probeAll({ timeoutMs: 2_000 });
      const slow = probes.find((p) => p.id === 'slow');
      assert.ok(slow !== undefined);
      assert.ok((slow?.latencyMs ?? 999) < 100, `取最小值后应远小于 120ms，实际 ${String(slow?.latencyMs)}`);
      // 每个 URL 必须被测两次
      assert.equal(calls.filter((c) => c.url === SLOW.probeUrl).length, 2);
      assert.equal(calls.filter((c) => c.url === FAST.probeUrl).length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('源挂掉时标记 ok=false / latency=Infinity，且不影响另一个源', async () => {
    const root = tmpDir('fail');
    try {
      const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url === SLOW.probeUrl) throw new Error('ECONNREFUSED');
        await new Promise((r) => setTimeout(r, 5));
        return fakeResponse(true);
      }) as unknown as typeof fetch;

      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [FAST, SLOW],
        disableDiskCache: true,
      });
      const probes = await selector.probeAll({ timeoutMs: 1_000 });
      const fast = probes.find((p) => p.id === 'fast');
      const slow = probes.find((p) => p.id === 'slow');
      assert.equal(fast?.ok, true);
      assert.equal(slow?.ok, false);
      assert.equal(slow?.latencyMs, Number.POSITIVE_INFINITY);
      // best() 绝不会挑一个不可用的源
      assert.equal((await selector.best()).id, 'fast');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('HTTP 非 2xx 也算不可用（200 才算通）', async () => {
    const root = tmpDir('http');
    try {
      const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        return url === SLOW.probeUrl ? fakeResponse(false, 503) : fakeResponse(true);
      }) as unknown as typeof fetch;

      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [FAST, SLOW],
        disableDiskCache: true,
      });
      const probes = await selector.probeAll({ timeoutMs: 1_000 });
      assert.equal(probes[0]?.id, 'fast');
      assert.equal(probes[1]?.ok, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('固定源模式：best() 直接返回指定源，不发任何请求', async () => {
    const root = tmpDir('fixed');
    try {
      const calls: FetchCall[] = [];
      const { fetchImpl } = makeFetch({ delays: {}, calls });
      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [FAST, SLOW],
        preferredId: 'slow',
        disableDiskCache: true,
      });
      const best = await selector.best();
      assert.equal(best.id, 'slow');
      assert.equal(best.base, SLOW.base);
      assert.equal(calls.length, 0, '固定源不该测速');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('setPreferred 传未知源 → 抛错（不静默接受）', () => {
    const selector = new MirrorSelector({ dataRoot: os.tmpdir(), mirrors: [FAST], disableDiskCache: true });
    assert.throws(() => {
      selector.setPreferred('nope');
    }, /不认识的下载源/);
    assert.doesNotThrow(() => {
      selector.setPreferred(undefined);
    });
  });
});

// ───────────────────────────── 缓存 ─────────────────────────────

describe('MirrorSelector: 缓存', () => {
  it('第二次 best() 在 TTL 内不重新探测', async () => {
    const root = tmpDir('cache-mem');
    try {
      const calls: FetchCall[] = [];
      const { fetchImpl } = makeFetch({
        delays: { [FAST.probeUrl]: { delayMs: 5 }, [SLOW.probeUrl]: { delayMs: 40 } },
        calls,
      });
      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [FAST, SLOW],
        ttlMs: 60_000,
        disableDiskCache: true,
      });

      const first = await selector.best();
      const afterFirst = calls.length;
      assert.ok(afterFirst > 0);
      assert.equal(first.id, 'fast');

      const second = await selector.best();
      assert.equal(second.id, 'fast');
      assert.equal(calls.length, afterFirst, 'TTL 内第二次 best() 不能再发请求');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('TTL 过期后会重新探测', async () => {
    const root = tmpDir('cache-ttl');
    try {
      const calls: FetchCall[] = [];
      const { fetchImpl } = makeFetch({
        delays: { [FAST.probeUrl]: { delayMs: 5 }, [SLOW.probeUrl]: { delayMs: 20 } },
        calls,
      });
      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [FAST, SLOW],
        ttlMs: 15,
        disableDiskCache: true,
      });

      await selector.best();
      const afterFirst = calls.length;
      await new Promise((r) => setTimeout(r, 40));
      await selector.best();
      assert.ok(calls.length > afterFirst, 'TTL 过期后必须重新测速');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('测速结果落到 <dataRoot>/cache/mirror-probe.json，可被新实例复用', async () => {
    const root = tmpDir('cache-disk');
    try {
      const { fetchImpl, calls } = makeFetch({
        delays: { [FAST.probeUrl]: { delayMs: 5 }, [SLOW.probeUrl]: { delayMs: 60 } },
      });
      const first = new MirrorSelector({ dataRoot: root, fetchImpl, mirrors: [FAST, SLOW] });
      await first.probeAll({ timeoutMs: 2_000 });

      const file = path.join(root, 'cache', PROBE_CACHE_FILE);
      assert.equal(fs.existsSync(file), true, '磁盘缓存文件必须存在');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        version: number;
        savedAt: number;
        probes: { id: string; latencyMs: number; ok: boolean }[];
      };
      assert.equal(parsed.version, 1);
      assert.equal(parsed.probes.length, 2);
      assert.equal(parsed.probes[0]?.id, 'fast');

      // 新实例（同一个 dataRoot）应该直接命中磁盘缓存，不联网
      const callsBefore = calls.length;
      const second = new MirrorSelector({ dataRoot: root, fetchImpl, mirrors: [FAST, SLOW] });
      const best = await second.best();
      assert.equal(best.id, 'fast');
      assert.equal(calls.length, callsBefore, '磁盘缓存命中时不该发请求');
      // 缓存里也必须能同步 peek 出来（/api/status 用）
      assert.equal(second.cachedProbes()?.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('缓存文件坏掉不影响使用（重新测速而不是崩）', async () => {
    const root = tmpDir('cache-bad');
    try {
      fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(root, 'cache', PROBE_CACHE_FILE), '{not json', 'utf8');

      const { fetchImpl } = makeFetch({
        delays: { [FAST.probeUrl]: { delayMs: 5 }, [SLOW.probeUrl]: { delayMs: 30 } },
      });
      const selector = new MirrorSelector({ dataRoot: root, fetchImpl, mirrors: [FAST, SLOW] });
      const best = await selector.best();
      assert.equal(best.id, 'fast');
      // 坏文件被覆盖成好文件
      const parsed = JSON.parse(fs.readFileSync(path.join(root, 'cache', PROBE_CACHE_FILE), 'utf8')) as {
        version: number;
      };
      assert.equal(parsed.version, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refresh() 强制重测，忽略缓存', async () => {
    const root = tmpDir('refresh');
    try {
      const calls: FetchCall[] = [];
      const { fetchImpl } = makeFetch({
        delays: { [FAST.probeUrl]: { delayMs: 5 }, [SLOW.probeUrl]: { delayMs: 25 } },
        calls,
      });
      const selector = new MirrorSelector({ dataRoot: root, fetchImpl, mirrors: [FAST, SLOW], ttlMs: 60_000 });
      await selector.best();
      const before = calls.length;
      const probes = await selector.refresh();
      assert.ok(calls.length > before, 'refresh() 必须真的重测');
      assert.equal(probes[0]?.id, 'fast');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cachedProbes()：没测过返回 null，不联网', () => {
    const selector = new MirrorSelector({
      dataRoot: os.tmpdir(),
      mirrors: [FAST],
      disableDiskCache: true,
      fetchImpl: (async () => {
        throw new Error('不该被调用');
      }) as unknown as typeof fetch,
    });
    assert.equal(selector.cachedProbes(), null, '冷启动时 peek 必须是 null（不能编造 0ms）');
  });
});

// ───────────────────────────── 失败降级 ─────────────────────────────

describe('MirrorSelector: 失败降级（连续失败 → 换源）', () => {
  it('连续 N 次失败后该源被降级，best() 不再选它', async () => {
    const root = tmpDir('degrade');
    try {
      const { fetchImpl } = makeFetch({
        delays: { [FAST.probeUrl]: { delayMs: 5 }, [SLOW.probeUrl]: { delayMs: 20 } },
      });
      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [FAST, SLOW],
        ttlMs: 60_000,
        disableDiskCache: true,
        failureThreshold: DEFAULT_FAILURE_THRESHOLD,
      });

      // 先测一遍：fast 最快
      assert.equal((await selector.best()).id, 'fast');

      // 模拟下载时 fast 连续失败
      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
        selector.reportFailure(FAST.base);
      }
      assert.equal(selector.isDegraded(FAST.base), true);
      assert.deepEqual(selector.degraded().map((d) => d.base), [FAST.base]);
      // 降级后「选源结论」作废：cachedProbes() 不再给旧结果，但延迟真值不受影响
      assert.equal(selector.cachedProbes(), null, '降级后旧的选源结论不能再被当成有效');

      // 缓存仍在 TTL 内，但 best() 必须跳过已降级的源
      const best = await selector.best();
      assert.equal(best.id, 'slow', '降级后应换源');
      assert.equal(best.ok, true);
      assert.ok(selector.cachedProbes()?.length === 2, '重新评估后缓存恢复可读');

      // 成功一次即恢复
      selector.reportSuccess(FAST.base);
      assert.equal(selector.isDegraded(FAST.base), false);
      assert.equal((await selector.best()).id, 'fast', '恢复后应重新选回更快的源');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reportFailure 也接受源 id，并返回连续失败次数', () => {
    const selector = new MirrorSelector({
      dataRoot: os.tmpdir(),
      mirrors: [FAST, SLOW],
      disableDiskCache: true,
      failureThreshold: 3,
    });
    assert.equal(selector.reportFailure('fast'), 1);
    assert.equal(selector.reportFailure('fast'), 2);
    assert.equal(selector.isDegraded('fast'), false);
    assert.equal(selector.reportFailure('fast'), 3);
    assert.equal(selector.isDegraded(FAST.base), true);
    // 未知源 id 不会误伤任何人
    assert.equal(selector.reportFailure('unknown-mirror'), 1);
  });

  it('测速成功不解降级（避免换源死循环），reportSuccess / refresh 才解', async () => {
    const root = tmpDir('recover');
    try {
      const { fetchImpl } = makeFetch({
        delays: { [FAST.probeUrl]: { delayMs: 5 }, [SLOW.probeUrl]: { delayMs: 20 } },
      });
      const selector = new MirrorSelector({
        dataRoot: root,
        fetchImpl,
        mirrors: [FAST, SLOW],
        disableDiskCache: true,
        failureThreshold: 2,
      });
      selector.reportFailure(FAST.base);
      selector.reportFailure(FAST.base);
      assert.equal(selector.isDegraded(FAST.base), true);

      // 测速照样能连通，但绝不因此解除降级
      const probes = await selector.probeAll({ timeoutMs: 1_000 });
      assert.equal(probes.find((p) => p.id === 'fast')?.ok, true, '延迟本身仍然是真值');
      assert.equal(selector.isDegraded(FAST.base), true, '测速成功不许解除降级');
      assert.equal((await selector.best()).id, 'slow', '仍然是降级状态，必须选别的源');

      // 真成功一次就恢复
      selector.reportSuccess('fast');
      assert.equal(selector.isDegraded(FAST.base), false);
      assert.equal((await selector.best()).id, 'fast');

      // refresh() 是「用户手动重测」，语义上也该清账
      selector.reportFailure(FAST.base);
      selector.reportFailure(FAST.base);
      await selector.refresh({ timeoutMs: 1_000 });
      assert.equal(selector.isDegraded(FAST.base), false, 'refresh 应清空失败计数');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── Downloader 接线 ─────────────────────────────

describe('Downloader.onRepeatedFailure：下载失败驱动换源', () => {
  const MIRROR_BASE = 'https://bmclapi2.bangbang93.com';
  const RAW_URL = 'https://libraries.minecraft.net/com/mojang/logging/1.2.7/logging-1.2.7.jar';

  function fakeFetchOneAlwaysFails() {
    return async (): Promise<{ outcome: 'failed'; error: Error }> => ({
      outcome: 'failed',
      error: new Error(`HTTP 503: ${MIRROR_BASE}/com/mojang/logging/1.2.7/logging-1.2.7.jar`),
    });
  }

  it('不传回调时行为完全不变（下载结果与统计照旧）', async () => {
    const dl = new Downloader({
      concurrency: 2,
      retries: 1,
      mirrors: [MIRROR_BASE],
      fetchOneFn: fakeFetchOneAlwaysFails() as never,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
    });
    const tasks: DownloadTask[] = [{ url: RAW_URL, dest: path.join(os.tmpdir(), 'pcl3-x.jar') }];
    const result: DownloadResult = await dl.downloadAll(tasks);
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
  });

  it('传了 onRepeatedFailure：失败会带出 mirrorBase，供上层降级该源', async () => {
    const seen: { base?: string; failedUrl?: string }[] = [];
    const dl = new Downloader({
      concurrency: 2,
      retries: 1,
      mirrors: [MIRROR_BASE],
      fetchOneFn: fakeFetchOneAlwaysFails() as never,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
      onRepeatedFailure: (info) => {
        seen.push({ ...(info.mirrorBase === undefined ? {} : { base: info.mirrorBase }), ...(info.failedUrl === undefined ? {} : { failedUrl: info.failedUrl }) });
      },
    });
    const tasks: DownloadTask[] = [{ url: RAW_URL, dest: path.join(os.tmpdir(), 'pcl3-y.jar') }];
    const result = await dl.downloadAll(tasks);
    assert.equal(result.failed.length, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.base, MIRROR_BASE, '必须识别出失败发生在镜像上');
  });

  it('失败发生在官方源时不上报镜像（避免误降级）', () => {
    // 纯函数级验证：fallbackMirrorFromUrl 的判定边界
    const mirrors = [MIRROR_BASE];
    assert.equal(fallbackMirrorFromUrl({ url: RAW_URL }, RAW_URL, mirrors), null);
    assert.equal(
      fallbackMirrorFromUrl({ url: `${MIRROR_BASE}/com/x.jar` }, RAW_URL, mirrors),
      MIRROR_BASE,
    );
    assert.equal(fallbackMirrorFromUrl({ url: 'https://other.example/x.jar' }, RAW_URL, mirrors), null);
  });

  it('回调抛错不会影响下载结果（观测不干预）', async () => {
    const dl = new Downloader({
      concurrency: 1,
      retries: 1,
      mirrors: [MIRROR_BASE],
      fetchOneFn: fakeFetchOneAlwaysFails() as never,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
      onRepeatedFailure: () => {
        throw new Error('回调故意炸');
      },
    });
    const tasks: DownloadTask[] = [{ url: RAW_URL, dest: path.join(os.tmpdir(), 'pcl3-z.jar') }];
    const result = await dl.downloadAll(tasks);
    assert.equal(result.ok, false);
    assert.equal(result.skipped + result.downloaded + result.failed.length, 1);
  });
});

// ───────────────────────────── 常量表 ─────────────────────────────

describe('mirrors 常量表', () => {
  it('三个已知源都存在，且测速点用同一个文件', () => {
    const ids = MIRROR_DEFINITIONS.map((m) => m.id);
    assert.deepEqual(ids, ['mojang', 'piston', 'bmclapi']);
    const paths = new Set(MIRROR_DEFINITIONS.map((m) => new URL(m.probeUrl).pathname));
    assert.equal(paths.size, 1, '所有源必须测同一个文件，否则延迟不可比');
  });

  it('契约里点名的两个测速 URL 一字不差', () => {
    assert.equal(
      findMirror('mojang')?.probeUrl,
      'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
    );
    assert.equal(
      findMirror('bmclapi')?.probeUrl,
      'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    );
  });

  it('orderedMirrorBases 排除首选源，按测速顺序排其余', () => {
    const bases = orderedMirrorBases('mojang', ['bmclapi', 'piston', 'mojang']);
    assert.deepEqual(bases, [
      'https://bmclapi2.bangbang93.com',
      'https://piston-meta.mojang.com',
    ]);
  });

  it('mirrorLabel 未知 id 原样返回', () => {
    assert.equal(mirrorLabel('bmclapi'), 'BMCLAPI 镜像');
    assert.equal(mirrorLabel('whatever'), 'whatever');
  });
});
