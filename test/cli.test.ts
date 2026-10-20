/**
 * CLI 测试 —— 只测「解析 + 路由 + 纯函数」，不触发真实网络。
 *
 * 做法：
 *   - `runCli(argv, ctx)` 的 ctx 由测试构造，塞 fake 依赖与 fake probe。
 *   - `versions` / `install` 用 fake VersionRepository / Downloader。
 *   - `account offline` 把数据根指向临时目录，校验 JSON 落盘与退出码。
 *   - `doctor` 的 probe 全部 fake，断言表格里出现每一项检查。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AssetIndex, DownloadResult, DownloadTask, VersionJson, VersionManifest } from '../src/core/types.js';
import {
  buildDoctorReport,
  commandTokens,
  findCommand,
  formatPlan,
  runCli,
  selectVersions,
  type CliContext,
  type CliIO,
  type ProbeResult,
} from '../src/cli/index.js';
import { offlineUuid } from '../src/core/auth/offline.js';
import { renderTable, formatBytes, displayWidth } from '../src/cli/ansi.js';
import { parseArgs, UsageError } from '../src/cli/args.js';
import { VanillaInstaller } from '../src/core/install/index.js';

// ───────────────────────────── 测试脚手架 ─────────────────────────────

function captureIO(): CliIO & { outText: () => string; errText: () => string } {
  let out = '';
  let err = '';
  return {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    outText: () => out,
    errText: () => err,
  };
}

const MANIFEST: VersionManifest = {
  latest: { release: '1.21', snapshot: '24w45a' },
  versions: [
    { id: '1.21', type: 'release', url: 'u', time: 't', releaseTime: '2024-06-13T08:24:03+00:00' },
    { id: '1.20.6', type: 'release', url: 'u', time: 't', releaseTime: '2024-04-29T08:00:00+00:00' },
    { id: '1.20.5', type: 'release', url: 'u', time: 't', releaseTime: '2024-04-23T08:00:00+00:00' },
    { id: '24w45a', type: 'snapshot', url: 'u', time: 't', releaseTime: '2024-11-06T10:00:00+00:00' },
    { id: 'b1.7.3', type: 'old_beta', url: 'u', time: 't', releaseTime: '2011-07-08T08:00:00+00:00' },
  ],
};

class FakeVersionRepository {
  readonly manifest: VersionManifest;
  readonly versions: Record<string, VersionJson>;
  fetchManifestCalls = 0;

  constructor(manifest: VersionManifest, versions: Record<string, VersionJson> = {}) {
    this.manifest = manifest;
    this.versions = versions;
  }
  async fetchManifest(): Promise<VersionManifest> {
    this.fetchManifestCalls += 1;
    return this.manifest;
  }
  async fetchVersion(id: string): Promise<VersionJson> {
    const found = this.versions[id];
    if (!found) throw new Error(`unknown version ${id}`);
    return found;
  }
  async resolveInherited(json: VersionJson): Promise<VersionJson> {
    return json;
  }
}

/**
 * 传给 `deps.VersionRepository` 的必须是**构造函数**（CLI 内部会 `new` 它），
 * 所以这里给一个带静态数据的类工厂，而不是实例。
 */
function fakeRepoClass(manifest: VersionManifest, versions: Record<string, VersionJson>) {
  return class CaptiveVersionRepository extends FakeVersionRepository {
    constructor() {
      super(manifest, versions);
    }
  } as never;
}

