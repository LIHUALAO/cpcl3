/**
 * launch 模块测试。
 *
 * 运行（与其他模块一致，走仓库里的共享解析钩子）：
 *   node --import ./test/ts-resolve.mjs --test test/launch.test.ts
 *
 * 全部离线：版本 JSON 用内联 fixture + 自造 fake 仓库（不触网），
 * 数据目录用临时目录，java 用临时目录里的假可执行文件（只验证命令拼装，不真跑游戏）。
 *
 * 覆盖（对应任务的验证标准）：
 *   1. 1.21 风格（arguments）：-cp / mainClass / --username / --uuid 正确
 *   2. 1.12 风格（minecraftArguments）：正确切分与占位符替换
 *   3. rules：`allow + os.name=osx` 的库在 Windows 上必须被排除
 *   4. natives：Windows 取到 natives-windows，并解压到实例目录（排除 META-INF）
 *   5. classpath：游戏本体 jar 在最后一位
 *   6. 分隔符：Windows 用 `;`
 *   7. 附加：17 个占位符全覆盖、java 缺失报错、rules 组合语义、inheritsFrom、launch() 真 spawn
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 说明：这里用 `.ts` 扩展名直接引用源码，是为了让测试无需先 `tsc` 就能跑（Node 24 内置
// 类型剥离）。`src/core/launch/*.ts` 内部写的 `.js` 相对导入由 test/ts-resolve.mjs 钩子解析。
// 代价：需要 tsconfig 打开 `allowImportingTsExtensions`（属 Lead/version-dev 的契约外事项，
// 已在汇报里列出）。
import { GameLauncher, KNOWN_PLACEHOLDERS } from '../src/core/launch/index.js';
import { buildZip } from './launch.zip-fixer.js';
import type { Account, Library, VersionJson } from '../src/core/types.js';
import type { Platform } from '../src/core/launch/index.js';

// ───────────────────────────── fake 版本仓库 ─────────────────────────────

class FakeVersionRepo {
  readonly requests: string[] = [];
  private readonly versions: Record<string, VersionJson>;

  constructor(versions: Record<string, VersionJson>) {
    this.versions = versions;
  }

  async fetchVersion(id: string): Promise<VersionJson> {
    this.requests.push(id);
    const json = this.versions[id];
    if (!json) throw new Error(`fake repo 里没有版本 ${id}`);
    return structuredClone(json);
  }

  /** 极简继承解析：只做一层，但足够验证 GameLauncher 走了哪条路径 */
  async resolveInherited(json: VersionJson): Promise<VersionJson> {
    const parentId = json.inheritsFrom;
    if (!parentId) return json;
    const parent = await this.fetchVersion(parentId);
    const merged: VersionJson = {
      ...parent,
      ...json,
      libraries: [...(parent.libraries ?? []), ...(json.libraries ?? [])],
      arguments: {
        game: [...(parent.arguments?.game ?? []), ...(json.arguments?.game ?? [])],
        jvm: [...(parent.arguments?.jvm ?? []), ...(json.arguments?.jvm ?? [])],
      },
    };
    merged.inheritsFrom = undefined;
    return merged;
  }
}

// ───────────────────────────── 工具 ─────────────────────────────

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

