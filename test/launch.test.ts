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
    // 关掉自动下载（javaProvisioner: null）——本用例只断言「没有可用 Java 时的错误文案」，
    // 自动下载路径由 java.test.ts 的接线用例单独覆盖。
    javaProvisioner: null,
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

  // 继承链被解析过即可（P0 修复后还会额外取一次未合并 JSON 来定位 jar，属正常）
  assert.ok(repo.requests.includes('1.21.4-forge-1') && repo.requests.includes('1.21.4'), '应解析继承链');
  assert.ok(cmd.args.includes('cpw.mods.bootstraplauncher.BootstrapLauncher'));
  assert.ok(!cmd.args.includes('net.minecraft.client.main.Main'), '子版本的 mainClass 应覆盖父版本');
  assert.equal(findArg(cmd.args, '--username'), 'Steve', '父版本的 game 参数应保留');
  assert.equal(findArg(cmd.args, '--launchTarget'), 'forgeclient', '子版本的 game 参数应存在');

  const entries = (cmd.args[cmd.args.indexOf('-cp') + 1] as string).split(';');
  assert.ok(entries.some((e) => e.includes('forge-1.21.4-1.jar')), '子版本的库应进 classpath');
  assert.ok(entries.some((e) => e.includes('guava-33.3.1-jre.jar')), '父版本的库应进 classpath');
  // ⚠ 语义变更（P0 修复）：classpath 最后一项是**真正持有 jar 的版本**。
  // makeEnv 不创建任何 .jar，链上谁都没有 jar，于是回退到 realVersionId（= 子版本）。
  // 有 jar 的场景见下方「client jar 解析」一组测试。
  assert.equal(entries[entries.length - 1], path.join(env.dataRoot, 'versions', '1.21.4-forge-1', '1.21.4-forge-1.jar'));

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ─────────────────────── 测试：client jar 解析（P0：加载器版本没有自己的 jar） ───────────────────────