class FakeDownloader {
  calls = 0;
  async downloadAll(
    tasks: DownloadTask[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<DownloadResult> {
    this.calls += 1;
    let done = 0;
    for (const task of tasks) {
      onProgress?.({ done, total: tasks.length, current: task.url });
      done += 1;
    }
    return { ok: true, skipped: 0, downloaded: tasks.length, failed: [] };
  }
}

function makeCtx(
  io: CliIO,
  options: {
    dataRoot: string;
    versions?: Record<string, VersionJson>;
    manifest?: VersionManifest;
    probe?: (url: string, timeoutMs: number) => Promise<ProbeResult>;
  },
): CliContext {
  return {
    io,
    deps: {
      VersionRepository: fakeRepoClass(options.manifest ?? MANIFEST, options.versions ?? {}),
      Downloader: FakeDownloader as never,
      getDataRoot: () => options.dataRoot,
      real: { versionRepo: true, downloader: true, getDataRoot: true },
    },
    env: { PATH: '' },
    openBrowser: async () => true,
    probe:
      options.probe ??
      (async (): Promise<ProbeResult> => ({ ok: true, status: 200, ms: 5 })),
  };
}

function tinyVersion(): { json: VersionJson; assetIndex: AssetIndex } {
  const assetIndex: AssetIndex = {
    objects: {
      'a.txt': { hash: `ab${'0'.repeat(38)}`, size: 10 },
      'b.txt': { hash: `cd${'1'.repeat(38)}`, size: 20 },
    },
  };
  const json: VersionJson = {
    id: '1.21',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    assetIndex: {
      id: '17',
      sha1: 'a'.repeat(40),
      size: 100,
      totalSize: 30,
      url: 'https://piston-meta.mojang.com/v1/packages/aaa/17.json',
    },
    downloads: {
      client: {
        sha1: 'b'.repeat(40),
        size: 1000,
        url: 'https://piston-data.mojang.com/v1/objects/bbbb/client.jar',
      },
    },
    libraries: [
      {
        name: 'com.mojang:logging:1.2.7',
        downloads: {
          artifact: {
            path: 'com/mojang/logging/1.2.7/logging-1.2.7.jar',
            sha1: 'c'.repeat(40),
            size: 100,
            url: 'https://libraries.minecraft.net/com/mojang/logging/1.2.7/logging-1.2.7.jar',
          },
        },
      },
    ],
  };
  return { json, assetIndex };
}

// ───────────────────────────── 参数解析 ─────────────────────────────

describe('parseArgs', () => {
  it('versions --limit 5 解析出 limit=5', () => {
    const parsed = parseArgs(['versions', '--limit', '5'], {
      values: { limit: { type: 'number', default: 20 } },
      booleans: { all: { default: false } },
    }, { commandTokens: commandTokens() });
    assert.deepEqual(parsed.command, ['versions']);
    assert.equal(parsed.values['limit'], 5);
    assert.equal(parsed.booleans['all'], false);
  });

  it('--limit=5 与默认值', () => {
    const withDefault = parseArgs(['versions'], { values: { limit: { type: 'number', default: 20 } } });
    assert.equal(withDefault.values['limit'], 20);

    const inline = parseArgs(['versions', '--limit=5'], { values: { limit: { type: 'number' } } });
    assert.equal(inline.values['limit'], 5);
  });

  it('install 1.21：位置参数进 positional', () => {
    const parsed = parseArgs(['install', '1.21'], { booleans: { yes: { default: false } } }, {
      commandTokens: commandTokens(),
    });
    assert.deepEqual(parsed.command, ['install']);
    assert.deepEqual(parsed.positional, ['1.21']);
  });

  it('account offline Steve：两级命令 + 位置参数', () => {
    const parsed = parseArgs(['account', 'offline', 'Steve'], {}, { commandTokens: commandTokens() });
    assert.deepEqual(parsed.command, ['account', 'offline']);
    assert.deepEqual(parsed.positional, ['Steve']);
  });

  it('选项写在位置参数前面也能识别', () => {
    const parsed = parseArgs(['versions', '--all', '--type', 'snapshot'], {
      values: { type: { type: 'string', default: 'release' } },
      booleans: { all: { default: false } },
    });
    assert.equal(parsed.booleans['all'], true);
    assert.equal(parsed.values['type'], 'snapshot');
  });

  it('未知选项报 UsageError', () => {
    assert.throws(
      () => parseArgs(['versions', '--limt', '5'], { values: { limit: { type: 'number' } } }),
      UsageError,
    );
  });

  it('数值选项收到非数字报 UsageError', () => {
    assert.throws(
      () => parseArgs(['versions', '--limit', 'abc'], { values: { limit: { type: 'number' } } }),
      /需要一个数字/,
    );
  });
});

// ───────────────────────────── 路由 ─────────────────────────────

describe('runCli 路由', () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-cli-'));
  });
  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('versions --limit 5 只列 5 条', async () => {
    const io = captureIO();
    const ctx = makeCtx(io, { dataRoot: tmpRoot });
    const code = await runCli(['versions', '--limit', '5'], ctx);

    assert.equal(code, 0);
    const out = io.outText();
    for (const id of ['1.21', '1.20.6', '1.20.5']) assert.ok(out.includes(id), `输出应包含 ${id}`);
  });

  it('versions --limit 2 截断到 2 条 release', async () => {
    const io = captureIO();
    const ctx = makeCtx(io, { dataRoot: tmpRoot });
    await runCli(['versions', '--limit', '2'], ctx);
    const out = io.outText();
    assert.ok(out.includes('1.21'));
    assert.ok(out.includes('1.20.6'));
    assert.ok(!out.includes('1.20.5'), 'limit=2 时不应出现第三条');
  });

