/**
 * 崩溃日志分析（基础版）测试。
 *
 * 原则：**用真实崩溃文本**（真实 launcher 的 crash-report / latest.log 片段），
 * 不用自己编的"理想输入"。这样规则一旦写歪，测试会立刻露馅。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CrashAnalyzer,
  MAX_EVIDENCE,
  detectJavaMajor,
  extractMissingPath,
  javaVersionOfClassFile,
  parseXmxMb,
  summarizeFindings,
  type CrashFinding,
} from '../src/core/diagnostics/index.js';

const analyzer = new CrashAnalyzer({ dataRoot: os.tmpdir() });

function kinds(findings: readonly CrashFinding[]): string[] {
  return findings.map((f) => f.kind);
}

// ───────────────────────────── 真实崩溃文本 ─────────────────────────────

/** 真实的 NoSuchFileException 崩溃（assets 对象缺失，用户清理工具删掉后常见） */
const MISSING_ASSET_LOG = `[10:23:45] [main/INFO]: Loading Minecraft 1.20.6 with Fabric Loader 0.15.11
[10:23:46] [main/INFO]: Loading 62 mods:
\t- fabric-api 0.100.1+1.20.6
\t- sodium 0.5.11+mc1.20.6
[10:23:48] [main/INFO]: java version: 21.0.3, vendor: Microsoft
[10:23:52] [Render thread/ERROR]: Failed to load icon
java.nio.file.NoSuchFileException: C:\\Users\\Steve\\AppData\\Roaming\\PCL3\\assets\\objects\\3f\\3f8ea3c0d1e5c2e4a2d0f3d1a9d6b0b9c1e3f7a2
\tat java.base/sun.nio.fs.WindowsException.translateToIOException(WindowsException.java:85)
\tat java.base/sun.nio.fs.WindowsFileSystemProvider.newByteChannel(WindowsFileSystemProvider.java:268)
\tat net.minecraft.client.resources.AssetIndex.getAsset(AssetIndex.java:118)
#@!@# Game crashed! Crash report saved to: #@!@# C:\\Users\\Steve\\AppData\\Roaming\\PCL3\\instances\\1.20.6\\crash-reports\\crash-2026-10-20_10.23.55-client.txt
`;

/** 真实的 UnsupportedClassVersionError（用户拿 Java 8 启动 1.21 / 或拿 Java 17 启动 1.20.5+） */
const JAVA_VERSION_LOG = `[12:01:02] [main/ERROR]: Unable to launch
java.lang.UnsupportedClassVersionError: net/fabricmc/loader/impl/launch/knot/KnotClient has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 52.0
\tat java.base/java.lang.ClassLoader.defineClass1(Native Method)
\tat java.base/java.lang.ClassLoader.defineClass(ClassLoader.java:1022)
\tat cpw.mods.bootstraplauncher.BootstrapLauncher.main(BootstrapLauncher.java:141)
`;

/** 同样的错误，但换成「日志里带 java version 行」的形态（真实 latest.log 头部会有） */
const JAVA_VERSION_WITH_CURRENT = `[12:01:00] [main/INFO]: java version: 17.0.8, vendor: Eclipse Adoptium
[12:01:02] [main/ERROR]: java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0
`;

/** 真实的 OutOfMemoryError: Java heap space（整合包 -Xmx2G 崩） */
const OOM_LOG = `[09:15:00] [main/INFO]: JVM Flags: -Xmx2048M -Xmn512M -Dfile.encoding=UTF-8
[09:31:12] [Server thread/ERROR]: Encountered an unexpected exception
java.lang.OutOfMemoryError: Java heap space
\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537)
\tat net.minecraft.world.level.chunk.LevelChunk.<init>(LevelChunk.java:112)
\tat net.minecraft.server.level.ServerChunkCache.tick(ServerChunkCache.java:312)
[09:31:12] [Server thread/ERROR]: This crash report has been saved to: ./crash-reports/crash-2026-10-20_09.31.12-server.txt
`;

/** 真实的 GC overhead limit exceeded */
const GC_OOM_LOG = `[22:40:00] [Render thread/ERROR]: java.lang.OutOfMemoryError: GC overhead limit exceeded
\tat java.base/java.util.HashMap.resize(HashMap.java:705)
`;

