/**
 * 包元信息：${launcher_name} / ${launcher_version}。
 *
 * 契约要求产品名从根 package.json 的 productName 读取，代码里不硬编码。
 * tsconfig 的 rootDir 是仓库根，编译后可执行文件位于 dist/src/core/launch/，
 * 因此 `../../../package.json` 仍然指向仓库根的 package.json。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LauncherMeta {
  name: string;
  version: string;
}

const PACKAGE_FALLBACK: LauncherMeta = { name: 'PCL3', version: '0.0.0' };

export function readLauncherMeta(): LauncherMeta {
  const candidates: string[] = [];
  for (const rel of ['../../../package.json', '../../package.json', '../package.json']) {
    try {
      candidates.push(fileURLToPath(new URL(rel, import.meta.url)));
    } catch {
      /* import.meta.url 不可用时忽略 */
    }
  }
  candidates.push(path.join(process.cwd(), 'package.json'));

  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        productName?: string;
        name?: string;
        version?: string;
      };
      const name = pkg.productName ?? pkg.name;
      if (name) return { name, version: pkg.version ?? PACKAGE_FALLBACK.version };
    } catch {
      /* 试下一个 */
    }
  }
  return PACKAGE_FALLBACK;
}
