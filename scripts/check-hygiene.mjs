/**
 * 仓库卫生检查 —— 防止「临时文件混进仓库」和「测试留下临时目录」两类事故。
 *
 * 用法：
 *   node scripts/check-hygiene.mjs              只检查仓库
 *   node scripts/check-hygiene.mjs --tmp        额外检查 %TEMP% 里有没有 pcl3-* 残留
 *   node scripts/check-hygiene.mjs --clean      清理 %TEMP% 里的 pcl3-* 残留（危险：只在确认无测试在跑时用）
 *
 * 为什么需要（都是实际发生过的事故）：
 *   1. 子代理把 `_tmp_serve5.ts`、`_inst.mjs` 这类调试脚本留在 test/ 和仓库根，
 *      其中带 `.ts` 后缀 import 的会让全仓 `tsc` 直接失败。
 *   2. 测试建了临时目录却不清理，%TEMP% 里累积过 2581 个目录、706 MB。
 *   3. 上传的 .mrpack 落到临时目录后从不删除，装一次留几百 MB。
 *
 * 退出码：0 = 干净，1 = 有问题。
 */

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

// ───────────────────────────── 1. 仓库里的临时文件 ─────────────────────────────

/** 这些目录允许存在，不往里扫 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'docs']);

/** 会被判定为「调试残留」的命名模式 */
const TEMP_FILE_PATTERNS = [
  /^_/,                       // _tmp_cdp.ts / _inst.mjs / _weprobe.mjs
  /\.bak$/,                   // Downloader.ts.bak
  /\.orig$/,
  /\.rej$/,
  /~$/,                       // 编辑器备份
];

function isTempFileName(name) {
  return TEMP_FILE_PATTERNS.some((re) => re.test(name));
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs);
      continue;
    }
    // 允许 test/ 下的 zip 夹具之类，只按名字判定
    if (isTempFileName(name)) {
      problems.push({
        kind: 'TEMP_FILE',
        file: relative(ROOT, abs).replace(/\\/g, '/'),
        detail: '调试残留文件，不应进仓库（会让 tsc 失败或污染提交）',
      });
    }
  }
}

function checkRepo() {
  for (const dir of ['src', 'test', 'scripts']) {
    const abs = join(ROOT, dir);
    try {
      if (statSync(abs).isDirectory()) walk(abs);
    } catch {
      /* 目录不存在就跳过 */
    }
  }
  // 仓库根只查已知的临时文件，避免误报正常文件
  for (const name of readdirSync(ROOT)) {
    if (!isTempFileName(name)) continue;
    const abs = join(ROOT, name);
    if (statSync(abs).isFile()) {
      problems.push({ kind: 'TEMP_FILE', file: name, detail: '仓库根的调试残留' });
    }
  }
}

// ───────────────────────────── 2. TEMP 目录残留 ─────────────────────────────

function tmpEntries() {
  try {
    return readdirSync(tmpdir())
      .filter((n) => n.startsWith('pcl3-'))
      .map((n) => ({ name: n, path: join(tmpdir(), n) }))
      .filter((e) => {
        try {
          return statSync(e.path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function reportTmp(clean) {
  const entries = tmpEntries();
  if (entries.length === 0) {
    console.log('OK: %TEMP% 里没有 pcl3-* 残留目录。');
    return;
  }

  // 按前缀分组统计，方便定位是哪个测试文件漏了清理
  const groups = new Map();
  for (const e of entries) {
    const parts = e.name.split('-');
    const prefix = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : parts[0];
    groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
  }
  const summary = [...groups.entries()].sort((a, b) => b[1] - a[1]);

  if (clean) {
    let removed = 0;
    for (const e of entries) {
      try {
        rmSync(e.path, { recursive: true, force: true });
        removed++;
      } catch {
        /* 被占用的目录（正在跑的测试）跳过 */
      }
    }
    console.log(`已清理 ${String(removed)} / ${String(entries.length)} 个 pcl3-* 临时目录。`);
    const left = tmpEntries().length;
    if (left > 0) console.log(`仍有 ${String(left)} 个被占用，稍后再清。`);
    return;
  }

  problems.push({
    kind: 'TEMP_DIRS',
    file: '%TEMP%',
    detail:
      `${String(entries.length)} 个 pcl3-* 残留目录（${summary.map(([p, n]) => `${p}=${String(n)}`).join(', ')}）。` +
      ' 说明有测试没在 after()/finally 里清理；加速排查可用 --clean 直接清掉。',
  });
}

// ───────────────────────────── 主流程 ─────────────────────────────

const argv = process.argv.slice(2);
const withTmp = argv.includes('--tmp');
const clean = argv.includes('--clean');

checkRepo();
if (withTmp || clean) reportTmp(clean);

if (problems.length === 0) {
  console.log('OK: 仓库卫生检查通过（无调试残留文件）。');
  process.exit(0);
}

console.log(`发现 ${String(problems.length)} 个卫生问题：\n`);
for (const p of problems) {
  console.log(`  [${p.kind}] ${p.file}`);
  console.log(`      ${p.detail}`);
}
console.log('\n修复：删掉上述文件；测试残留请给对应测试加 after() 清理。');
process.exit(1);
