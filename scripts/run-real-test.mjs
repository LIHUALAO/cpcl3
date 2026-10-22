/**
 * 跑一次「带真实下载」的全量测试。
 *
 * `integrity.test.ts` 的 B 组默认关闭（它要真下整个 Minecraft 1.8.9，几分钟），
 * 只有在改过下载/安装/校验逻辑、或发版前才需要开。
 *
 * 为什么用脚本而不是 `cross-env`：本项目零第三方依赖，不想为了一个环境变量
 * 引一个包。Windows 与 POSIX 的写法还各不相同（`set X=1 &&` vs `X=1`），
 * 用 Node 来定环境变量最省事，也跨平台。
 *
 * 用法：
 *   npm run test:real
 *   npm run test:real -- test/integrity.test.ts    只跑指定文件
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const extra = process.argv.slice(2);
const targets = extra.length > 0 ? extra : ['test/**/*.test.ts'];

const result = spawnSync(
  process.execPath,
  ['--import', './test/ts-resolve.mjs', '--test', ...targets],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // 打开 B 组：真下载 + 逐文件核对落盘
      PCL3_REAL_INSTALL_TEST: '1',
      // 明确关掉「跳网」开关，否则两者冲突时 B 组仍然不跑
      PCL3_SKIP_NETWORK_TESTS: '0',
    },
  },
);

process.exit(result.status ?? 1);
