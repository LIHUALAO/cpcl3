/**
 * content/packs 模块测试（node --test 内置 runner）。
 *
 * 覆盖派单要求的所有验收点：
 *   1. pack.mcmeta 两种格式：数字 pack_format / 对象区间
 *   2. description 两种格式：字符串 / 聊天组件（含 extra 嵌套与数组）
 *   3. 光影包识别：含 shaders/ → 判定为 shader；没有 mcmeta 也不报错
 *   4. 三类内容各自落到正确目录
 *   5. 数据包带 saveName → saves/<存档名>/datapacks/
 *   6. 路径穿越被拒：`../`、`..\\`、绝对路径、盘符、NUL
 *   7. 启用/禁用改名正确（加/去 .disabled）
 *
 * 另外覆盖：列表不因坏包失败、URL 安装走注入的下载器、损坏 zip 不 500。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_PACK_BYTES,
  PACK_KINDS,
  PackManager,
  PackValidationError,
  checkFilename,
  chatToPlainText,
  detectShader,
  diskNameOf,
  enabledNameOf,
  isPackKind,
  listSaves,
  parsePackKind,
  parsePackMetaText,
  sanitizeFilename,
  tryOpenZip,
} from '../src/core/content/packs/index.js';
import type { PackDownloaderLike } from '../src/core/content/packs/index.js';

import {
  buildZip,
  dataPackZip,
  mcmetaNumeric,
  mcmetaRange,
  notAZip,
  resourcePackZip,
  shaderPackZip,
} from './packs.zip-fixtures.js';
import {
  cleanupTempDirs,
  listLeftoverPackTempDirs,
  makeTempDir,
  pendingTempDirCount,
  removeTempDir,
} from './packs.temp.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/**
 * 临时目录一律走登记簿（packs.temp.ts）。
 * 双保险：每个用例自己 `finally` 删 + 文件级 `after()` 兜底 + `process.on('exit')` 收尾，
 * 保证「断言中途抛错」也不会在 %TEMP% 里留下 pcl3-packs-* 垃圾。
 */
after(() => {
  cleanupTempDirs();
});

/** 记录用例开始时 %TEMP% 里已有的 pcl3-packs* 目录，用于结尾自检 */
const PREEXISTING_PACK_TEMP = new Set(listLeftoverPackTempDirs());

function tmpRoot(tag: string): string {
  return makeTempDir(`packs-${tag}`);
}

