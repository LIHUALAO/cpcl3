# PCL3 维护手册（写给 AI 看的）

> **这份文件是给接手这个项目的 AI 助手看的。**
> 如果你是一个新的 AI 会话，被要求「修改 PCL3」「修复某个 bug」「加一个功能」——
> 先读完这份文件再动手。它能让你少走我走过的所有弯路。

---

## 一、这个项目是什么

PCL3 是一个 **Minecraft 启动器**，对标 PCL2。重写的原因：PCL2 因不可抗力无法再正常下载 Minecraft。

**技术栈**：
- TypeScript（严格模式），Node.js ≥ 22
- **零第三方运行时依赖** —— 核心只用 `node:fs` / `node:https` / `node:crypto` / `node:child_process` 等内置模块
- Web UI：纯原生 HTML/CSS/JS，**零框架、零 CDN、零构建步骤**
- 测试：`node --test`（内置 runner，不用 vitest/jest）

**规模**（截至当前）：
```
源码   28,875 行（14 个 core 模块 + cli + web）
测试   18,699 行（23 个测试文件，756 个用例）
前端   14 个文件，458 KB
```

## 二、快速上手

本机 Node **不在 PATH**，所有命令用绝对路径：

```powershell
$n = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd C:\Users\Administrator\Desktop\DSW\PCL3

# 类型检查（必须 0 错误）
& $n node_modules\typescript\bin\tsc -p tsconfig.json --noEmit

# 跑全部测试（必须 fail = 0）
& $n --import ./test/ts-resolve.mjs --test "test/**/*.test.ts"

# 编码检查（必须 OK）
& $n scripts\check-encoding.mjs

# 仓库卫生检查（必须干净）
& $n scripts\check-hygiene.mjs
& $n scripts\check-hygiene.mjs --tmp    # 额外检查 %TEMP% 残留
& $n scripts\check-hygiene.mjs --clean  # 清理临时目录

# 构建
& $n node_modules\typescript\bin\tsc -p tsconfig.build.json
& $n scripts\copy-web-assets.mjs

# 起服务
& $n dist\cli\index.js web --no-open --port 37421
```

或直接用 npm scripts（需要 npm 在 PATH）：`npm run verify`

---

## 三、目录结构

```
src/
├─ core/
│  ├─ version/       版本清单、版本 JSON、缓存、inheritsFrom 合并
│  ├─ download/      并发下载、SHA1、断点续传、镜像回退、重定向、代理
│  ├─ install/       安装计划、libraries / assets / natives
│  ├─ launch/        rules 求值、占位符、classpath、natives、JVM 拉起、options.txt
│  ├─ java/          Java 运行时自动下载（按 component 精确匹配）
│  ├─ auth/          微软 OAuth 设备码、XBL/XSTS/MC 换令牌、离线账户
│  ├─ loader/        Fabric / Quilt 安装
│  ├─ content/       Modrinth 客户端、mod 管理、资源包/数据包/光影、整合包
│  ├─ settings/      版本级设置（内存、JVM 参数、displayName）
│  ├─ preflight/     启动前体检（11 种检查项）
│  ├─ diagnostics/   崩溃日志分析（6 类识别）
│  ├─ net/           源测速、代理探测、网络引导
│  ├─ config/        全局配置（数据目录、下载源、代理）
│  └─ shell/         打开文件夹、磁盘占用、启动参数导出
├─ cli/              命令行入口
└─ web/
   ├─ api.ts         REST 路由 + 业务 handler（5700 行，最大的文件）
   ├─ server.ts      HTTP 服务、静态资源、Origin 校验
   ├─ jobs.ts        内存任务表
   ├─ static.ts      静态文件 + 路径穿越防护
   └─ public/        前端（app.js / nav.js / versions.js / mods.js / packs.js / modpack.js / infra.js / folders.js / preflight.js / proxy.js / theme.js / themes.css / style.css / index.html）
```