/** 真实的 Duplicate mods（Forge 1.20.1，两个 JEI 版本同时在 mods/） */
const DUPLICATE_MODS_LOG = `[08:00:01] [main/ERROR]: Duplicate mods found
[08:00:01] [main/ERROR]: Found a duplicate mod jei at [C:\\PCL3\\instances\\1.20.1-forge\\mods\\jei-1.20.1-forge-15.2.0.27.jar, C:\\PCL3\\instances\\1.20.1-forge\\mods\\jei-1.20.1-forge-15.3.0.1.jar]
[08:00:01] [main/ERROR]: Mod loading has failed
`;

/** 真实的 Mixin apply failed（mod 与游戏版本不匹配） */
const MIXIN_LOG = `[07:12:31] [main/ERROR]: Mixin apply failed create.mixins.json:MixinPistonMovement -> net.minecraft.world.level.block.piston.PistonBaseBlock: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException
[07:12:31] [main/ERROR]: Critical injection failure: @Inject annotation on onMove could not find any targets
[07:12:31] [main/ERROR]: A potential solution has been determined:
[07:12:31] [main/ERROR]:   1. Install a newer version of create
`;

/** 真实的 NoSuchMethodError（Fabric API 版本比 mod 要求旧） */
const NOSUCHMETHOD_LOG = `[18:22:05] [main/ERROR]: java.lang.NoSuchMethodError: 'void net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.registerEndTick(Lnet/minecraft/class_1255;)'
\tat com.example.mymod.MyMod.onInitialize(MyMod.java:42)
`;

/** 真实的 Pixel format not accelerated（老显卡 / 远程桌面） */
const GL_LOG = `# A fatal error has been detected by the Java Runtime Environment:
#
#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb3d2a1a4e, pid=12044, tid=8812
#
# JRE version: OpenJDK Runtime Environment (17.0.8+7) (build 17.0.8+7)
# Problematic frame:
# C  [ig8icd64.dll+0x11a4e]
#
[10:02:11] [Render thread/ERROR]: Pixel format not accelerated
[10:02:11] [Render thread/ERROR]: 	at org.lwjgl.glfw.GLFW.glfwCreateWindow(GLFW.java:2013)
[10:02:11] [Render thread/ERROR]: 	at com.mojang.blaze3d.platform.Window.createGlfwWindow(Window.java:262)
[10:02:11] [Render thread/INFO]: OpenGL Vendor: Intel
[10:02:11] [Render thread/INFO]: OpenGL Version: 3.3.0 - Build 27.20.100.9316
`;

/**
 * 乱码 / 二进制垃圾：必须不抛错，返回 unknown。
 * 注意：这里只用**转义序列**表达不可打印字符（\u0000 / \uFFFD / \uDC00），
 * 绝不把原始替换字符写进源文件 —— 那会污染编码检查（scripts/check-encoding.mjs）。
 */
const GARBAGE = `\u0000\u0001\u0002 4e 6f 74 20 61 20 6c 6f 67 \uFFFD\uFFFD\uFFFD \uDBFF\uDFFF
%PDF-1.7
1 0 obj << /Type /Catalog >>
endobj
trailer << /Root 1 0 R >>
%%EOF`;

// ───────────────────────────── 每种类型至少一条 ─────────────────────────────

