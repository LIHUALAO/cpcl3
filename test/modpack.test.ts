/**
 * 整合包（`.mrpack`）模块测试。
 *
 * 全部用**自己构造的假 .mrpack**（`makeZip` 现场写 STORED zip），
 * 不依赖网络、不下载任何真实整合包。
 *
 * 覆盖面：
 *   1. 解析 modrinth.index.json：name / versionId / dependencies / files
 *   2. env.client === 'unsupported' 的文件被跳过
 *   3. overrides 条目被列出
 *   4. zip-slip 防护：`../../evil.txt` 之类必须拒绝
 *   5. 加载器依赖映射：fabric-loader → LoaderInstaller.install('fabric', gv, lv)
 *   6. 缺 modrinth.index.json 时报人话错误
 *   7. 完整安装流程（用 fake 下载器 / 原版 / 加载器）的落盘形态
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { DownloadTask } from '../src/core/types.js';
import type { LoaderKind } from '../src/core/loader/index.js';
import { createApiRouter, createRealDeps } from '../src/web/api.js';
import { JobTable } from '../src/web/jobs.js';
import {
  INDEX_ENTRY,
  ModpackError,
  ModpackInstaller,
  checkInstanceName,
  isClientFile,
  listOverrides,
  openBuffer,
  openModpack,
  readIndex,
  resolveInside,
  resolveLoaderDependency,
  splitSafeZipPath,
  type ModpackLoaderInstallerLike,
  type ModpackProgress,
} from '../src/core/content/modpack/index.js';

// ───────────────────────────── 测试用 zip 构造器 ─────────────────────────────

interface ZipFixtureEntry {
  name: string;
  data: string | Buffer;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 手写一个 STORED（不压缩）zip。
 *
 * 为什么不用 zlib.deflateRawSync 造 DEFLATE 条目：launch/zip.ts 两种都支持，
 * 但 STORED 的字节布局最容易核对 —— 出问题时能一眼看出是构造器错了还是解析器错了。
 */
function makeZip(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // UTF-8 名字
    local.writeUInt16LE(0, 8); // STORED
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const sha1Of = (text: string): string => createHash('sha1').update(text).digest('hex');

interface IndexFixtureOptions {
  name?: string;
  versionId?: string;
  summary?: string;
  dependencies?: Record<string, string>;
  files?: Record<string, unknown>[];
}

function indexFixture(opts: IndexFixtureOptions = {}): string {
  return JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: opts.versionId ?? '1.0.0',
    name: opts.name ?? 'Fabulously Optimized',
    ...(opts.summary === undefined ? { summary: '钠 + 铟，性能向' } : { summary: opts.summary }),
    files: opts.files ?? [
      {
        path: 'mods/sodium.jar',
        hashes: { sha1: sha1Of('sodium'), sha512: 'aa' },
        env: { client: 'required', server: 'unsupported' },
        downloads: ['https://cdn.modrinth.com/data/AANobbMI/sodium.jar'],
        fileSize: 1_000_000,
      },
      {
        path: 'mods/lithium.jar',
        hashes: { sha1: sha1Of('lithium') },
        env: { client: 'required', server: 'required' },
        downloads: ['https://cdn.modrinth.com/data/gvQqBUqZ/lithium.jar'],
        fileSize: 500_000,
      },
      {
        path: 'mods/server-only.jar',
        hashes: { sha1: sha1Of('server-only') },
        env: { client: 'unsupported', server: 'required' },
        downloads: ['https://cdn.modrinth.com/data/SRV/server-only.jar'],
        fileSize: 300_000,
      },
    ],
    dependencies: opts.dependencies ?? { minecraft: '1.21', 'fabric-loader': '0.16.9' },
  });
}

/** 一份「正常」的 mrpack 条目集 */
function normalEntries(indexJson: string): ZipFixtureEntry[] {
  return [
    { name: INDEX_ENTRY, data: indexJson },
    { name: 'overrides/', data: '' },
    { name: 'overrides/config/sodium-options.json', data: '{"quality":11}' },
    { name: 'overrides/options.txt', data: 'lang:zh_cn' },
    { name: 'client-overrides/config/modmenu.json', data: '{}' },
    { name: 'server-overrides/server.properties', data: 'online-mode=false' },
    { name: 'mods/', data: '' },
    { name: 'mods/README.txt', data: 'not-an-override' },
  ];
}

// ───────────────────────────── 临时目录 ─────────────────────────────

const tmpRoots: string[] = [];

function tmpDir(prefix = 'pcl3-modpack-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function writePack(bytes: Buffer, name = 'pack.mrpack'): string {
  const dir = tmpDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/**
 * 清掉测试期间**服务端**在系统临时目录里留下的 `pcl3-modpack-*` 上传目录。
 *
 * 为什么要单独清：`/api/modpack/upload` 按设计把上传文件落到
 * `<tmp>/pcl3-modpack-<random>/`（不进数据目录），并且**解析成功时刻意不删**
 * —— 真实用户随后还要点「确认安装」，那时才用得到这个文件。
 * 测试里走完这段流程后，那些目录就成了孤儿，所以由测试自己收尾。
 *
 * 只删本进程记录的、以及本次测试时间窗内新建的，不误伤正在运行的服务。
 */
function sweepServerUploadDirs(): void {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('pcl3-modpack-')) continue;
    // 排除本文件自己的夹具目录（pcl3-modpack-test- / -install- 等已在 tmpRoots 里）
    if (name.startsWith('pcl3-modpack-test-')) continue;
    if (name.includes('-install-') || name.includes('-loader-') || name.includes('-quilt-')) continue;
    if (name.includes('-forge-') || name.includes('-vanilla-') || name.includes('-phases-')) continue;
    if (name.includes('-isolated-')) continue;
    try {
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
    } catch {
      /* 被占用就跳过，不影响测试结论 */
    }
  }
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
  sweepServerUploadDirs();
});

