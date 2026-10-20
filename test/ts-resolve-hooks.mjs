/**
 * resolve 钩子实现：`.js` / `.mjs` 说明符在磁盘上不存在时，尝试同名 `.ts` / `.mts`。
 * 只在测试的 --import 场景下注册，不影响构建产物与生产运行。
 */

import { existsSync } from 'node:fs';
import { resolve as resolvePath, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SWAPS = [
  ['.js', '.ts'],
  ['.mjs', '.mts'],
  ['.js', '.tsx'],
];

function toFilePath(specifier, parentURL) {
  if (specifier.startsWith('file:')) return fileURLToPath(specifier);
  if (specifier.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(specifier)) return specifier;
  if (specifier.startsWith('.')) {
    const base = parentURL && parentURL.startsWith('file:') ? dirname(fileURLToPath(parentURL)) : process.cwd();
    return resolvePath(base, specifier);
  }
  return undefined;
}

export async function resolve(specifier, context, nextResolve) {
  const filePath = toFilePath(specifier, context.parentURL);
  if (filePath && !existsSync(filePath)) {
    for (const [from, to] of SWAPS) {
      if (filePath.endsWith(from)) {
        const swapped = filePath.slice(0, -from.length) + to;
        if (existsSync(swapped)) {
          return nextResolve(pathToFileURL(swapped).href, context);
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
