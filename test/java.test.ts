/**
 * java 模块测试 —— 全部离线：自造两段式清单 + fake Downloader，绝不真的下几百 MB JRE。
 *
 * 覆盖点（对应验收标准）：
 *   1. 清单解析：windows-x64 / mac-os / linux 三个平台 key 选取正确
 *   2. 运行时清单 type 三态处理（directory / file / link）
 *   3. executable 文件识别，返回值是**绝对路径**
 *   4. isInstalled 幂等性（重复 ensureRuntime 不重复下载）
 *   5. 网络失败时回退过期缓存（外加「无缓存时才抛错」）
 *   6. 平台判定函数在模拟 mac / linux / arm64 下的行为
 *   7. 24h TTL：新鲜缓存不触网，过期才重拉
 *   8. 镜像根替换（BMCLAPI）
 *   9. safety：目录穿越拒绝、失败不静默、并发去重
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DownloadResult, DownloadTask, VersionJson } from '../src/core/types.js';
import { GameLauncher } from '../src/core/launch/index.js';
import type { Platform } from '../src/core/launch/index.js';
import {
  DEFAULT_MANIFEST_TTL_MS,
  JAVA_RUNTIME_PRODUCT_URL,
  JavaRuntimeInstaller,
  ManifestStore,
  entriesForComponent,
  findJavaEntry,
  isRuntimeManifest,
  listComponents,
  majorFromComponentName,
  parseMajorFromVersionName,
  pickAvailablePlatform,
  pickRuntimeEntry,
  platformCandidates,
  primaryPlatform,
  withMirror,
  type JavaRuntimeFileEntry,
  type JavaRuntimeManifest,
  type TextFetcher,
} from '../src/core/java/index.js';
import {
  JavaAutoProvisioner,
  JavaProvisionError,
  classifyProvisionError,
  humanizeProvisionError,
} from '../src/core/launch/index.js';
import type { JavaInstallerLike } from '../src/core/launch/index.js';

// ───────────────────────────── fake 依赖 ─────────────────────────────

/**
 * fake Downloader：把任务 URL 里的 basename 当作内容写盘（不联网），
 * 记录每次调用收到的任务，便于断言「下载了什么 / 有没有重复下载」。
 *
 * `mutate` 允许把文件内容改掉或干脆不写，用来模拟「下载成功但文件缺失」。
 */
class FakeDownloader {
  readonly calls: DownloadTask[][] = [];
  readonly progress: { done: number; total: number; current: string }[] = [];
  /** 抛错的任务（模拟单文件失败） */
  failUrls = new Set<string>();
  /** 不落盘的任务（模拟「下载器说成功但其实没文件」） */
  skipWriteUrls = new Set<string>();

  get taskCount(): number {
    return this.calls.reduce((n, list) => n + list.length, 0);
  }