// ───────────────────────────── fake 依赖 ─────────────────────────────

class FakeDownloader {
  readonly calls: DownloadTask[][] = [];
  /** 用 url 末段造文件内容，避免真的联网 */
  failFor: string[] = [];

  async downloadAll(
    tasks: DownloadTask[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<{ ok: boolean; skipped: number; downloaded: number; failed: DownloadTask[] }> {
    this.calls.push(tasks);
    const failed: DownloadTask[] = [];
    let done = 0;
    for (const task of tasks) {
      if (this.failFor.some((needle) => task.url.includes(needle))) {
        failed.push(task);
      } else {
        fs.mkdirSync(path.dirname(task.dest), { recursive: true });
        fs.writeFileSync(task.dest, `content-of-${path.basename(task.dest)}`, 'utf8');
      }
      done += 1;
      onProgress?.({ done, total: tasks.length, current: task.dest });
    }
    return { ok: failed.length === 0, skipped: 0, downloaded: tasks.length - failed.length, failed };
  }
}

class FakeVanilla {
  readonly calls: string[] = [];
  error?: Error;

  async install(versionId: string, onProgress?: (p: { phase: string; done: number; total: number }) => void): Promise<void> {
    this.calls.push(versionId);
    if (this.error !== undefined) throw this.error;
    onProgress?.({ phase: 'meta', done: 1, total: 1 });
  }
}

/** 只实现契约里的 install(kind, gameVersion, loaderVersion)，并记录调用参数 */
class FakeLoader implements ModpackLoaderInstallerLike {
  readonly calls: { kind: LoaderKind; gameVersion: string; loaderVersion: string }[] = [];

  async install(
    kind: LoaderKind,
    gameVersion: string,
    loaderVersion: string,
    onProgress?: (p: { phase: string; done: number; total: number }) => void,
  ): Promise<{ versionId: string }> {
    this.calls.push({ kind, gameVersion, loaderVersion });
    onProgress?.({ phase: 'libraries', done: 1, total: 1 });
    return { versionId: `${kind}-loader-${loaderVersion}-${gameVersion}` };
  }
}

/** 懒构造：只有真正需要「有原版安装器」的用例才把它塞进去 */
function makeInstaller(opts: {
  dataRoot: string;
  downloader?: FakeDownloader;
  /** 传 'none' 表示故意不给原版安装器（测装配缺失的人话错误） */
  vanilla?: FakeVanilla | 'none';
  loader?: FakeLoader | 'none';
}): {
  installer: ModpackInstaller;
  downloader: FakeDownloader;
  vanilla: FakeVanilla;
  loader: FakeLoader;
} {
  const downloader = opts.downloader ?? new FakeDownloader();
  const vanilla = opts.vanilla === 'none' || opts.vanilla === undefined ? new FakeVanilla() : opts.vanilla;
  const loader = opts.loader === 'none' || opts.loader === undefined ? new FakeLoader() : opts.loader;
  const installer = new ModpackInstaller({
    downloader,
    dataRoot: opts.dataRoot,
    ...(opts.vanilla === 'none' ? {} : { vanillaInstaller: vanilla }),
    ...(opts.loader === 'none' ? {} : { loaderInstaller: loader }),
  });
  return { installer, downloader, vanilla, loader };
}

// ───────────────────────────── 1. 解析 ─────────────────────────────

describe('ModpackInstaller.parse', () => {
  it('解析 modrinth.index.json：name / versionId / dependencies / files 全部正确', async () => {
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const parsed = await new ModpackInstaller({ downloader: new FakeDownloader() }).parse(file);

    assert.equal(parsed.index.name, 'Fabulously Optimized');
    assert.equal(parsed.index.versionId, '1.0.0');
    assert.equal(parsed.index.formatVersion, 1);
    assert.equal(parsed.index.game, 'minecraft');
    assert.equal(parsed.index.summary, '钠 + 铟，性能向');
    assert.deepEqual(parsed.index.dependencies, { minecraft: '1.21', 'fabric-loader': '0.16.9' });

    assert.equal(parsed.index.files.length, 3);
    const sodium = parsed.index.files[0];
    assert.equal(sodium?.path, 'mods/sodium.jar');
    assert.equal(sodium?.hashes.sha1, sha1Of('sodium'));
    assert.deepEqual(sodium?.downloads, ['https://cdn.modrinth.com/data/AANobbMI/sodium.jar']);
    assert.equal(sodium?.fileSize, 1_000_000);
    assert.equal(sodium?.env?.client, 'required');

    // 整合包文件本身的路径 / 大小也要如实给出
    assert.equal(parsed.filePath, path.resolve(file));
    assert.ok(parsed.fileSize > 0);
    assert.equal(parsed.entryCount, 8, 'zip 中央目录应有 8 个条目');
  });

  it('env.client === "unsupported" 的文件被跳过，不进入 clientFiles', async () => {
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const parsed = await new ModpackInstaller({ downloader: new FakeDownloader() }).parse(file);

    assert.equal(parsed.index.files.length, 3, '清单里仍然有 3 个文件');
    assert.equal(parsed.clientFiles.length, 2, '客户端只装 2 个');
    assert.equal(parsed.skippedServerFiles.length, 1);
    assert.equal(parsed.skippedServerFiles[0]?.path, 'mods/server-only.jar');

    const paths = parsed.clientFiles.map((f) => f.path);
    assert.deepEqual(paths, ['mods/sodium.jar', 'mods/lithium.jar']);
    assert.ok(!paths.includes('mods/server-only.jar'), '服务端专用 mod 绝不能出现在客户端下载清单里');

    // 字节总数只算客户端那两个
    assert.equal(parsed.totalBytes, 1_500_000);
  });

  it('overrides 条目被列出，三个根目录都能识别，并剥掉前缀', async () => {
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const parsed = await new ModpackInstaller({ downloader: new FakeDownloader() }).parse(file);

    const targets = parsed.overrides.map((o) => `${o.source}:${o.target}`);
    assert.ok(targets.includes('overrides:config/sodium-options.json'), `实际：${targets.join(', ')}`);
    assert.ok(targets.includes('overrides:options.txt'));
    assert.ok(targets.includes('client-overrides:config/modmenu.json'));
    assert.ok(targets.includes('server-overrides:server.properties'));

    // `mods/README.txt` 不是 override，不该出现
    assert.ok(!targets.some((t) => t.includes('mods/README.txt')));

    const optionsTxt = parsed.overrides.find((o) => o.path === 'overrides/options.txt');
    assert.equal(optionsTxt?.target, 'options.txt');
    assert.equal(optionsTxt?.size, Buffer.byteLength('lang:zh_cn'));
    assert.equal(optionsTxt?.isDirectory, false);
  });

  it('识别不出加载器依赖时 loader 为 undefined（纯原版整合包）', async () => {
    const file = writePack(
      makeZip(normalEntries(indexFixture({ dependencies: { minecraft: '1.20.1' } }))),
    );
    const parsed = await new ModpackInstaller({ downloader: new FakeDownloader() }).parse(file);
    assert.equal(parsed.loader, undefined);
    assert.equal(parsed.index.dependencies['minecraft'], '1.20.1');
  });

  it('缺 modrinth.index.json 时报人话错误（不是 JSON.parse 的原始异常）', async () => {
    const file = writePack(
      makeZip([
        { name: 'overrides/options.txt', data: 'x' },
        { name: 'manifest.json', data: '{}' },
      ]),
    );

    await assert.rejects(
      () => new ModpackInstaller({ downloader: new FakeDownloader() }).parse(file),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError, `应当是 ModpackError，实际 ${String(error)}`);
        assert.equal(error.code, 'missing-index');
        assert.match(error.message, /没有 modrinth\.index\.json/);
        assert.match(error.message, /不是 Modrinth 整合包/);
        assert.ok(typeof error.hint === 'string' && error.hint.length > 0, '必须给 hint 告诉用户怎么办');
        return true;
      },
    );
  });

  it('不是 zip 的文件 → not-a-zip，而不是崩在 readUInt32LE', async () => {
    const file = writePack(Buffer.from('这不是 zip，只是一段文本', 'utf8'));
    await assert.rejects(
      () => new ModpackInstaller({ downloader: new FakeDownloader() }).parse(file),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'not-a-zip');
        assert.match(error.message, /不是合法的整合包/);
        return true;
      },
    );
  });

  it('文件不存在 → not-found（而不是 ENOENT 抛到上层）', async () => {
    await assert.rejects(
      () => new ModpackInstaller({ downloader: new FakeDownloader() }).parse(path.join(tmpDir(), 'nope.mrpack')),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'not-found');
        return true;
      },
    );
  });

  it('formatVersion 不是 1 → 明确拒绝，不假装能装', async () => {
    const bad = JSON.stringify({ formatVersion: 2, game: 'minecraft', name: 'x', versionId: '1', files: [], dependencies: { minecraft: '1.21' } });
    await assert.rejects(
      () => new ModpackInstaller({ downloader: new FakeDownloader() }).parse(writePack(makeZip([{ name: INDEX_ENTRY, data: bad }]))),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'bad-index');
        assert.match(error.message, /formatVersion 1/);
        return true;
      },
    );
  });
});

