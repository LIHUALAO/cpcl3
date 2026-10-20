/**
 * 测试的模块解析钩子（仅测试用，`node --import ./test/ts-resolve.mjs --test test/*.test.ts`）。
 *
 * 背景：仓库是 ESM（package.json `"type": "module"`）+ `moduleResolution: NodeNext`，
 * 源码里按 TypeScript 规范写 `./foo.js` 来引用 `./foo.ts`。TypeScript 编译没问题，
 * 但 Node 的 type-stripping 不会把 `.js` 重映射到 `.ts`，于是直接 `node --test test/x.test.ts` 会
 * `ERR_MODULE_NOT_FOUND`。这个钩子把「`.js` 且在磁盘上只存在 `.ts`」的引用重写成 `.ts`，
 * 让测试无需构建即可运行，也保证测试断言的是源码而不是过期的编译产物。
 */

import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