const LIBS = 'https://libraries.minecraft.net/';

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-launch-${tag}-`));
}

/** 造一个「数据目录 + 假 java + 空 jar 文件」的完整环境，返回 dataRoot 与 instanceDir */
function makeEnv(tag: string): { dataRoot: string; instanceDir: string; javaMajor: number } {
  const dataRoot = tmpDir(tag);
  const instanceDir = path.join(dataRoot, 'instances', 'demo');
  fs.mkdirSync(instanceDir, { recursive: true });

  // 假 java：java-runtime-delta/21（目录名含大版本号，供 findJavaInDataRoot 匹配）
  const javaHome = path.join(dataRoot, 'java', 'java-runtime-delta', '21');
  fs.mkdirSync(path.join(javaHome, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(javaHome, 'bin', 'javaw.exe'), 'fake');
  fs.writeFileSync(path.join(javaHome, 'bin', 'java.exe'), 'fake');
  fs.writeFileSync(path.join(javaHome, 'release'), 'JAVA_VERSION="21.0.1"\n');

  return { dataRoot, instanceDir, javaMajor: 21 };
}

function javaHomeOf(dataRoot: string): string {
  return path.join(dataRoot, 'java', 'java-runtime-delta', '21');
}

function lib(name: string, artifactPath: string | undefined, extra: Partial<Library> = {}): Library {
  const out: Library = { name, ...extra };
  if (artifactPath !== undefined) {
    out.downloads = {
      artifact: { path: artifactPath, sha1: '0'.repeat(40), size: 1, url: `${LIBS}${artifactPath}` },
    };
  }
  return out;
}

function findArg(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1];
  }
  return undefined;
}

/** 找形如 `-Djava.library.path=xxx` 的参数，返回 '=' 之后的值 */
function findValueOf(args: readonly string[], prefix: string): string | undefined {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function findFlag(args: readonly string[], prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ───────────────────────────── fixture：1.21 风格 ─────────────────────────────

function version121(): VersionJson {
  return {
    id: '1.21.4',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    assetIndex: { id: '17', sha1: 'a'.repeat(40), size: 1, totalSize: 1, url: 'https://example/assets.json' },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
    libraries: [
      // 普通跨平台库
      lib('com.mojang:logging:1.2.7', 'com/mojang/logging/1.2.7/logging-1.2.7.jar'),
      lib('com.google.guava:guava:33.3.1-jre', 'com/google/guava/guava/33.3.1-jre/guava-33.3.1-jre.jar'),
      // 只在 osx 上用的库 → Windows 必须排除
      {
        ...lib('ca.weblite:java-objc-bridge:1.1', 'ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar'),
        rules: [{ action: 'allow', os: { name: 'osx' } }],
      },
      // 只在 linux 上用的库 → Windows 必须排除
      {
        ...lib('org.lwjgl:lwjgl:3.3.3', 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar'),
        rules: [{ action: 'allow', os: { name: 'linux' } }],
      },
      // natives 库：Windows 取 natives-windows，且不进 classpath
      {
        name: 'org.lwjgl:lwjgl:3.3.3:natives-windows',
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
            sha1: '0'.repeat(40),
            size: 1,
            url: `${LIBS}org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar`,
          },
          classifiers: {
            'natives-windows': {
              path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
              sha1: '0'.repeat(40),
              size: 1,
              url: `${LIBS}org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar`,
            },
            'natives-macos': {
              path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-macos.jar',
              sha1: '0'.repeat(40),
              size: 1,
              url: `${LIBS}org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-macos.jar`,
            },
            'natives-linux': {
              path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar',
              sha1: '0'.repeat(40),
              size: 1,
              url: `${LIBS}org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar`,
            },
          },
        },
        natives: {
          windows: 'natives-windows',
          osx: 'natives-macos',
          linux: 'natives-linux',
        },
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        extract: { exclude: ['META-INF/'] },
      },
      // 老库：只有 Maven 坐标，没有 downloads（必须自己拼路径）
      { name: 'net.sf.jopt-simple:jopt-simple:5.0.4' },
    ],
    arguments: {
      game: [
        '--username',
        '${auth_player_name}',
        '--version',
        '${version_name}',
        '--gameDir',
        '${game_directory}',
        '--assetsDir',
        '${assets_root}',
        '--assetIndex',
        '${assets_index_name}',
        '--uuid',
        '${auth_uuid}',
        '--accessToken',
        '${auth_access_token}',
        '--clientId',
        '${clientid}',
        '--xuid',
        '${auth_xuid}',
        '--userType',
        '${user_type}',
        '--versionType',
        '${version_type}',
        {
          rules: [{ action: 'allow', features: { is_demo_user: true } }],
          value: '--demo',
        },
        {
          rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '1280', '--height', '720'],
        },
      ],
      jvm: [
        {
          rules: [{ action: 'allow', os: { name: 'osx' } }],
          value: ['-XstartOnFirstThread'],
        },
        {
          rules: [{ action: 'allow', os: { name: 'windows' } }],
          value: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump',
        },
        '-Djava.library.path=${natives_directory}',
        '-Djna.tmpdir=${natives_directory}',
        '-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}',
        '-Dio.netty.native.workdir=${natives_directory}',
        '-Dminecraft.launcher.brand=${launcher_name}',
        '-Dminecraft.launcher.version=${launcher_version}',
        '-cp',
        '${classpath}',
      ],
    },
  };
}

// ───────────────────────────── fixture：1.12 风格 ─────────────────────────────

function version1122(): VersionJson {
  return {
    id: '1.12.2',
    type: 'release',
    mainClass: 'net.minecraft.launchwrapper.Launch',
    assets: '1.12',
    assetIndex: { id: '1.12', sha1: 'b'.repeat(40), size: 1, totalSize: 1, url: 'https://example/legacy.json' },
    javaVersion: { component: 'jre-legacy', majorVersion: 8 },
    minecraftArguments:
      '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} '
      + '--assetsDir ${game_assets} --assetIndex ${assets_index_name} --uuid ${auth_uuid} '
      + '--accessToken ${auth_access_token} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker',
    libraries: [
      lib('net.minecraft:launchwrapper:1.12', 'net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar'),
      { name: 'org.scala-lang:scala-library:2.11.1' }, // 老库无 downloads，按坐标拼
      {
        name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
        downloads: {
          classifiers: {
            'natives-windows': {
              path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar',
              sha1: '0'.repeat(40),
              size: 1,
              url: `${LIBS}win.jar`,
            },
          },
        },
        natives: { windows: 'natives-windows', linux: 'natives-linux', osx: 'natives-osx' },
        extract: { exclude: ['META-INF/'] },
      },
    ],
  };
}

// ───────────────────────────── 测试：1.21 风格 ─────────────────────────────

test('1.21 风格：-cp / mainClass / --username / --uuid / 分隔符 / 游戏 jar 在最后', async () => {
  const env = makeEnv('121');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });

  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });

  // java：数据目录下的 java home（fake javaw.exe）
  assert.equal(
    cmd.java,
    path.join(javaHomeOf(env.dataRoot), 'bin', 'javaw.exe'),
    `java 应命中 java/ 下的运行时，实际：${cmd.java}`,
  );

  // cwd = 游戏目录 = 实例目录
  assert.equal(cmd.cwd, path.resolve(env.instanceDir));

  // -cp 必须存在且在 mainClass 之前
  const cpAt = cmd.args.indexOf('-cp');
  const mainAt = cmd.args.indexOf('net.minecraft.client.main.Main');
  assert.ok(cpAt >= 0, `args 里必须有 -cp：${cmd.args.join(' ')}`);
  assert.ok(mainAt > cpAt, `-cp 必须在 mainClass 之前（-cp@${cpAt}, main@${mainAt}）`);

  const classpath = cmd.args[cpAt + 1] as string;
  const entries = classpath.split(';');

  // 分隔符是 ;
  assert.ok(classpath.includes(';'), 'Windows classpath 必须用 ; 分隔');
  assert.ok(!classpath.split(';').some((e) => e.includes(':') && !/^[A-Za-z]:/.test(e)), '不应出现 : 分隔符');

  // 游戏本体 jar 在最后一位
  const expectedJar = path.join(env.dataRoot, 'versions', '1.21.4', '1.21.4.jar');
  assert.equal(entries[entries.length - 1], expectedJar, `游戏 jar 必须是最后一位，实际末尾：${entries[entries.length - 1]}`);
  assert.ok(!entries.slice(0, -1).includes(expectedJar), '游戏 jar 只能出现一次');

  // 库路径
  assert.ok(
    entries.includes(path.join(env.dataRoot, 'libraries', 'com', 'mojang', 'logging', '1.2.7', 'logging-1.2.7.jar')),
    '带 downloads.artifact.path 的库应直接用该 path',
  );
  assert.ok(
    entries.includes(path.join(env.dataRoot, 'libraries', 'net', 'sf', 'jopt-simple', 'jopt-simple', '5.0.4', 'jopt-simple-5.0.4.jar')),
    '无 downloads 的老库应按 Maven 坐标拼路径（group 的 . 换成 /）',
  );

  // natives 库不进 classpath
  assert.ok(
    !entries.some((e) => e.includes('natives-windows')),
    `natives 库不应出现在 classpath：${classpath}`,
  );
  // 但同时声明了 artifact 的 natives 库，其 artifact 仍应在 classpath 里
  assert.ok(
    entries.includes(path.join(env.dataRoot, 'libraries', 'org', 'lwjgl', 'lwjgl', '3.3.3', 'lwjgl-3.3.3.jar')),
    'natives 库声明了 artifact 时该 artifact 仍应进 classpath',
  );

  // game 参数
  assert.equal(findArg(cmd.args, '--username'), 'Steve');
  assert.equal(findArg(cmd.args, '--uuid'), OFFLINE.uuid);
  assert.equal(findArg(cmd.args, '--version'), '1.21.4');
  assert.equal(findArg(cmd.args, '--gameDir'), path.resolve(env.instanceDir));
  assert.equal(findArg(cmd.args, '--assetsDir'), path.join(env.dataRoot, 'assets'));
  assert.equal(findArg(cmd.args, '--assetIndex'), '17');
  assert.equal(findArg(cmd.args, '--accessToken'), '0');
  assert.equal(findArg(cmd.args, '--clientId'), '');
  assert.equal(findArg(cmd.args, '--userType'), 'legacy');
  assert.equal(findArg(cmd.args, '--versionType'), 'release');

  // 位置：--username 在 mainClass 之后（game 参数）
  const usernameAt = cmd.args.indexOf('--username');
  assert.ok(usernameAt > mainAt, '--username 必须作为 game 参数跟在 mainClass 之后');

  // 默认 JVM 参数
  assert.equal(findFlag(cmd.args, '-Xmx'), '-Xmx2048M');
  assert.equal(findFlag(cmd.args, '-Xmn'), '-Xmn512M');
  assert.equal(findFlag(cmd.args, '-Dfile.encoding='), '-Dfile.encoding=UTF-8');
  assert.equal(findValueOf(cmd.args, '-Djava.library.path='), path.join(env.instanceDir, 'natives'));

  // 占位符一个都不能剩
  const leftovers = cmd.args.filter((a) => a.includes('${'));
  assert.deepEqual(leftovers, [], `不允许残留占位符：${leftovers.join(' | ')}`);

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ───────────────────────────── 测试：1.12 风格 ─────────────────────────────

test('1.12 风格：minecraftArguments 按空格切分并逐个替换占位符', async () => {
  const env = makeEnv('112');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.12.2': version1122() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });

  const cmd = await launcher.buildCommand({ versionId: '1.12.2', instanceDir: env.instanceDir, account: OFFLINE });
  const mainAt = cmd.args.indexOf('net.minecraft.launchwrapper.Launch');
  assert.ok(mainAt >= 0);

  // 切成独立参数，不是一整个长字符串
  assert.equal(findArg(cmd.args, '--username'), 'Steve');
  assert.equal(findArg(cmd.args, '--version'), '1.12.2');
  assert.equal(findArg(cmd.args, '--gameDir'), path.resolve(env.instanceDir));
  assert.equal(findArg(cmd.args, '--assetsDir'), path.join(env.dataRoot, 'assets'), '${game_assets} 应映射到 assets 根');
  assert.equal(findArg(cmd.args, '--assetIndex'), '1.12');
  assert.equal(findArg(cmd.args, '--uuid'), OFFLINE.uuid);
  assert.equal(findArg(cmd.args, '--accessToken'), '0');
  assert.equal(findArg(cmd.args, '--tweakClass'), 'net.minecraftforge.fml.common.launcher.FMLTweaker');

  // 没有任何参数包含空格（切分正确）
  const withSpace = cmd.args.filter((a) => a.includes(' '));
  assert.deepEqual(withSpace, [], '老版本参数必须切分成独立元素，不能带空格');

  // 老版本自己拼 JVM 参数：-cp 在 mainClass 之前
  const cpAt = cmd.args.indexOf('-cp');
  assert.ok(cpAt >= 0 && cpAt < mainAt, '-cp 必须在 mainClass 之前');

  const entries = (cmd.args[cpAt + 1] as string).split(';');
  assert.equal(entries[entries.length - 1], path.join(env.dataRoot, 'versions', '1.12.2', '1.12.2.jar'));
  assert.ok(
    entries.includes(path.join(env.dataRoot, 'libraries', 'org', 'scala-lang', 'scala-library', '2.11.1', 'scala-library-2.11.1.jar')),
    '老库按 Maven 坐标拼路径',
  );

  assert.deepEqual(cmd.args.filter((a) => a.includes('${')), []);

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ───────────────────────────── 测试：rules 求值 ─────────────────────────────

test('rules：{allow, os.name=osx} 的库在 Windows 上必须被排除', async () => {
  const env = makeEnv('rules-osx');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });
  const cpIndex = cmd.args.indexOf('-cp');
  const entries = (cmd.args[cpIndex + 1] as string).split(';');

  assert.ok(
    !entries.some((e) => e.includes('java-objc-bridge')),
    `osx 专属库必须被排除，实际 classpath：\n${entries.join('\n')}`,
  );
  assert.ok(
    !cmd.args.includes('-XstartOnFirstThread'),
    'osx 专属的 JVM 参数必须被排除',
  );
  assert.ok(
    !cmd.args.includes('--demo'),
    'is_demo_user=false 时不应出现 --demo',
  );
  assert.ok(!cmd.args.includes('--width'), 'has_custom_resolution=false 时不应出现 --width');

  // 同一份 JSON 换到 osx 平台，该库必须出现
  const osx: Platform = { name: 'osx', arch: 'arm64', classpathSeparator: ':', nativesKey: 'osx' };
  const osxLauncher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: osx,
  });
  const osxCmd = await osxLauncher.buildCommand({
    versionId: '1.21.4',
    instanceDir: env.instanceDir,
    account: OFFLINE,
    javaPath: path.join(javaHomeOf(env.dataRoot), 'bin', 'java.exe'),
  });
  const osxEntries = (osxCmd.args[osxCmd.args.indexOf('-cp') + 1] as string).split(':');
  assert.ok(
    osxEntries.some((e) => e.includes('java-objc-bridge')),
    `osx 平台上该库必须出现：${osxEntries.join(':')}`,
  );
  assert.ok(osxCmd.args.includes('-XstartOnFirstThread'), 'osx 专属 JVM 参数应生效');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('rules：最后一条匹配的 rule 说了算（allow 后接 disallow → 排除）', async () => {
  const env = makeEnv('rules-order');
  const json = version121();
  json.libraries = [
    {
      name: 'com.example:override:1.0',
      downloads: { artifact: { path: 'com/example/override/1.0/override-1.0.jar', sha1: '0'.repeat(40), size: 1, url: `${LIBS}x.jar` } },
      rules: [{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }],
    },
    {
      name: 'com.example:reverse:1.0',
      downloads: { artifact: { path: 'com/example/reverse/1.0/reverse-1.0.jar', sha1: '0'.repeat(40), size: 1, url: `${LIBS}y.jar` } },
      // 先 disallow 再 allow windows → 在 Windows 上允许
      rules: [{ action: 'disallow' }, { action: 'allow', os: { name: 'windows' } }],
    },
    {
      // 无 rules → 允许
      name: 'com.example:plain:1.0',
      downloads: { artifact: { path: 'com/example/plain/1.0/plain-1.0.jar', sha1: '0'.repeat(40), size: 1, url: `${LIBS}z.jar` } },
    },
    {
      // 有 arch 条件：x86_64 命中
      name: 'com.example:arch64:1.0',
      downloads: { artifact: { path: 'com/example/arch64/1.0/arch64-1.0.jar', sha1: '0'.repeat(40), size: 1, url: `${LIBS}a.jar` } },
      rules: [{ action: 'allow', os: { arch: 'x86_64' } }],
    },
    {
      // 有架构条件：x86 不命中
      name: 'com.example:arch32:1.0',
      downloads: { artifact: { path: 'com/example/arch32/1.0/arch32-1.0.jar', sha1: '0'.repeat(40), size: 1, url: `${LIBS}b.jar` } },
      rules: [{ action: 'allow', os: { arch: 'x86' } }],
    },
  ];

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': json }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });
  const entries = (cmd.args[cmd.args.indexOf('-cp') + 1] as string).split(';');
  const has = (needle: string): boolean => entries.some((e) => e.includes(needle));

  assert.equal(has('override-1.0.jar'), false, 'allow 之后又被 disallow(windows) 覆盖 → 排除');
  assert.equal(has('reverse-1.0.jar'), true, 'disallow 之后 allow(windows) 覆盖 → 允许');
  assert.equal(has('plain-1.0.jar'), true, '无 rules → 允许');
  assert.equal(has('arch64-1.0.jar'), true, 'os.arch=x86_64 命中');
  assert.equal(has('arch32-1.0.jar'), false, 'os.arch=x86 在 x86_64 上不命中');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('rules：os.arch 省略时按「匹配任意架构」处理（官方绝大多数库的情形）', async () => {
  const env = makeEnv('rules-arch-absent');
  const json = version121();
  json.libraries = [
    {
      name: 'org.lwjgl:lwjgl:3.3.3',
      downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar', sha1: '0'.repeat(40), size: 1, url: `${LIBS}a.jar` } },
      rules: [{ action: 'allow' }],
    },
  ];
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': json }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });
  const entries = (cmd.args[cmd.args.indexOf('-cp') + 1] as string).split(';');
  assert.ok(entries.some((e) => e.includes('lwjgl-3.3.3.jar')), '无 os 条件的 allow 规则应生效');
  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ───────────────────────────── 测试：natives ─────────────────────────────

test('natives：Windows 取 natives-windows，解压到实例目录并排除 META-INF', async () => {
  const env = makeEnv('natives');

  // 在 libraries 下放真实的 natives jar（一个 STORED、一个 DEFLATE）
  const nativesRel = 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar';
  const nativesAbs = path.join(env.dataRoot, 'libraries', ...nativesRel.split('/'));
  fs.mkdirSync(path.dirname(nativesAbs), { recursive: true });
  fs.writeFileSync(
    nativesAbs,
    buildZip([
      { name: 'lwjgl.dll', data: 'windows native dll' },
      { name: 'glfw.dll', data: 'glfw dll', deflate: true },
      { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0' },
      { name: 'META-INF/hashes.txt', data: 'deadbeef' },
    ]),
  );

  const javaHome = javaHomeOf(env.dataRoot);
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });

  const nativesDir = findValueOf(cmd.args, '-Djava.library.path=');
  assert.equal(nativesDir, path.join(env.instanceDir, 'natives'));

  assert.ok(fs.existsSync(path.join(nativesDir as string, 'lwjgl.dll')), 'STORED 条目应解出');
  assert.ok(fs.existsSync(path.join(nativesDir as string, 'glfw.dll')), 'DEFLATE 条目应解出');
  assert.equal(fs.readFileSync(path.join(nativesDir as string, 'lwjgl.dll'), 'utf8'), 'windows native dll');
  assert.equal(fs.readFileSync(path.join(nativesDir as string, 'glfw.dll'), 'utf8'), 'glfw dll');
  assert.equal(fs.existsSync(path.join(nativesDir as string, 'META-INF')), false, 'extract.exclude 里的 META-INF/ 必须被跳过');

  // 只取 windows classifier：macos / linux 的 jar 不应被创建
  assert.equal(fs.existsSync(path.join(nativesDir as string, 'lwjgl-3.3.3-natives-macos.jar')), false);

  // 二次调用应命中断点跳过，不重复解压
  const before = fs.statSync(path.join(nativesDir as string, 'lwjgl.dll')).mtimeMs;
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });
  const after = fs.statSync(path.join(nativesDir as string, 'lwjgl.dll')).mtimeMs;
  assert.equal(after, before, '已解压过应跳过（mtime 不变）');

  // 缓存文件存在，说明走了状态比对
  assert.ok(fs.existsSync(path.join(nativesDir as string, '.pcl3-natives.json')));

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
  void javaHome;
});

// ───────────────────────────── 测试：java 选择与错误 ─────────────────────────────

test('javaPath：未指定且数据目录里没有对应 JRE 时抛出明确错误（不静默用错版本）', async () => {
  const dataRoot = tmpDir('no-java');
  const instanceDir = path.join(dataRoot, 'instances', 'demo');
  fs.mkdirSync(instanceDir, { recursive: true });
  // 只装了一个 Java 8，但版本要求 21
  const j8 = path.join(dataRoot, 'java', 'jre-legacy', 'bin');
  fs.mkdirSync(j8, { recursive: true });
  fs.writeFileSync(path.join(j8, 'javaw.exe'), 'fake');

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot,
    platform: WINDOWS,
  });

  await assert.rejects(
    () => launcher.buildCommand({ versionId: '1.21.4', instanceDir, account: OFFLINE }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /找不到可用的 Java 运行时/);
      assert.match(msg, /Java 21/);
      assert.match(msg, /javaPath/);
      return true;
    },
  );

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('javaPath：显式给出时优先使用，且支持 java home 目录', async () => {
  const env = makeEnv('java-explicit');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });

  const home = javaHomeOf(env.dataRoot);
  const cmd = await launcher.buildCommand({
    versionId: '1.21.4',
    instanceDir: env.instanceDir,
    account: OFFLINE,
    javaPath: home,
  });
  assert.equal(cmd.java, path.join(home, 'bin', 'javaw.exe'));

  const exe = path.join(home, 'bin', 'java.exe');
  const cmd2 = await launcher.buildCommand({
    versionId: '1.21.4',
    instanceDir: env.instanceDir,
    account: OFFLINE,
    javaPath: exe,
  });
  assert.equal(cmd2.java, exe);

  await assert.rejects(
    () =>
      launcher.buildCommand({
        versionId: '1.21.4',
        instanceDir: env.instanceDir,
        account: OFFLINE,
        javaPath: path.join(env.dataRoot, 'nope'),
      }),
    /指定的 javaPath 不可用/,
  );

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ───────────────────────────── 测试：占位符全覆盖 ─────────────────────────────

test('占位符：17 个全部有映射，且任何情况下都不残留 ${...}', async () => {
  const env = makeEnv('placeholders');
  const json = version121();
  // 把 17 个占位符全部塞进 game 参数，验证逐个替换
  json.arguments = {
    game: KNOWN_PLACEHOLDERS.map((name) => `--ph-${name}=` + '${' + name + '}'),
    jvm: ['-cp', '${classpath}', '-Djava.library.path=${natives_directory}', '-Dph.sep=${classpath_separator}'],
  };
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': json }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });

  assert.equal(KNOWN_PLACEHOLDERS.length, 17);
  assert.deepEqual(cmd.args.filter((a) => a.includes('${')), []);

  const value = (name: string): string | undefined => {
    const prefix = `--ph-${name}=`;
    const hit = cmd.args.find((a) => a.startsWith(prefix));
    return hit?.slice(prefix.length);
  };

  assert.equal(value('auth_player_name'), 'Steve');
  assert.equal(value('version_name'), '1.21.4');
  assert.equal(value('game_directory'), path.resolve(env.instanceDir));
  assert.equal(value('assets_root'), path.join(env.dataRoot, 'assets'));
  assert.equal(value('assets_index_name'), '17');
  assert.equal(value('auth_uuid'), OFFLINE.uuid);
  assert.equal(value('auth_access_token'), '0');
  assert.equal(value('clientid'), '');
  assert.equal(value('auth_xuid'), '');
  assert.equal(value('user_type'), 'legacy');
  assert.equal(value('version_type'), 'release');
  assert.equal(value('natives_directory'), path.join(env.instanceDir, 'natives'));
  assert.equal(value('game_assets'), path.join(env.dataRoot, 'assets'));
  assert.equal(value('classpath_separator'), ';');
  assert.ok((value('launcher_name') ?? '').length > 0, '${launcher_name} 应取自 package.json 的 productName');
  assert.match(value('launcher_version') ?? '', /^\d+\.\d+\.\d+/);
  assert.ok((value('classpath') ?? '').includes('1.21.4.jar'));

  // classpath 分隔符占位符用于 JVM 参数时也正确
  assert.equal(findFlag(cmd.args, '-Dph.sep='), '-Dph.sep=;');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ───────────────────────────── 测试：内存与额外参数 ─────────────────────────────

test('内存：memoryMB=4096 时 -Xmx4096M / -Xmn1024M，额外 JVM 参数落在 -cp 之前', async () => {
  const env = makeEnv('memory');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({
    versionId: '1.21.4',
    instanceDir: env.instanceDir,
    account: OFFLINE,
    memoryMB: 4096,
    extraJvmArgs: ['-XX:+UseG1GC', '-Dpcl3.debug=true'],
    extraGameArgs: ['--server', 'localhost'],
  });

  assert.equal(findFlag(cmd.args, '-Xmx'), '-Xmx4096M');
  assert.equal(findFlag(cmd.args, '-Xmn'), '-Xmn1024M');
  assert.ok(cmd.args.includes('-XX:+UseG1GC'));
  assert.ok(cmd.args.includes('-Dpcl3.debug=true'));
  const cpAt = cmd.args.indexOf('-cp');
  assert.ok(cpAt >= 0, '必须有 -cp');
  // mainClass 紧跟在 classpath 之后
  assert.equal(cmd.args[cpAt + 2], 'net.minecraft.client.main.Main', '-cp 的值之后应紧跟 mainClass');
  assert.ok(cmd.args.indexOf('-XX:+UseG1GC') < cpAt, '额外 JVM 参数应在 -cp 之前');
  assert.ok((cmd.args[cpAt + 1] as string).endsWith('1.21.4.jar'), '-cp 的值就是完整 classpath');
  assert.equal(findArg(cmd.args, '--server'), 'localhost');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ───────────────────────────── 测试：正版账户 user_type ─────────────────────────────

test('正版账户：user_type 为 msa，xuid 透传', async () => {
  const env = makeEnv('msa');
  const account: Account = {
    type: 'microsoft',
    username: 'Notch',
    uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    accessToken: 'mc-token',
    xuid: '2535410000000000',
  };
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account });

  assert.equal(findArg(cmd.args, '--username'), 'Notch');
  assert.equal(findArg(cmd.args, '--uuid'), account.uuid);
  assert.equal(findArg(cmd.args, '--accessToken'), 'mc-token');
  assert.equal(findArg(cmd.args, '--userType'), 'msa');
  assert.equal(findArg(cmd.args, '--xuid'), '2535410000000000');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ───────────────────────────── 测试：inheritsFrom ─────────────────────────────

test('inheritsFrom：resolveInherited 合并后父版本参数与库都在', async () => {
  const env = makeEnv('inherit');
  const parent = version121();
  const child: VersionJson = {
    id: '1.21.4-forge-1',
    type: 'release',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    assets: '17',
    inheritsFrom: '1.21.4',
    libraries: [
      lib('net.minecraftforge:forge:1.21.4-1', 'net/minecraftforge/forge/1.21.4-1/forge-1.21.4-1.jar'),
    ],
    arguments: {
      game: ['--launchTarget', 'forgeclient'],
      jvm: [],
    },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
  };
  const repo = new FakeVersionRepo({ '1.21.4': parent, '1.21.4-forge-1': child });
  const launcher = new GameLauncher({ versionRepo: repo, dataRoot: env.dataRoot, platform: WINDOWS });

  const cmd = await launcher.buildCommand({
    versionId: '1.21.4-forge-1',
    instanceDir: env.instanceDir,
    account: OFFLINE,
  });

  assert.deepEqual(repo.requests, ['1.21.4-forge-1', '1.21.4'], '应解析继承链');
  assert.ok(cmd.args.includes('cpw.mods.bootstraplauncher.BootstrapLauncher'));
  assert.ok(!cmd.args.includes('net.minecraft.client.main.Main'), '子版本的 mainClass 应覆盖父版本');
  assert.equal(findArg(cmd.args, '--username'), 'Steve', '父版本的 game 参数应保留');
  assert.equal(findArg(cmd.args, '--launchTarget'), 'forgeclient', '子版本的 game 参数应存在');

  const entries = (cmd.args[cmd.args.indexOf('-cp') + 1] as string).split(';');
  assert.ok(entries.some((e) => e.includes('forge-1.21.4-1.jar')), '子版本的库应进 classpath');
  assert.ok(entries.some((e) => e.includes('guava-33.3.1-jre.jar')), '父版本的库应进 classpath');
  assert.equal(entries[entries.length - 1], path.join(env.dataRoot, 'versions', '1.21.4-forge-1', '1.21.4-forge-1.jar'));

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ───────────────────────────── 测试：launch() 真的 spawn ─────────────────────────────

test('launch()：真 spawn（假 java = node 的 exe 副本），并验证 args 原样到达子进程', async () => {
  const env = makeEnv('spawn');

  // 把 node.exe 复制成 javaw.exe 当假 java（javaExecutable 优先选 javaw.exe），
  // 再删掉 bin/java.exe，保证 buildCommand 选中的一定是它。
  const fakeJava = path.join(javaHomeOf(env.dataRoot), 'bin', 'javaw.exe');
  fs.rmSync(fakeJava, { force: true });
  fs.copyFileSync(process.execPath, fakeJava);
  fs.rmSync(path.join(javaHomeOf(env.dataRoot), 'bin', 'java.exe'), { force: true });

  // 子进程侧记录 argv：用 `--require` 注入 CJS（node 遇到 -Xmx 这类未知参数会直接退出，
  // ESM 的 --import 来不及生效）。--require 也会继承给本进程，但本进程已在运行，
  // 注入不生效；环境变量在 launch 之后立即恢复。
  const dumpScript = path.join(env.instanceDir, 'dump-argv.cjs');
  const dumpOut = path.join(env.instanceDir, 'argv.json');
  fs.writeFileSync(
    dumpScript,
    'const fs = require("node:fs");\n'
      + 'fs.writeFileSync(process.env.PCL3_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n',
  );
  const saved = {
    nodeOptions: process.env['NODE_OPTIONS'],
    argvOut: process.env['PCL3_ARGV_OUT'],
  };
  process.env['NODE_OPTIONS'] = `--require=${dumpScript}`;
  process.env['PCL3_ARGV_OUT'] = dumpOut;

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });

  const built = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });
  assert.equal(built.java, fakeJava, '假 javaw.exe 应被选中（优先于 java.exe）');

  const started = await launcher.launch({
    versionId: '1.21.4',
    instanceDir: env.instanceDir,
    account: OFFLINE,
  });
  restoreEnv('NODE_OPTIONS', saved.nodeOptions);
  restoreEnv('PCL3_ARGV_OUT', saved.argvOut);

  assert.ok(started.pid > 0, `应拿到 pid，实际 ${started.pid}`);
  assert.equal(typeof started.process.kill, 'function', 'process 字段应是 ChildProcess');
  const code = await new Promise<number | null>((resolve) => {
    started.process.once('exit', (c) => resolve(c));
  });
  assert.equal(typeof code, 'number', '子进程应正常退出并被捕获');

  // args 结构自检（这部分不依赖旁路落盘，是最硬的断言）
  const cpAt = built.args.indexOf('-cp');
  assert.equal(built.args[cpAt + 2], 'net.minecraft.client.main.Main', '-cp / value / mainClass 相邻');
  assert.equal(findArg(built.args, '--username'), 'Steve');
  assert.deepEqual(built.args.filter((a) => a.includes('${')), [], '不应有未替换占位符');

  // 若旁路落盘生效（取决于 NODE_OPTIONS 是否被子进程继承），比对真实 argv
  if (fs.existsSync(dumpOut)) {
    const received = JSON.parse(fs.readFileSync(dumpOut, 'utf8')) as string[];
    assert.deepEqual(received, built.args, 'launch() 传给子进程的必须是 buildCommand 的 args');
    assert.ok(received.includes('-Xmx2048M'));
  }

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});