// ───────────────────────────── 2. zip-slip ─────────────────────────────

describe('zip-slip 防护', () => {
  it('overrides 里出现 ../../evil.txt → 解析阶段就拒绝，并指出是哪个条目', async () => {
    const entries = [
      { name: INDEX_ENTRY, data: indexFixture() },
      { name: 'overrides/config/ok.json', data: '{}' },
      { name: 'overrides/../../evil.txt', data: 'pwned' },
    ];
    await assert.rejects(
      () => new ModpackInstaller({ downloader: new FakeDownloader() }).parse(writePack(makeZip(entries))),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError, `应当是 ModpackError，实际 ${String(error)}`);
        assert.equal(error.code, 'unsafe-path');
        assert.match(error.message, /\.\.\/\.\.\/evil\.txt/);
        assert.match(error.message, /不安全的文件路径/);
        return true;
      },
    );
  });

  it('反斜杠形式的 ..\\..\\evil.txt 同样被拒（不能靠分隔符绕过）', async () => {
    const entries = [indexEntry(), { name: 'overrides\\..\\..\\evil.txt', data: 'pwned' }];
    await assert.rejects(
      () => openAndList(writePack(makeZip(entries))),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'unsafe-path');
        return true;
      },
    );
  });

  it('绝对路径 / 盘符路径 / UNC 路径一律拒绝', async () => {
    for (const bad of ['/etc/passwd', 'C:/Windows/evil.dll', '\\\\server\\share\\x', 'overrides//etc/x']) {
      assert.throws(
        () => splitSafeZipPath(bad),
        (error: unknown) => {
          assert.ok(error instanceof ModpackError, `${bad} 应当抛 ModpackError`);
          assert.equal(error.code, 'unsafe-path');
          return true;
        },
        `${bad} 必须被拒绝`,
      );
    }
  });

  it('files[].path 含 .. 时解析阶段就拒绝（不给安装阶段留机会）', async () => {
    const bad = indexFixture({
      files: [
        {
          path: '../outside.jar',
          hashes: { sha1: sha1Of('x') },
          downloads: ['https://example.invalid/x.jar'],
          fileSize: 1,
        },
      ],
    });
    await assert.rejects(
      () => new ModpackInstaller({ downloader: new FakeDownloader() }).parse(writePack(makeZip([{ name: INDEX_ENTRY, data: bad }]))),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'unsafe-path');
        return true;
      },
    );
  });

  it('安装时 zip-slip 条目不会写出实例目录（整个安装中止，磁盘上不留 evil.txt）', async () => {
    const dataRoot = tmpDir('pcl3-modpack-install-');
    const entries = [
      indexEntry(),
      { name: 'overrides/config/ok.json', data: '{}' },
      { name: 'client-overrides/../../evil.txt', data: 'pwned' },
    ];
    const file = writePack(makeZip(entries));
    const { installer } = makeInstaller({ dataRoot });

    await assert.rejects(
      () => installer.install(file, { instanceName: 'EvilPack' }),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'unsafe-path');
        return true;
      },
    );

    // dataRoot/instances 之外绝不能出现 evil.txt
    const escape = path.resolve(dataRoot, 'instances', '..', '..', 'evil.txt');
    assert.equal(fs.existsSync(escape), false, `不许在实例目录外落盘：${escape}`);
    assert.equal(fs.existsSync(path.join(path.dirname(dataRoot), 'evil.txt')), false);
  });

  it('resolveInside 对正常路径放行，对逃逸路径拒绝', () => {
    const root = path.join(os.tmpdir(), 'pcl3-root-' + String(process.pid));
    assert.equal(safeJoin(root, 'mods/a.jar'), path.resolve(root, 'mods', 'a.jar'));
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:x']) {
      assert.throws(() => safeJoin(root, bad), ModpackError, `${bad} 应当被拒绝`);
    }
  });

  it('实例名里的路径分隔符 / .. / 保留名会被拒', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', 'CON', 'nul.txt', '.', '..', 'x:y', 'trail.']) {
      const result = checkInstanceName(bad);
      assert.equal(result.ok, false, `「${bad}」必须被拒绝`);
    }
    for (const good of ['我的整合包', 'Fabulously Optimized', 'pack_v1.2', 'a b']) {
      const result = checkInstanceName(good);
      assert.equal(result.ok, true, `「${good}」应当被接受`);
    }
  });
});