**关键文档**（也在 `docs/` 下）：
- `ARCHITECTURE.md` —— 模块接口契约
- `DATA-LAYOUT.md` —— 数据目录布局
- `ENCODING.md` —— 编码规约（**必读，见第六节**）
- `PCL2-GAP-ANALYSIS.md` —— 对标 PCL2 的差距清单
- `AI-ASSISTANT.md` —— AI 助手的工具定义与提示词（未来功能）
- `NEED-MANUAL-TEST.md` —— 需要真人验证的清单

---

## 四、架构决策（为什么这么设计）

理解这些「为什么」，能避免你在修复时把设计改坏。

### 1. 为什么核心零依赖

用户机器上不需要装任何 npm 包。这意味着：
- 体积小（打包后 30~50 MB，对标 PCL2 的 30 MB）
- 没有供应链风险
- 装完就能用，不需要 `npm install`

**代价**：HTTP 客户端、zip 解析、并发池、SOCKS5 握手、SHA3 都得自己写。已经写好了，在 `download/`、`launch/zip.ts`、`pool.ts`、`proxy.ts` 里。

### 2. 为什么 `core/config` 不能 import `core/download`

`download/paths.ts` 需要读配置文件来定位数据目录，而 `config` 又需要知道数据目录在哪 —— **循环依赖**，ESM 下会炸成 TDZ 错误。

**解法**：两边各留一个 `globalThis` 钩子。
- `config/store.ts` 通过 `globalThis.__pcl3ConfigStore` 可选地拿存储
- `config/store.ts` 暴露 `setProxyApplier` / `setProxyDetector` 让上层注入
- `net/bootstrap.ts` 是唯一同时 import 两边的地方，负责把它们拼起来

**如果你要往 config 里加「读取某模块」的能力，请用同样的注入模式，不要直接 import。**

### 3. 为什么 `instanceId` 实际是 `versionId`

历史上曾有「实例」概念（同一版本多套配置），后来因为「版本选择」已经满足需求而被**移除**。

现在：**一个版本 = 一份配置**。`<dataRoot>/instances/<versionId>/`。

但很多老路由仍叫 `:instanceId`（`/api/instances/:instanceId/mods` 之类）。**这些路由里的 `instanceId` 传的就是 `versionId`**。改名会破坏所有前端脚本，所以保持原样。

### 4. 为什么 `launch` 有 `clientJarVersion` 和 `realVersionId` 两个字段

Fabric / Quilt 的版本 JSON 有 `inheritsFrom: "26.3"`，但**它自己没有 jar** —— jar 属于原版。所以：
- `realVersionId` = `fabric-loader-0.19.5-26.3`（用于 `${version_name}`、natives 目录名）
- `clientJarVersion` = `26.3`（用于拼 classpath 最后一项）

**这是 P0 级 bug 的修复结果**，别合并回一个字段。

### 5. 为什么 `mergeVersionJson` 在两个模块里参数顺序相反

- `core/version/merge.ts` → `(child, parent)`
- `core/launch/version-merge.ts` → `(parent, child)`

**这是历史遗留，不是 bug**（各自调用处都匹配）。但极易误用，改动时要看清是哪个文件。

### 6. 为什么下载失败要三层检查

曾经有过「假成功」事故：5147 个资产只落了 87 个，却报告安装成功。根因是 `runPool` 把 worker 异常吞进 `errors[]`，而 `Downloader` 丢弃了 `runPool` 的返回值 —— 任务凭空蒸发。

**现在的三层防线**（改动时不要削弱）：
1. `Downloader.downloadAll` 接住 `runPool` 的 `errors`，异常任务补进 `failed`
2. 契约级不变量：`skipped + downloaded + failed.length === tasks.length`，不等就抛错
3. `install()` 收尾逐个 `stat` 磁盘文件（`verifyOnDisk` 默认开）

### 7. 为什么内容页的版本选择要「追赶」

`mods.js` / `packs.js` 的版本下拉是异步加载的，加载完会自己设默认值（第一个），把当前版本覆盖掉。典型症状：「刷新后内容页显示装到 1.20.1」。