describe('CrashAnalyzer: 五类已知崩溃 + unknown 兜底', () => {
  it('missing-file：真实 NoSuchFileException 日志 → 识别为 missing-file 并摘出证据', () => {
    const findings = analyzer.analyze(MISSING_ASSET_LOG);
    assert.ok(findings.length >= 1);
    const f = findings.find((x) => x.kind === 'missing-file');
    assert.ok(f !== undefined, `应识别为 missing-file，实际：${kinds(findings).join(',')}`);
    assert.equal(f?.severity, 'error');
    assert.match(f?.title ?? '', /文件不完整/);
    assert.match(f?.detail ?? '', /修复|重装|校验/);
    // 证据必须是日志里的真实行
    assert.ok((f?.evidence.length ?? 0) > 0, '证据不能为空');
    assert.ok((f?.evidence.length ?? 0) <= MAX_EVIDENCE);
    assert.ok(
      f?.evidence.some((line) => line.includes('NoSuchFileException')),
      '证据里必须含真正的异常行',
    );
    assert.ok(
      f?.evidence.some((line) => /assets|objects/.test(line)),
      '证据里应能看到具体缺失的路径',
    );
  });

  it('java-version：class file version 65.0 + 当前 Java 8 → 说清「要 21 你是 8」', () => {
    const findings = analyzer.analyze(JAVA_VERSION_LOG);
    const f = findings.find((x) => x.kind === 'java-version');
    assert.ok(f !== undefined, `应识别为 java-version，实际：${kinds(findings).join(',')}`);
    assert.match(f?.title ?? '', /Java 21/, `标题应给出需要的大版本，实际：${f?.title ?? ''}`);
    assert.ok(f?.evidence.some((line) => line.includes('UnsupportedClassVersionError')));
    assert.ok(f?.evidence.some((line) => line.includes('class file version')));
  });

  it('java-version：日志带 java version 行时，同时报出「当前是什么版本」', () => {
    const findings = analyzer.analyze(JAVA_VERSION_WITH_CURRENT);
    const f = findings.find((x) => x.kind === 'java-version');
    assert.ok(f !== undefined);
    assert.match(f?.title ?? '', /Java 21/);
    assert.match(f?.title ?? '', /Java 17/, '应同时指出当前是 17');
  });

  it('out-of-memory：Java heap space + -Xmx2048M → 建议调大', () => {
    const findings = analyzer.analyze(OOM_LOG);
    const f = findings.find((x) => x.kind === 'out-of-memory');
    assert.ok(f !== undefined, `应识别为 out-of-memory，实际：${kinds(findings).join(',')}`);
    assert.match(f?.title ?? '', /内存不足/);
    assert.match(f?.detail ?? '', /2048 MB/, '应报出日志里的真实 -Xmx');
    assert.match(f?.detail ?? '', /4096 MB/, '应给出调大到 4096 的建议');
    assert.ok(f?.evidence.some((line) => line.includes('OutOfMemoryError')));
  });

  it('out-of-memory：GC overhead limit exceeded 也算', () => {
    const findings = analyzer.analyze(GC_OOM_LOG);
    assert.ok(findings.some((x) => x.kind === 'out-of-memory'));
  });

  it('mod-conflict：Duplicate mods → 点出重复的 mod 名', () => {
    const findings = analyzer.analyze(DUPLICATE_MODS_LOG);
    const f = findings.find((x) => x.kind === 'mod-conflict');
    assert.ok(f !== undefined, `应识别为 mod-conflict，实际：${kinds(findings).join(',')}`);
    assert.match(f?.detail ?? '', /jei/, '应从日志里认出重复的 mod 名');
    assert.ok(f?.evidence.some((line) => line.includes('Duplicate mods')));
  });

  it('mod-conflict：Mixin apply failed 也算，并给二分排查建议', () => {
    const findings = analyzer.analyze(MIXIN_LOG);
    const f = findings.find((x) => x.kind === 'mod-conflict');
    assert.ok(f !== undefined, `应识别为 mod-conflict，实际：${kinds(findings).join(',')}`);
    assert.match(f?.detail ?? '', /Mixin apply failed|改写/);
    assert.match(f?.detail ?? '', /二分/);
    assert.match(f?.detail ?? '', /create/, '应认出出问题的 mod 名');
  });

  it('mod-conflict：NoSuchMethodError 也算（mod 与 API 版本不匹配）', () => {
    const findings = analyzer.analyze(NOSUCHMETHOD_LOG);
    assert.ok(findings.some((x) => x.kind === 'mod-conflict'));
  });

  it('gl-driver：Pixel format not accelerated → 建议更新驱动', () => {
    const findings = analyzer.analyze(GL_LOG);
    const f = findings.find((x) => x.kind === 'gl-driver');
    assert.ok(f !== undefined, `应识别为 gl-driver，实际：${kinds(findings).join(',')}`);
    assert.match(f?.detail ?? '', /驱动/);
    assert.ok(f?.evidence.some((line) => line.includes('Pixel format not accelerated')));
    assert.match(f?.detail ?? '', /Intel|3\.3\.0/, '应带上日志里的显卡信息');
  });

  it('unknown：乱码 / 二进制文本 → 不抛错，返回 unknown 且带原文摘要', () => {
    const findings = analyzer.analyze(GARBAGE);
    assert.equal(findings.length, 1);
    const f = findings[0] as CrashFinding;
    assert.equal(f.kind, 'unknown');
    assert.equal(f.severity, 'warn');
    assert.match(f.title, /没看懂/);
    assert.ok(f.evidence.length > 0, 'unknown 也必须带原文摘要');
    // 不许编造结论
    assert.match(f.detail, /没匹配到|不认识/);
  });

  it('unknown：空文本 / 只有空白也不抛错', () => {
    for (const input of ['', '   ', '\n\n\n', 'ok\n']) {
      const findings = analyzer.analyze(input);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.kind, 'unknown');
    }
  });

  it('非字符串输入（防御性）不抛错', () => {
    assert.doesNotThrow(() => {
      analyzer.analyze(undefined as unknown as string);
      analyzer.analyze(null as unknown as string);
      analyzer.analyze(123 as unknown as string);
    });
  });

  it('一条日志里多个病灶 → 各自一条 finding，且都不带空证据', () => {
    const mixed = `${JAVA_VERSION_WITH_CURRENT}\n${OOM_LOG}`;
    const findings = analyzer.analyze(mixed);
    assert.ok(kinds(findings).includes('java-version'));
    assert.ok(kinds(findings).includes('out-of-memory'));
    for (const f of findings) {
      assert.ok(f.evidence.length > 0, `${f.kind} 的证据不能为空`);
      assert.ok(f.evidence.length <= MAX_EVIDENCE, `证据最多 ${String(MAX_EVIDENCE)} 条`);
    }
  });

  it('正常日志（没有崩溃特征）→ unknown，不会硬凑一个结论', () => {
    const normal = `[10:00:00] [main/INFO]: Setting user: Steve
[10:00:01] [main/INFO]: Backend library: LWJGL version 3.3.3
[10:00:05] [Render thread/INFO]: Sound engine started
`;
    const findings = analyzer.analyze(normal);
    assert.deepEqual(kinds(findings), ['unknown']);
  });
});