/** 造一个实例目录（只是目录，不写 settings） */
function makeInstance(root: string, id = '1.21'): string {
  const dir = path.join(root, 'instances', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造存档：saves/<name>/level.dat */
function makeSave(instanceDir: string, name: string): string {
  const dir = path.join(instanceDir, 'saves', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), Buffer.from([0x0a, 0x00, 0x00]));
  return dir;
}

/** 把 zip 字节写成一个临时源文件 */
function writeTempZip(dir: string, name: string, data: Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

/** 假的下载器：把预置字节「下载」到 dest，并记录被调用的参数 */
class FakeDownloader implements PackDownloaderLike {
  readonly calls: { url: string; dest: string; sha1?: string }[] = [];
  private readonly payload: Buffer | Error;

  constructor(payload: Buffer | Error) {
    this.payload = payload;
  }

  async downloadAll(
    tasks: { url: string; dest: string; sha1?: string; size?: number }[],
    onProgress?: (p: { done: number; total: number; current: string }) => void,
  ): Promise<{ ok: boolean; skipped: number; downloaded: number; failed: unknown[] }> {
    const failed: unknown[] = [];
    let downloaded = 0;
    for (const task of tasks) {
      this.calls.push({ url: task.url, dest: task.dest, ...(task.sha1 ? { sha1: task.sha1 } : {}) });
      if (this.payload instanceof Error) {
        failed.push({ url: task.url, error: this.payload });
        onProgress?.({ done: 1, total: 1, current: task.dest });
        continue;
      }
      fs.mkdirSync(path.dirname(task.dest), { recursive: true });
      fs.writeFileSync(task.dest, this.payload);
      downloaded += 1;
      onProgress?.({ done: 1, total: 1, current: task.dest });
    }
    return { ok: failed.length === 0, skipped: 0, downloaded, failed };
  }
}

// ───────────────────────────── 1. mcmeta 解析 ─────────────────────────────

test('pack.mcmeta: 数字 pack_format + 字符串 description', () => {
  const meta = parsePackMetaText(mcmetaNumeric(15, '树叶重制版'));
  assert.equal(meta.error, undefined);
  assert.equal(meta.packFormat, 15);
  assert.equal(meta.description, '树叶重制版');
  assert.deepEqual(meta.packFormatRange, { minInclusive: 15, maxInclusive: 15 });
});

test('pack.mcmeta: 对象区间 pack_format 取 min_inclusive，区间完整保留', () => {
  const meta = parsePackMetaText(mcmetaRange(15, 18, '兼容 1.20~1.20.2'));
  assert.equal(meta.error, undefined);
  assert.equal(meta.packFormat, 15, '对象区间必须取 min_inclusive（与 Minecraft 的比较口径一致）');
  assert.deepEqual(meta.packFormatRange, { minInclusive: 15, maxInclusive: 18 });
  assert.equal(meta.description, '兼容 1.20~1.20.2');
});

test('pack.mcmeta: description 是聊天组件 {"text":...}', () => {
  const meta = parsePackMetaText(mcmetaNumeric(22, { text: '光影材质包' }));
  assert.equal(meta.packFormat, 22);
  assert.equal(meta.description, '光影材质包');
});

test('pack.mcmeta: 聊天组件带 color 字段仍能拍平', () => {
  const meta = parsePackMetaText(
    JSON.stringify({ pack: { pack_format: 9, description: { text: '彩色描述', color: 'gold' } } }),
  );
  assert.equal(meta.description, '彩色描述');
});

test('聊天组件: 数组 / extra 嵌套 / translate 都拍平', () => {
  // 数组 = 组件序列（1.20.3+ 的 description 就是数组），元素之间用空格连接
  assert.equal(chatToPlainText(['第一行', '第二行']), '第一行 第二行');
  assert.equal(chatToPlainText([]), undefined);
  // extra 是同一行的续写 → 空格连接
  assert.equal(chatToPlainText({ text: 'A', extra: ['B', { text: 'C' }] }), 'A B C');
  // translate 我们翻译不了，如实显示键名，而不是当成空
  assert.equal(chatToPlainText({ translate: 'pack.description' }), 'pack.description');
  // 空组件 → undefined（不硬造一个空字符串）
  assert.equal(chatToPlainText({}), undefined);
  assert.equal(chatToPlainText(null), undefined);
  // 叶子里的真实换行必须收成一行，不能把列表行撑爆
  assert.equal(chatToPlainText('第一行\n第二行'), '第一行 / 第二行');
  assert.equal(chatToPlainText({ text: '第一行\n第二行' }), '第一行 / 第二行');
});

test('pack.mcmeta: 坏 JSON / 缺 pack / pack 不是对象 → 返回 error 而不是抛错', () => {
  assert.match(String(parsePackMetaText('{ broken').error), /不是合法 JSON/);
  assert.match(String(parsePackMetaText('{}').error), /缺少 pack/);
  assert.match(String(parsePackMetaText('{"pack":[]}').error), /不是对象/);
  assert.match(String(parsePackMetaText('[1,2,3]').error), /顶层不是对象/);
});

test('pack.mcmeta: UTF-8 BOM 不影响解析（真实资源包里很常见）', () => {
  const meta = parsePackMetaText(`\uFEFF${mcmetaNumeric(34, '带 BOM 的包')}`);
  assert.equal(meta.packFormat, 34);
  assert.equal(meta.description, '带 BOM 的包');
});

test('pack.mcmeta: 1.20.2+ 的 supported_formats 在 pack_format 缺失时顶上来', () => {
  const meta = parsePackMetaText(
    JSON.stringify({ pack: { description: 'd', supported_formats: { min_inclusive: 15, max_inclusive: 22 } } }),
  );
  assert.equal(meta.packFormat, 15);
  assert.equal(meta.packFormatRange?.maxInclusive, 22);
});

// ───────────────────────────── 2. 光影包识别 ─────────────────────────────

test('光影包: zip 里有 shaders/ → 识别为光影包，且没有 mcmeta 也不报错', async () => {
  const buf = shaderPackZip();
  const opened = tryOpenZip(buf);
  assert.ok('archive' in opened, 'zip 应能打开');
  assert.equal(detectShader(opened.archive), true, 'shaders/final.fsh 必须被判为光影包');

  const root = tmpRoot('shader-detect');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    await mgr.installFromBuffer('1.21', 'shader', buf, { filename: 'Complementary.zip' });

    const list = await mgr.list('1.21', 'shader');
    assert.equal(list.length, 1);
    assert.equal(list[0]?.hasShaders, true);
    assert.equal(list[0]?.mcmetaError, undefined, '光影包本来就没有 mcmeta，不该被标记为错误');
    assert.equal(list[0]?.packFormat, undefined);
    assert.equal(list[0]?.description, undefined);
  } finally {
    removeTempDir(root);
  }
});

test('光影包: 只有无关目录 → 不认（hasShaders=false，带说明但不报错）', () => {
  const opened = tryOpenZip(shaderPackZip({ withEntry: false }));
  assert.ok('archive' in opened);
  assert.equal(detectShader(opened.archive), false);
});

test('光影包: 空 zip / 坏 zip 不抛错', () => {
  const empty = tryOpenZip(buildZip([]));
  assert.ok('archive' in empty);
  assert.equal(detectShader(empty.archive), false);

  const bad = tryOpenZip(notAZip());
  assert.ok('error' in bad, '坏 zip 必须返回 error 而不是抛异常');
});

// ───────────────────────────── 3. 三类内容落盘目录 ─────────────────────────────

test('三类内容各自落到正确目录（resourcepacks / datapacks / shaderpacks）', async () => {
  const root = tmpRoot('dirs');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root, downloader: new FakeDownloader(Buffer.alloc(0)) });

    // 用 installFromBuffer 走完整落盘流程
    await mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip(), { filename: '材质包.zip' });
    await mgr.installFromBuffer('1.21', 'datapack', dataPackZip(), { filename: '全局数据包.zip' });
    await mgr.installFromBuffer('1.21', 'shader', shaderPackZip(), { filename: '光影.zip' });

    assert.ok(fs.existsSync(path.join(instanceDir, 'resourcepacks', '材质包.zip')));
    assert.ok(fs.existsSync(path.join(instanceDir, 'datapacks', '全局数据包.zip')));
    assert.ok(fs.existsSync(path.join(instanceDir, 'shaderpacks', '光影.zip')));

    assert.equal(path.basename(mgr.targetDir('1.21', 'resourcepack')), 'resourcepacks');
    assert.equal(path.basename(mgr.targetDir('1.21', 'datapack')), 'datapacks');
    assert.equal(path.basename(mgr.targetDir('1.21', 'shader')), 'shaderpacks');

    // 不传 saveName 时不碰 saves/
    assert.equal(fs.existsSync(path.join(instanceDir, 'saves')), false, '全局数据包不该创建 saves/');
  } finally {
    removeTempDir(root);
  }
});

