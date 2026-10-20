/**
 * 扫一遍仓库文本文件，报告编码问题。
 *
 * 检查项：
 *   1. BOM（本项目要求无 BOM）
 *   2. 非法 UTF-8 字节序列
 *   3. 含 U+FFFD 替换字符的行（说明曾被错误解码过，几乎不可逆）
 *   4. CRLF 换行
 *
 * 用法：node scripts/check-encoding.mjs
 * 退出码：有问题返回 1，干净返回 0。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src', 'test', 'docs', 'scripts'];
const SCAN_ROOT_FILES = [
  '.gitattributes',
  '.editorconfig',
  '.gitignore',
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
];
const TEXT_EXT = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

const problems = [];
let scanned = 0;

function checkFile(abs) {
  const bytes = readFileSync(abs);
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  scanned++;

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push({ file: rel, kind: 'BOM', detail: '文件以 UTF-8 BOM 开头' });
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    problems.push({
      file: rel,
      kind: 'INVALID_UTF8',
      detail: '存在非法 UTF-8 字节序列（可能已被 ANSI 破坏）',
    });
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  if (text.includes('\uFFFD')) {
    const lines = text
      .split('\n')
      .map((line, i) => ({ i: i + 1, line }))
      .filter((x) => x.line.includes('\uFFFD'))
      .slice(0, 3);
    for (const { i, line } of lines) {
      problems.push({
        file: rel,
        kind: 'REPLACEMENT_CHAR',
        detail: `第 ${i} 行含 U+FFFD：${line.trim().slice(0, 60)}`,
      });
    }
  }

  if (text.includes('\r\n')) {
    problems.push({ file: rel, kind: 'CRLF', detail: '存在 CRLF 换行（本项目用 LF）' });
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs);
    else if (TEXT_EXT.has(extname(name))) checkFile(abs);
  }
}

for (const d of SCAN_DIRS) {
  const abs = join(ROOT, d);
  try {
    if (statSync(abs).isDirectory()) walk(abs);
  } catch {
    /* 目录不存在就跳过 */
  }
}

for (const f of SCAN_ROOT_FILES) {
  const abs = join(ROOT, f);
  try {
    if (statSync(abs).isFile()) checkFile(abs);
  } catch {
    /* 不存在就跳过 */
  }
}

if (problems.length === 0) {
  console.log(`OK: 扫描 ${scanned} 个文本文件，未发现编码问题。`);
  process.exit(0);
}

console.log(`发现 ${problems.length} 个问题（扫描 ${scanned} 个文件）：\n`);
const byFile = new Map();
for (const p of problems) {
  if (!byFile.has(p.file)) byFile.set(p.file, []);
  byFile.get(p.file).push(p);
}
for (const [file, list] of byFile) {
  console.log(`  ${file}`);
  for (const p of list) console.log(`    [${p.kind}] ${p.detail}`);
}
console.log('\n修复指引见 docs/ENCODING.md');
process.exit(1);