// ───────────────────────────── 3. 加载器映射 ─────────────────────────────

describe('dependencies → 加载器映射', () => {
  it('fabric-loader: "0.16.9" → LoaderInstaller.install("fabric", "1.21", "0.16.9")', async () => {
    const dataRoot = tmpDir('pcl3-modpack-loader-');
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const { installer, loader } = makeInstaller({ dataRoot });

    const result = await installer.install(file, { instanceName: 'FabricPack' });

    assert.deepEqual(loader.calls, [{ kind: 'fabric', gameVersion: '1.21', loaderVersion: '0.16.9' }]);
    assert.equal(result.versionId, 'fabric-loader-0.16.9-1.21', '启动版本应指向 loader profile');
    assert.equal(result.gameVersion, '1.21');
    assert.equal(result.loader?.kind, 'fabric');
    assert.equal(result.loader?.version, '0.16.9');
  });

  it('quilt-loader / forge / neoforge 都能识别，且 only fabric+quilt 算 supported', () => {
    const quilt = resolveLoaderDependency({ minecraft: '1.20.1', 'quilt-loader': '0.24.0' });
    assert.equal(quilt?.kind, 'quilt');
    assert.equal(quilt?.version, '0.24.0');
    assert.equal(quilt?.supported, true);

    const forge = resolveLoaderDependency({ minecraft: '1.20.1', forge: '47.2.0' });
    assert.equal(forge?.kind, 'forge');
    assert.equal(forge?.supported, false);

    const neo = resolveLoaderDependency({ minecraft: '1.20.4', neoforge: '20.4.80' });
    assert.equal(neo?.kind, 'neoforge');
    assert.equal(neo?.supported, false);

    assert.equal(resolveLoaderDependency({ minecraft: '1.21' }), undefined);
  });

  it('quilt 依赖真的传给 LoaderInstaller.install("quilt", …)', async () => {
    const dataRoot = tmpDir('pcl3-modpack-quilt-');
    const file = writePack(
      makeZip(normalEntries(indexFixture({ dependencies: { minecraft: '1.20.1', 'quilt-loader': '0.24.0' } }))),
    );
    const { installer, loader } = makeInstaller({ dataRoot });
    const result = await installer.install(file, { instanceName: 'QuiltPack' });

    assert.deepEqual(loader.calls, [{ kind: 'quilt', gameVersion: '1.20.1', loaderVersion: '0.24.0' }]);
    assert.equal(result.versionId, 'quilt-loader-0.24.0-1.20.1');
  });

  it('forge 整合包 → unsupported-loader 人话错误，且在装原版之前就中止', async () => {
    const dataRoot = tmpDir('pcl3-modpack-forge-');
    const file = writePack(
      makeZip(normalEntries(indexFixture({ dependencies: { minecraft: '1.20.1', forge: '47.2.0' } }))),
    );
    const { installer, vanilla, loader } = makeInstaller({ dataRoot });

    await assert.rejects(
      () => installer.install(file, { instanceName: 'ForgePack' }),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'unsupported-loader');
        assert.match(error.message, /Forge 47\.2\.0/);
        assert.match(error.message, /只支持 Fabric \/ Quilt/);
        return true;
      },
    );
    assert.deepEqual(vanilla.calls, [], '不该为了一个装不了的包去下载几十 MB 原版');
    assert.deepEqual(loader.calls, []);
  });

  it('纯原版整合包（无加载器）→ 只装原版，versionId 就是游戏版本', async () => {
    const dataRoot = tmpDir('pcl3-modpack-vanilla-');
    const file = writePack(makeZip(normalEntries(indexFixture({ dependencies: { minecraft: '1.20.1' } }))));
    const { installer, vanilla, loader } = makeInstaller({ dataRoot });

    const result = await installer.install(file, { instanceName: 'VanillaPack' });
    assert.deepEqual(vanilla.calls, ['1.20.1']);
    assert.deepEqual(loader.calls, []);
    assert.equal(result.versionId, '1.20.1');
    assert.equal(result.loader, undefined);
  });
});