修法是 `versions.js` 的 `catchUpLegacySelects()` 盯 4 秒，并加「人点的才算」窗口。

---

## 五、已知的坑（都是真实踩过的）

### 编码：**最容易翻车的地方**

这台机器是简体中文 Windows。**PowerShell 的 `Get-Content -Raw` 会用 GBK 解码 UTF-8 文件**，`Set-Content -Encoding UTF8` 写回后中文永久损坏、**不可逆**。仓库里已经报废过两个文件。

**规矩**：
- 改文件一律用 `write` / `edit` 工具
- 必须用脚本时用 `node` + `fs.writeFileSync(path, text, 'utf8')`
- 提交前跑 `scripts/check-encoding.mjs`

### 测试污染真实环境

发生过三次事故：
1. 测试真实调用 `spawn('explorer.exe')`，在用户桌面弹了 7 个文件夹窗口
2. 测试创建临时目录不清理，`%TEMP%` 累积 2581 个目录、706 MB
3. 调试脚本 `_tmp_cdp.ts` 留在 `test/` 里，带 `.ts` 后缀 import 让全仓 `tsc` 失败

**规矩**：
- 临时目录必须 `after()` 统一 `rmSync`
- 调试脚本放 `os.tmpdir()`，截图放 `docs/shots/`
- 起服务测试完必须 `close()`
- 涉及外部进程的测试必须注入 fake，或设 `PCL3_NO_SHELL=1`

仓库有 `scripts/check-hygiene.mjs` 自动检查这些。

### 网络：国内环境的特殊性

**实测结论（会变，但能说明问题）**：
- `launchermeta.mojang.com` 直连可用
- `resources.download.minecraft.net` 可用
- **`cdn.modrinth.com`（Fastly）经常连不上** —— 表现为「能搜到 mod 但下载失败」
- `bmclapi2.bangbang93.com` 波动极大，有时 45 秒才回、有时直接超时
- **不要假设国内镜像一定更快**，有测速功能就是因为它会倒挂

### BMCLAPI 的特殊行为

- `/mc/game/version_manifest_v2.json` 返回 **302**（不是 200）
- `/assets/` 也返回 302，重定向到轮换的第三方节点

所以「按 200 判断成功」的抓取逻辑在它是会炸的。`transport.ts` 已支持跟随重定向。

### Fabric / Quilt 的 profile 陷阱

它们的 `libraries[]` **没有 `downloads.artifact`**，只有 `name` + `url` + 可选平铺的 `sha1`/`size`。

照原版安装器的 `lib.downloads?.artifact` 写法直接套，会得到**空下载列表** —— 表面装成功、依赖全缺、启动必崩。

`core/loader/libraries.ts` 里有三级回退链处理这个，别改坏。

### 库合并必须区分 classifier

`com.mojang:jtracy:1.14.38` 和 `com.mojang:jtracy:1.14.38:natives-windows` 是**两个不同的库**。

只用 `group:artifact` 做去重键会导致后者覆盖前者，实测丢掉一半库，启动时 `NoClassDefFoundError`。

`libraryKey()` 里必须包含 classifier。

### POJ 的启动参数顺序

`-Duser.language=zh` 必须在 `-cp` **之前**。JVM 读到 `-cp` 就认为选项区结束，之后的 `-D` 会被当成主类名。

---

## 六、修改代码的检查清单

每次改完，按顺序跑：

```powershell
& $n node_modules\typescript\bin\tsc -p tsconfig.json --noEmit   # 必须 0 错误
& $n --import ./test/ts-resolve.mjs --test "test/**/*.test.ts"   # 必须 fail 0
& $n scripts\check-encoding.mjs                                  # 必须 OK
& $n scripts\check-hygiene.mjs --tmp                             # 必须干净
```

**如果是 UI 改动**，还要：

```powershell
# 构建 + 起服务 + 截图，亲眼看
& $n node_modules\typescript\bin\tsc -p tsconfig.build.json
& $n scripts\copy-web-assets.mjs
& $n dist\cli\index.js web --no-open --port 37421

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
& $edge --headless=new --disable-gpu --screenshot="docs/shots/xxx.png" --window-size=1440,900 --virtual-time-budget=12000 "http://127.0.0.1:37421/"
```