// ───────────────────────────── 辅助解析 ─────────────────────────────

describe('CrashAnalyzer: 辅助解析函数', () => {
  it('javaVersionOfClassFile：官方对应表', () => {
    assert.equal(javaVersionOfClassFile(52), 8);
    assert.equal(javaVersionOfClassFile(61), 17);
    assert.equal(javaVersionOfClassFile(65), 21);
    assert.equal(javaVersionOfClassFile(66), 22);
    assert.equal(javaVersionOfClassFile(Number.NaN), undefined);
  });

  it('parseXmxMb：M / G / K 三种写法', () => {
    assert.equal(parseXmxMb('-Xmx2048M'), 2048);
    assert.equal(parseXmxMb('-Xmx4G'), 4096);
    assert.equal(parseXmxMb('-Xmx524288K'), 512);
    assert.equal(parseXmxMb('-Xmx'), undefined);
    assert.equal(parseXmxMb('没有这个参数'), undefined);
  });

  it('extractMissingPath：从异常行里摘出路径并去掉系统提示尾巴', () => {
    assert.equal(
      extractMissingPath(
        'java.nio.file.NoSuchFileException: C:\\PCL3\\assets\\objects\\ab\\abcdef',
      ),
      'C:\\PCL3\\assets\\objects\\ab\\abcdef',
    );
    assert.equal(
      extractMissingPath(
        'java.io.FileNotFoundException: .\\libraries\\com\\mojang\\x.jar (系统找不到指定的路径。)',
      ),
      '.\\libraries\\com\\mojang\\x.jar',
    );
  });

  it('detectJavaMajor：识别 java version 行', () => {
    const ctx = { lines: ['java version "1.8.0_402"', ''], lower: '' };
    assert.equal(detectJavaMajor(ctx), 1);
    const ctx2 = { lines: ['[10:00] java version: 21.0.3, vendor: Microsoft'], lower: '' };
    assert.equal(detectJavaMajor(ctx2), 21);
  });

  it('summarizeFindings：空结果给诚实的提示，不假装分析成功', () => {
    const text = summarizeFindings([]);
    assert.match(text, /没有从日志里认出/);
  });

  it('summarizeFindings：有结论时逐条列出并带证据', () => {
    const text = summarizeFindings(analyzer.analyze(OOM_LOG));
    assert.match(text, /【1】/);
    assert.match(text, /内存不足/);
    assert.match(text, /证据/);
  });
});