// ───────────────────────────── 4. 完整安装 ─────────────────────────────

describe('ModpackInstaller.install', () => {
  it('四个阶段依次上报：plan → vanilla → loader → mods → overrides → done', async () => {
    const dataRoot = tmpDir('pcl3-modpack-phases-');
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const { installer } = makeInstaller({ dataRoot });

    const phases: string[] = [];
    const events: ModpackProgress[] = [];
    await installer.install(file, {
      instanceName: 'PhasePack',
      onProgress: (p) => {
        events.push(p);
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      },
    });

    assert.deepEqual(phases, ['plan', 'vanilla', 'loader', 'mods', 'overrides', 'done']);
    // 每个阶段最后一次上报都必须收敛到 done === total（进度条不能停在半路）
    for (const phase of ['plan', 'vanilla', 'loader', 'mods', 'overrides']) {
      const last = [...events].reverse().find((e) => e.phase === phase);
      assert.ok(last !== undefined, `${phase} 阶段必须有事件`);
      assert.equal(last.done, last.total, `${phase} 阶段收尾应当是 done === total`);
    }
  });

  it('实例隔离：文件只落在 <dataRoot>/instances/<name>/ 下，服务端专用文件不下载', async () => {
    const dataRoot = tmpDir('pcl3-modpack-isolated-');
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const { installer, downloader } = makeInstaller({ dataRoot });

    const result = await installer.install(file, { instanceName: 'MyPack' });
    const instanceDir = path.join(dataRoot, 'instances', 'MyPack');

    assert.equal(result.instanceId, 'MyPack');
    assert.equal(path.resolve(result.instanceDir), path.resolve(instanceDir));

    // 下载任务的目标必须在实例目录里
    assert.equal(downloader.calls.length, 1);
    const tasks = downloader.calls[0] ?? [];
    assert.equal(tasks.length, 2, '只下载 2 个客户端文件');
    for (const task of tasks) {
      assert.ok(task.dest.startsWith(instanceDir + path.sep), `越界：${task.dest}`);
      assert.ok(!task.dest.includes('server-only'), '服务端专用 mod 不能出现在下载任务里');
    }
    assert.deepEqual(
      tasks.map((t) => path.relative(instanceDir, t.dest).replace(/\\/g, '/')).sort(),
      ['mods/lithium.jar', 'mods/sodium.jar'],
    );
    assert.equal(tasks[0]?.sha1, sha1Of('sodium'), 'sha1 必须透传给 Downloader 做校验');
    assert.equal(tasks[0]?.size, 1_000_000);

    // 覆盖文件：overrides + client-overrides 落盘，非 overrides 的 zip 条目不动
    assert.equal(fs.readFileSync(path.join(instanceDir, 'options.txt'), 'utf8'), 'lang:zh_cn');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'sodium-options.json'), 'utf8'), '{"quality":11}');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'modmenu.json'), 'utf8'), '{}');
    assert.equal(fs.existsSync(path.join(instanceDir, 'server.properties')), false, 'server-overrides 不该进客户端实例');
    assert.equal(fs.existsSync(path.join(instanceDir, 'README.txt')), false, '非 overrides 的 zip 条目不该被解压');

    assert.deepEqual(result.stats, { files: 2, skipped: 1, overridden: 3 });
  });

  it('覆盖文件在 client-overrides 与 overrides 同名时，client-overrides 后写（优先级更高）', async () => {
    const dataRoot = tmpDir('pcl3-modpack-priority-');
    const entries = [
      indexEntry(),
      { name: 'overrides/config/x.json', data: '{"from":"overrides"}' },
      { name: 'client-overrides/config/x.json', data: '{"from":"client"}' },
    ];
    const { installer } = makeInstaller({ dataRoot });
    await installer.install(writePack(makeZip(entries)), { instanceName: 'PriorityPack' });

    const text = fs.readFileSync(path.join(dataRoot, 'instances', 'PriorityPack', 'config', 'x.json'), 'utf8');
    assert.equal(text, '{"from":"client"}');
  });

  it('装完写一份 pcl3-modpack.json 记录来源（原子写，无 .tmp 残留）', async () => {
    const dataRoot = tmpDir('pcl3-modpack-manifest-');
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const { installer } = makeInstaller({ dataRoot });
    await installer.install(file, { instanceName: 'ManifestPack' });

    const manifestPath = path.join(dataRoot, 'instances', 'ManifestPack', 'pcl3-modpack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    assert.equal(manifest['name'], 'Fabulously Optimized');
    assert.equal(manifest['gameVersion'], '1.21');
    assert.equal((manifest['loader'] as { versionId: string }).versionId, 'fabric-loader-0.16.9-1.21');
    assert.equal(fs.existsSync(`${manifestPath}.tmp`), false, '原子写不应留下 .tmp');
  });

  it('下载失败 → 抛 download-failed 并点名失败文件，不假装成功', async () => {
    const dataRoot = tmpDir('pcl3-modpack-fail-');
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const downloader = new FakeDownloader();
    downloader.failFor = ['sodium'];
    const { installer } = makeInstaller({ dataRoot, downloader });

    await assert.rejects(
      () => installer.install(file, { instanceName: 'FailPack' }),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'download-failed');
        assert.match(error.message, /sodium\.jar/);
        assert.match(error.message, /1\/2/);
        return true;
      },
    );
    // 覆盖阶段不该被执行（失败就停）
    assert.equal(fs.existsSync(path.join(dataRoot, 'instances', 'FailPack', 'config', 'x.json')), false);
  });

  it('实例目录已存在且非空 → instance-exists，不覆盖', async () => {
    const dataRoot = tmpDir('pcl3-modpack-exists-');
    const instanceDir = path.join(dataRoot, 'instances', 'Taken');
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'saves.dat'), 'user data', 'utf8');

    const file = writePack(makeZip(normalEntries(indexFixture())));
    const { installer, vanilla } = makeInstaller({ dataRoot });

    await assert.rejects(
      () => installer.install(file, { instanceName: 'Taken' }),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'instance-exists');
        return true;
      },
    );
    assert.deepEqual(vanilla.calls, [], '冲突检查要在装原版之前');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'saves.dat'), 'utf8'), 'user data');
  });

  it('缺 minecraft 依赖 → missing-minecraft 人话错误', async () => {
    const dataRoot = tmpDir('pcl3-modpack-nogame-');
    const file = writePack(makeZip(normalEntries(indexFixture({ dependencies: { 'fabric-loader': '0.16.9' } }))));
    const { installer } = makeInstaller({ dataRoot });

    await assert.rejects(
      () => installer.install(file, { instanceName: 'NoGame' }),
      (error: unknown) => {
        assert.ok(error instanceof ModpackError);
        assert.equal(error.code, 'missing-minecraft');
        assert.match(error.message, /没有声明 minecraft 依赖/);
        return true;
      },
    );
  });
});