  async downloadAll(
    tasks: DownloadTask[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<DownloadResult> {
    this.calls.push(tasks);
    const result: DownloadResult = { ok: true, skipped: 0, downloaded: 0, failed: [] };
    let done = 0;
    onProgress?.({ done, total: tasks.length, current: tasks[0]?.url ?? '' });
    this.progress.push({ done, total: tasks.length, current: tasks[0]?.url ?? '' });

    for (const task of tasks) {
      if (this.failUrls.has(task.url)) {
        result.failed.push(task);
      } else {
        if (!this.skipWriteUrls.has(task.url)) {
          fs.mkdirSync(path.dirname(task.dest), { recursive: true });
          fs.writeFileSync(task.dest, `content:${path.basename(task.dest)}`, 'utf8');
        }
        result.downloaded += 1;
      }
      done += 1;
      onProgress?.({ done, total: tasks.length, current: task.url });
      this.progress.push({ done, total: tasks.length, current: task.url });
    }

    result.ok = result.failed.length === 0;
    return result;
  }
}

/** 按 URL 路由的 fake 抓取器：第一段清单 / 第二段运行时清单各喂一份。 */
class FakeFetcher {
  readonly urls: string[] = [];
  coarse: JavaRuntimeManifest | Error;
  fine: Record<string, unknown> | Error;
  /** 置 true 后所有请求都失败（模拟断网） */
  offline = false;

  constructor(coarse: JavaRuntimeManifest, fine: Record<string, unknown>) {
    this.coarse = coarse;
    this.fine = fine;
  }

  fetch: TextFetcher = async (url: string): Promise<string> => {
    this.urls.push(url);
    if (this.offline) throw new Error(`ENOTFOUND ${url}`);

    if (url.includes('/all.json')) {
      if (this.coarse instanceof Error) throw this.coarse;
      return JSON.stringify(this.coarse);
    }
    if (url.includes('manifest.json')) {
      if (this.fine instanceof Error) throw this.fine;
      const body = this.fine[url];
      if (body === undefined) throw new Error(`404 ${url}`);
      return JSON.stringify(body);
    }
    throw new Error(`unexpected url ${url}`);
  };

  /** 只统计真正打到网络上的「第一段清单」次数 */
  get coarseCalls(): number {
    return this.urls.filter((u) => u.includes('/all.json')).length;
  }
}

// ───────────────────────────── 测试夹具 ─────────────────────────────

const COARSE_URL = `${JAVA_RUNTIME_PRODUCT_URL}/all.json`;

/** 与实测结构一致：platform → component → 条目数组 */
function makeCoarse(): JavaRuntimeManifest {
  const entry = (name: string, url: string) => ({
    availability: { group: 7609, progress: 100 },
    manifest: { url, sha1: 'a'.repeat(40), size: 1024 },
    version: { name, released: '2025-05-19T08:28:47+00:00' },
  });
  return {
    'windows-x64': {
      'java-runtime-gamma': [entry('17.0.15', 'https://piston-meta.mojang.com/win-x64/gamma/manifest.json')],
      'java-runtime-delta': [entry('21.0.7', 'https://piston-meta.mojang.com/win-x64/delta/manifest.json')],
    },
    'windows-arm64': {
      'java-runtime-delta': [entry('21.0.7', 'https://piston-meta.mojang.com/win-arm64/delta/manifest.json')],
    },
    'mac-os': {
      'java-runtime-gamma': [entry('17.0.15', 'https://piston-meta.mojang.com/mac/gamma/manifest.json')],
      'java-runtime-delta': [entry('21.0.7', 'https://piston-meta.mojang.com/mac/delta/manifest.json')],
    },
    'mac-os-arm64': {
      'java-runtime-delta': [entry('21.0.7', 'https://piston-meta.mojang.com/mac-arm64/delta/manifest.json')],
    },
    linux: {
      'java-runtime-gamma': [entry('17.0.15', 'https://piston-meta.mojang.com/linux/gamma/manifest.json')],
      'java-runtime-delta': [entry('21.0.7', 'https://piston-meta.mojang.com/linux/delta/manifest.json')],
    },
    'linux-i386': {
      'jre-legacy': [entry('1.8.0_392', 'https://piston-meta.mojang.com/linux-i386/legacy/manifest.json')],
    },
    gamecore: {
      'java-runtime-gamma': [entry('17.0.15', 'https://piston-meta.mojang.com/gamecore/gamma/manifest.json')],
    },
  };
}

/** 第二段运行时清单：含三种 type + 一个 executable 的 bin/java(.exe) */
function makeFine(platform: 'windows' | 'posix'): Record<string, JavaRuntimeFileEntry> {
  const javaName = platform === 'windows' ? 'bin/java.exe' : 'bin/java';
  const files: Record<string, JavaRuntimeFileEntry> = {
    bin: { type: 'directory' },
    'bin/server': { type: 'directory' },
    legal: { type: 'directory' },
    'legal/java.base': { type: 'directory' },
    'legal/java.compiler': { type: 'directory' },
    [javaName]: {
      type: 'file',
      executable: true,
      downloads: {
        // 实测里 lzma 与 raw 并存，确定我们只用 raw
        lzma: { url: `https://piston-data.mojang.com/lzma/java`, sha1: 'b'.repeat(40), size: 1 },
        raw: { url: `https://piston-data.mojang.com/raw/java`, sha1: 'c'.repeat(40), size: 100 },
      },
    },
    'bin/javaw.exe': {
      type: 'file',
      executable: true,
      downloads: { raw: { url: 'https://piston-data.mojang.com/raw/javaw', sha1: 'd'.repeat(40), size: 100 } },
    },
    'lib/modules': {
      type: 'file',
      downloads: { raw: { url: 'https://piston-data.mojang.com/raw/modules', sha1: 'e'.repeat(40), size: 4200 } },
    },
    'legal/java.base/ASSEMBLY_EXCEPTION': {
      type: 'file',
      downloads: {
        raw: { url: 'https://piston-data.mojang.com/raw/assembly', sha1: 'f'.repeat(40), size: 30 },
      },
    },
    'legal/java.compiler/ADDITIONAL_LICENSE_INFO': {
      type: 'link',
      target: '../java.base/ADDITIONAL_LICENSE_INFO',
    },
    // 链接指向一个在同目录树里真实存在的文件，验证「复制」语义
    'legal/java.compiler/COPY_OF_ASSEMBLY': {
      type: 'link',
      target: '../java.base/ASSEMBLY_EXCEPTION',
    },
  };
  // windows 专属的 javaw 在 posix 平台上不该出现；这里只是夹具，无伤大雅
  return files;
}

let tmpRoots: string[] = [];

function makeDataRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcl3-java-'));
  tmpRoots.push(dir);
  return dir;
}

function makeInstaller(opts: {
  root?: string;
  platform?: { platform?: string; arch?: string };
  fetcher?: FakeFetcher;
  downloader?: FakeDownloader;
  ttlMs?: number;
  now?: () => number;
  mirror?: string;
}): {
  installer: JavaRuntimeInstaller;
  downloader: FakeDownloader;
  fetcher: FakeFetcher;
  root: string;
  warnings: string[];
} {
  const root = opts.root ?? makeDataRoot();
  const downloader = opts.downloader ?? new FakeDownloader();
  const fetcher = opts.fetcher ?? new FakeFetcher(makeCoarse(), collectFine());
  const warnings: string[] = [];
  const installer = new JavaRuntimeInstaller({
    downloader,
    dataRoot: root,
    platform: opts.platform ?? { platform: 'win32', arch: 'x64' },
    fetchTextImpl: fetcher.fetch,
    logger: { warn: (m) => warnings.push(m) },
    ...(opts.ttlMs === undefined ? {} : { manifestTtlMs: opts.ttlMs }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.mirror === undefined ? {} : { mirror: opts.mirror }),
  });
  return { installer, downloader, fetcher, root, warnings };
}

/** 把「平台 → 运行时清单」按 fake URL 组装成 fake 抓取器要的形状。 */
function collectFine(): Record<string, unknown> {
  const win = { files: makeFine('windows') };
  const posix = { files: makeFine('posix') };
  return {
    'https://piston-meta.mojang.com/win-x64/gamma/manifest.json': win,
    'https://piston-meta.mojang.com/win-x64/delta/manifest.json': win,
    'https://piston-meta.mojang.com/win-arm64/delta/manifest.json': win,
    'https://piston-meta.mojang.com/mac/gamma/manifest.json': posix,
    'https://piston-meta.mojang.com/mac/delta/manifest.json': posix,
    'https://piston-meta.mojang.com/mac-arm64/delta/manifest.json': posix,
    'https://piston-meta.mojang.com/linux/gamma/manifest.json': posix,
    'https://piston-meta.mojang.com/linux/delta/manifest.json': posix,
    'https://piston-meta.mojang.com/linux-i386/legacy/manifest.json': posix,
    'https://piston-meta.mojang.com/gamecore/gamma/manifest.json': posix,
  };
}

before(() => {
  tmpRoots = [];
});

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────── 1. 平台判定 ─────────────────────────────

describe('平台 key 判定（platform.ts）', () => {
  it('Windows x64 → windows-x64 优先，arm64 作为次选', () => {
    assert.equal(primaryPlatform({ platform: 'win32', arch: 'x64' }), 'windows-x64');
    assert.deepEqual(platformCandidates({ platform: 'win32', arch: 'x64' }), [
      'windows-x64',
      'windows-arm64',
    ]);
  });

  it('Windows arm64 → windows-arm64 优先（要求：有则优先）', () => {
    assert.deepEqual(platformCandidates({ platform: 'win32', arch: 'arm64' }), [
      'windows-arm64',
      'windows-x64',
    ]);
  });

  it('Windows ia32 → windows-x86 优先', () => {
    assert.equal(primaryPlatform({ platform: 'win32', arch: 'ia32' }), 'windows-x86');
  });

  it('模拟 macOS x64 → mac-os；arm64 → mac-os-arm64 优先', () => {
    assert.equal(primaryPlatform({ platform: 'darwin', arch: 'x64' }), 'mac-os');
    assert.equal(primaryPlatform({ platform: 'darwin', arch: 'arm64' }), 'mac-os-arm64');
    assert.deepEqual(platformCandidates({ platform: 'darwin', arch: 'arm64' }), [
      'mac-os-arm64',
      'mac-os',
    ]);
  });

  it('模拟 Linux → linux；ia32 → linux-i386 优先', () => {
    assert.equal(primaryPlatform({ platform: 'linux', arch: 'x64' }), 'linux');
    assert.deepEqual(platformCandidates({ platform: 'linux', arch: 'x64' }), ['linux', 'linux-i386']);
    assert.equal(primaryPlatform({ platform: 'linux', arch: 'ia32' }), 'linux-i386');
  });

  it('未知平台返回 null / 空数组（调用方据此明确报错）', () => {
    assert.equal(primaryPlatform({ platform: 'freebsd', arch: 'x64' }), null);
    assert.deepEqual(platformCandidates({ platform: 'freebsd', arch: 'x64' }), []);
  });

  it('gamecore（Xbox）永远不会被自动选中', () => {
    for (const plat of ['win32', 'darwin', 'linux']) {
      assert.ok(!platformCandidates({ platform: plat, arch: 'x64' }).includes('gamecore'));
    }
  });

  it('pickAvailablePlatform 按优先级挑第一个存在的 key', () => {
    assert.equal(
      pickAvailablePlatform(['linux', 'mac-os'], { platform: 'darwin', arch: 'x64' }),
      'mac-os',
    );
    // 清单里只有 arm64 版本时，x64 机器也能用它作为次选
    assert.equal(
      pickAvailablePlatform(['mac-os-arm64'], { platform: 'darwin', arch: 'x64' }),
      'mac-os-arm64',
    );
    assert.equal(pickAvailablePlatform(['gamecore'], { platform: 'win32', arch: 'x64' }), null);
  });
});

// ───────────────────────────── 2. 清单解析 ─────────────────────────────

describe('两段式清单解析', () => {
  it('识别 platform → component 结构，并列出全部 component', () => {
    const coarse = makeCoarse();
    assert.ok(isRuntimeManifest(coarse));
    const names = listComponents(coarse);
    assert.ok(names.includes('java-runtime-gamma'));
    assert.ok(names.includes('java-runtime-delta'));
    assert.ok(names.includes('jre-legacy'));
    // 去重
    assert.equal(names.length, new Set(names).size);
  });

  it('windows-x64 / mac-os / linux 三个平台各自取到正确的 manifest.url', () => {
    const coarse = makeCoarse();

    const win = entriesForComponent(coarse, 'java-runtime-delta', platformCandidates({ platform: 'win32', arch: 'x64' }));
    assert.equal(win.length, 1);
    assert.equal(win[0]?.manifest.url, 'https://piston-meta.mojang.com/win-x64/delta/manifest.json');
    assert.equal(win[0]?.manifest.sha1, 'a'.repeat(40));

    const mac = entriesForComponent(coarse, 'java-runtime-delta', platformCandidates({ platform: 'darwin', arch: 'x64' }));
    assert.equal(mac[0]?.manifest.url, 'https://piston-meta.mojang.com/mac/delta/manifest.json');

    const linux = entriesForComponent(coarse, 'java-runtime-delta', platformCandidates({ platform: 'linux', arch: 'x64' }));
    assert.equal(linux[0]?.manifest.url, 'https://piston-meta.mojang.com/linux/delta/manifest.json');
  });

  it('arm64 平台优先拿到 windows-arm64 / mac-os-arm64 的条目', () => {
    const coarse = makeCoarse();
    const winArm = entriesForComponent(
      coarse,
      'java-runtime-delta',
      platformCandidates({ platform: 'win32', arch: 'arm64' }),
    );
    assert.equal(winArm[0]?.manifest.url, 'https://piston-meta.mojang.com/win-arm64/delta/manifest.json');

    const macArm = entriesForComponent(
      coarse,
      'java-runtime-delta',
      platformCandidates({ platform: 'darwin', arch: 'arm64' }),
    );
    assert.equal(macArm[0]?.manifest.url, 'https://piston-meta.mojang.com/mac-arm64/delta/manifest.json');
  });

  it('某个组件在某平台缺失时，回退到下一个平台候选', () => {
    const coarse = makeCoarse();
    // gamma 没有 windows-arm64 条目 → arm64 机器回退到 windows-x64
    const entries = entriesForComponent(
      coarse,
      'java-runtime-gamma',
      platformCandidates({ platform: 'win32', arch: 'arm64' }),
    );
    assert.equal(entries[0]?.manifest.url, 'https://piston-meta.mojang.com/win-x64/gamma/manifest.json');
  });

  it('结构校验拒绝错误形状（错误页 / 数组 / 空对象）', () => {
    assert.equal(isRuntimeManifest(null), false);
    assert.equal(isRuntimeManifest([]), false);
    assert.equal(isRuntimeManifest({ error: 'not found' }), false);
    assert.equal(isRuntimeManifest({ 'windows-x64': {} }), false);
    assert.equal(isRuntimeManifest({ 'windows-x64': { gamma: 'nope' } }), false);
    assert.equal(isRuntimeManifest(makeCoarse()), true);
  });

  it('pickRuntimeEntry 在组件完全不存在时返回 undefined', () => {
    const coarse = makeCoarse();
    assert.equal(
      pickRuntimeEntry(coarse, 'java-runtime-epsilon', platformCandidates({ platform: 'win32', arch: 'x64' })),
      undefined,
    );
  });

  it('版本名 → 主版本：21.0.7→21，17.0.15→17，1.8.0_392→8', () => {
    assert.equal(parseMajorFromVersionName('21.0.7'), 21);
    assert.equal(parseMajorFromVersionName('17.0.15'), 17);
    assert.equal(parseMajorFromVersionName('1.8.0_392'), 8);
    assert.equal(parseMajorFromVersionName(undefined), null);
    assert.equal(parseMajorFromVersionName('garbage'), null);
    // 实测对照表
    assert.equal(majorFromComponentName('java-runtime-delta'), 21);
    assert.equal(majorFromComponentName('java-runtime-gamma'), 17);
    assert.equal(majorFromComponentName('jre-legacy'), 8);
    assert.equal(majorFromComponentName('nope'), null);
  });

  it('镜像根只替换 origin，路径保留', () => {
    assert.equal(
      withMirror(COARSE_URL, 'https://bmclapi2.bangbang93.com'),
      'https://bmclapi2.bangbang93.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
    );
    assert.equal(withMirror(COARSE_URL, undefined), COARSE_URL);
    assert.equal(withMirror(COARSE_URL, '  '), COARSE_URL);
  });
});

// ───────────────────────────── 3. type 三态 + executable ─────────────────────────────

describe('ensureRuntime：type 三态落盘与 executable 识别', () => {
  it('windows-x64：directory 建目录、file 走 Downloader、link 复制，返回绝对路径', async () => {
    const { installer, downloader, root } = makeInstaller({});

    const javaPath = await installer.ensureRuntime('java-runtime-delta');

    // executable 识别 + 绝对路径
    assert.ok(path.isAbsolute(javaPath), `期望绝对路径，实得 ${javaPath}`);
    assert.equal(javaPath, path.join(root, 'java', 'java-runtime-delta', 'bin', 'java.exe'));
    assert.ok(fs.statSync(javaPath).isFile());

    // directory 三态之 directory
    assert.ok(fs.statSync(path.join(root, 'java', 'java-runtime-delta', 'bin')).isDirectory());
    assert.ok(fs.statSync(path.join(root, 'java', 'java-runtime-delta', 'legal', 'java.base')).isDirectory());

    // file 三态之 file：清单里 4 个 file 都交给了 Downloader，且 sha1 原样透传
    const tasks = downloader.calls.flat();
    const dests = tasks.map((t) => path.relative(path.join(root, 'java', 'java-runtime-delta'), t.dest));
    assert.ok(dests.includes(path.join('bin', 'java.exe')));
    assert.ok(dests.includes(path.join('lib', 'modules')));
    assert.ok(tasks.some((t) => t.sha1 === 'c'.repeat(40)));
    assert.ok(tasks.some((t) => t.size === 4200));
    // 只用 raw，不用 lzma
    assert.ok(tasks.every((t) => !t.url.includes('/lzma/')));
    assert.ok(tasks.every((t) => t.url.startsWith('https://piston-data.mojang.com/raw/')));

    // link 三态之 link：简化成复制 → 目标文件内容与源一致
    const copied = path.join(root, 'java', 'java-runtime-delta', 'legal', 'java.compiler', 'COPY_OF_ASSEMBLY');
    assert.ok(fs.statSync(copied).isFile(), 'link 应被复制成真实文件');
    assert.equal(fs.readFileSync(copied, 'utf8'), 'content:ASSEMBLY_EXCEPTION');
    // 指向不存在目标的 link 只 warn，不失败
    assert.ok(!fs.existsSync(path.join(root, 'java', 'java-runtime-delta', 'legal', 'java.compiler', 'ADDITIONAL_LICENSE_INFO')));
  });

  it('link 复制失败的条目只打 warning，不影响整个安装', async () => {
    const { installer, warnings, root } = makeInstaller({});
    await installer.ensureRuntime('java-runtime-delta');
    assert.ok(
      warnings.some((w) => w.includes('ADDITIONAL_LICENSE_INFO')),
      `应记录 link 失败警告，实得：${JSON.stringify(warnings)}`,
    );
    assert.ok(installer.isInstalled('java-runtime-delta'));
    assert.ok(fs.existsSync(path.join(root, 'java', 'java-runtime-delta', 'bin', 'java.exe')));
  });

  it('mac-os（模拟）：平台 key 与可执行文件名都换成 posix 形态', async () => {
    const { installer, root } = makeInstaller({ platform: { platform: 'darwin', arch: 'x64' } });
    const javaPath = await installer.ensureRuntime('java-runtime-delta');
    assert.equal(javaPath, path.join(root, 'java', 'java-runtime-delta', 'bin', 'java'));
    assert.ok(fs.statSync(javaPath).isFile());
    assert.ok(!fs.existsSync(path.join(root, 'java', 'java-runtime-delta', 'bin', 'java.exe')));
  });

  it('linux（模拟）：同样落 posix 形态', async () => {
    const { installer } = makeInstaller({ platform: { platform: 'linux', arch: 'x64' } });
    const javaPath = await installer.ensureRuntime('java-runtime-delta');
    assert.equal(path.basename(javaPath), 'java');
  });

  it('onProgress 上报 done/total/file，且 total 与文件任务数一致', async () => {
    const { installer, downloader } = makeInstaller({});
    const seen: { done: number; total: number; file: string }[] = [];
    await installer.ensureRuntime('java-runtime-delta', (p) => seen.push(p));
    assert.ok(seen.length > 0);
    const totals = new Set(seen.map((p) => p.total));
    const expected = downloader.calls.flat().length;
    assert.ok(totals.has(expected), `total 应为 ${expected}，实得 ${[...totals].join(',')}`);
  });

  it('目录穿越路径被拒绝', async () => {
    const fine = {
      files: {
        bin: { type: 'directory' },
        'bin/java.exe': {
          type: 'file',
          executable: true,
          downloads: { raw: { url: 'https://piston-data.mojang.com/raw/java', sha1: 'c'.repeat(40), size: 100 } },
        },
        '../../evil.txt': { type: 'file', downloads: { raw: { url: 'u', sha1: 'a', size: 1 } } },
      },
    };
    const fetcher = new FakeFetcher(makeCoarse(), {
      ...collectFine(),
      'https://piston-meta.mojang.com/win-x64/delta/manifest.json': fine,
    });
    const { installer, root } = makeInstaller({ fetcher });
    await assert.rejects(() => installer.ensureRuntime('java-runtime-delta'), /escapes runtime dir/);
    // 关键：拒绝发生在任何写盘动作之前，数据目录里不该留下半截安装
    assert.ok(!fs.existsSync(path.join(root, 'java', 'java-runtime-delta')));
  });

  it('component 名不安全时直接抛错', async () => {
    const { installer } = makeInstaller({});
    assert.throws(() => installer.runtimeDir('../etc'), /unsafe java component/);
    await assert.rejects(() => installer.ensureRuntime('../etc'), /unsafe java component/);
  });

  it('清单里没有 java 可执行文件时明确报错', async () => {
    const fine = {
      files: {
        bin: { type: 'directory' },
        'lib/modules': { type: 'file', downloads: { raw: { url: 'u1', sha1: 'a', size: 1 } } },
      },
    };
    const fetcher = new FakeFetcher(makeCoarse(), {
      ...collectFine(),
      'https://piston-meta.mojang.com/win-x64/delta/manifest.json': fine,
    });
    const { installer } = makeInstaller({ fetcher });
    await assert.rejects(() => installer.ensureRuntime('java-runtime-delta'), /没有找到 java 可执行文件/);
  });

  it('findJavaEntry 优先取 executable 且名字是 java/java.exe 的条目', () => {
    const found = findJavaEntry(makeFine('windows'));
    assert.equal(found?.relativePath, 'bin/java.exe');
    assert.equal(found?.entry.executable, true);

    // 只有 java、没标 executable 时兜底选中
    const noFlag: Record<string, JavaRuntimeFileEntry> = {
      'bin/java': { type: 'file', downloads: { raw: { url: 'u', sha1: 'a', size: 1 } } },
    };
    assert.equal(findJavaEntry(noFlag)?.relativePath, 'bin/java');

    // javac / jar 之类绝不能被当成 java 本体
    const decoy: Record<string, JavaRuntimeFileEntry> = {
      'bin/javac': { type: 'file', executable: true, downloads: { raw: { url: 'u', sha1: 'a', size: 1 } } },
      'bin/jar.exe': { type: 'file', executable: true, downloads: { raw: { url: 'u', sha1: 'a', size: 1 } } },
    };
    assert.equal(findJavaEntry(decoy), undefined);
  });
});

// ───────────────────────────── 4. 幂等 ─────────────────────────────

describe('isInstalled 与幂等', () => {
  it('未安装时 isInstalled 为 false；安装后为 true', async () => {
    const { installer } = makeInstaller({});
    assert.equal(installer.isInstalled('java-runtime-delta'), false);
    await installer.ensureRuntime('java-runtime-delta');
    assert.equal(installer.isInstalled('java-runtime-delta'), true);
  });

  it('重复调用 ensureRuntime 不重复下载，且返回同一路径', async () => {
    const { installer, downloader, fetcher } = makeInstaller({});
    const first = await installer.ensureRuntime('java-runtime-delta');
    const afterFirst = downloader.taskCount;
    const coarseAfterFirst = fetcher.coarseCalls;
    assert.ok(afterFirst > 0);

    const second = await installer.ensureRuntime('java-runtime-delta');
    const third = await installer.ensureRuntime('java-runtime-delta');

    assert.equal(first, second);
    assert.equal(second, third);
    assert.equal(downloader.taskCount, afterFirst, '第二次调用不应再产生下载任务');
    assert.equal(fetcher.coarseCalls, coarseAfterFirst, '第二次调用不应再拉清单');
    assert.equal(downloader.calls.length, 1);
  });

  it('java 本体被删掉后 isInstalled 立刻变回 false，并触发补装', async () => {
    const { installer, downloader, root } = makeInstaller({});
    const javaPath = await installer.ensureRuntime('java-runtime-delta');
    // 只删 java.exe（javaw.exe 还在，所以仍算已安装 —— 这是刻意的容忍度）
    fs.rmSync(javaPath);
    assert.equal(installer.isInstalled('java-runtime-delta'), true);
    // 把 bin/ 下所有 java 本体都删掉才算真没装
    for (const name of ['javaw.exe', 'java']) {
      const p = path.join(root, 'java', 'java-runtime-delta', 'bin', name);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    assert.equal(installer.isInstalled('java-runtime-delta'), false);
    const again = await installer.ensureRuntime('java-runtime-delta');
    assert.equal(again, javaPath);
    assert.equal(downloader.calls.length, 2);
  });

  it('目录存在但没有 java 本体 → 不算已安装', () => {
    const root = makeDataRoot();
    fs.mkdirSync(path.join(root, 'java', 'java-runtime-delta', 'bin'), { recursive: true });
    const { installer } = makeInstaller({ root });
    assert.equal(installer.isInstalled('java-runtime-delta'), false);
  });

  it('并发 ensureRuntime 合并成一次安装', async () => {
    const { installer, downloader } = makeInstaller({});
    const paths = await Promise.all([
      installer.ensureRuntime('java-runtime-delta'),
      installer.ensureRuntime('java-runtime-delta'),
      installer.ensureRuntime('java-runtime-delta'),
    ]);
    assert.equal(new Set(paths).size, 1);
    assert.equal(downloader.calls.length, 1);
  });

  it('downloadAll 部分失败时抛错并说明可续传，不静默成功', async () => {
    const downloader = new FakeDownloader();
    downloader.failUrls.add('https://piston-data.mojang.com/raw/modules');
    const { installer, root } = makeInstaller({ downloader });
    await assert.rejects(() => installer.ensureRuntime('java-runtime-delta'), /1\/4 个文件失败/);
    // modules 没下下来，但 java 本体下到了 → isInstalled 仍为 true
    // （契约判定标准就是「目录 + java 可执行文件」，不做全量 sha1 核对）
    assert.equal(installer.isInstalled('java-runtime-delta'), true);
    assert.ok(!fs.existsSync(path.join(root, 'java', 'java-runtime-delta', 'lib', 'modules')));
  });

  it('下载器说成功但 java 本体没落盘 → 抛错', async () => {
    const downloader = new FakeDownloader();
    downloader.skipWriteUrls.add('https://piston-data.mojang.com/raw/java');
    const { installer } = makeInstaller({ downloader });
    await assert.rejects(() => installer.ensureRuntime('java-runtime-delta'), /找不到可执行文件/);
  });
});

// ───────────────────────────── 5. 缓存与网络失败回退 ─────────────────────────────

describe('清单缓存：24h TTL 与网络失败回退', () => {
  it('默认 TTL 是 24 小时', () => {
    assert.equal(DEFAULT_MANIFEST_TTL_MS, 24 * 60 * 60 * 1000);
  });

  it('fetchManifest 把清单写进 <dataRoot>/java/_manifest.json 并带拉取时间', async () => {
    const { installer, root } = makeInstaller({});
    const manifest = await installer.fetchManifest();
    assert.ok(manifest['windows-x64'] !== undefined);

    const cacheFile = path.join(root, 'java', '_manifest.json');
    const metaFile = path.join(root, 'java', '_manifest.meta.json');
    assert.ok(fs.existsSync(cacheFile));
    assert.ok(fs.existsSync(metaFile));
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { fetchedAt: number; url: string };
    assert.equal(typeof meta.fetchedAt, 'number');
    assert.ok(meta.url.endsWith('/all.json'));
  });

  it('TTL 内第二次 fetchManifest 不触网', async () => {
    const { installer, fetcher } = makeInstaller({});
    await installer.fetchManifest();
    assert.equal(fetcher.coarseCalls, 1);
    await installer.fetchManifest();
    assert.equal(fetcher.coarseCalls, 1);
  });

  it('force=true 时即使新鲜也重拉', async () => {
    const { installer, fetcher } = makeInstaller({});
    await installer.fetchManifest();
    await installer.fetchManifest(true);
    assert.equal(fetcher.coarseCalls, 2);
  });

  it('超过 24h 后重新拉取', async () => {
    let now = 1_700_000_000_000;
    const { installer, fetcher } = makeInstaller({ now: () => now });
    await installer.fetchManifest();
    assert.equal(fetcher.coarseCalls, 1);

    // 24h - 1ms：仍然新鲜
    now += DEFAULT_MANIFEST_TTL_MS - 1;
    await installer.fetchManifest();
    assert.equal(fetcher.coarseCalls, 1);

    // 越过 TTL：必须重拉（换新实例，绕开进程内 memory 缓存）
    const second = makeInstaller({ root: (installer as unknown as { javaDir: string }).javaDir.replace(/[\\/]java$/, ''), now: () => now + 2 });
    await second.installer.fetchManifest();
    assert.equal(second.fetcher.coarseCalls, 1, '新实例越过 TTL 应触发一次真实拉取');
  });

  it('网络失败 → 回退过期缓存并打 warning（不抛错）', async () => {
    const root = makeDataRoot();
    const first = makeInstaller({ root, ttlMs: 1000, now: () => 1_000_000 });
    await first.installer.fetchManifest();
    assert.equal(first.fetcher.coarseCalls, 1);

    // 时间早已过期 + 断网
    const offlineFetcher = new FakeFetcher(makeCoarse(), collectFine());
    offlineFetcher.offline = true;
    const warnings: string[] = [];
    const second = new JavaRuntimeInstaller({
      downloader: new FakeDownloader(),
      dataRoot: root,
      platform: { platform: 'win32', arch: 'x64' },
      fetchTextImpl: offlineFetcher.fetch,
      manifestTtlMs: 1000,
      now: () => 9_999_999,
      logger: { warn: (m) => warnings.push(m) },
    });

    const manifest = await second.fetchManifest();
    assert.ok(isRuntimeManifest(manifest), '应返回过期缓存而不是抛错');
    assert.ok(manifest['windows-x64'] !== undefined);
    assert.equal(offlineFetcher.coarseCalls, 1, '确实尝试过网络');
    assert.ok(
      warnings.some((w) => w.includes('回退到磁盘缓存')),
      `应记录回退警告，实得：${JSON.stringify(warnings)}`,
    );
  });

  it('网络失败且无缓存 → 抛错并带 URL', async () => {
    const fetcher = new FakeFetcher(makeCoarse(), collectFine());
    fetcher.offline = true;
    const { installer } = makeInstaller({ fetcher });
    await assert.rejects(() => installer.fetchManifest(), /本地无缓存/);
  });

  it('缓存文件损坏（非法 JSON）视为无缓存，重新拉取', async () => {
    const root = makeDataRoot();
    fs.mkdirSync(path.join(root, 'java'), { recursive: true });
    fs.writeFileSync(path.join(root, 'java', '_manifest.json'), '{ not json', 'utf8');

    const { installer, fetcher } = makeInstaller({ root });
    const manifest = await installer.fetchManifest();
    assert.ok(isRuntimeManifest(manifest));
    assert.equal(fetcher.coarseCalls, 1);
    // 损坏文件被覆盖成合法内容
    assert.ok(isRuntimeManifest(JSON.parse(fs.readFileSync(path.join(root, 'java', '_manifest.json'), 'utf8'))));
  });

  it('ensureRuntime 在断网但有缓存时仍能完成安装', async () => {
    const root = makeDataRoot();
    // 先联网一次，把清单缓存铺好
    await makeInstaller({ root }).installer.fetchManifest();

    const fetcher = new FakeFetcher(makeCoarse(), collectFine());
    const downloader = new FakeDownloader();
    const second = new JavaRuntimeInstaller({
      downloader,
      dataRoot: root,
      platform: { platform: 'win32', arch: 'x64' },
      fetchTextImpl: fetcher.fetch,
      manifestTtlMs: 1,
      now: () => Date.now() + 10 * DEFAULT_MANIFEST_TTL_MS,
      logger: { warn: () => undefined },
    });
    // 运行时清单（第二段）仍需网络；这里只让 all.json 失败
    const originalFetch = fetcher.fetch;
    fetcher.fetch = async (url: string) => {
      if (url.includes('/all.json')) throw new Error('offline');
      return originalFetch(url);
    };

    const javaPath = await second.ensureRuntime('java-runtime-delta');
    assert.ok(fs.existsSync(javaPath));
  });
});

// ───────────────────────────── 6. majorVersionOf ─────────────────────────────

describe('majorVersionOf', () => {
  it('从清单 version.name 读出主版本（delta→21，gamma→17）', async () => {
    const { installer } = makeInstaller({});
    assert.equal(await installer.majorVersionOf('java-runtime-delta'), 21);
    assert.equal(await installer.majorVersionOf('java-runtime-gamma'), 17);
    assert.equal(await installer.majorVersionOf('jre-legacy'), 8);
  });

  it('清单里没有的组件返回对照表结果；完全未知返回 null', async () => {
    const { installer } = makeInstaller({});
    assert.equal(await installer.majorVersionOf('java-runtime-epsilon'), 25);
    assert.equal(await installer.majorVersionOf('totally-unknown'), null);
  });

  it('断网时退回内置对照表（不抛错）', async () => {
    const fetcher = new FakeFetcher(makeCoarse(), collectFine());
    fetcher.offline = true;
    const { installer, warnings } = makeInstaller({ fetcher });
    assert.equal(await installer.majorVersionOf('java-runtime-delta'), 21);
    assert.ok(warnings.some((w) => w.includes('内置对照表')));
  });

  it('ManifestStore 可独立使用（库 API）', async () => {
    const root = makeDataRoot();
    const fetcher = new FakeFetcher(makeCoarse(), collectFine());
    const store = new ManifestStore({ javaDir: path.join(root, 'java'), fetchTextImpl: fetcher.fetch });
    const manifest = await store.fetch();
    assert.ok(isRuntimeManifest(manifest));
    assert.equal(store.isFresh(), true);
  });

  it('镜像模式下请求的是 BMCLAPI 域名', async () => {
    const { installer, fetcher } = makeInstaller({ mirror: 'https://bmclapi2.bangbang93.com' });
    await installer.fetchManifest();
    assert.equal(
      fetcher.urls[0],
      'https://bmclapi2.bangbang93.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
    );
  });
});

// ───────────────────────────── 7. 启动接线（java-provision） ─────────────────────────────

/** 记录调用次数的 fake installer：真的把 java 落到 <dataRoot>/java/<component>/bin 下 */
class FakeInstaller implements JavaInstallerLike {
  readonly calls: { component: string; progress: { done: number; total: number; file: string }[] }[] = [];
  /** 让 ensureRuntime 抛这个错 */
  failWith: Error | undefined;
  /** 不落盘（模拟「说成功但其实没装」） */
  skipWrite = false;
  /** 清单里各组件的主版本（模拟 all.json 的真实返回）；缺省按内置表 */
  majors: Record<string, number> = {
    'jre-legacy': 8,
    'java-runtime-alpha': 16,
    'java-runtime-beta': 17,
    'java-runtime-gamma': 17,
    'java-runtime-delta': 21,
    'java-runtime-epsilon': 25,
  };
  /** majorVersionOf 是否直接抛错（模拟清单拉取失败） */
  majorLookupFails = false;
  readonly majorLookups: string[] = [];
  private readonly dataRootRef: () => string;

  // 不用 TS 参数属性（`constructor(private x)`）：Node 的 strip-only 类型剥离不支持它
  constructor(dataRootRef: () => string) {
    this.dataRootRef = dataRootRef;
  }

  async ensureRuntime(
    component: string,
    onProgress?: (p: { done: number; total: number; file: string }) => void,
  ): Promise<string> {
    const record = {
      component,
      progress: [] as { done: number; total: number; file: string }[],
    };
    this.calls.push(record);

    const emit = (p: { done: number; total: number; file: string }): void => {
      record.progress.push(p);
      onProgress?.(p);
    };

    emit({ done: 0, total: 3, file: 'bin/java.exe' });
    if (this.failWith !== undefined) throw this.failWith;

    if (!this.skipWrite) {
      const home = path.join(this.dataRootRef(), 'java', component);
      fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(home, 'bin', 'java.exe'), 'fake');
      fs.writeFileSync(path.join(home, 'bin', 'javaw.exe'), 'fake');
      // release 文件：让真实 JDK 结构也像真的
      const major = this.majors[component] ?? 21;
      fs.writeFileSync(path.join(home, 'release'), `JAVA_VERSION="${String(major)}.0.7"\n`);
      emit({ done: 3, total: 3, file: path.join(home, 'bin', 'java.exe') });
      return path.join(home, 'bin', 'java.exe');
    }
    return path.join(this.dataRootRef(), 'java', component, 'bin', 'java.exe');
  }

  isInstalled(component: string): boolean {
    return fs.existsSync(path.join(this.dataRootRef(), 'java', component, 'bin', 'java.exe'));
  }

  async majorVersionOf(component: string): Promise<number | null> {
    this.majorLookups.push(component);
    if (this.majorLookupFails) throw new Error('ENOTFOUND launchermeta.mojang.com');
    return this.majors[component] ?? null;
  }
}

/** 造一个「只有 Java 8、要求 Java 21」的数据根 */
function makeRootWithJava8Only(): string {
  const root = makeDataRoot();
  const bin = path.join(root, 'java', 'jre-legacy', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'javaw.exe'), 'fake');
  fs.writeFileSync(path.join(bin, 'java.exe'), 'fake');
  return root;
}