test('数据包带 saveName → saves/<存档名>/datapacks/', async () => {
  const root = tmpRoot('save-datapack');
  try {
    const instanceDir = makeInstance(root);
    makeSave(instanceDir, '新的世界');
    const mgr = new PackManager({ dataRoot: root });

    const target = mgr.targetDir('1.21', 'datapack', '新的世界');
    assert.equal(target, path.join(instanceDir, 'saves', '新的世界', 'datapacks'));

    await mgr.installFromBuffer('1.21', 'datapack', dataPackZip(), {
      filename: '刷怪塔.zip',
      saveName: '新的世界',
    });
    assert.ok(fs.existsSync(path.join(instanceDir, 'saves', '新的世界', 'datapacks', '刷怪塔.zip')));
    assert.equal(
      fs.existsSync(path.join(instanceDir, 'datapacks', '刷怪塔.zip')),
      false,
      '带存档的数据包不能同时落进全局目录',
    );

    // 存档隔离：两个存档各自独立
    makeSave(instanceDir, '第二个世界');
    await mgr.installFromBuffer('1.21', 'datapack', dataPackZip(), {
      filename: '专属.zip',
      saveName: '第二个世界',
    });
    const first = await mgr.list('1.21', 'datapack', '新的世界');
    const second = await mgr.list('1.21', 'datapack', '第二个世界');
    assert.deepEqual(first.map((p) => p.filename), ['刷怪塔.zip']);
    assert.deepEqual(second.map((p) => p.filename), ['专属.zip']);
  } finally {
    removeTempDir(root);
  }
});