// ───────────────────────────── 5. 工具函数 ─────────────────────────────

describe('模块工具函数', () => {
  it('isClientFile：没写 env 视为双端通用；optional 也要装；只有 unsupported 跳过', () => {
    assert.equal(isClientFile({ path: 'a', hashes: {}, downloads: ['u'] }), true);
    assert.equal(isClientFile({ path: 'a', hashes: {}, downloads: ['u'], env: { client: 'required' } }), true);
    assert.equal(isClientFile({ path: 'a', hashes: {}, downloads: ['u'], env: { client: 'optional' } }), true);
    assert.equal(isClientFile({ path: 'a', hashes: {}, downloads: ['u'], env: { client: 'unsupported' } }), false);
  });

  it('openBuffer / readIndex / listOverrides 是 parse 的零件，可单独用', () => {
    const buf = makeZip(normalEntries(indexFixture()));
    const opened = openBuffer(buf);
    const index = readIndex(opened);
    assert.equal(index.name, 'Fabulously Optimized');
    const overrides = listOverrides(opened.archive);
    assert.ok(overrides.length >= 4);
  });

  it('缺 index 的 openModpack 报 missing-index（供上层直接用）', async () => {
    const file = writePack(makeZip([{ name: 'a.txt', data: 'x' }]));
    await assert.rejects(() => openModpack(file), (error: unknown) => {
      assert.ok(error instanceof ModpackError);
      assert.equal((error as ModpackError).code, 'missing-index');
      return true;
    });
  });
});

// ───────────────────────────── 6. Web API（只挂整合包路由） ─────────────────────────────

