/**
 * 全局配置（数据目录自定义 / 固定下载源）测试。
 *
 * 重点覆盖用户真会踩的坑：
 *   · 配置**不能**放在数据目录里（鸡生蛋）
 *   · 改目录要真校验（不可写 / 是文件 / 是当前目录的子目录）
 *   · `getDataRoot()` 优先级：环境变量 > config.json > 默认
 *   · 不自动迁移数据，只提示
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ConfigValidationError,
  GlobalConfigStore,
  KNOWN_MIRROR_IDS,
  defaultConfig,
  defaultConfigPath,
  defaultDataRootDir,
  globalConfigRoot,
  installConfigHook,
  isInsideOrEqual,
  mergeConfigPatch,
  normalizeConfig,
  probeWritable,
  resetDefaultConfigStoreCache,
  validateDataDir,
} from '../src/core/config/index.js';
import {
  dataRootSource,
  getDataRoot,
  resetDataRootCache,
} from '../src/core/download/paths.js';

// ───────────────────────────── 脚手架 ─────────────────────────────

const ORIGINAL_ENV = { ...process.env };

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-cfg-${tag}-`));
}

/** 造一个「与产品无关」的干净配置存储（临时目录里） */
function makeStore(root: string): GlobalConfigStore {
  return new GlobalConfigStore({ configPath: path.join(root, 'config.json') });
}

function clearDataRootEnv(): void {
  delete process.env['PCL3_DATA_ROOT'];
}

beforeEach(() => {
  clearDataRootEnv();
  resetDataRootCache();
  resetDefaultConfigStoreCache();
});

afterEach(() => {
  clearDataRootEnv();
  // 环境变量与全局钩子都还原，避免污染其它测试文件
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  resetDataRootCache();
  resetDefaultConfigStoreCache();
  const slot = globalThis as { __pcl3ConfigStore?: unknown };
  delete slot.__pcl3ConfigStore;
});

// ───────────────────────────── 配置位置 ─────────────────────────────