/** GameLauncher 端到端用例用的固定平台与账户（与 launch.test.ts 一致） */
const WINDOWS_PLATFORM: Platform = {
  name: 'windows',
  arch: 'x86_64',
  classpathSeparator: ';',
  nativesKey: 'windows',
};

const OFFLINE_ACCOUNT = {
  type: 'offline' as const,
  username: 'Steve',
  uuid: 'c06f8906-4c8a-4911-9a29-e1c62d1c12c7',
  accessToken: '0',
};

describe('启动期接线：本地没有 Java 时自动下载', () => {
  it('本地无 Java + 要求 Java 21 → 触发 ensureRuntime，返回可执行文件路径', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const progress: { phase: string; done: number; total: number; current?: string }[] = [];
    const provisioner = new JavaAutoProvisioner({
      installer,
      onProgress: (p) => progress.push(p),
    });

    const java = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );

    assert.equal(installer.calls.length, 1, '必须真的调用一次下载');
    assert.equal(installer.calls[0]?.component, 'java-runtime-delta');
    assert.ok(path.isAbsolute(java));
    assert.ok(fs.existsSync(java), `返回的路径必须真实存在：${java}`);
    // 返回的是 javaw.exe（启动器偏好，无控制台窗口）
    assert.equal(path.basename(java), 'javaw.exe');
    // 进度被透传
    assert.ok(progress.length > 0);
    assert.ok(progress.every((p) => p.phase === 'java'));
    assert.ok(progress.some((p) => p.total === 3));
  });

  it('本地已有合适 Java → 不触发下载（零调用、零进度）', async () => {
    const root = makeDataRoot();
    const home = path.join(root, 'java', 'java-runtime-delta');
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', 'java.exe'), 'fake');

    const installer = new FakeInstaller(() => root);
    const progress: unknown[] = [];
    const provisioner = new JavaAutoProvisioner({ installer, onProgress: (p) => progress.push(p) });

    const java = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );

    assert.equal(java, path.join(home, 'bin', 'java.exe'));
    assert.equal(installer.calls.length, 0, '已有可用 Java 时绝不能重复下载');
    assert.equal(progress.length, 0);
  });

  it('本地只有低版本（Java 8）→ 仍然触发下载，不拿错版本顶替', async () => {
    const root = makeRootWithJava8Only();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    const java = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    assert.equal(installer.calls.length, 1);
    assert.ok(java.includes('java-runtime-delta'));
  });

  it('版本 JSON 没声明 component → 不尝试下载，直接报原来的错', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    await assert.rejects(
      () => provisioner.ensureJava({ majorVersion: 21 }, root),
      /找不到可用的 Java 运行时/,
    );
    assert.equal(installer.calls.length, 0);
  });

  it('显式 javaPath 可用时完全不碰 installer', async () => {
    const root = makeDataRoot();
    const exe = path.join(root, 'my-java', 'bin', 'java.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'fake');

    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });
    const java = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
      exe,
    );
    assert.equal(java, exe);
    assert.equal(installer.calls.length, 0);
  });

  it('显式 javaPath 不可用 → 立刻报错，不偷偷去下载', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });
    await assert.rejects(
      () =>
        provisioner.ensureJava(
          { majorVersion: 21, component: 'java-runtime-delta' },
          root,
          path.join(root, 'nope'),
        ),
      /指定的 javaPath 不可用/,
    );
    assert.equal(installer.calls.length, 0);
  });

  it('下载失败 → 抛 JavaProvisionError，信息是人话（网络类）', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    installer.failWith = new Error('getaddrinfo ENOTFOUND launchermeta.mojang.com');
    const provisioner = new JavaAutoProvisioner({ installer });

    await assert.rejects(
      () => provisioner.ensureJava({ majorVersion: 21, component: 'java-runtime-delta' }, root),
      (err: unknown) => {
        assert.ok(err instanceof JavaProvisionError);
        assert.equal(err.kind, 'network');
        assert.match(err.message, /自动下载 Java 21（组件 java-runtime-delta）失败/);
        assert.match(err.message, /网络无法访问/);
        assert.match(err.message, /BMCLAPI/);
        assert.match(err.message, /bin\/java/);
        return true;
      },
    );
  });

  it('下载失败（磁盘满）→ 错误信息指明空间问题', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    installer.failWith = new Error('ENOSPC: no space left on device');
    const provisioner = new JavaAutoProvisioner({ installer });

    await assert.rejects(
      () => provisioner.ensureJava({ majorVersion: 21, component: 'java-runtime-delta' }, root),
      (err: unknown) => {
        assert.ok(err instanceof JavaProvisionError);
        assert.equal(err.kind, 'disk');
        assert.match(err.message, /磁盘写入失败/);
        assert.match(err.message, /MB/);
        return true;
      },
    );
  });

  it('下载失败（组件不存在）→ 错误信息指明清单里没有该组件', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    installer.failWith = new Error('java-runtime 清单里找不到组件 java-runtime-lol 的平台 windows-x64 条目。');
    const provisioner = new JavaAutoProvisioner({ installer });

    await assert.rejects(
      () => provisioner.ensureJava({ majorVersion: 21, component: 'java-runtime-lol' }, root),
      (err: unknown) => {
        assert.ok(err instanceof JavaProvisionError);
        assert.equal(err.kind, 'unknown-component');
        assert.match(err.message, /没有可用的「java-runtime-lol」运行时/);
        return true;
      },
    );
  });

  it('classifyProvisionError 分类正确', () => {
    assert.equal(classifyProvisionError('ENOTFOUND x'), 'network');
    assert.equal(classifyProvisionError('HTTP 503: url'), 'network');
    assert.equal(classifyProvisionError('ETIMEDOUT'), 'network');
    assert.equal(classifyProvisionError('ENOSPC: no space'), 'disk');
    assert.equal(classifyProvisionError('EACCES: permission denied'), 'disk');
    assert.equal(classifyProvisionError('运行时清单里没有找到 java 可执行文件'), 'unknown-component');
    assert.equal(classifyProvisionError('当前平台（freebsd/x64）没有可用的'), 'platform');
    assert.equal(classifyProvisionError('something weird'), 'unknown');
  });

  it('humanizeProvisionError 每种 kind 都给得出下一步操作', () => {
    const req = { majorVersion: 21, component: 'java-runtime-delta' };
    for (const kind of ['network', 'disk', 'unknown-component', 'platform', 'unknown'] as const) {
      const msg = humanizeProvisionError(kind, 'java-runtime-delta', req, 'raw', 'D:/data');
      assert.match(msg, /自动下载 Java 21/);
      assert.match(msg, /处理办法/);
      assert.match(msg, /raw/);
    }
  });

  it('installer 说成功但没落盘 → 抛人话错误，而不是返回一个不存在的路径', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    installer.skipWrite = true;
    const provisioner = new JavaAutoProvisioner({ installer });

    await assert.rejects(
      () => provisioner.ensureJava({ majorVersion: 21, component: 'java-runtime-delta' }, root),
      (err: unknown) => {
        assert.ok(err instanceof JavaProvisionError);
        assert.match(err.message, /下载完成但目录里仍没有可用的 java/);
        return true;
      },
    );
  });

  it('未注入 downloader 时，惰性装配给出明确提示而不是静默失败', async () => {
    const root = makeDataRoot();
    const provisioner = new JavaAutoProvisioner({});
    await assert.rejects(
      () => provisioner.ensureJava({ majorVersion: 21, component: 'java-runtime-delta' }, root),
      /尚未注入 Downloader/,
    );
  });

  it('端到端接线：用真实 JavaRuntimeInstaller + fake 网络，一次 ensureJava 完成下载', async () => {
    // 这里用真实的 installer（不是 fake），验证「provision 层 ↔ installer 层」的契约真的对得上
    const root = makeDataRoot();
    const fetcher = new FakeFetcher(makeCoarse(), collectFine());
    const downloader = new FakeDownloader();
    const realInstaller = new JavaRuntimeInstaller({
      downloader,
      dataRoot: root,
      platform: { platform: 'win32', arch: 'x64' },
      fetchTextImpl: fetcher.fetch,
      logger: { warn: () => undefined },
    });

    const progress: { phase: string; done: number; total: number; current?: string }[] = [];
    const provisioner = new JavaAutoProvisioner({
      installer: realInstaller,
      onProgress: (p) => progress.push(p),
    });

    const java = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );

    assert.ok(fs.existsSync(java));
    // provision 层统一按「启动器偏好」返回：Windows 上优先 javaw.exe（不弹控制台窗口）。
    // installer 自己产出 java.exe + javaw.exe 两个，选择权在 provision 层。
    assert.equal(path.basename(java), 'javaw.exe');
    assert.ok(path.isAbsolute(java));
    assert.ok(downloader.calls.length >= 1);
    assert.ok(progress.length > 0);
    assert.ok(progress.every((p) => p.phase === 'java'));

    // 第二次调用：本地已有，不再下载
    const callsAfterFirst = downloader.calls.length;
    const again = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    assert.equal(again, java);
    assert.equal(downloader.calls.length, callsAfterFirst, '第二次启动不该重下');
  });
});