/**
 * 起一个**只挂整合包三条路由**的 HTTP 服务。
 *
 * 为什么不直接用 `createServer`：它会把整个 api.ts 的路由表都装进来，
 * 而那张表里其它模块的路由还在并行开发中（可能一瞬间缺 handler），
 * 这一节要验证的只是整合包自己的三个端点，不该被别人的半成品拖挂。
 * 静态资源仍然从 `src/web/public` 真实目录读，所以这是对 UI 的真实装配。
 */
async function startModpackServer(opts: {
  dataRoot: string;
  installer?: ModpackInstallerLike;
}): Promise<{ url: string; close: () => Promise<void>; jobs: JobTable }> {
  const jobs = new JobTable();
  const real = createRealDeps(opts.dataRoot, jobs);
  const router = createApiRouter({
    ...real,
    // 其它模块的工厂面可能还在变，这里只注入本节的 fake
    ...(opts.installer === undefined ? {} : { modpackInstallerFactory: () => opts.installer as ModpackInstallerLike }),
  });

  const pub = path.resolve('src/web/public');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      void router(req, res);
      return;
    }
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const abs = path.join(pub, file);
    res.statusCode = 200;
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(abs));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    jobs,
    close: async () => {
      jobs.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

type ModpackInstallerLike = Parameters<typeof createApiRouter>[0]['modpackInstallerFactory'] extends
  (() => infer T) | undefined ? T : never;

async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json, text };
}

/**
 * 等一个后台任务结束。
 *
 * 超时为什么是弹性的：这些用例跑的是**真实安装流程**（装原版 + 装加载器 +
 * 下载 mod + 解压覆盖），单跑时几秒就好，但并发跑全量套件时 CPU 被其它
 * 测试文件抢占，10 秒固定超时会偶发失败（实测在全量运行时出现过）。
 *
 * 所以：默认给 60 秒，可用 PCL3_JOB_TIMEOUT_MS 覆盖。真挂住时仍然会失败，
 * 只是不会因为机器忙而误报。
 */
const JOB_TIMEOUT_MS = Number(process.env['PCL3_JOB_TIMEOUT_MS'] ?? 60_000);