// ───────────────────────────── 实例目录 ─────────────────────────────

describe('CrashAnalyzer.analyzeInstance', () => {
  function makeInstance(tag: string): { root: string; dir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pcl3-crash-${tag}-`));
    const dir = path.join(root, 'instances', '1.20.6');
    fs.mkdirSync(dir, { recursive: true });
    return { root, dir };
  }

  it('读 crash-reports 里最新的一份并分析出 missing-file', async () => {
    const { root, dir } = makeInstance('report');
    try {
      const crashDir = path.join(dir, 'crash-reports');
      fs.mkdirSync(crashDir, { recursive: true });
      const older = path.join(crashDir, 'crash-2026-01-01_00.00.00-client.txt');
      const newer = path.join(crashDir, 'crash-2026-10-20_10.23.55-client.txt');
      fs.writeFileSync(older, 'nothing here\n', 'utf8');
      fs.writeFileSync(newer, MISSING_ASSET_LOG, 'utf8');
      // 保证 mtime 顺序确定（文件系统精度可能只有 1ms）
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(older, past, past);

      const analyzerWithRoot = new CrashAnalyzer({ dataRoot: root });
      const result = await analyzerWithRoot.analyzeInstance('1.20.6');
      assert.equal(result.reportPath, newer, '必须取 mtime 最新的那份');
      assert.ok(result.findings.some((f) => f.kind === 'missing-file'));
      assert.ok((result.mtimeMs ?? 0) > 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('没有 crash-reports 时退回 logs/latest.log', async () => {
    const { root, dir } = makeInstance('latest-log');
    try {
      const logs = path.join(dir, 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, 'latest.log'), GL_LOG, 'utf8');

      const analyzerWithRoot = new CrashAnalyzer({ dataRoot: root });
      const result = await analyzerWithRoot.analyzeInstance('1.20.6');
      assert.match(result.reportPath ?? '', /latest\.log$/);
      assert.ok(result.findings.some((f) => f.kind === 'gl-driver'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('什么都没崩过 → findings 为空 + 人话 reason（不抛错、不伪造）', async () => {
    const { root, dir } = makeInstance('empty');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const analyzerWithRoot = new CrashAnalyzer({ dataRoot: root });
      const result = await analyzerWithRoot.analyzeInstance('1.20.6');
      assert.deepEqual(result.findings, []);
      assert.equal(result.reportPath, undefined);
      assert.match(result.reason ?? '', /还没有崩溃报告/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('实例 id 非法（含分隔符 / ..）直接拒绝，不拼路径', async () => {
    const analyzerWithRoot = new CrashAnalyzer({ dataRoot: os.tmpdir() });
    for (const id of ['', '..', '../etc', 'a/b', 'a\\b']) {
      const result = await analyzerWithRoot.analyzeInstance(id);
      assert.deepEqual(result.findings, []);
      assert.match(result.reason ?? '', /不合法/);
    }
  });

  it('通过 opts.dataRoot 覆盖数据根（不依赖构造参数）', async () => {
    const { root, dir } = makeInstance('opt-root');
    try {
      const crashDir = path.join(dir, 'crash-reports');
      fs.mkdirSync(crashDir, { recursive: true });
      fs.writeFileSync(path.join(crashDir, 'crash-x.txt'), DUPLICATE_MODS_LOG, 'utf8');

      const analyzerOther = new CrashAnalyzer({ dataRoot: os.tmpdir() });
      const result = await analyzerOther.analyzeInstance('1.20.6', { dataRoot: root });
      assert.ok(result.findings.some((f) => f.kind === 'mod-conflict'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