**如果是启动相关改动**，还要真实启动一次（见下一节）。

---

## 七、如何真实验证「能启动」

无头环境下 SDL 创建不了窗口，游戏会在渲染线程后退出。**这不是失败**。

判据是日志里出现 `[Render thread/INFO]` 或 `Backend library: LWJGL`，且**没有** `couldn't locate the game`。

```powershell
$env:PCL3_DATA_ROOT = "$env:APPDATA\PCL3"
# 用 GameLauncher.buildCommand 拿到命令，spawn 并捕获 stdout/stderr
# 看前 50 行里有没有 Render thread
```

**用户真人测试**才是最终判据。需要真人测的清单在 `docs/NEED-MANUAL-TEST.md`。

---

## 八、当前状态与待办

### 已完成

| 能力 | 状态 |
|---|---|
| 版本清单 / 下载 / 安装 | ✅ 实测 5147 个资产齐全 |
| Java 自动下载（按版本精确匹配） | ✅ 实测下到 Java 25 并启动 |
| 启动 Minecraft | ✅ 进渲染线程（LWJGL/SDL 全通过） |
| Fabric / Quilt | ✅ 实测进渲染线程 |
| Modrinth 搜索 / 装 mod / 前置依赖 | ✅ 依赖预检 + 一键装前置 |
| 资源包 / 数据包 / 光影 | ✅ 三类目录隔离 |
| 整合包 `.mrpack` 导入 | ✅ 解析 → 确认 → 装 |
| 启动前体检 | ✅ 11 种检查，2ms 判定 |
| 崩溃分析 | ✅ 6 类识别 + 证据行 |
| 源测速 / 自动换源 | ✅ 实测延迟 |
| 代理（HTTP/SOCKS5/自动探测） | ✅ 24 个测试 |
| 主题（6 套 + 强调色 + 字号/紧凑/动效） | ✅ WCAG AA |
| 数据目录自定义 | ✅ 校验 + 迁移提示 |
| 打开文件夹 / 复制路径 | ✅ 环回地址限制 |

### 待办（按优先级）

1. **微软账户登录界面** —— 后端 OAuth 已完成，但缺 Azure `client_id`（用户需自己注册）。缺 client_id 时应显示配置指引而不是报错。
2. **AI 助手** —— 工具定义与提示词已写好（`docs/AI-ASSISTANT.md`），未实现。计划：先做纯规则意图路由 + 分析引擎，再接 LLM。
3. **打包分发** —— 目前只能命令行跑。选项：Node 便携版（30~50 MB）或 Tauri（5~10 MB，需 Rust）。
4. **模组冲突检测引擎** —— `check_conflicts` 接口设计好了但未实现，是 AI 助手最有价值的工具。
5. 下载速度显示（实时 MB/s / 剩余时间）
6. 键盘快捷键

### 明确的非目标

- 多人服务器列表（用户明确去掉）
- 皮肤系统（未讨论）

---

## 九、给你的忠告

1. **先读代码，再改代码。** 每个模块的文件头都有详细的「为什么这么设计」注释，那是花时间写的，能省你很多试错。

2. **不要为了「让它通过」而削弱防线。** 那个假成功 bug 的修复代价很高，收尾复核、计数不变量这些看起来啰嗦，但它们是防止用户装完一半崩溃的唯一屏障。

3. **测试不是走过场。** 这个项目有过「756 个测试全绿但真实启动崩溃」的记录。写测试时要问自己：这个断言在真实环境下会不会失效？

4. **数字要实测。** 不要说「应该能跑」，要给出 `tsc exit=0`、`756 pass 0 fail`、`assets 5147/5147`。用户看得懂数字。

5. **诚实报告失败。** 如果某个修复没做好，直接说「改了 A 但 B 还有问题」，比粉饰成「已完成」有价值一百倍。