test('资源包/光影包传了 saveName 也仍然落到实例根目录（忽略而不是报错）', async () => {
  const root = tmpRoot('save-ignored');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    await mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip(), {
      filename: 'a.zip',
      saveName: '某个世界',
    });
    assert.ok(fs.existsSync(path.join(instanceDir, 'resourcepacks', 'a.zip')));
  } finally {
    removeTempDir(root);
  }
});

test('list 会读出 mcmeta 元数据（pack_format + 中文 description）', async () => {
  const root = tmpRoot('meta-list');
  try {
    makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    await mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip({
      mcmeta: mcmetaRange(15, 18, { text: '更好的树叶' }),
    }), { filename: 'leaves.zip' });

    const list = await mgr.list('1.21', 'resourcepack');
    assert.equal(list.length, 1);
    assert.equal(list[0]?.packFormat, 15);
    assert.equal(list[0]?.description, '更好的树叶');
    assert.equal(list[0]?.enabled, true);
    assert.ok((list[0]?.size ?? 0) > 0);
  } finally {
    removeTempDir(root);
  }
});

test('list: 目录不存在返回空数组；坏 zip 也列出来（只标 mcmetaError，不抛错）', async () => {
  const root = tmpRoot('list-bad');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });

    assert.deepEqual(await mgr.list('1.21', 'resourcepack'), [], '目录不存在 = 空列表，不是错误');

    fs.mkdirSync(path.join(instanceDir, 'shaderpacks'), { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'shaderpacks', 'broken.zip'), notAZip());
    fs.writeFileSync(path.join(instanceDir, 'shaderpacks', 'notes.txt'), 'not a pack');

    const list = await mgr.list('1.21', 'shader');
    assert.equal(list.length, 1, '只列 .zip，不列 notes.txt');
    assert.equal(list[0]?.filename, 'broken.zip');
    assert.match(String(list[0]?.mcmetaError), /不是合法的 zip/);
  } finally {
    removeTempDir(root);
  }
});

// ───────────────────────────── 4. 路径穿越 ─────────────────────────────

test('路径穿越: filename 含 ../ 或 ..\\ 一律被拒', async () => {
  const root = tmpRoot('traversal');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });

    const evil = ['../evil.zip', '..\\evil.zip', 'a/../../evil.zip', '..\\..\\windows\\evil.zip'];
    for (const name of evil) {
      assert.notEqual(checkFilename(name), null, `checkFilename 必须拒绝 ${name}`);
      await assert.rejects(
        () => mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip(), { filename: name }),
        (error: unknown) => {
          assert.ok(error instanceof PackValidationError, `${name} 应该抛 PackValidationError`);
          return true;
        },
      );
    }

    // 什么都没有被写到实例目录之外
    assert.equal(fs.existsSync(path.join(root, 'evil.zip')), false);
    assert.equal(fs.existsSync(path.join(instanceDir, '..', 'evil.zip')), false);
  } finally {
    removeTempDir(root);
  }
});

test('路径穿越: 绝对路径 / 盘符 / UNC / NUL / 保留名 都被拒', () => {
  const cases = [
    'C:\\Windows\\evil.zip',
    '/etc/passwd.zip',
    '\\\\server\\share\\evil.zip',
    'C:evil.zip',
    'evil\u0000.zip',
    'evil\n.zip',
    '..',
    '.',
    '...',
    'evil.zip.',
    'evil.zip ',
    'CON.zip',
    'nul.zip',
  ];
  for (const bad of cases) {
    assert.notEqual(checkFilename(bad), null, `必须拒绝：${JSON.stringify(bad)}`);
  }

  // 正常的文件名必须放行（含中文、空格、括号、加号）
  for (const good of ['材质包.zip', 'Better Leaves 1.21.zip', 'pack(1).zip', 'a+b.zip', '中文 名字 [v2].zip']) {
    assert.equal(checkFilename(good), null, `不该拒绝：${good}`);
  }
});