/** 写一个版本目录：<root>/versions/<id>/<id>.json（可选同时建 .jar） */
function writeVersionDir(dataRoot: string, json: VersionJson, withJar: boolean): void {
  const dir = path.join(dataRoot, 'versions', json.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${json.id}.json`), JSON.stringify(json, null, 2), 'utf8');
  if (withJar) fs.writeFileSync(path.join(dir, `${json.id}.jar`), 'fake-jar', 'utf8');
}

/** 加载器版本的 profile：只有 json，没有 jar */
function loaderProfile(gameVersion: string, loaderId: string): VersionJson {
  return {
    id: loaderId,
    type: 'release',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    assets: '',
    inheritsFrom: gameVersion,
    libraries: [
      lib('net.fabricmc:fabric-loader:0.19.5', 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar'),
    ],
    arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
  };
}

test('P0：加载器版本无 jar 时，classpath 末项必须指向 inheritsFrom 原版的 jar', async () => {
  const env = makeEnv('loaderjar');
  const loaderId = 'fabric-loader-0.19.5-1.21.4';
  // 原版：有 jar
  writeVersionDir(env.dataRoot, version121(), true);
  // 加载器：只有 json
  const profile = loaderProfile('1.21.4', loaderId);
  writeVersionDir(env.dataRoot, profile, false);

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121(), [loaderId]: profile }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });

  const cmd = await launcher.buildCommand({ versionId: loaderId, instanceDir: env.instanceDir, account: OFFLINE });
  const entries = (cmd.args[cmd.args.indexOf('-cp') + 1] as string).split(';');
  const last = entries[entries.length - 1] as string;

  assert.equal(
    last,
    path.join(env.dataRoot, 'versions', '1.21.4', '1.21.4.jar'),
    'classpath 末项应是原版 1.21.4 的 jar，而不是不存在的加载器 jar',
  );
  assert.ok(!last.includes(loaderId), '绝不能引用加载器版本自己的 jar（它不存在）');
  assert.ok(fs.existsSync(last), 'classpath 末项必须是真实存在的文件');

  // mainClass 仍是加载器的
  assert.ok(cmd.args.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'));
  // 资产索引跟随原版
  assert.equal(findArg(cmd.args, '--assetIndex'), '17', '资产索引必须来自原版');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('P0：加载器版本自己有 jar 时仍用自己的（不误伤原版直接启动）', async () => {
  const env = makeEnv('ownjar');
  writeVersionDir(env.dataRoot, version121(), true);

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });
  const entries = (cmd.args[cmd.args.indexOf('-cp') + 1] as string).split(';');
  assert.equal(entries[entries.length - 1], path.join(env.dataRoot, 'versions', '1.21.4', '1.21.4.jar'));

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('P0：多层继承链（loader → 中间层 → 原版 jar）能一路找到 jar', async () => {
  const env = makeEnv('chain');
  writeVersionDir(env.dataRoot, version121(), true);

  const mid: VersionJson = {
    id: 'mid-layer',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    inheritsFrom: '1.21.4',
    libraries: [],
  };
  writeVersionDir(env.dataRoot, mid, false);

  const top: VersionJson = {
    ...loaderProfile('mid-layer', 'quilt-loader-0.30.1-1.21.4'),
    id: 'quilt-loader-0.30.1-1.21.4',
    inheritsFrom: 'mid-layer',
  };
  writeVersionDir(env.dataRoot, top, false);

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({
      '1.21.4': version121(),
      'mid-layer': mid,
      'quilt-loader-0.30.1-1.21.4': top,
    }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });

  const cmd = await launcher.buildCommand({
    versionId: 'quilt-loader-0.30.1-1.21.4',
    instanceDir: env.instanceDir,
    account: OFFLINE,
  });
  const entries = (cmd.args[cmd.args.indexOf('-cp') + 1] as string).split(';');
  assert.equal(
    entries[entries.length - 1],
    path.join(env.dataRoot, 'versions', '1.21.4', '1.21.4.jar'),
    '应跳过中间层，找到真正有 jar 的祖先',
  );

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('P0：整条链都没有 jar 时回退到自身 id（不抛错，保留旧行为）', async () => {
  const env = makeEnv('nojar');
  const loaderId = 'fabric-loader-x-1.21.4';
  writeVersionDir(env.dataRoot, version121(), false);
  writeVersionDir(env.dataRoot, loaderProfile('1.21.4', loaderId), false);

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121(), [loaderId]: loaderProfile('1.21.4', loaderId) }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: loaderId, instanceDir: env.instanceDir, account: OFFLINE });
  const entries = (cmd.args[cmd.args.indexOf('-cp') + 1] as string).split(';');
  assert.equal(entries[entries.length - 1], path.join(env.dataRoot, 'versions', loaderId, `${loaderId}.jar`));

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('P0：资产索引跟随原版（加载器 assets 为空串时不使用它）', async () => {
  const env = makeEnv('assets');
  const loaderId = 'fabric-loader-0.19.5-1.21.4';
  writeVersionDir(env.dataRoot, version121(), true);
  const profile = loaderProfile('1.21.4', loaderId);
  profile.assets = ''; // 加载器 profile 的 assets 是空串（真实情况）
  writeVersionDir(env.dataRoot, profile, false);

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121(), [loaderId]: profile }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: loaderId, instanceDir: env.instanceDir, account: OFFLINE });
  assert.equal(findArg(cmd.args, '--assetsIndex') ?? findArg(cmd.args, '--assetIndex'), '17');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

// ─────────────────── 测试：libraries 合并必须区分 classifier（P0：jtracy 主 jar 丢失） ───────────────────

test('P0：合并时 classifier 不同的库必须同时保留（jtracy 主 jar 不能被 natives 覆盖）', async () => {
  const { mergeVersionJson } = await import('../src/core/launch/version-merge.js');

  const parent: VersionJson = {
    id: '26.3',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    libraries: [
      lib('com.mojang:jtracy:1.14.38', 'com/mojang/jtracy/1.14.38/jtracy-1.14.38.jar'),
      lib('com.mojang:jtracy:1.14.38:natives-windows', 'com/mojang/jtracy/1.14.38/jtracy-1.14.38-natives-windows.jar', {
        rules: [{ action: 'allow', os: { name: 'windows' } }],
      }),
    ],
  };
  const child: VersionJson = {
    id: 'fabric-loader-0.19.5-26.3',
    type: 'release',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    assets: '',
    inheritsFrom: '26.3',
    libraries: [lib('net.fabricmc:fabric-loader:0.19.5', 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar')],
  };

  const merged = mergeVersionJson(parent, child);
  const names = (merged.libraries ?? []).map((l) => l.name);

  assert.ok(names.includes('com.mojang:jtracy:1.14.38'), 'jtracy 主 jar 必须保留（缺失会 NoClassDefFoundError）');
  assert.ok(names.includes('com.mojang:jtracy:1.14.38:natives-windows'), 'jtracy natives 也必须保留');
  assert.ok(names.includes('net.fabricmc:fabric-loader:0.19.5'), '子版本库也要在');
});

test('P0：同 group:artifact 且同 classifier 时仍由子版本覆盖（版本升级语义不变）', async () => {
  const { mergeVersionJson } = await import('../src/core/launch/version-merge.js');

  const parent: VersionJson = {
    id: '1.21.4',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    libraries: [lib('com.google.guava:guava:33.3.1-jre', 'com/google/guava/guava/33.3.1-jre/guava-33.3.1-jre.jar')],
  };
  const child: VersionJson = {
    id: 'child',
    type: 'release',
    mainClass: 'X',
    assets: '',
    inheritsFrom: '1.21.4',
    libraries: [lib('com.google.guava:guava:33.4.0-jre', 'com/google/guava/guava/33.4.0-jre/guava-33.4.0-jre.jar')],
  };

  const merged = mergeVersionJson(parent, child);
  const guavas = (merged.libraries ?? []).filter((l) => l.name.startsWith('com.google.guava:guava'));
  assert.equal(guavas.length, 1, '同分类的同名库应只剩一条');
  assert.equal(guavas[0]?.name, 'com.google.guava:guava:33.4.0-jre', '子版本应覆盖父版本');
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

// ═════════════════ 测试：首次启动默认中文（options.txt + JVM locale） ═════════════════

test('options.txt：不存在时生成，且含 lang:zh_cn', async () => {
  const env = makeEnv('opt-create');
  const optFile = path.join(env.instanceDir, 'options.txt');
  assert.ok(!fs.existsSync(optFile), '前置条件：一开始不该有 options.txt');

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });

  assert.ok(fs.existsSync(optFile), 'buildCommand 后应生成 options.txt');
  const raw = fs.readFileSync(optFile, 'utf8');
  const content = raw.replace(/\r\n/g, '\n');

  assert.match(content, /^lang:zh_cn$/m, '必须含 lang:zh_cn');
  assert.ok(content.startsWith('version:1.0\n'), '首行应是 version:1.0');
  assert.match(content, /^renderDistance:12$/m);
  assert.match(content, /^guiScale:0$/m);
  assert.match(content, /^autoJump:false$/m);

  // 格式约束：无 BOM、无冒号后空格、LF 换行
  assert.notEqual(raw.charCodeAt(0), 0xfeff, '不能有 BOM');
  assert.ok(!content.includes(': '), 'key:value 之间不能有空格');
  assert.ok(!raw.includes('\r\n'), '本项目约定 LF 换行');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('options.txt：已存在但无 lang 行 → 追加 lang:zh_cn，其他行原样保留', async () => {
  const env = makeEnv('opt-append');
  const optFile = path.join(env.instanceDir, 'options.txt');
  const original = 'version:1.0\nrenderDistance:8\nfov:0.5\nnarrator:1\n';
  fs.writeFileSync(optFile, original, 'utf8');

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });

  const content = fs.readFileSync(optFile, 'utf8').replace(/\r\n/g, '\n');
  assert.match(content, /^lang:zh_cn$/m, '应追加 lang:zh_cn');
  // 原有每一行都必须原样在
  for (const line of ['version:1.0', 'renderDistance:8', 'fov:0.5', 'narrator:1']) {
    assert.ok(content.split('\n').includes(line), `原有行 ${line} 必须保留`);
  }
  assert.ok(!content.includes(': '), '不能引入冒号后空格');
  // 只追加了一行
  assert.equal(content.trimEnd().split('\n').length, 5, '应恰好 5 行');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('options.txt：已有 lang:en_us → 逐字节不变（绝不改回中文）', async () => {
  const env = makeEnv('opt-respect');
  const optFile = path.join(env.instanceDir, 'options.txt');
  const original = 'version:1.0\nlang:en_us\nrenderDistance:16\nguiScale:2\n';
  fs.writeFileSync(optFile, original, 'utf8');
  const before = fs.readFileSync(optFile);
  const beforeMtime = fs.statSync(optFile).mtimeMs;

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });

  const after = fs.readFileSync(optFile);
  assert.deepEqual(after, before, '文件内容必须逐字节不变');
  assert.equal(fs.statSync(optFile).mtimeMs, beforeMtime, '连 mtime 都不该变（说明根本没写）');
  assert.ok(!after.toString('utf8').includes('zh_cn'));

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('options.txt：已有 lang:ja_jp → 同样不动', async () => {
  const env = makeEnv('opt-ja');
  const optFile = path.join(env.instanceDir, 'options.txt');
  const original = 'version:1.0\nlang:ja_jp\n';
  fs.writeFileSync(optFile, original, 'utf8');
  const before = fs.readFileSync(optFile);

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });

  assert.deepEqual(fs.readFileSync(optFile), before);
  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('options.txt：重复启动不会重复追加 lang 行', async () => {
  const env = makeEnv('opt-idempotent');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });
  const optFile = path.join(env.instanceDir, 'options.txt');
  const first = fs.readFileSync(optFile, 'utf8');

  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });
  const second = fs.readFileSync(optFile, 'utf8');

  assert.equal(second, first, '第二次启动不该改动文件');
  assert.equal(second.split('\n').filter((l) => l.startsWith('lang:')).length, 1, 'lang 行只能有一条');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('P0-locale：默认 jvm 参数里有 -Duser.language=zh 与 -Duser.country=CN，且在 -cp 之前', async () => {
  const env = makeEnv('locale-default');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.21.4', instanceDir: env.instanceDir, account: OFFLINE });

  assert.ok(cmd.args.includes('-Duser.language=zh'), '应有 -Duser.language=zh');
  assert.ok(cmd.args.includes('-Duser.country=CN'), '应有 -Duser.country=CN');

  const cpAt = cmd.args.indexOf('-cp');
  assert.ok(cpAt >= 0, '应有 -cp');
  assert.ok(cmd.args.indexOf('-Duser.language=zh') < cpAt, 'locale 必须在 -cp 之前');
  assert.ok(cmd.args.indexOf('-Duser.country=CN') < cpAt, 'locale 必须在 -cp 之前');
  assert.equal(cmd.args[cpAt + 2], 'net.minecraft.client.main.Main', '-cp / value / mainClass 仍相邻');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('P0-locale：用户显式传 -Duser.language=ja → 不重复添加 zh', async () => {
  const env = makeEnv('locale-ja');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({
    versionId: '1.21.4',
    instanceDir: env.instanceDir,
    account: OFFLINE,
    extraJvmArgs: ['-Duser.language=ja'],
  });

  const langArgs = cmd.args.filter((a) => a.startsWith('-Duser.language'));
  assert.deepEqual(langArgs, ['-Duser.language=ja'], `用户设置必须被尊重，实际：${JSON.stringify(langArgs)}`);
  assert.ok(!cmd.args.includes('-Duser.language=zh'), '不能出现 zh');
  // country 仍可补（用户没指定）
  assert.ok(cmd.args.includes('-Duser.country=CN'), '未指定的 country 仍应补上');

  const cpAt = cmd.args.indexOf('-cp');
  assert.ok(cmd.args.indexOf('-Duser.country=CN') < cpAt);

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('P0-locale：用户同时传了 language 与 country → 一个都不补', async () => {
  const env = makeEnv('locale-both');
  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({
    versionId: '1.21.4',
    instanceDir: env.instanceDir,
    account: OFFLINE,
    extraJvmArgs: ['-Duser.language=en', '-Duser.country=US'],
  });

  assert.equal(cmd.args.filter((a) => a.startsWith('-Duser.language')).length, 1);
  assert.equal(cmd.args.filter((a) => a.startsWith('-Duser.country')).length, 1);
  assert.ok(cmd.args.includes('-Duser.language=en'));
  assert.ok(cmd.args.includes('-Duser.country=US'));
  assert.ok(!cmd.args.some((a) => a.includes('zh') && a.startsWith('-Duser')));

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('options.txt：老版本（无 arguments.jvm）也会生成，且 locale 参数同样在 -cp 前', async () => {
  const env = makeEnv('locale-legacy');
  const legacy = {
    id: '1.8.9',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '1.8',
    libraries: [lib('com.google.guava:guava:17.0', 'com/google/guava/guava/17.0/guava-17.0.jar')],
    minecraftArguments: '--username ${auth_player_name} --version ${version_name}',
    javaVersion: { component: 'jre-legacy', majorVersion: 8 },
  } as unknown as VersionJson;
  // 老版本用 java 8：塞一个 8 的 java home
  const javaHome8 = path.join(env.dataRoot, 'java', 'jre-legacy', '8');
  fs.mkdirSync(path.join(javaHome8, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(javaHome8, 'bin', 'javaw.exe'), 'fake');
  fs.writeFileSync(path.join(javaHome8, 'release'), 'JAVA_VERSION="1.8.0_202"\n');

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.8.9': legacy }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });
  const cmd = await launcher.buildCommand({ versionId: '1.8.9', instanceDir: env.instanceDir, account: OFFLINE });

  const optFile = path.join(env.instanceDir, 'options.txt');
  assert.ok(fs.existsSync(optFile), '老版本也要生成 options.txt');
  assert.match(fs.readFileSync(optFile, 'utf8'), /lang:zh_cn/);
  assert.ok(cmd.args.includes('-Duser.language=zh'));
  const cpAt = cmd.args.indexOf('-cp');
  assert.ok(cmd.args.indexOf('-Duser.language=zh') < cpAt, 'locale 必须在 -cp 之前（老版本路径也一样）');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('options-txt：hasSystemProperty / withDefaultLocale 纯函数的边界', async () => {
  const { hasSystemProperty, withDefaultLocale } = await import('../src/core/launch/command.js');

  assert.equal(hasSystemProperty(['-Duser.language=zh'], 'user.language'), true);
  assert.equal(hasSystemProperty(['-Duser.language', 'zh'], 'user.language'), true);
  assert.equal(hasSystemProperty(['-Duser.language'], 'user.language'), false, '没有值不算声明');
  assert.equal(hasSystemProperty(['-Duser.language=zh'], 'user.country'), false, '键名不能前缀误判');

  assert.deepEqual(withDefaultLocale([]), ['-Duser.language=zh', '-Duser.country=CN']);
  assert.deepEqual(withDefaultLocale(['-Duser.language=ja']), ['-Duser.language=ja', '-Duser.country=CN']);
  assert.deepEqual(
    withDefaultLocale(['-Duser.language=en', '-Duser.country=US']),
    ['-Duser.language=en', '-Duser.country=US'],
  );
  // 不修改入参
  const input = ['-Xmx1G'];
  withDefaultLocale(input);
  assert.deepEqual(input, ['-Xmx1G']);
});

test('options-txt：ensureChineseOptions 的三种 action 与原子写', async () => {
  const { ensureChineseOptions, DEFAULT_OPTIONS_LINES } = await import('../src/core/launch/options-txt.js');
  const dir = tmpDir('opt-unit');

  const created = await ensureChineseOptions(dir);
  assert.equal(created.action, 'created');
  assert.ok(created.content.includes('lang:zh_cn'));
  assert.deepEqual(created.content.split('\n'), [...DEFAULT_OPTIONS_LINES]);

  // 残留临时文件检查（原子写应清理干净）
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], '不应残留临时文件');

  const unchanged = await ensureChineseOptions(dir);
  assert.equal(unchanged.action, 'unchanged');

  // 删掉 lang 行后再跑 → appended-lang
  fs.writeFileSync(path.join(dir, 'options.txt'), 'version:1.0\nfov:0.5\n', 'utf8');
  const appended = await ensureChineseOptions(dir);
  assert.equal(appended.action, 'appended-lang');
  assert.ok(appended.content.endsWith('lang:zh_cn'), `实际：${appended.content}`);
  assert.ok(appended.content.startsWith('version:1.0\nfov:0.5\n'), '原有内容必须在前面');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ═══════════════ 测试：options.txt 备份保护（用户资产，写坏即灾难） ═══════════════

test('备份：需要追加 lang 时生成 .bak-* 且内容与原文件逐字节相同', async () => {
  const { ensureChineseOptions, BACKUP_PREFIX } = await import('../src/core/launch/options-txt.js');
  const dir = tmpDir('bak-create');
  const optFile = path.join(dir, 'options.txt');
  // 模拟用户的完整配置（真实规模，5356 字节那种）
  const userConfig = [
    'version:5023',
    'ao:true',
    'biomeBlendRadius:2',
    'renderDistance:16',
    'guiScale:2',
    'fov:0.5',
    'soundCategory_master:0.73',
    'key_key.forward:87',
    'key_key.jump:32',
  ].join('\n') + '\n';
  fs.writeFileSync(optFile, userConfig, 'utf8');
  const before = fs.readFileSync(optFile);

  const result = await ensureChineseOptions(dir);
  assert.equal(result.action, 'appended-lang');
  assert.ok(result.backup, '必须给出备份路径');
  assert.ok(fs.existsSync(result.backup), '备份文件必须真实存在');
  assert.ok(path.basename(result.backup).startsWith(BACKUP_PREFIX), `备份名应带前缀，实际 ${path.basename(result.backup)}`);

  // 备份内容与原文件**逐字节相同**
  const backupBytes = fs.readFileSync(result.backup);
  assert.deepEqual(backupBytes, before, '备份必须与原文件逐字节相同');

  // 主文件已被追加，但原有每一行都还在
  const after = fs.readFileSync(optFile, 'utf8');
  for (const line of userConfig.trimEnd().split('\n')) {
    assert.ok(after.split('\n').includes(line), `原有行 ${line} 必须保留`);
  }
  assert.match(after, /^lang:zh_cn$/m, '追加后应含 lang:zh_cn');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('备份：只保留最近 3 份，旧的自动清理', async () => {
  const { ensureChineseOptions, listBackups, MAX_BACKUPS } = await import('../src/core/launch/options-txt.js');
  const dir = tmpDir('bak-prune');
  const optFile = path.join(dir, 'options.txt');

  // 连续 5 次「删掉 lang 行 → 触发追加」，每次都会产生一份备份
  const seen: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(optFile, `version:1.0\nmarker:${String(i)}\n`, 'utf8');
    // 给不同的时间戳，保证文件名可区分（真实场景是不同启动时间）
    const result = await ensureChineseOptions(dir, Date.now() + i * 1000);
    assert.equal(result.action, 'appended-lang');
    if (result.backup) seen.push(result.backup);
  }

  const remaining = await listBackups(dir);
  assert.equal(remaining.length, MAX_BACKUPS, `应只剩 ${String(MAX_BACKUPS)} 份，实际 ${String(remaining.length)}`);

  // 留下的必须是最新的 3 份（文件名倒序前 3 个）
  const expected = seen.slice(-MAX_BACKUPS).map((p) => path.basename(p)).sort().reverse();
  assert.deepEqual(remaining.map((p) => path.basename(p)), expected, '应保留最新的 3 份，删掉更早的');

  // 被清掉的那份确实不在盘上了
  for (const old of seen.slice(0, 2)) {
    assert.ok(!fs.existsSync(old), `旧备份 ${path.basename(old)} 应已被清理`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('备份：已有 lang: 时不写也不产生备份', async () => {
  const { ensureChineseOptions, listBackups } = await import('../src/core/launch/options-txt.js');
  const dir = tmpDir('bak-none');
  const optFile = path.join(dir, 'options.txt');
  fs.writeFileSync(optFile, 'version:1.0\nlang:en_us\nfov:0.5\n', 'utf8');
  const before = fs.readFileSync(optFile);
  const beforeMtime = fs.statSync(optFile).mtimeMs;

  const result = await ensureChineseOptions(dir);
  assert.equal(result.action, 'unchanged');
  assert.equal(result.backup, undefined, '没写就不该有备份');
  assert.deepEqual(await listBackups(dir), [], '目录里不该出现任何 .bak-*');

  // 主文件一字未动
  assert.deepEqual(fs.readFileSync(optFile), before);
  assert.equal(fs.statSync(optFile).mtimeMs, beforeMtime);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('备份：文件不存在（首次创建）时不产生备份', async () => {
  const { ensureChineseOptions, listBackups } = await import('../src/core/launch/options-txt.js');
  const dir = tmpDir('bak-created');

  const result = await ensureChineseOptions(dir);
  assert.equal(result.action, 'created');
  assert.equal(result.backup, undefined, '新建文件没有「原文件」可备份');
  assert.deepEqual(await listBackups(dir), []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('备份失败 → 放弃写入，action 为 skipped-backup-failed，原文件内容不变', async () => {
  const { ensureChineseOptions } = await import('../src/core/launch/options-txt.js');
  const dir = tmpDir('bak-fail');
  const optFile = path.join(dir, 'options.txt');
  const original = 'version:1.0\nfov:0.5\n';
  fs.writeFileSync(optFile, original, 'utf8');
  const before = fs.readFileSync(optFile);

  // 造一个必然失败的备份：在目录里预先铺满 100 个同名候选备份（mkdtemp 产物），
  // 让 backupOptions 的 COPYFILE_EXCL 每次都命中 EEXIST，最终抛出「连续撞名」。
  // 这比 chmod 可靠（Windows 上只读目录不阻止新建文件）。
  const { BACKUP_PREFIX } = await import('../src/core/launch/options-txt.js');
  const now = 1_700_000_000_000;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  for (let seq = 0; seq < 100; seq += 1) {
    const name = seq === 0 ? `${BACKUP_PREFIX}${stamp}` : `${BACKUP_PREFIX}${stamp}-${String(seq)}`;
    fs.mkdirSync(path.join(dir, name), { recursive: true }); // 空目录占位 → copyFile 会 EEXIST/EPERM
  }

  const result = await ensureChineseOptions(dir, now);
  assert.equal(result.action, 'skipped-backup-failed', '备份失败必须放弃写入');
  assert.match(result.skippedReason ?? '', /备份失败/);
  assert.equal(result.backup, undefined, '失败时不该报告备份路径');

  // 核心不变量：**没备份就绝不写**——原文件必须逐字节不变
  assert.deepEqual(fs.readFileSync(optFile), before, '放弃写入时原文件必须完全没变');
  assert.ok(!fs.readFileSync(optFile, 'utf8').includes('lang:'), '不该出现任何 lang 行');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('备份：copyFile 在源文件不可读时抛错（backupOptions 直接失败）', async () => {
  const mod = await import('../src/core/launch/options-txt.js');
  const dir = tmpDir('bak-nosrc');
  // 源 options.txt 根本不存在 → copyFile 抛 ENOENT
  await assert.rejects(() => mod.backupOptions(dir), /ENOENT|no such file/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ═══════════════ 测试：多实例隔离（绝不串味） ═══════════════

test('多实例隔离：两个 instanceDir 的 options.txt 互不影响', async () => {
  const { ensureChineseOptions } = await import('../src/core/launch/options-txt.js');
  // 用 makeEnv 建一个带假 java 的数据目录（buildCommand 会走 pickJava）
  const env = makeEnv('iso-two');
  const dirA = path.join(env.dataRoot, 'instances', 'A');
  const dirB = path.join(env.dataRoot, 'instances', 'B');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  // 模拟真实情况：A 是用户真玩的完整配置，B 完全没有 options.txt
  const configA = 'version:5023\nrenderDistance:16\nguiScale:2\n';
  fs.writeFileSync(path.join(dirA, 'options.txt'), configA, 'utf8');

  const launcher = new GameLauncher({
    versionRepo: new FakeVersionRepo({ '1.21.4': version121() }),
    dataRoot: env.dataRoot,
    platform: WINDOWS,
  });

  const aBefore = fs.readFileSync(path.join(dirA, 'options.txt'));

  // 先跑 B（生成全新配置），再跑 A（追加 lang）
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: dirB, account: OFFLINE });
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: dirA, account: OFFLINE });

  // A：原配置保留 + 追加 lang
  const aAfter = fs.readFileSync(path.join(dirA, 'options.txt'), 'utf8');
  assert.ok(aAfter.startsWith(configA.trimEnd()), 'A 的原有配置必须完整保留');
  assert.match(aAfter, /^lang:zh_cn$/m);
  // B 的生成行为不能污染 A：A 的第一行仍是 version:5023，而不是 version:1.0
  assert.ok(aAfter.startsWith('version:5023'), 'A 的 version 不能被 B 的默认值覆盖');

  // B：独立的最小配置
  const bAfter = fs.readFileSync(path.join(dirB, 'options.txt'), 'utf8');
  assert.ok(bAfter.startsWith('version:1.0'), 'B 应是独立生成的最小配置');
  assert.ok(!bAfter.includes('renderDistance:16'), 'B 不能沾到 A 的配置');
  assert.ok(!bAfter.includes('version:5023'), 'B 不能沾到 A 的 version');

  // 备份只在 A 目录
  const aFiles = fs.readdirSync(dirA).filter((f) => f.startsWith('options.txt.bak-'));
  const bFiles = fs.readdirSync(dirB).filter((f) => f.startsWith('options.txt.bak-'));
  assert.equal(aFiles.length, 1, 'A 应有 1 份备份');
  assert.equal(bFiles.length, 0, 'B 是新建文件，不该有备份');
  // 备份内容等于 A 的原始内容
  assert.deepEqual(fs.readFileSync(path.join(dirA, aFiles[0] as string)), aBefore);

  // 再跑一次 B（已有 lang）→ 依然什么都不做
  await launcher.buildCommand({ versionId: '1.21.4', instanceDir: dirB, account: OFFLINE });
  assert.equal(fs.readFileSync(path.join(dirB, 'options.txt'), 'utf8'), bAfter, 'B 第二次启动不该变');

  fs.rmSync(env.dataRoot, { recursive: true, force: true });
});

test('多实例隔离：instanceDir 不同 → 所有产物都落在各自目录，无全局路径', async () => {
  const { ensureChineseOptions, listBackups } = await import('../src/core/launch/options-txt.js');
  const dirs = [tmpDir('iso-1'), tmpDir('iso-2'), tmpDir('iso-3')];
  for (const dir of dirs) {
    fs.writeFileSync(path.join(dir, 'options.txt'), `version:1.0\nid:${path.basename(dir)}\n`, 'utf8');
  }

  for (const dir of dirs) {
    const r = await ensureChineseOptions(dir);
    assert.equal(r.action, 'appended-lang');
    // 文件与备份都在自己的目录里
    assert.equal(path.dirname(r.file), dir);
    assert.equal(path.dirname(r.backup as string), dir);
  }

  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('options.txt.bak-'));
    assert.equal(files.length, 1, `${path.basename(dir)} 应恰有 1 份自己的备份`);
    // 内容里带着自己的 id，证明没有串到别的实例
    const content = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8');
    assert.ok(content.includes(`id:${path.basename(dir)}`), '内容必须是自己的');
    assert.equal((await listBackups(dir)).length, 1);
  }

  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
