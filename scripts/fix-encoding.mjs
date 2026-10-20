/**
 * 修复被 PowerShell ANSI 解码破坏的 UTF-8 文件。
 *
 * 背景：`Get-Content -Raw` 会用系统 ANSI 代码页（简体中文机器上是 GBK）解码，
 * 再 `Set-Content -Encoding UTF8` 写回，原始字节整段丢失，无法用同一路径还原。
 *
 * 本脚本尝试常见解法：把当前 UTF-8 字节按 latin1 取回"字节"，再用 GBK / GB18030 解码。
 * 无法自动还原时会**拒绝写入**，只报告，避免把文件改得更糟。
 *
 * 用法：node scripts/fix-encoding.mjs <file>...
 */

import { readFileSync, writeFileSync } from 'node:fs';

const REPAIRS = [
  { name: 'latin1+gbk', fn: (s) => Buffer.from(s, 'latin1'), dec: 'gbk' },
  { name: 'latin1+gb18030', fn: (s) => Buffer.from(s, 'latin1'), dec: 'gb18030' },
  {
    name: 'codepoint+gbk',
    fn: (s) => Buffer.from(s.split('').map((c) => c.charCodeAt(0) & 0xff)),
    dec: 'gbk',
  },
];

function score(text) {
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const control = (text.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length;
  const cjk = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
  return { replacement, control, cjk, bad: replacement * 10 + control * 5 };
}

function repair(file) {
  let s = readFileSync(file).toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const before = score(s);
  let best = null;

  for (const r of REPAIRS) {
    let raw;
    try {
      raw = r.fn(s);
    } catch {
      continue;
    }
    const decoded = new TextDecoder(r.dec, { fatal: false }).decode(raw);
    const sc = score(decoded);
    if (sc.bad < before.bad && (!best || sc.bad < best.score.bad)) {
      best = { name: r.name, text: decoded, score: sc };
    }
  }

  if (!best) {
    console.log(`UNRECOVERABLE ${file}`);
    console.log(
      `  当前状态：U+FFFD=${before.replacement} 控制字符=${before.control} CJK=${before.cjk}`,
    );
    console.log('  没有任何解码方式能把坏字节还原。原始字节已被丢弃，需要重新生成或从版本库恢复。');
    return false;
  }

  writeFileSync(file, best.text, 'utf8');
  console.log(`FIXED ${file} via ${best.name}`);
  console.log(`  U+FFFD ${before.replacement} -> ${best.score.replacement}`);
  return true;
}

let ok = 0;
const files = process.argv.slice(2);
for (const f of files) {
  try {
    if (repair(f)) ok++;
  } catch (e) {
    console.log(`ERROR ${f}: ${e.message}`);
  }
}
console.log(`\n可修复 ${ok} / ${files.length}`);
process.exit(ok === files.length ? 0 : 1);