  it('versions --type snapshot 只出快照', async () => {
    const io = captureIO();
    const ctx = makeCtx(io, { dataRoot: tmpRoot });
    await runCli(['versions', '--type', 'snapshot'], ctx);
    assert.ok(io.outText().includes('24w45a'));
    assert.ok(!io.outText().includes('1.20.6'));
  });

  it('install 1.21 --dry-run 只打印计划不下载', async () => {
    const { json, assetIndex } = tinyVersion();
    fs.mkdirSync(path.join(tmpRoot, 'assets', 'indexes'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'assets', 'indexes', '17.json'), JSON.stringify(assetIndex), 'utf8');

    const io = captureIO();
    const ctx = makeCtx(io, { dataRoot: tmpRoot, versions: { '1.21': json } });
    const code = await runCli(['install', '1.21', '--dry-run'], ctx);

    assert.equal(code, 0);
    const out = io.outText();
    assert.ok(out.includes('安装计划'), '应打印计划标题');
    assert.ok(out.includes('1.21'), '应包含版本号');
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'versions', '1.21', '1.21.jar')), 'dry-run 不应写文件');
  });

  it('install 缺版本号 → 退出码 2 并给用法', async () => {
    const io = captureIO();
    const ctx = makeCtx(io, { dataRoot: tmpRoot });
    const code = await runCli(['install'], ctx);
    assert.equal(code, 2);
    assert.ok(io.errText().includes('用法'));
  });

  it('account offline Steve 写 accounts.json 并输出玩家名', async () => {
    const accountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-acct-'));
    try {
      const io = captureIO();
      const ctx = makeCtx(io, { dataRoot: accountRoot });
      const code = await runCli(['account', 'offline', 'Steve'], ctx);

      assert.equal(code, 0);
      assert.ok(io.outText().includes('Steve'));

      const saved = JSON.parse(fs.readFileSync(path.join(accountRoot, 'accounts.json'), 'utf8')) as {
        accounts: { username: string; type: string; uuid: string }[];
      };
      assert.equal(saved.accounts.length, 1);
      assert.equal(saved.accounts[0]!.username, 'Steve');
      assert.equal(saved.accounts[0]!.type, 'offline');
      assert.equal(saved.accounts[0]!.uuid, offlineUuid('Steve'));
    } finally {
      fs.rmSync(accountRoot, { recursive: true, force: true });
    }
  });

  it('account offline 不重复追加同名账户', async () => {
    const accountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-acct2-'));
    try {
      const ctx = makeCtx(captureIO(), { dataRoot: accountRoot });
      await runCli(['account', 'offline', 'Alex'], ctx);
      await runCli(['account', 'offline', 'Alex'], ctx);
      const saved = JSON.parse(fs.readFileSync(path.join(accountRoot, 'accounts.json'), 'utf8')) as {
        accounts: unknown[];
      };
      assert.equal(saved.accounts.length, 1);
    } finally {
      fs.rmSync(accountRoot, { recursive: true, force: true });
    }
  });

  it('account list 空目录给出提示', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-acct3-'));
    try {
      const io = captureIO();
      const ctx = makeCtx(io, { dataRoot: emptyRoot });
      const code = await runCli(['account', 'list'], ctx);
      assert.equal(code, 0);
      assert.ok(io.outText().includes('还没有账户'));
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('未知命令 → 退出码 2', async () => {
    const io = captureIO();
    const ctx = makeCtx(io, { dataRoot: tmpRoot });
    const code = await runCli(['frobnicate'], ctx);
    assert.equal(code, 2);
    assert.ok(io.errText().includes('未知命令'));
  });

  it('--help 列出全部命令', async () => {
    const io = captureIO();
    const ctx = makeCtx(io, { dataRoot: tmpRoot });
    const code = await runCli(['--help'], ctx);
    assert.equal(code, 0);
    for (const name of ['versions', 'install', 'launch', 'account', 'doctor']) {
      assert.ok(io.outText().includes(name), `帮助里应有 ${name}`);
    }
  });

  it('doctor 全部通过时退出码 0，表格含各检查项', async () => {
    const io = captureIO();
    const ctx = makeCtx(io, {
      dataRoot: tmpRoot,
      probe: async (url): Promise<ProbeResult> => ({ ok: true, status: 200, ms: 12 }),
    });
    const code = await runCli(['doctor'], ctx);
    const out = io.outText();
    for (const name of ['Node 运行时', '数据目录', 'Java', 'BMCLAPI 清单', '官方资源']) {
      assert.ok(out.includes(name), `doctor 输出应含 ${name}`);
    }
    // Java 那行必须是「未检测到」，不能伪造成功
    assert.ok(out.includes('未检测到 Java'), '本机没有 Java，必须如实报告');
    assert.equal(code, 1, 'Java 缺失时退出码应为 1');
  });

  it('doctor --no-network 不发探测请求', async () => {
    let probed = 0;
    const io = captureIO();
    const ctx = makeCtx(io, {
      dataRoot: tmpRoot,
      probe: async () => {
        probed += 1;
        return { ok: true, status: 200, ms: 1 };
      },
    });
    await runCli(['doctor', '--no-network'], ctx);
    assert.equal(probed, 0, '--no-network 时不应探测');
  });

  it('doctor 端点 500 判为失败', async () => {
    const io = captureIO();
    const ctx = makeCtx(io, {
      dataRoot: tmpRoot,
      probe: async (url): Promise<ProbeResult> =>
        url.includes('bmclapi') ? { ok: false, status: 502, ms: 30 } : { ok: true, status: 200, ms: 10 },
    });
    await runCli(['doctor'], ctx);
    assert.ok(io.outText().includes('HTTP 502'));
  });
});