describe('配置位置：与数据目录解耦（鸡生蛋）', () => {
  it('默认配置路径在系统用户目录，不受 PCL3_DATA_ROOT 影响', () => {
    const env = { APPDATA: path.join('C:', 'Users', 'x', 'AppData', 'Roaming') } as NodeJS.ProcessEnv;
    assert.equal(defaultConfigPath(env), path.join(env.APPDATA as string, 'PCL3', 'config.json'));
    assert.equal(globalConfigRoot(env), path.join(env.APPDATA as string, 'PCL3'));
    assert.equal(defaultDataRootDir(env), globalConfigRoot(env));
  });

  it('PCL3_CONFIG_FILE 可以把配置搬到别处（配置位置本身可覆盖）', () => {
    const env = { PCL3_CONFIG_FILE: path.join(os.tmpdir(), 'moved', 'config.json') } as NodeJS.ProcessEnv;
    assert.equal(defaultConfigPath(env), path.resolve(os.tmpdir(), 'moved', 'config.json'));
  });

  it('配置文件的 dataRoot 可以指向任意地方（不要求在配置目录里）', () => {
    const root = tmpDir('decouple');
    try {
      const store = makeStore(root);
      const dataRoot = path.join(root, 'elsewhere', 'data');
      store.save({ dataRoot, autoProbeMirror: true });
      const raw = JSON.parse(fs.readFileSync(store.configPath, 'utf8')) as { dataRoot: string };
      assert.equal(raw.dataRoot, dataRoot);
      // 配置目录里除了 config.json 不该冒出一堆游戏目录
      assert.deepEqual(fs.readdirSync(root).sort(), ['config.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 读写 ─────────────────────────────

describe('GlobalConfigStore: 读写', () => {
  it('文件不存在 → 默认配置，不算错误', () => {
    const root = tmpDir('load-default');
    try {
      const store = makeStore(root);
      const cfg = store.load();
      assert.deepEqual(cfg, defaultConfig());
      assert.equal(store.loadProblem, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('save → load 往返，字段完整（null 不落盘）', () => {
    const root = tmpDir('roundtrip');
    try {
      const store = makeStore(root);
      store.save({ dataRoot: path.join(root, 'd'), preferredMirror: 'bmclapi', autoProbeMirror: false });
      const cfg = store.load();
      assert.equal(cfg.dataRoot, path.join(root, 'd'));
      assert.equal(cfg.preferredMirror, 'bmclapi');
      assert.equal(cfg.autoProbeMirror, false);

      store.save({ autoProbeMirror: true });
      const cleared = store.load();
      assert.equal(cleared.dataRoot, undefined, '不传 dataRoot 应当被清空');
      assert.equal(cleared.preferredMirror, undefined);
      assert.equal(cleared.autoProbeMirror, true);
      const text = fs.readFileSync(store.configPath, 'utf8');
      assert.equal(text.includes('null'), false, '不该往文件里写 null 占位');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('原子写：不留 .tmp 残留', () => {
    const root = tmpDir('atomic');
    try {
      const store = makeStore(root);
      store.save({ autoProbeMirror: true });
      store.save({ autoProbeMirror: false });
      const leftovers = fs.readdirSync(root).filter((n) => n.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('坏 JSON：备份成 .bad-<时间戳>，按默认配置继续（不崩）', () => {
    const root = tmpDir('bad');
    try {
      const store = makeStore(root);
      fs.writeFileSync(store.configPath, '{ "dataRoot": ', 'utf8');
      const cfg = store.load();
      assert.deepEqual(cfg, defaultConfig());
      assert.match(store.loadProblem ?? '', /不是合法 JSON/);
      const backups = fs.readdirSync(root).filter((n) => n.includes('.bad-'));
      assert.equal(backups.length, 1, '坏文件必须被备份而不是直接删掉');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('未知字段被忽略但会给出提示（不静默吞掉）', () => {
    const root = tmpDir('unknown');
    try {
      const store = makeStore(root);
      fs.writeFileSync(
        store.configPath,
        JSON.stringify({ autoProbeMirror: true, mircle: 'typo', dataRoot: 42 }),
        'utf8',
      );
      const cfg = store.load();
      assert.equal(cfg.autoProbeMirror, true);
      assert.equal(cfg.dataRoot, undefined, '类型不对的 dataRoot 当没设置');
      assert.match(store.loadProblem ?? '', /没生效/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('update() 只改出现的字段，其余保持原样', () => {
    const root = tmpDir('update');
    try {
      const store = makeStore(root);
      store.save({ dataRoot: path.join(root, 'a'), preferredMirror: 'mojang', autoProbeMirror: true });
      const result = store.update({ preferredMirror: null, autoProbeMirror: false });
      assert.equal(result.config.preferredMirror, undefined);
      assert.equal(result.config.autoProbeMirror, false);
      assert.equal(result.config.dataRoot, path.join(root, 'a'), '没提 dataRoot 就不该动它');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('update() 传未知源 id → 抛 ConfigValidationError（不悄悄接受）', () => {
    const root = tmpDir('bad-mirror');
    try {
      const store = makeStore(root);
      assert.throws(
        () => store.update({ preferredMirror: 'not-a-mirror' }),
        (error: unknown) => error instanceof ConfigValidationError && /不认识的下载源/.test(error.message),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 数据目录校验 ─────────────────────────────

describe('validateDataDir: 目录校验', () => {
  it('正常空目录 → ok', async () => {
    const root = tmpDir('ok');
    try {
      const target = path.join(root, 'newdata');
      const check = await validateDataDir(target);
      assert.equal(check.ok, true);
      assert.equal(check.dir, path.resolve(target));
      assert.equal(check.exists, false, '探测前不存在的目录，exists 必须如实报 false');
      assert.deepEqual(check.warnings, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('目标是文件 → 拒绝', async () => {
    const root = tmpDir('file');
    try {
      const file = path.join(root, 'not-a-dir.txt');
      fs.writeFileSync(file, 'x', 'utf8');
      const check = await validateDataDir(file);
      assert.equal(check.ok, false);
      assert.match(check.reason ?? '', /是一个文件/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('不可写路径 → 拒绝（用只读目录模拟）', async () => {
    const root = tmpDir('ro');
    try {
      const roDir = path.join(root, 'readonly');
      fs.mkdirSync(roDir);
      if (process.platform === 'win32') {
        // Windows 上 chmod 不可靠，改用「写探测本身」的行为验证：
        // 目录存在但不能创建子文件时 probeWritable 必须报错。
        // 用一个不存在且父级是文件的路径来稳定复现「不可写」。
        const blocked = path.join(root, 'not-a-dir.txt', 'child');
        fs.writeFileSync(path.join(root, 'not-a-dir.txt'), 'x', 'utf8');
        const probe = await probeWritable(blocked);
        assert.equal(probe.ok, false);
        const check = await validateDataDir(blocked);
        assert.equal(check.ok, false);
        assert.ok((check.reason ?? '').length > 0);
      } else {
        fs.chmodSync(roDir, 0o500);
        try {
          const probe = await probeWritable(roDir);
          assert.equal(probe.ok, false, '只读目录必须探测为不可写');
          const check = await validateDataDir(roDir);
          assert.equal(check.ok, false);
        } finally {
          fs.chmodSync(roDir, 0o700);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('是当前数据目录的子目录 → 拒绝（新旧数据嵌套）', async () => {
    const root = tmpDir('inside');
    try {
      const current = path.join(root, 'PCL3');
      fs.mkdirSync(current, { recursive: true });
      const nested = path.join(current, 'elsewhere');
      const check = await validateDataDir(nested, { currentDataRoot: current });
      assert.equal(check.ok, false);
      assert.equal(check.relation, 'inside-current');
      assert.match(check.reason ?? '', /里面/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('是当前数据目录的父级 → 允许但给warning', async () => {
    const root = tmpDir('parent');
    try {
      const current = path.join(root, 'PCL3');
      fs.mkdirSync(current, { recursive: true });
      const check = await validateDataDir(root, { currentDataRoot: current });
      assert.equal(check.ok, true);
      assert.equal(check.relation, 'parent-of-current');
      assert.ok(check.warnings.some((w) => w.includes('上级目录')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('与当前目录相同 → ok + 提示「没有变化」', async () => {
    const root = tmpDir('same');
    try {
      const check = await validateDataDir(root, { currentDataRoot: root });
      assert.equal(check.ok, true);
      assert.equal(check.relation, 'same');
      assert.ok(check.warnings.some((w) => w.includes('不会发生任何变化')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('空串 / 含空字节 → 拒绝（不 resolve 成 cwd）', async () => {
    for (const bad of ['', '   ', 'a\0b']) {
      const check = await validateDataDir(bad);
      assert.equal(check.ok, false);
      assert.ok((check.reason ?? '').length > 0);
    }
  });

  it('已有数据的目录：认出是 PCL3 数据目录并给出体积', async () => {
    const root = tmpDir('occupied');
    try {
      const target = path.join(root, 'old');
      fs.mkdirSync(path.join(target, 'versions'), { recursive: true });
      fs.writeFileSync(path.join(target, 'versions', 'a.bin'), Buffer.alloc(2048));

      const check = await validateDataDir(target);
      assert.equal(check.ok, true);
      assert.equal(check.looksLikeDataRoot, true);
      assert.ok((check.sizeBytes ?? 0) >= 2048);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('isInsideOrEqual：标签边界判定（不能把 PCL3x 当成 PCL3 的子目录）', () => {
    const base = path.join('C:', 'PCL3');
    assert.equal(isInsideOrEqual(path.join(base, 'sub'), base), true);
    assert.equal(isInsideOrEqual(base, base), true);
    assert.equal(isInsideOrEqual(path.join('C:', 'PCL3x'), base), false);
  });
});

// ───────────────────────────── setDataRoot ─────────────────────────────

describe('GlobalConfigStore.setDataRoot', () => {
  it('合法新目录 → ok + 迁移提示（不搬数据）', async () => {
    const root = tmpDir('setdir');
    try {
      const store = makeStore(root);
      const oldDir = path.join(root, 'old-data');
      fs.mkdirSync(path.join(oldDir, 'versions'), { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'versions', 'big.bin'), Buffer.alloc(4096));
      store.save({ dataRoot: oldDir, autoProbeMirror: true });

      const newDir = path.join(root, 'new-data');
      const result = await store.setDataRoot(newDir);
      assert.equal(result.ok, true);
      assert.equal(result.dataRoot, newDir);
      assert.equal(store.load().dataRoot, newDir);

      // 不自动迁移：新目录里没有旧数据
      assert.equal(fs.existsSync(path.join(newDir, 'versions', 'big.bin')), false);
      assert.equal(fs.existsSync(path.join(oldDir, 'versions', 'big.bin')), true, '旧数据必须原地不动');
      assert.match(result.notice ?? '', /不会自动移动/);
      assert.ok((result.notice ?? '').includes(newDir), '提示里必须点名新目录');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('指向文件 → ok:false + 人话原因，配置不被改坏', async () => {
    const root = tmpDir('setdir-file');
    try {
      const store = makeStore(root);
      const keep = path.join(root, 'keep');
      store.save({ dataRoot: keep, autoProbeMirror: true });

      const file = path.join(root, 'x.txt');
      fs.writeFileSync(file, 'x', 'utf8');
      const result = await store.setDataRoot(file);
      assert.equal(result.ok, false);
      assert.match(result.reason ?? '', /是一个文件/);
      assert.equal(store.load().dataRoot, keep, '失败时配置必须保持原样');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('指向当前数据目录的子目录 → ok:false', async () => {
    const root = tmpDir('setdir-nested');
    try {
      const store = makeStore(root);
      const current = path.join(root, 'cur');
      fs.mkdirSync(current, { recursive: true });
      store.save({ dataRoot: current, autoProbeMirror: true });

      const result = await store.setDataRoot(path.join(current, 'inner'));
      assert.equal(result.ok, false);
      assert.match(result.reason ?? '', /里面/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── getDataRoot 优先级 ─────────────────────────────

describe('getDataRoot(): 环境变量 > config.json > 默认', () => {
  it('都没有 → 默认目录（%APPDATA%/PCL3）', () => {
    clearDataRootEnv();
    resetDataRootCache();
    resetDefaultConfigStoreCache();
    // 用临时配置目录，避免读到开发机真实的 config.json
    const cfgRoot = tmpDir('root-default');
    try {
      process.env['PCL3_CONFIG_ROOT'] = cfgRoot;
      resetDefaultConfigStoreCache();
      installConfigHook(new GlobalConfigStore());
      resetDataRootCache();
      assert.equal(dataRootSource(), 'default');
      assert.equal(getDataRoot(), defaultDataRootDir(process.env));
    } finally {
      delete process.env['PCL3_CONFIG_ROOT'];
      fs.rmSync(cfgRoot, { recursive: true, force: true });
    }
  });

  it('只有 config.json 的 dataRoot → 用它（并且目录会被创建）', () => {
    const cfgRoot = tmpDir('root-config');
    const dataDir = path.join(tmpDir('root-config-data'), 'from-config');
    try {
      process.env['PCL3_CONFIG_ROOT'] = cfgRoot;
      resetDefaultConfigStoreCache();
      const store = new GlobalConfigStore();
      store.save({ dataRoot: dataDir, autoProbeMirror: true });
      installConfigHook(store);
      resetDataRootCache();

      assert.equal(dataRootSource(), 'config');
      assert.equal(getDataRoot(), path.resolve(dataDir));
      assert.equal(fs.existsSync(dataDir), true, 'getDataRoot 负责 mkdir -p');
    } finally {
      delete process.env['PCL3_CONFIG_ROOT'];
      fs.rmSync(cfgRoot, { recursive: true, force: true });
      fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
    }
  });

  it('环境变量与 config 同时存在 → 环境变量赢', () => {
    const cfgRoot = tmpDir('root-both');
    const envDir = path.join(tmpDir('root-both-env'), 'from-env');
    try {
      process.env['PCL3_CONFIG_ROOT'] = cfgRoot;
      resetDefaultConfigStoreCache();
      const store = new GlobalConfigStore();
      store.save({ dataRoot: path.join(cfgRoot, 'from-config'), autoProbeMirror: true });
      installConfigHook(store);

      process.env['PCL3_DATA_ROOT'] = envDir;
      resetDataRootCache();
      assert.equal(dataRootSource(), 'env');
      assert.equal(getDataRoot(), path.resolve(envDir));
    } finally {
      delete process.env['PCL3_CONFIG_ROOT'];
      delete process.env['PCL3_DATA_ROOT'];
      resetDataRootCache();
      fs.rmSync(cfgRoot, { recursive: true, force: true });
      fs.rmSync(path.dirname(envDir), { recursive: true, force: true });
    }
  });

  it('环境变量是空白 → 视为未设置（不许把 cwd 当数据目录）', () => {
    process.env['PCL3_DATA_ROOT'] = '   ';
    resetDataRootCache();
    try {
      assert.notEqual(getDataRoot(), path.resolve('.'));
      assert.notEqual(dataRootSource(), 'env');
    } finally {
      delete process.env['PCL3_DATA_ROOT'];
      resetDataRootCache();
    }
  });

  it('没有装配置钩子时退化为旧行为（不抛错）', () => {
    const cfgRoot = tmpDir('no-hook');
    const cfgFile = path.join(cfgRoot, 'config.json');
    try {
      fs.writeFileSync(cfgFile, JSON.stringify({ dataRoot: path.join(cfgRoot, 'x') }), 'utf8');
      // 刻意不 installConfigHook
      resetDataRootCache();
      resetDefaultConfigStoreCache();
      assert.doesNotThrow(() => getDataRoot());
      assert.equal(dataRootSource(), 'default');
    } finally {
      fs.rmSync(cfgRoot, { recursive: true, force: true });
    }
  });

  it('配置里 dataRoot 是坏值 → 回落默认，不崩', () => {
    const cfgRoot = tmpDir('root-bad');
    const cfgFile = path.join(cfgRoot, 'config.json');
    try {
      fs.writeFileSync(cfgFile, '{ bad json', 'utf8');
      process.env['PCL3_CONFIG_ROOT'] = cfgRoot;
      resetDefaultConfigStoreCache();
      installConfigHook(new GlobalConfigStore());
      resetDataRootCache();
      assert.doesNotThrow(() => getDataRoot());
      assert.equal(dataRootSource(), 'default');
    } finally {
      delete process.env['PCL3_CONFIG_ROOT'];
      fs.rmSync(cfgRoot, { recursive: true, force: true });
    }
  });

  it('resetDataRootCache() 之后能读到新配置（改目录立即生效的底层）', () => {
    const cfgRoot = tmpDir('root-reset');
    const first = path.join(cfgRoot, 'a');
    const second = path.join(cfgRoot, 'b');
    try {
      process.env['PCL3_CONFIG_ROOT'] = cfgRoot;
      resetDefaultConfigStoreCache();
      const store = new GlobalConfigStore();
      installConfigHook(store);
      store.save({ dataRoot: first, autoProbeMirror: true });
      resetDataRootCache();
      assert.equal(getDataRoot(), path.resolve(first));

      store.save({ dataRoot: second, autoProbeMirror: true });
      // 不 reset 就还是旧值（这是刻意的：一次运行内路径稳定）
      assert.equal(getDataRoot(), path.resolve(first));
      resetDataRootCache();
      assert.equal(getDataRoot(), path.resolve(second));
    } finally {
      delete process.env['PCL3_CONFIG_ROOT'];
      resetDataRootCache();
      fs.rmSync(cfgRoot, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 纯函数 ─────────────────────────────

describe('配置字段校验（纯函数）', () => {
  it('KNOWN_MIRROR_IDS 覆盖三个已知源', () => {
    assert.deepEqual([...KNOWN_MIRROR_IDS], ['mojang', 'piston', 'bmclapi']);
  });

  it('normalizeConfig：宽松，坏值当没设置', () => {
    const { config } = normalizeConfig({ dataRoot: 123, autoProbeMirror: 'yes', preferredMirror: '' });
    assert.equal(config.dataRoot, undefined);
    assert.equal(config.preferredMirror, undefined);
    assert.equal(config.autoProbeMirror, true, '非布尔值回落默认');
  });

  it('mergeConfigPatch：严格，类型错就报错', () => {
    const { problems } = mergeConfigPatch(defaultConfig(), { autoProbeMirror: 'yes' });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /布尔值/);

    const { problems: badRoot } = mergeConfigPatch(defaultConfig(), { dataRoot: 42 });
    assert.match(badRoot[0] ?? '', /字符串/);

    const ok = mergeConfigPatch(defaultConfig(), { dataRoot: ' D:\\PCL3 ', autoProbeMirror: false });
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.config.dataRoot, 'D:\\PCL3', '首尾空白要 trim');
    assert.equal(ok.config.autoProbeMirror, false);
  });

  it('mergeConfigPatch：null 表示清空该字段', () => {
    const { config } = mergeConfigPatch(
      { dataRoot: 'D:\\x', preferredMirror: 'mojang', autoProbeMirror: true },
      { dataRoot: null, preferredMirror: null },
    );
    assert.equal(config.dataRoot, undefined);
    assert.equal(config.preferredMirror, undefined);
    assert.equal(config.autoProbeMirror, true);
  });
});
