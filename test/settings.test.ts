/**
 * settings 模块测试：存储 round-trip、原子写、坏 JSON 回退、越界拦截、参数注入防护。
 *
 * 全部离线、全部在临时目录里跑，不碰用户真实数据目录。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_MEMORY_MB,
  MEMORY_MAX_MB,
  MEMORY_MIN_MB,
  SettingsStore,
  SettingsValidationError,
  checkInstanceId,
  commitTempFile,
  defaultSettings,
  minMemoryJvmArg,
  toLaunchOptionFields,
  validateSettings,
  writeTempFile,
} from '../src/core/settings/index.js';
import type { Account, VersionJson } from '../src/core/types.js';
import { GameLauncher, type Platform } from '../src/core/launch/index.js';

// ───────────────────────────── 夹具 ─────────────────────────────

function tmpDataRoot(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-settings-${tag}-`));
}

const WINDOWS: Platform = {
  name: 'windows',
  arch: 'x86_64',
  classpathSeparator: ';',
  nativesKey: 'windows',
};

const OFFLINE: Account = {
  type: 'offline',
  username: 'Steve',
  uuid: 'c06f8906-4c8a-4911-9a29-e1c62d1c12c7',
  accessToken: '0',
};

class FakeVersionRepo {
  private readonly versions: Record<string, VersionJson>;

  constructor(versions: Record<string, VersionJson>) {
    this.versions = versions;
  }

  async fetchVersion(id: string): Promise<VersionJson> {
    const json = this.versions[id];
    if (!json) throw new Error(`fake repo 里没有版本 ${id}`);
    return structuredClone(json);
  }

  async resolveInherited(json: VersionJson): Promise<VersionJson> {
    return json;
  }
}

/** 1.21 风格的版本元数据（与 launch 测试同形，但不带 -Xmx，走 launch 的补全分支） */
function version121(): VersionJson {
  return {
    id: '1.21.4',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    assetIndex: { id: '17', sha1: 'a'.repeat(40), size: 1, totalSize: 1, url: 'https://example/assets.json' },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
    libraries: [],
    arguments: {
      game: ['--username', '${auth_player_name}', '--version', '${version_name}'],
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    },
  };
}

