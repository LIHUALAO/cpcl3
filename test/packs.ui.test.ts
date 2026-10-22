/**
 * 前端三标签的「接线」回归测试（只读文件，不起浏览器）。
 *
 * 为什么需要：packs 面板的 DOM 在 index.html、逻辑在 packs.js、样式在 style.css，
 * 三处任何一处被别人的改动顺手覆盖掉（并行开发时真发生过），页面就会静默半残：
 * 面板在但按钮不响应，或者标签在但列表永远空着。这些断言把三处钉在一起。
 *
 * 真实渲染另有 Edge headless 截图验收（`_ui-packs-1/2/3.png`）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cleanupTempDirs } from './packs.temp.js';

after(() => {
  cleanupTempDirs();
});

const PUBLIC_DIR = path.resolve('src', 'web', 'public');

function read(name: string): string {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

test('index.html：内容面板有三个标签、导入按钮、存档下拉与列表容器', () => {
  const html = read('index.html');
  assert.match(html, /id="packs-panel"/, '必须有内容面板');
  assert.match(html, /id="packs-tabs"/, '必须有标签容器');
  assert.match(html, /data-pack-kind="resourcepack"/);
  assert.match(html, /data-pack-kind="datapack"/);
  assert.match(html, /data-pack-kind="shader"/);
  assert.match(html, /id="btn-packs-import"/, '必须有「导入本地文件」按钮');
  assert.match(html, /type="file"[^>]*id="packs-file"/, '必须有隐藏的 file input');
  assert.match(html, /id="packs-save"/, '数据包必须能选存档');
  assert.match(html, /id="packs-instance"/, '必须能选实例');
  assert.match(html, /id="pack-list"/, '必须有列表容器');
  assert.match(html, /<script src="\/packs\.js"><\/script>/, '必须加载 packs.js');

  // 三个标签的中文名必须就是这三个，别被改写成别的
  const tabs = html.slice(html.indexOf('id="packs-tabs"'), html.indexOf('id="packs-save-field"'));
  assert.match(tabs, />资源包</);
  assert.match(tabs, />数据包</);
  assert.match(tabs, />光影</);
});

test('packs.js：走对接口、用对方法，且不引任何 CDN', () => {
  const source = read('packs.js');
  assert.match(source, /\/api\/instances\//, '必须请求实例接口');
  assert.match(source, /\/packs['"] *\+|'\/packs'|\/packs'/, '必须请求 packs 路由');
  assert.match(source, /\/packs\/upload/, '导入必须走 upload 路由（FormData）');
  assert.match(source, /\/packs\/' *\+/);
  assert.match(source, /new FormData\(\)/, '上传必须用 FormData');
  assert.match(source, /\/toggle/, '启停必须走 toggle 路由');
  assert.match(source, /method: 'DELETE'/, '删除必须走 DELETE');
  assert.match(source, /data\.saves/, '必须读后端给的存档列表');
  assert.match(source, /packs-kind=/, '必须支持 URL hash 指定初始标签（截图与刷新依赖它）');
  assert.doesNotMatch(source, /https?:\/\/[a-z]/i, '不允许引用任何 CDN');
  assert.doesNotMatch(source, /<\/script>/i, '不允许把 HTML 拼进 DOM');
});

test('style.css：三标签与列表的样式都在', () => {
  const css = read('style.css');
  assert.match(css, /\.pack-list/, '列表样式');
  assert.match(css, /\.pack-item/, '列表项样式');
  assert.match(css, /\.pack-item\.is-disabled/, '禁用态必须有明显区分');
  assert.match(css, /\.btn-on/, '启用态按钮样式');
  assert.match(css, /\.tag-pack-format/, 'pack_format 标签样式');
  assert.match(css, /\.packs-tabs/, '标签容器样式');
});

test('packs.js 语法可解析（交给浏览器前先排除低级错误）', () => {
  const source = read('packs.js');
  // 整套 IIFE 直接交给引擎解析：new Function 只编译不执行，语法错会立刻抛。
  // （不要剥掉首尾的 IIFE 外壳 —— 剥错会出现「Unexpected end of input」的假失败。）
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(source);
  }, 'packs.js 必须能被 JS 引擎解析');
});