// ───────────────────────────── 纯函数 ─────────────────────────────

describe('selectVersions', () => {
  it('默认取最近 N 个 release', () => {
    const list = selectVersions(MANIFEST, { limit: 2, all: false, type: 'release' });
    assert.deepEqual(list.map((v) => v.id), ['1.21', '1.20.6']);
  });

  it('--all 不按 type 过滤，返回清单全部', () => {
    const list = selectVersions(MANIFEST, { limit: 1, all: true, type: 'release' });
    assert.equal(list.length, MANIFEST.versions.length);
  });

  it('type=all 出全部类型', () => {
    const list = selectVersions(MANIFEST, { limit: 100, all: false, type: 'all' });
    assert.equal(list.length, 5);
  });
});

describe('findCommand / commandTokens', () => {
  it('两级命令能精确命中', () => {
    assert.equal(findCommand(['account', 'offline'])?.usage.includes('account'), true);
    assert.equal(findCommand(['account']), undefined);
    assert.equal(findCommand(['install'])?.path[0], 'install');
  });

  it('commandTokens 覆盖所有命令路径', () => {
    const tokens = commandTokens();
    assert.ok(tokens.some((t) => t.join(' ') === 'doctor'));
    assert.ok(tokens.some((t) => t.join(' ') === 'account login'));
  });
});

describe('offlineUuid', () => {
  it('与 Java UUID.nameUUIDFromBytes 结果一致（Notch 经典样例）', () => {
    // Java: UUID.nameUUIDFromBytes("OfflinePlayer:Notch".getBytes(UTF_8))
    const uuid = offlineUuid('Notch');
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // 同一名字必须稳定
    assert.equal(uuid, offlineUuid('Notch'));
    assert.notEqual(uuid, offlineUuid('Steve'));
  });
});

describe('ansi 与表格', () => {
  it('formatBytes 走 1024 进制', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(26836080), '25.6 MB');
  });

  it('displayWidth 把中文按 2 算', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('版本'), 4);
  });

  it('renderTable 对齐且包含表头', () => {
    const table = renderTable(['a', 'bb'], [['xx', 'y']]);
    assert.ok(table.includes('a'));
    assert.ok(table.split('\n').length >= 3);
  });
});

describe('formatPlan', () => {
  it('打印任务数与总大小', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-plan-'));
    try {
      const { json, assetIndex } = tinyVersion();
      fs.mkdirSync(path.join(tmpRoot, 'assets', 'indexes'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'assets', 'indexes', '17.json'), JSON.stringify(assetIndex), 'utf8');

      const installer = new VanillaInstaller(
        {
          versionRepo: new FakeVersionRepository(MANIFEST, { '1.21': json }) as never,
          downloader: new FakeDownloader() as never,
        },
        { dataRoot: tmpRoot, os: { name: 'windows', arch: 'x86_64', version: '10.0' } },
      );
      const plan = await installer.plan('1.21');
      const text = formatPlan(plan);
      assert.ok(text.includes('1.21'));
      assert.ok(text.includes('任务数'));
      assert.ok(text.includes(String(plan.tasks.length)));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('buildDoctorReport', () => {
  it('模块缺失时如实标为 FAIL', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-doc-'));
    try {
      const io = captureIO();
      const ctx = makeCtx(io, { dataRoot: tmpRoot });
      ctx.deps.real = { versionRepo: false, downloader: false, getDataRoot: false };
      const report = await buildDoctorReport(ctx, { timeoutMs: 1000, skipNetwork: true });
      const versionRow = report.checks.find((c) => c.name === '模块 version');
      assert.equal(versionRow?.ok, false);
      assert.ok(versionRow?.detail.includes('缺失'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