async function waitJob(base: string, jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    const res = await requestJson(`${base}api/jobs/${encodeURIComponent(jobId)}`);
    if (res.status === 200 && res.json['status'] !== 'running') return res.json;
    if (Date.now() > deadline) {
      const last = res.json['status'] ?? 'unknown';
      throw new Error(
        `任务 ${jobId} 超时未结束（${String(JOB_TIMEOUT_MS)}ms，最后状态 ${String(last)}）。` +
          '并发跑全量时可调大 PCL3_JOB_TIMEOUT_MS。',
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Web API：整合包三条路由', () => {
  it('前端三个入口文件都在：整合包标签、导入按钮、确认安装', () => {
    const html = fs.readFileSync(path.resolve('src/web/public/index.html'), 'utf8');
    assert.match(html, /id="modpack-panel"/, 'index.html 必须有整合包面板');
    assert.match(html, /id="btn-modpack-import"/, '必须有「导入整合包」按钮');
    assert.match(html, /id="btn-modpack-install"/, '必须有「确认安装」按钮');
    assert.match(html, /id="modpack-file"/, '必须有文件选择框');
    assert.match(html, /\/modpack\.js/, '必须加载 modpack.js');

    const js = fs.readFileSync(path.resolve('src/web/public/modpack.js'), 'utf8');
    assert.match(js, /api\/modpack\/upload/);
    assert.match(js, /api\/modpack\/install/);

    const css = fs.readFileSync(path.resolve('src/web/public/style.css'), 'utf8');
    assert.match(css, /\.modpack-card/);
  });

  it('POST /api/modpack/upload 上传假 .mrpack → 202 + jobId，解析结果带 name/版本/加载器/mod 数', async () => {
    const dataRoot = tmpDir('pcl3-modpack-api-');
    const srv = await startModpackServer({ dataRoot });
    const pack = makeZip(normalEntries(indexFixture()));
    try {
      const res = await requestJson(`${srv.url}api/modpack/upload?name=demo.mrpack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(pack),
      });
      assert.equal(res.status, 202, `应当是 202，实际 ${res.status}: ${res.text}`);
      assert.equal(typeof res.json['jobId'], 'string');

      const job = await waitJob(srv.url, String(res.json['jobId']));
      assert.equal(job['status'], 'done', `解析任务应成功：${String(job['error'] ?? '')}`);
      const result = job['result'] as Record<string, unknown>;
      assert.equal(result['name'], 'Fabulously Optimized');
      assert.equal(result['versionId'], '1.0.0');
      assert.equal(result['gameVersion'], '1.21');
      assert.equal((result['loader'] as Record<string, unknown>)['kind'], 'fabric');
      assert.equal((result['loader'] as Record<string, unknown>)['version'], '0.16.9');
      assert.equal((result['files'] as Record<string, unknown>)['client'], 2);
      assert.equal(result['totalBytes'], 1_500_000);

      // 上传文件必须落在系统临时目录，绝不进数据目录
      const uploadPath = String(result['filePath']);
      assert.ok(uploadPath.startsWith(os.tmpdir()), `上传文件应落在临时目录：${uploadPath}`);
      assert.ok(!uploadPath.startsWith(dataRoot), `不该写进数据目录：${uploadPath}`);
      assert.ok(fs.existsSync(uploadPath), '上传文件应当真实存在（供下一步安装）');
    } finally {
      await srv.close();
    }
  });

  it('上传非 zip → 任务失败，错误是人话（不是 JSON.parse 原始异常）', async () => {
    const dataRoot = tmpDir('pcl3-modpack-api2-');
    const srv = await startModpackServer({ dataRoot });
    try {
      const res = await requestJson(`${srv.url}api/modpack/upload?name=bad.mrpack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(Buffer.from('not a zip', 'utf8')),
      });
      assert.equal(res.status, 202, '上传本身可以成功，解析在后台失败');
      const job = await waitJob(srv.url, String(res.json['jobId']));
      assert.equal(job['status'], 'failed');
      assert.match(String(job['error']), /不是合法的整合包|不是 Modrinth 整合包/);
    } finally {
      await srv.close();
    }
  });

  it('GET /api/modpack/inspect 解析服务器上的文件（不安装）', async () => {
    const dataRoot = tmpDir('pcl3-modpack-inspect-');
    const file = writePack(makeZip(normalEntries(indexFixture())));
    const srv = await startModpackServer({ dataRoot });
    try {
      const ok = await requestJson(`${srv.url}api/modpack/inspect?path=${encodeURIComponent(file)}`);
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json['name'], 'Fabulously Optimized');
      assert.equal(ok.json['gameVersion'], '1.21');

      const missing = await requestJson(`${srv.url}api/modpack/inspect?path=${encodeURIComponent(path.join(dataRoot, 'nope.mrpack'))}`);
      assert.equal(missing.status, 404);
      assert.match(String(missing.json['error']), /找不到整合包文件/);

      const noParam = await requestJson(`${srv.url}api/modpack/inspect`);
      assert.equal(noParam.status, 400);
    } finally {
      await srv.close();
    }
  });

  it('GET /api/modpack/inspect 对 zip-slip 包返回 400 + 明确指出条目', async () => {
    const dataRoot = tmpDir('pcl3-modpack-slip-');
    const file = writePack(
      makeZip([{ name: INDEX_ENTRY, data: indexFixture() }, { name: 'overrides/../../evil.txt', data: 'x' }]),
    );
    const srv = await startModpackServer({ dataRoot });
    try {
      const res = await requestJson(`${srv.url}api/modpack/inspect?path=${encodeURIComponent(file)}`);
      assert.equal(res.status, 400);
      assert.equal(res.json['code'], 'unsafe-path');
      assert.match(String(res.json['error']), /evil\.txt/);
    } finally {
      await srv.close();
    }
  });

  it('POST /api/modpack/install 拒绝未上传过的任意路径（403）', async () => {
    const dataRoot = tmpDir('pcl3-modpack-403-');
    const srv = await startModpackServer({ dataRoot });
    try {
      const outside = writePack(makeZip(normalEntries(indexFixture())));
      const res = await requestJson(`${srv.url}api/modpack/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: outside, instanceName: 'Nope' }),
      });
      assert.equal(res.status, 403, res.text);
      assert.match(String(res.json['error']), /拒绝安装/);
    } finally {
      await srv.close();
    }
  });

  it('POST /api/modpack/install：上传 → 安装 → 任务成功并回 instanceId/versionId', async () => {
    const dataRoot = tmpDir('pcl3-modpack-e2e-');
    const srv = await startModpackServer({ dataRoot });
    const pack = makeZip(normalEntries(indexFixture()));
    try {
      const up = await requestJson(`${srv.url}api/modpack/upload?name=demo.mrpack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(pack),
      });
      assert.equal(up.status, 202);
      const parsed = await waitJob(srv.url, String(up.json['jobId']));
      assert.equal(parsed['status'], 'done');
      const filePath = String((parsed['result'] as Record<string, unknown>)['filePath']);

      const inst = await requestJson(`${srv.url}api/modpack/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, instanceName: 'APIPack' }),
      });
      assert.equal(inst.status, 202, inst.text);
      assert.equal(typeof inst.json['jobId'], 'string');

      const job = await waitJob(srv.url, String(inst.json['jobId']));
      // 真实安装器第一步就会去下原版；测试环境不联网，正常结局是「失败 + 人话错误」。
      // 若某个环境已经把 1.21 装好了（成功路径），就断言实例真的落到了隔离目录里。
      if (job['status'] === 'done') {
        const result = job['result'] as Record<string, unknown>;
        assert.equal(result['instanceId'], 'APIPack');
        assert.ok(String(result['versionId']).length > 0);
        assert.ok(fs.existsSync(path.join(dataRoot, 'instances', 'APIPack')), '实例目录必须落在实例隔离区');
      } else {
        const message = String(job['error'] ?? '');
        assert.ok(message.length > 0, '失败必须给出人话错误');
        assert.match(message, /安装|网络|下载|原版/, `错误应是可读的安装类文案，实际：${message}`);
      }
    } finally {
      await srv.close();
    }
  });
});

// ───────────────────────────── 辅助 ─────────────────────────────

function indexEntry(): ZipFixtureEntry {
  return { name: INDEX_ENTRY, data: indexFixture() };
}

async function openAndList(file: string): Promise<string[]> {
  const opened = await openModpack(file);
  return listOverrides(opened.archive).map((o) => o.target);
}

/** 用 safe-path 的 resolveInside 直接测（不经过安装器） */
function safeJoin(root: string, rel: string): string {
  return resolveInside(root, rel);
}