test('路径穿越: instanceId / saveName 也走同一套校验', async () => {
  const root = tmpRoot('id-traversal');
  try {
    makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    assert.throws(() => mgr.targetDir('../evil', 'resourcepack'), PackValidationError);
    assert.throws(() => mgr.targetDir('1.21', 'datapack', '../..'), PackValidationError);
    assert.throws(() => mgr.targetDir('1.21', 'datapack', 'a/b'), PackValidationError);
    assert.throws(
      () => mgr.targetDir('1.21', 'mod' as never),
      (error: unknown) => error instanceof PackValidationError,
      '未知 kind 必须是 400 语义',
    );
  } finally {
    removeTempDir(root);
  }
});

test('sanitizeFilename: URL 与浏览器给的名字被清洗成安全文件名', () => {
  assert.equal(sanitizeFilename('https://cdn.example.com/a/b/%E6%9D%90%E8%B4%A8.zip?x=1'), '材质.zip');
  assert.equal(sanitizeFilename('C:\\Users\\me\\Desktop\\pack'), 'pack.zip', '不带扩展名要补上 .zip');
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd.zip');
  assert.equal(sanitizeFilename(''), 'pack.zip');
  assert.equal(sanitizeFilename('a<b>c:d.zip'), 'a_b_c_d.zip');
});

// ───────────────────────────── 5. 启用 / 禁用 ─────────────────────────────

test('启用/禁用: 加 .disabled / 去掉 .disabled，filename 始终是原名', async () => {
  const root = tmpRoot('toggle');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    await mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip(), { filename: '材质.zip' });

    const dir = path.join(instanceDir, 'resourcepacks');
    assert.ok(fs.existsSync(path.join(dir, '材质.zip')));

    await mgr.setEnabled('1.21', 'resourcepack', '材质.zip', false);
    assert.equal(fs.existsSync(path.join(dir, '材质.zip')), false, '禁用后不能还留着 .zip（游戏会照读）');
    assert.ok(fs.existsSync(path.join(dir, '材质.zip.disabled')));

    let list = await mgr.list('1.21', 'resourcepack');
    assert.equal(list.length, 1);
    assert.equal(list[0]?.filename, '材质.zip', '列表里必须是原文件名，不是 .disabled 那个');
    assert.equal(list[0]?.enabled, false);
    assert.equal(list[0]?.packFormat, 15, '禁用态照样能读出元数据');

    // 重复禁用是幂等的
    await mgr.setEnabled('1.21', 'resourcepack', '材质.zip', false);
    assert.ok(fs.existsSync(path.join(dir, '材质.zip.disabled')));

    await mgr.setEnabled('1.21', 'resourcepack', '材质.zip', true);
    assert.ok(fs.existsSync(path.join(dir, '材质.zip')));
    assert.equal(fs.existsSync(path.join(dir, '材质.zip.disabled')), false);

    list = await mgr.list('1.21', 'resourcepack');
    assert.equal(list[0]?.enabled, true);
  } finally {
    removeTempDir(root);
  }
});

test('启用/禁用: 用 .disabled 名字传进来也能工作（兼容前端）', async () => {
  const root = tmpRoot('toggle-disabled-name');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    await mgr.installFromBuffer('1.21', 'shader', shaderPackZip(), { filename: 's.zip' });

    await mgr.setEnabled('1.21', 'shader', 's.zip.disabled', false);
    assert.ok(fs.existsSync(path.join(instanceDir, 'shaderpacks', 's.zip.disabled')));
  } finally {
    removeTempDir(root);
  }
});

test('启用/禁用: 文件不存在 → 抛 PackValidationError（不是静默成功）', async () => {
  const root = tmpRoot('toggle-missing');
  try {
    makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    await assert.rejects(
      () => mgr.setEnabled('1.21', 'resourcepack', 'nope.zip', false),
      (error: unknown) => error instanceof PackValidationError,
    );
  } finally {
    removeTempDir(root);
  }
});

test('diskNameOf / enabledNameOf 是纯函数且互逆', () => {
  assert.equal(diskNameOf('a.zip', true), 'a.zip');
  assert.equal(diskNameOf('a.zip', false), 'a.zip.disabled');
  assert.equal(enabledNameOf('a.zip.disabled'), 'a.zip');
  assert.equal(enabledNameOf('a.zip'), 'a.zip');
  assert.equal(diskNameOf('a.zip.disabled', false), 'a.zip.disabled');
});