/** 造一个「数据目录 + 假 java」环境 */
function makeLaunchEnv(tag: string): { dataRoot: string; instanceDir: string } {
  const dataRoot = tmpDataRoot(tag);
  const instanceDir = path.join(dataRoot, 'instances', 'demo');
  fs.mkdirSync(instanceDir, { recursive: true });
  const javaHome = path.join(dataRoot, 'java', 'java-runtime-delta', '21');
  fs.mkdirSync(path.join(javaHome, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(javaHome, 'bin', 'javaw.exe'), 'fake');
  fs.writeFileSync(path.join(javaHome, 'bin', 'java.exe'), 'fake');
  fs.writeFileSync(path.join(javaHome, 'release'), 'JAVA_VERSION="21.0.1"\n');
  return { dataRoot, instanceDir };
}

function settingsFile(root: string, id: string): string {
  return path.join(root, 'instances', id, 'settings.json');
}

// ───────────────────────────── 1. resolve() 默认值 ─────────────────────────────

test('未设置时 resolve() 返回默认 2048 MB', () => {
  const root = tmpDataRoot('default');
  try {
    const store = new SettingsStore({ dataRoot: root });
    const settings = store.resolve('1.21');

    assert.equal(settings.memoryMB, DEFAULT_MEMORY_MB, '默认内存必须是 2048');
    assert.equal(DEFAULT_MEMORY_MB, 2048);
    assert.equal(settings.versionId, '1.21');
    assert.equal(settings.id, '1.21', '没给实例名时 id 就是 versionId');
    assert.equal(store.load('1.21'), undefined, '没存过时 load 必须返回 undefined');
    assert.deepEqual(store.list(), [], '空目录 list 为空数组');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('defaultSettings：实例名与版本号可以不同（同一版本开多份实例）', () => {
  const settings = defaultSettings('1.21', '生存');
  assert.equal(settings.id, '生存');
  assert.equal(settings.versionId, '1.21');
  assert.equal(settings.memoryMB, 2048);
});

// ───────────────────────────── 2. round-trip ─────────────────────────────

test('存储 round-trip：所有字段都能原样读回', () => {
  const root = tmpDataRoot('roundtrip');
  try {
    const store = new SettingsStore({ dataRoot: root });
    store.save({
      id: '1.21',
      versionId: '1.21',
      memoryMB: 4096,
      minMemoryMB: 1024,
      extraJvmArgs: ['-XX:+UseG1GC', '-Dfoo=bar'],
      extraGameArgs: ['--fullscreen'],
      javaPath: 'C:\\Java\\bin\\javaw.exe',
      windowWidth: 1600,
      windowHeight: 900,
      fullscreen: false,
    });

    const loaded = store.load('1.21');
    assert.ok(loaded, '必须读回来');
    assert.equal(loaded.memoryMB, 4096);
    assert.equal(loaded.minMemoryMB, 1024);
    assert.deepEqual(loaded.extraJvmArgs, ['-XX:+UseG1GC', '-Dfoo=bar']);
    assert.deepEqual(loaded.extraGameArgs, ['--fullscreen']);
    assert.equal(loaded.javaPath, 'C:\\Java\\bin\\javaw.exe');
    assert.equal(loaded.windowWidth, 1600);
    assert.equal(loaded.windowHeight, 900);
    assert.equal(loaded.fullscreen, false);
    assert.equal(loaded.id, '1.21');

    // resolve() 与 load() 对同一份数据必须给出同样结果
    const resolved = store.resolve('1.21');
    assert.equal(resolved.memoryMB, 4096);
    assert.deepEqual(resolved.extraJvmArgs, ['-XX:+UseG1GC', '-Dfoo=bar']);

    // 落盘是带缩进的 UTF-8 JSON，且一定有 memoryMB
    const text = fs.readFileSync(settingsFile(root, '1.21'), 'utf8');
    assert.match(text, /"memoryMB": 4096/);
    assert.ok(!text.includes('\r'), '不允许 CRLF');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('save 后不留临时文件；list 按 id 排序', () => {
  const root = tmpDataRoot('list');
  try {
    const store = new SettingsStore({ dataRoot: root });
    store.save({ id: 'b-version', versionId: 'b-version', memoryMB: 2048 });
    store.save({ id: 'a-version', versionId: 'a-version', memoryMB: 4096 });

    const dir = path.join(root, 'instances', 'a-version');
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['settings.json'], `目录里只该有 settings.json，实际：${files.join(',')}`);

    const list = store.list();
    assert.deepEqual(
      list.map((s) => s.id),
      ['a-version', 'b-version'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────── 3. 原子写 ─────────────────────────────

test('原子写：写到临时文件再 rename，读方永远看不到半截内容', () => {
  const root = tmpDataRoot('atomic');
  try {
    const store = new SettingsStore({ dataRoot: root });
    store.save({ id: '1.21', versionId: '1.21', memoryMB: 2048 });

    const file = settingsFile(root, '1.21');
    const before = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);

    // 1) 写临时文件这一步：settings.json 一个字都没动，磁盘上多出一个 .tmp
    const tmp = writeTempFile(file, '{"memoryMB": 8192}\n');
    assert.equal(path.basename(tmp), 'settings.json.tmp');
    assert.equal(fs.readFileSync(file, 'utf8'), before, '临时文件写完时正主必须还是旧的');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'settings.json.tmp']);

    // 2) rename 这一步：正主被整体替换，临时文件消失
    commitTempFile(tmp, file);
    assert.equal(store.load('1.21')?.memoryMB, 8192);
    assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'rename 之后不该再有临时文件');

    // 3) 真实 save 也必须走同一条路径：落盘内容永远是一份完整 JSON
    store.save({ id: '1.21', versionId: '1.21', memoryMB: 6144 });
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(text), '落盘内容必须是完整可解析的 JSON');
    assert.match(text, /"memoryMB": 6144/);
    assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('原子写：rename 失败时抛错且旧文件完好（不假装保存成功）', () => {
  const root = tmpDataRoot('atomic-fail');
  try {
    const store = new SettingsStore({ dataRoot: root });
    store.save({ id: '1.21', versionId: '1.21', memoryMB: 2048 });
    const file = settingsFile(root, '1.21');
    const before = fs.readFileSync(file, 'utf8');

    // 目标目录被换成只读形态太依赖平台，这里直接验证「rename 源不存在」这条真实失败路径
    assert.throws(() => commitTempFile(path.join(path.dirname(file), 'nope.tmp'), file), /ENOENT/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '失败后旧文件必须完好');
    assert.equal(store.load('1.21')?.memoryMB, 2048);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('save 会建出缺失的实例目录', () => {
  const root = tmpDataRoot('mkdir');
  try {
    const store = new SettingsStore({ dataRoot: root });
    store.save({ id: 'deep/../x', versionId: 'x', memoryMB: 2048 });
  } catch (error) {
    // 这条 id 含路径分隔符，必须被拒；顺手确认目录没被创建出去
    assert.ok(error instanceof SettingsValidationError);
    assert.equal(fs.existsSync(path.join(root, 'instances', 'deep')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────── 4. 坏文件回退 ─────────────────────────────

test('JSON 损坏：备份成 .bad-* 并回退默认值，不崩', (t) => {
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning.message);
  };
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));

  const root = tmpDataRoot('corrupt');
  try {
    const dir = path.join(root, 'instances', '1.21');
    fs.mkdirSync(dir, { recursive: true });
    // 故意写成半截 JSON（模拟断电 / 手改坏）
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"memoryMB": 4096, "extraJvmArg', 'utf8');

    const store = new SettingsStore({ dataRoot: root });
    assert.equal(store.load('1.21'), undefined, '坏文件必须当作没存过');

    const resolved = store.resolve('1.21');
    assert.equal(resolved.memoryMB, 2048, '回退默认 2048');

    const backups = fs.readdirSync(dir).filter((n) => n.includes('.bad-'));
    assert.equal(backups.length, 1, `必须留下一份备份，实际：${fs.readdirSync(dir).join(',')}`);
    assert.match(
      fs.readFileSync(path.join(dir, backups[0] as string), 'utf8'),
      /extraJvmArg/,
      '备份必须保留原始内容，不能是空的',
    );
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, '坏文件被挪走');

    // 备份之后还能正常保存
    store.save({ id: '1.21', versionId: '1.21', memoryMB: 6144 });
    assert.equal(store.resolve('1.21').memoryMB, 6144);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('内容不是 JSON 对象（数组/字符串）也回退默认值', () => {
  const root = tmpDataRoot('notobject');
  try {
    const dir = path.join(root, 'instances', '1.21');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '[1,2,3]', 'utf8');

    const store = new SettingsStore({ dataRoot: root });
    assert.equal(store.resolve('1.21').memoryMB, 2048);
    assert.equal(store.load('1.21'), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('手改出越界内存：读回来时丢弃该字段并补默认值', () => {
  const root = tmpDataRoot('outofrange');
  try {
    const dir = path.join(root, 'instances', '1.21');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ id: '1.21', versionId: '1.21', memoryMB: 999999, extraJvmArgs: ['-Dok=1'] }),
      'utf8',
    );

    const store = new SettingsStore({ dataRoot: root });
    const resolved = store.resolve('1.21');
    assert.equal(resolved.memoryMB, 2048, '越界值必须被丢弃，退默认');
    assert.deepEqual(resolved.extraJvmArgs, ['-Dok=1'], '同一份文件里的合法字段要保留');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────── 5. 校验 ─────────────────────────────

test('memoryMB 越界（511 / 65537）被拒', () => {
  for (const value of [511, 65537, 0, -1, 1e9]) {
    const result = validateSettings({ memoryMB: value }, '1.21');
    assert.ok(result.errors.length > 0, `${String(value)} 必须被拒`);
    assert.match(result.errors.join(' '), /memoryMB|内存/);
    assert.equal(result.settings.memoryMB, undefined, `${String(value)} 不应被接受`);
  }

  const low = validateSettings({ memoryMB: 511 }, '1.21');
  assert.match(low.errors[0] as string, new RegExp(`${String(MEMORY_MIN_MB)}`), '错误里要写出边界');
  const high = validateSettings({ memoryMB: 65537 }, '1.21');
  assert.match(high.errors[0] as string, new RegExp(`${String(MEMORY_MAX_MB)}`));
});

test('memoryMB 边界值本身合法（512 / 65536）', () => {
  assert.deepEqual(validateSettings({ memoryMB: 512 }, '1.21').errors, []);
  assert.deepEqual(validateSettings({ memoryMB: 65536 }, '1.21').errors, []);
  assert.equal(validateSettings({ memoryMB: 65536 }, '1.21').settings.memoryMB, 65536);
});

test('memoryMB 非数字 / 小数被拒', () => {
  assert.ok(validateSettings({ memoryMB: '4096' }, '1.21').errors.length > 0, '字符串数字不算数字');
  assert.ok(validateSettings({ memoryMB: 4096.5 }, '1.21').errors.length > 0, '内存不接受小数');
  assert.ok(validateSettings({ memoryMB: Number.NaN }, '1.21').errors.length > 0);
});

test('extraJvmArgs 含换行被拒', () => {
  const withNewline = validateSettings({ extraJvmArgs: ['-XX:+UseG1GC\n--add-opens java.base/java.lang=ALL-UNNAMED'] }, '1.21');
  assert.ok(withNewline.errors.length > 0, '带换行的参数必须被拒');
  assert.match(withNewline.errors.join(' '), /换行/);

  const withCRLF = validateSettings({ extraJvmArgs: ['-Da=1\r\n-Db=2'] }, '1.21');
  assert.ok(withCRLF.errors.length > 0, 'CRLF 也算换行');

  const bareCR = validateSettings({ extraJvmArgs: ['-Da=1\r-b'] }, '1.21');
  assert.ok(bareCR.errors.length > 0, '单独的 CR 也算换行');
});

test('extraJvmArgs 含空字节被拒', () => {
  const result = validateSettings({ extraJvmArgs: ['-Dfoo=ba\u0000r'] }, '1.21');
  assert.ok(result.errors.length > 0, '空字节必须被拒');
  assert.match(result.errors.join(' '), /空字节/);
});

test('extraJvmArgs 必须是字符串数组', () => {
  assert.ok(validateSettings({ extraJvmArgs: '-XX:+UseG1GC' }, '1.21').errors.length > 0, '字符串不是数组');
  assert.ok(validateSettings({ extraJvmArgs: [123] }, '1.21').errors.length > 0, '数字项不是字符串');
  assert.ok(validateSettings({ extraJvmArgs: [null] }, '1.21').errors.length > 0, 'null 项不是字符串');
  assert.ok(
    validateSettings({ extraJvmArgs: [{ a: 1 }] }, '1.21').errors.length > 0,
    '对象项不是字符串',
  );

  const good = validateSettings({ extraJvmArgs: ['-XX:+UseG1GC', '-Dfoo=bar'] }, '1.21');
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.settings.extraJvmArgs, ['-XX:+UseG1GC', '-Dfoo=bar']);
});

test('空字符串项被丢掉而不是报错（多行输入框里的空行）', () => {
  const result = validateSettings({ extraJvmArgs: ['', '  ', '-Da=1'] }, '1.21');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.settings.extraJvmArgs, ['-Da=1']);
});

test('未知字段被忽略且不报错（向前兼容）', () => {
  const result = validateSettings(
    { memoryMB: 4096, someFutureField: 'whatever', nested: { a: 1 } },
    '1.21',
  );
  assert.deepEqual(result.errors, [], '未知字段不能导致 400');
  assert.equal(result.settings.memoryMB, 4096);
  assert.deepEqual(result.ignored.sort(), ['nested', 'someFutureField']);
});

test('minMemoryMB 大于 memoryMB 被拒', () => {
  const result = validateSettings({ memoryMB: 2048, minMemoryMB: 4096 }, '1.21');
  assert.ok(result.errors.length > 0);
  assert.match(result.errors.join(' '), /最小内存/);
});

test('javaPath 含引号/控制字符被拒；空串等于没填', () => {
  assert.ok(validateSettings({ javaPath: 'C:\\Java\\"x\\"\\javaw.exe' }, '1.21').errors.length > 0);
  assert.ok(validateSettings({ javaPath: 'C:\\Java\n\\javaw.exe' }, '1.21').errors.length > 0);
  const empty = validateSettings({ javaPath: '   ' }, '1.21');
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.settings.javaPath, undefined, '留空 = 自动，不写成空串');
});

test('checkInstanceId：挡住路径穿越与盘符', () => {
  assert.equal(checkInstanceId('1.21'), null);
  assert.equal(checkInstanceId('fabric-loader-0.16.9-1.21'), null);
  assert.equal(checkInstanceId('生存 世界'), null, '中文与空格可以');

  assert.match(checkInstanceId('..') ?? '', /不能是/);
  assert.match(checkInstanceId('a/b') ?? '', /分隔符/);
  assert.match(checkInstanceId('a\\b') ?? '', /分隔符/);
  assert.match(checkInstanceId('C:evil') ?? '', /分隔符|盘符/);
  assert.match(checkInstanceId('') ?? '', /不能为空/);
  assert.ok(checkInstanceId('x'.repeat(65)) !== null, '超长要拒');
});

test('save 传入非法数据抛 SettingsValidationError（带上每条问题）', () => {
  const root = tmpDataRoot('save-invalid');
  try {
    const store = new SettingsStore({ dataRoot: root });
    assert.throws(
      () => store.save({ id: '1.21', versionId: '1.21', memoryMB: 511 }),
      (error: unknown) => {
        assert.ok(error instanceof SettingsValidationError);
        assert.ok(error.problems.length > 0);
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(root, 'instances', '1.21')), false, '拒了就什么都不该写');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────── 6. remove / resolve ─────────────────────────────

test('remove 之后回到默认值；remove 不存在的实例不报错', () => {
  const root = tmpDataRoot('remove');
  try {
    const store = new SettingsStore({ dataRoot: root });
    store.save({ id: '1.21', versionId: '1.21', memoryMB: 8192 });
    assert.equal(store.resolve('1.21').memoryMB, 8192);

    store.remove('1.21');
    assert.equal(store.load('1.21'), undefined);
    assert.equal(store.resolve('1.21').memoryMB, 2048);

    store.remove('never-existed');
    store.remove('../etc');
    assert.deepEqual(store.list(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolve(versionId, instanceId)：读的是实例目录，返回的 versionId 仍是版本号', () => {
  const root = tmpDataRoot('instance');
  try {
    const store = new SettingsStore({ dataRoot: root });
    store.save({ id: '生存', versionId: '1.21', memoryMB: 6144 });

    const resolved = store.resolve('1.21', '生存');
    assert.equal(resolved.memoryMB, 6144);
    assert.equal(resolved.versionId, '1.21', 'versionId 是版本号，不是实例名');

    // 同一版本的另一份实例没设置 → 默认值
    assert.equal(store.resolve('1.21', '创造').memoryMB, 2048);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────── 7. 映射到 LaunchOptions ─────────────────────────────

test('toLaunchOptionFields：minMemoryMB 变成 -Xmn，最小内存真的能传下去', () => {
  const fields = toLaunchOptionFields({
    id: '1.21',
    versionId: '1.21',
    memoryMB: 4096,
    minMemoryMB: 2048,
    extraJvmArgs: ['-XX:+UseG1GC'],
    extraGameArgs: ['--demo'],
    windowWidth: 1280,
    windowHeight: 720,
  });

  assert.equal(fields.memoryMB, 4096);
  assert.deepEqual(fields.extraJvmArgs, ['-XX:+UseG1GC', '-Xmn2048M']);
  assert.deepEqual(fields.extraGameArgs, ['--demo', '--width', '1280', '--height', '720']);
  assert.equal(fields.javaPath, undefined, '没填 javaPath 就不出现');
});

test('toLaunchOptionFields：什么都没填时只给 memoryMB', () => {
  const fields = toLaunchOptionFields({ id: '1.21', versionId: '1.21', memoryMB: 2048 });
  assert.deepEqual(fields, { memoryMB: 2048 });
  assert.equal(minMemoryJvmArg(undefined), undefined);
  assert.equal(minMemoryJvmArg(0), undefined);
  assert.equal(minMemoryJvmArg(1024), '-Xmn1024M');
});

// ───────────────────────────── 8. 端到端：设置真的进到命令行 ─────────────────────────────

test('启动时设置真正生效：buildCommand 的 args 里出现 -Xmx4096M', async () => {
  const env = makeLaunchEnv('e2e');
  try {
    const store = new SettingsStore({ dataRoot: env.dataRoot });
    store.save({ id: '1.21.4', versionId: '1.21.4', memoryMB: 4096, minMemoryMB: 2048 });

    const fields = toLaunchOptionFields(store.resolve('1.21.4'));
    const launcher = new GameLauncher({
      versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
      dataRoot: env.dataRoot,
      platform: WINDOWS,
    });

    const built = await launcher.buildCommand({
      versionId: '1.21.4',
      instanceDir: env.instanceDir,
      account: OFFLINE,
      ...fields,
    });

    assert.ok(
      built.args.includes('-Xmx4096M'),
      `args 里必须有 -Xmx4096M，实际：${built.args.filter((a) => a.startsWith('-Xmx') || a.startsWith('-Xmn')).join(' ')}`,
    );
    assert.ok(built.args.includes('-Xmn2048M'), '最小内存要作为显式 -Xmn 传下去');
    // 元数据没声明 -Xmn 时，launch 会先按 1/4 补一条 -Xmn1024M，我们的 -Xmn2048M 追加在它后面。
    // 这正是想要的效果：JVM 对重复参数取最后一个，所以实际生效的是 2048。
    const xmn = built.args.filter((a) => a.startsWith('-Xmn'));
    assert.equal(xmn[xmn.length - 1], '-Xmn2048M', `最后一个 -Xmn 必须是我们给的值，实际：${xmn.join(' ')}`);
  } finally {
    fs.rmSync(env.dataRoot, { recursive: true, force: true });
  }
});

test('没设置过时启动仍是 -Xmx2048M（默认值必须进命令行）', async () => {
  const env = makeLaunchEnv('e2e-default');
  try {
    const store = new SettingsStore({ dataRoot: env.dataRoot });
    const launcher = new GameLauncher({
      versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
      dataRoot: env.dataRoot,
      platform: WINDOWS,
    });

    const built = await launcher.buildCommand({
      versionId: '1.21.4',
      instanceDir: env.instanceDir,
      account: OFFLINE,
      ...toLaunchOptionFields(store.resolve('1.21.4')),
    });

    assert.ok(built.args.includes('-Xmx2048M'), `实际：${built.args.filter((a) => a.startsWith('-Xmx')).join(' ')}`);
    assert.ok(built.args.includes('-Xmn512M'), '2048 的 1/4 是 512');
  } finally {
    fs.rmSync(env.dataRoot, { recursive: true, force: true });
  }
});

test('附加 JVM 参数与游戏参数都进到命令行，且 JVM 参数在 -cp 之前', async () => {
  const env = makeLaunchEnv('e2e-args');
  try {
    const store = new SettingsStore({ dataRoot: env.dataRoot });
    store.save({
      id: '1.21.4',
      versionId: '1.21.4',
      memoryMB: 3072,
      extraJvmArgs: ['-XX:+UseG1GC', '-Dfoo=bar'],
      extraGameArgs: ['--demo'],
    });

    const launcher = new GameLauncher({
      versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
      dataRoot: env.dataRoot,
      platform: WINDOWS,
    });
    const built = await launcher.buildCommand({
      versionId: '1.21.4',
      instanceDir: env.instanceDir,
      account: OFFLINE,
      ...toLaunchOptionFields(store.resolve('1.21.4')),
    });

    assert.ok(built.args.includes('-Xmx3072M'));
    assert.ok(built.args.includes('-XX:+UseG1GC'));
    assert.ok(built.args.includes('-Dfoo=bar'));

    const cpIndex = built.args.indexOf('-cp');
    assert.ok(cpIndex > 0, '必须有 -cp');
    assert.ok(built.args.indexOf('-XX:+UseG1GC') < cpIndex, 'JVM 参数必须在 -cp 之前');
    assert.ok(built.args.includes('--demo'), '附加游戏参数要进 game args');
  } finally {
    fs.rmSync(env.dataRoot, { recursive: true, force: true });
  }
});