// ───────────────────────────── 8. 按 component 精确适配（核心验收项） ─────────────────────────────

describe('按版本要求装对的那个 Java（PCL2 语义）', () => {
  it('1.8.9：jre-legacy / 8 → 只装 jre-legacy，不碰别的组件', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    const java = await provisioner.ensureJava({ majorVersion: 8, component: 'jre-legacy' }, root);

    assert.equal(installer.calls.length, 1);
    assert.equal(installer.calls[0]?.component, 'jre-legacy');
    assert.ok(java.includes(path.join('java', 'jre-legacy')), `实际路径：${java}`);
    // 校验也针对同一个组件
    assert.deepEqual(installer.majorLookups, ['jre-legacy']);
  });

  it('1.20.4：java-runtime-gamma / 17 → 只装 gamma', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    const java = await provisioner.ensureJava(
      { majorVersion: 17, component: 'java-runtime-gamma' },
      root,
    );
    assert.equal(installer.calls[0]?.component, 'java-runtime-gamma');
    assert.ok(java.includes(path.join('java', 'java-runtime-gamma')));
  });

  it('1.21：java-runtime-delta / 21 → 只装 delta', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    const java = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    assert.equal(installer.calls[0]?.component, 'java-runtime-delta');
    assert.ok(java.includes(path.join('java', 'java-runtime-delta')));
  });

  it('多版本共存：1.21 + 1.8.9 各自独立，互不覆盖', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    const java21 = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    const java8 = await provisioner.ensureJava({ majorVersion: 8, component: 'jre-legacy' }, root);

    // 两个 Java 同时存在且路径不同
    assert.notEqual(java21, java8);
    assert.ok(fs.existsSync(java21), 'Java 21 必须还在');
    assert.ok(fs.existsSync(java8), 'Java 8 必须也还在');
    assert.ok(java21.includes('java-runtime-delta'));
    assert.ok(java8.includes('jre-legacy'));
    assert.equal(installer.calls.length, 2, '两个组件各装一次，共两次');

    // 再启动 1.21：复用 delta，不再下载；1.8.9 也复用
    const again21 = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    const again8 = await provisioner.ensureJava({ majorVersion: 8, component: 'jre-legacy' }, root);
    assert.equal(again21, java21);
    assert.equal(again8, java8);
    assert.equal(installer.calls.length, 2, '复用不该新增下载');
  });

  it('已有 component 就复用：第二次调用零下载、零清单请求', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const lookupsBefore = installer.majorLookups.length;
    const provisioner = new JavaAutoProvisioner({ installer });

    const first = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    const installCount = installer.calls.length;
    const lookupCount = installer.majorLookups.length;
    assert.equal(installCount, 1);
    assert.ok(lookupCount > lookupsBefore, '首次需要校验版本');

    for (let i = 0; i < 3; i++) {
      const again = await provisioner.ensureJava(
        { majorVersion: 21, component: 'java-runtime-delta' },
        root,
      );
      assert.equal(again, first);
    }
    assert.equal(installer.calls.length, installCount, '3 次复用后下载次数不变');
  });

  it('复用路径也不漏掉版本校验：已装但清单版本不符 → 报错（不硬启）', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    // 先正常装好
    await new JavaAutoProvisioner({ installer }).ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    const installCount = installer.calls.length;

    // 模拟清单变更：delta 现在实际是 Java 17
    installer.majors['java-runtime-delta'] = 17;

    await assert.rejects(
      () =>
        new JavaAutoProvisioner({ installer }).ensureJava(
          { majorVersion: 21, component: 'java-runtime-delta' },
          root,
        ),
      (err: unknown) => {
        assert.ok(err instanceof JavaProvisionError);
        assert.equal(err.kind, 'version-mismatch');
        assert.match(err.message, /Java 版本不一致，拒绝启动/);
        assert.match(err.message, /实际是 Java 17/);
        assert.match(err.message, /需要 Java 21/);
        assert.match(err.message, /已安装的运行时版本与版本要求不符/);
        return true;
      },
    );
    assert.equal(installer.calls.length, installCount, '校验失败时不该悄悄重装');
  });

  it('下载前也校验：清单说 gamma 是 17，但版本 JSON 要 21 → 拒绝下载并报错', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    await assert.rejects(
      () => provisioner.ensureJava({ majorVersion: 21, component: 'java-runtime-gamma' }, root),
      (err: unknown) => {
        assert.ok(err instanceof JavaProvisionError);
        assert.equal(err.kind, 'version-mismatch');
        assert.match(err.message, /实际是 Java 17/);
        assert.match(err.message, /手动安装 Java 21/);
        return true;
      },
    );
    assert.equal(installer.calls.length, 0, '版本不符时一个字节都不该下');
  });

  it('本机只有 Java 8、版本要 21 → 触发下载（不拿 Java 8 硬启）', async () => {
    const root = makeRootWithJava8Only();
    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    const java = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    assert.equal(installer.calls.length, 1, '必须触发下载');
    assert.equal(installer.calls[0]?.component, 'java-runtime-delta');
    assert.ok(java.includes('java-runtime-delta'));
    // 绝不能用本机那个 Java 8
    assert.ok(!java.includes('jre-legacy'), `不能拿 Java 8 顶替，实际：${java}`);
  });

  it('本机 Java 8 目录在别处（非 component 路径）也不会被 component 匹配误用', async () => {
    const root = makeDataRoot();
    // 一个「路径里有 21」的旧式目录，但不是 java-runtime-delta
    const other = path.join(root, 'java', 'jdk-21-manual', 'bin');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'java.exe'), 'fake');

    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });
    const java = await provisioner.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    assert.equal(installer.calls.length, 1, '没有精确的 component 目录就必须下载');
    assert.ok(java.includes('java-runtime-delta'));
    assert.ok(!java.includes('jdk-21-manual'));
  });

  it('清单拉取失败（断网）时跳过校验，不阻断已装好的 Java', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    await new JavaAutoProvisioner({ installer }).ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );

    // 断网：majorVersionOf 抛错
    installer.majorLookupFails = true;
    const warnings: string[] = [];
    const offline = new JavaAutoProvisioner({
      installer,
      logger: { warn: (m) => warnings.push(m) },
    });
    const java = await offline.ensureJava(
      { majorVersion: 21, component: 'java-runtime-delta' },
      root,
    );
    assert.ok(fs.existsSync(java));
    assert.ok(warnings.some((w) => w.includes('跳过校验')), `应记录跳过校验：${JSON.stringify(warnings)}`);
  });

  it('清单里查不到该组件（返回 null）时不误判为不符，交给下载阶段报错', async () => {
    const root = makeDataRoot();
    const installer = new FakeInstaller(() => root);
    installer.majors = {}; // majorVersionOf → null
    installer.failWith = new Error('java-runtime 清单里找不到组件 x 的平台 windows-x64 条目。');
    const provisioner = new JavaAutoProvisioner({ installer });

    await assert.rejects(
      () => provisioner.ensureJava({ majorVersion: 21, component: 'x' }, root),
      (err: unknown) => {
        assert.ok(err instanceof JavaProvisionError);
        assert.equal(err.kind, 'unknown-component');
        return true;
      },
    );
  });

  it('GameLauncher 端到端：1.21 缺 Java → 自动下载 → buildCommand 拿到 javaw', async () => {
    // 用真实 GameLauncher，验证「点启动」这条链路真的会触发下载
    const root = makeDataRoot();
    const instanceDir = path.join(root, 'instances', '1.21');
    fs.mkdirSync(instanceDir, { recursive: true });

    const installer = new FakeInstaller(() => root);
    const provisioner = new JavaAutoProvisioner({ installer });

    const version: VersionJson = {
      id: '1.21',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      assets: '17',
      javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
      libraries: [],
      arguments: {
        game: ['--username', '${auth_player_name}'],
        jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
      },
    };

    const launcher = new GameLauncher({
      versionRepo: {
        fetchVersion: async () => structuredClone(version),
        resolveInherited: async (j) => j,
      },
      dataRoot: root,
      platform: WINDOWS_PLATFORM,
      javaProvisioner: provisioner,
    });

    const cmd = await launcher.buildCommand({
      versionId: '1.21',
      instanceDir,
      account: OFFLINE_ACCOUNT,
    });

    assert.equal(installer.calls.length, 1, '点启动必须触发一次自动下载');
    assert.equal(installer.calls[0]?.component, 'java-runtime-delta');
    assert.ok(fs.existsSync(cmd.java), `启动命令里的 java 必须真实存在：${cmd.java}`);
    assert.equal(path.basename(cmd.java), 'javaw.exe');
  });
});
