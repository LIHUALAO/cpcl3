/**
 * 构建后把 Web UI 的静态资源复制进 dist。
 *
 * 为什么需要：`tsc` 只编译 .ts，不会搬运 `src/web/public/` 里的
 * .html / .css / .js。缺了它，从 dist 起服务时 index.html 里引用的
 * /app.js 会 404 —— 页面能开但一片空白、永远停在「正在加载」。
 *
 * 用法：node scripts/copy-web-assets.mjs
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src', 'web', 'public');
// tsconfig.build.json 的 rootDir 是 `src`，所以 `src/web/static.ts` 编译为
// `dist/web/static.js`，它用 import.meta.url 找同级 `public/`，
// 因此静态资源必须放到 `dist/web/public/`，不是 `dist/src/web/public/`。
const DEST = join(ROOT, 'dist', 'web', 'public');

if (!existsSync(SRC)) {
  console.error(`找不到静态资源目录：${SRC}`);
  process.exit(1);
}

mkdirSync(dirname(DEST), { recursive: true });
cpSync(SRC, DEST, { recursive: true });

/** 列出目录下的所有文件（相对路径），用于打印清单。 */
function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, base));
    else out.push(abs.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

const files = listFiles(DEST);
console.log(`已复制 ${files.length} 个静态文件到 ${DEST.replace(ROOT, '').replace(/\\/g, '/')}`);
for (const f of files) console.log(`  ${f}`);

// 硬性自检：这几个文件缺任何一个，Web UI 都会变成空白页
const REQUIRED = ['index.html', 'app.js', 'style.css'];
const missing = REQUIRED.filter((f) => !files.includes(f));
if (missing.length > 0) {
  console.error(`\n缺少必需文件：${missing.join(', ')}`);
  process.exit(1);
}
console.log('必需文件齐全（index.html / app.js / style.css）');