// ───────────────────────────── 6. 删除 / 覆盖 / URL 安装 ─────────────────────────────

test('remove: 启用态与禁用态都能删掉', async () => {
  const root = tmpRoot('remove');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    await mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip(), { filename: 'a.zip' });
    await mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip(), { filename: 'b.zip' });
    await mgr.setEnabled('1.21', 'resourcepack', 'b.zip', false);

    await mgr.remove('1.21', 'resourcepack', 'a.zip');
    await mgr.remove('1.21', 'resourcepack', 'b.zip');
    assert.deepEqual(await mgr.list('1.21', 'resourcepack'), []);
    assert.deepEqual(fs.readdirSync(path.join(instanceDir, 'resourcepacks')), []);
  } finally {
    removeTempDir(root);
  }
});

test('覆盖安装同名包不会留下两份（启用态与禁用态互斥）', async () => {
  const root = tmpRoot('overwrite');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    await mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip(), { filename: 'a.zip' });
    await mgr.setEnabled('1.21', 'resourcepack', 'a.zip', false);
    await mgr.installFromBuffer('1.21', 'resourcepack', resourcePackZip(), { filename: 'a.zip' });

    const files = fs.readdirSync(path.join(instanceDir, 'resourcepacks')).sort();
    assert.deepEqual(files, ['a.zip'], '覆盖安装后只该剩一份启用的');
  } finally {
    removeTempDir(root);
  }
});

test('installFromUrl: 复用注入的下载器，先下到 .part 再改名', async () => {
  const root = tmpRoot('url');
  try {
    const instanceDir = makeInstance(root);
    const payload = resourcePackZip();
    const fake = new FakeDownloader(payload);
    const mgr = new PackManager({ dataRoot: root, downloader: fake });

    const progress: { done: number; total: number }[] = [];
    const dest = await mgr.installFromUrl(
      '1.21',
      'resourcepack',
      { url: 'https://example.invalid/packs/leaves.zip', filename: 'leaves.zip' },
      { onProgress: (p) => progress.push(p) },
    );

    assert.equal(dest, path.join(instanceDir, 'resourcepacks', 'leaves.zip'));
    assert.ok(fs.existsSync(dest));
    assert.equal(fake.calls.length, 1);
    assert.match(String(fake.calls[0]?.dest), /leaves\.zip\.part$/, '下载器必须先写到 .part');
    assert.equal(progress.length > 0, true, '必须收到进度回调');

    const list = await mgr.list('1.21', 'resourcepack');
    assert.equal(list[0]?.filename, 'leaves.zip');
    assert.equal(list[0]?.packFormat, 15);
    assert.equal(fs.existsSync(`${dest}.part`), false, '最后的文件名里不能残留 .part');
  } finally {
    removeTempDir(root);
  }
});

test('installFromUrl: 下载失败 → 抛错且不留任何文件', async () => {
  const root = tmpRoot('url-fail');
  try {
    const instanceDir = makeInstance(root);
    const mgr = new PackManager({ dataRoot: root, downloader: new FakeDownloader(new Error('连接被重置')) });

    await assert.rejects(
      () =>
        mgr.installFromUrl('1.21', 'shader', {
          url: 'https://example.invalid/x.zip',
          filename: 'x.zip',
        }),
      /下载失败.*连接被重置/s,
    );
    const dir = path.join(instanceDir, 'shaderpacks');
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], '失败不该留下半个文件');
  } finally {
    removeTempDir(root);
  }
});

test('installFromUrl: 非 http(s)、带凭据、非 .zip 文件名都被拒', async () => {
  const root = tmpRoot('url-bad');
  try {
    makeInstance(root);
    const mgr = new PackManager({ dataRoot: root, downloader: new FakeDownloader(Buffer.alloc(0)) });

    await assert.rejects(
      () => mgr.installFromUrl('1.21', 'resourcepack', { url: 'file:///etc/passwd', filename: 'a.zip' }),
      PackValidationError,
    );
    await assert.rejects(
      () =>
        mgr.installFromUrl('1.21', 'resourcepack', {
          url: 'https://user:pass@example.invalid/a.zip',
          filename: 'a.zip',
        }),
      PackValidationError,
    );
    await assert.rejects(
      () => mgr.installFromUrl('1.21', 'resourcepack', { url: 'https://example.invalid/a.jar', filename: 'a.jar' }),
      PackValidationError,
    );
  } finally {
    removeTempDir(root);
  }
});

test('installFromFile: 从本地文件复制导入（源文件保留）', async () => {
  const root = tmpRoot('file');
  try {
    const instanceDir = makeInstance(root);
    const src = writeTempZip(root, '我的材质.zip', resourcePackZip());
    const mgr = new PackManager({ dataRoot: root });

    const dest = await mgr.installFromFile('1.21', 'resourcepack', src);
    assert.equal(dest, path.join(instanceDir, 'resourcepacks', '我的材质.zip'));
    assert.ok(fs.existsSync(dest));
    assert.ok(fs.existsSync(src), '导入是复制，不能把用户的源文件搬走');

    await assert.rejects(
      () => mgr.installFromFile('1.21', 'resourcepack', path.join(root, '不存在.zip')),
      PackValidationError,
    );
  } finally {
    removeTempDir(root);
  }
});

test('installFromBuffer: 超大文件被拒（不做无意义的 512MB 写入）', async () => {
  const root = tmpRoot('too-big');
  try {
    makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    const fake = Buffer.alloc(MAX_PACK_BYTES + 1);
    await assert.rejects(
      () => mgr.installFromBuffer('1.21', 'shader', fake, { filename: 'big.zip' }),
      /文件过大/,
    );
  } finally {
    removeTempDir(root);
  }
});

// ───────────────────────────── 7. 存档列表 ─────────────────────────────

test('listSaves: 只有含 level.dat 的目录才算存档，最近修改的在前', async () => {
  const root = tmpRoot('saves');
  try {
    const instanceDir = makeInstance(root);
    makeSave(instanceDir, '生存');
    makeSave(instanceDir, '创造');
    // 没有 level.dat 的目录不算
    fs.mkdirSync(path.join(instanceDir, 'saves', '半成品'), { recursive: true });
    // 散落文件也不算
    fs.writeFileSync(path.join(instanceDir, 'saves', 'desktop.ini'), '');

    const saves = await listSaves(instanceDir);
    assert.deepEqual(saves.map((s) => s.name).sort(), ['创造', '生存'].sort());

    // 不存在的实例 → 空数组
    assert.deepEqual(await listSaves(path.join(root, 'instances', 'nope')), []);
  } finally {
    removeTempDir(root);
  }
});

// ───────────────────────────── 8. 小工具 ─────────────────────────────

test('parsePackKind / isPackKind: 只接受三种', () => {
  assert.deepEqual([...PACK_KINDS], ['resourcepack', 'datapack', 'shader']);
  assert.equal(parsePackKind('shader'), 'shader');
  assert.equal(parsePackKind(' ResourcePack '), 'resourcepack');
  assert.equal(parsePackKind('mod'), undefined);
  assert.equal(parsePackKind(''), undefined);
  assert.equal(parsePackKind(null), undefined);
  assert.equal(isPackKind('datapack'), true);
  assert.equal(isPackKind('datapacks'), false);
});

test('下载器真的被复用了：默认构造会拿到 download 模块的 Downloader', async () => {
  // 只验证「懒加载时确实拿到的是 download 模块的实现」，不发起任何网络请求
  const root = tmpRoot('real-downloader');
  try {
    makeInstance(root);
    const mgr = new PackManager({ dataRoot: root });
    const internal = await (mgr as unknown as { downloader: () => Promise<{ constructor: { name: string } }> }).downloader();
    assert.equal(internal.constructor.name, 'Downloader', '必须是 download 模块的 Downloader，不能自写 HTTP');
  } finally {
    removeTempDir(root);
  }
});

// ───────────────────────────── 9. 临时目录卫生 ─────────────────────────────

test('临时目录自检：跑完后 %TEMP% 里没有新增 pcl3-packs-* 残留', () => {
  const now = listLeftoverPackTempDirs();
  const leaked = now.filter((name) => !PREEXISTING_PACK_TEMP.has(name));
  assert.deepEqual(leaked, [], `测试留下了临时目录：${leaked.join(', ')}`);
});
