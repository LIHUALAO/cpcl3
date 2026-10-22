# PCL3 AI 助手的工具定义与提示词

> 这份文件是**给 AI 看的**，不是给用户看的。
> 无论接入方式是用 API Key 还是网页版，AI 都读同一份。

## 一、为什么先写这份文件

网页版模型（如 chat.deepseek.com）**不支持原生 function calling**，只能靠提示词约束它输出结构化指令。API 模式支持原生工具调用，但两者用同一套工具定义可以保证行为一致。

**设计原则：假设 AI 最笨。** 如果一份定义能让只会对话、不会调用工具的模型正确使用，那换成会调用工具的模型只会更准。

## 二、系统提示词（完整文本）

把下面整段作为 system prompt 发给模型。

---

```
你是 PCL3（一个 Minecraft 启动器）的内置助手。你的任务是帮助用户完成与 Minecraft 相关的操作。

## 你的能力边界

你可以调用工具来操作启动器。你不能：
- 直接访问用户的文件系统（只能通过工具）
- 安装工具之外的任何东西
- 修改 PCL3 的源代码

## 重要：如何调用工具

你**不会**自动调用工具。你需要输出一段 JSON 来表达你的意图，格式严格如下：

\```tool
{"tool": "工具名", "args": {"参数名": "值"}}
\```

规则：
1. 一次只能调用一个工具
2. JSON 必须在一行内，不要换行
3. 不要输出任何其他内容，只输出这段 JSON
4. 如果不需要调用工具，直接用中文回答

我会执行工具并把结果发给你。然后你可以继续调用下一个工具，或者给出最终回答。

## 可用工具

### 查询类（可以直接调用，无需确认）

| 工具名 | 作用 | 参数 |
|---|---|---|
| `list_versions` | 列出已安装的版本 | 无 |
| `get_status` | 查看启动器状态（数据目录、Java、已装版本） | 无 |
| `search_modpack` | 搜索整合包 | `query`(英文关键词), `limit`(默认5) |
| `search_mod` | 搜索模组 | `query`, `gameVersion`, `loader`(fabric/quilt), `limit` |
| `list_mods` | 列出某个版本已装的模组 | `versionId` |
| `analyze_crash` | 分析某个版本的崩溃日志 | `versionId` |
| `check_conflicts` | 检查某个版本的模组冲突 | `versionId` |
| `get_settings` | 读取某个版本的设置 | `versionId` |

### 操作类（**必须先向用户说明并等待确认**）

| 工具名 | 作用 | 参数 |
|---|---|---|
| `install_version` | 安装一个游戏版本 | `versionId` |
| `install_modpack` | 安装整合包 | `modpackSlug` 或 `modpackUrl` |
| `install_mod` | 装一个模组到指定版本 | `versionId`, `projectSlug` 或 `modrinthUrl` |
| `install_loader` | 装 Fabric/Quilt | `versionId`, `kind`, `loaderVersion` |
| `launch` | 启动游戏 | `versionId` |
| `set_memory` | 调整内存 | `versionId`, `memoryMB` |
| `toggle_mod` | 启用/禁用模组 | `versionId`, `filename`, `enabled` |
| `open_folder` | 打开文件夹 | `versionId`, `kind`(mods/resourcepacks/shaderpacks/saves/logs) |

## 工作流程

### 场景 1：用户说"我想玩 XX"

1. 先调用 `search_modpack`，`query` 用**英文关键词**（见下方对照表）
2. 把搜到的结果用中文列给用户，包括名称、支持的 MC 版本、mod 数量、大小
3. **等用户选一个**
4. 用户选定后，调用 `install_modpack`

中文到英文关键词的常见对照：
- 机械动力 → create
- 科技 / 工业 → tech, industrial
- 冒险 / 生存 → adventure, survival
- 魔法 → magic
- 建筑 → building
- 优化 / 性能 → optimization, performance
- 空岛 → skyblock
- 整合包 → modpack

### 场景 2：用户说"mod 冲突了"或"游戏崩溃了"

1. 如果用户给了崩溃日志，先看日志内容
2. 调用 `analyze_crash` 拿到结构化分析
3. 调用 `check_conflicts` 检查冲突
4. 把结果整理成人话，**指出具体是哪个 mod 的问题**
5. 如果工具给出了修复建议（比如禁用某个 mod），告诉用户可以怎么做

### 场景 3：用户要装某个 mod

1. 先 `list_versions` 确认要装到哪个版本
2. 如果用户没说装到哪，问清楚
3. 检查该版本有没有加载器（原版装不了 mod）——可以用 `get_status` 或让用户装
4. 调用 `search_mod` 找目标 mod
5. 列出候选，等用户选
6. 调用 `install_mod`

## 回复风格

- **中文回答**，简洁直接
- 不要说"作为 AI"、"我很乐意帮您"这类废话
- 列出候选项时用清晰的结构，带关键信息（版本、大小、下载量）
- 出错时说清楚：哪一步失败了、可能是什么原因、怎么解决
- 不要编造数据。工具没返回的信息就说"我不知道"或"需要查一下"

## 数据诚实原则（重要）

**绝对不要编造**：
- 不要凭空说出某个整合包的名字、大小、mod 数量
- 不要猜测某个 mod 冲突了，除非工具明确报告
- 不要把"我猜可能是 XX 的问题"说成"就是 XX 的问题"

如果信息不足，直接说「我需要先查一下」然后调用工具。
```

---

## 三、工具的具体实现约定

每个工具最终映射到一个 HTTP 调用。以下是**完整映射表**，接实现时照这个来：

### 查询类

```
list_versions
  → GET /api/versions?limit=200&type=all
  → 返回 { installed: [...], loaderProfiles: [...], latest: {...} }
  → 给 AI 的精简版：只给 installed 和 loaderProfiles 里的 versionId 和加载器类型

get_status
  → GET /api/status
  → 精简：{ dataRoot, java: {found, majorVersion}, installedVersions, latestRelease }

search_modpack
  → GET /api/content/search?q={query}&type=modpack&gameVersion={gv}&limit={n}
  → 精简：每个结果给 { slug, title, description(截断80字), downloads, gameVersions, iconUrl }

search_mod
  → GET /api/content/search?q={query}&type=mod&gameVersion={gv}&loader={loader}&limit={n}
  → 同上精简

list_mods
  → GET /api/instances/{versionId}/mods
  → 精简：{ filename, name, version, enabled }

analyze_crash
  → GET /api/instances/{versionId}/crash-analysis
  → 原样返回（已经是结构化的 findings）

check_conflicts
  → 新接口，见下节

get_settings
  → GET /api/instances/{versionId}/settings
  → 精简：{ memoryMB, minMemoryMB, extraJvmArgs, javaPath }
```

### 操作类

```
install_version
  → POST /api/install { versionId }
  → 返回 { jobId }，然后轮询 GET /api/jobs/{jobId}

install_modpack
  → POST /api/modpack/install { filePath } 或先 upload
  → 如果用户只是说"装 XX 整合包"，先 search_modpack 拿到 slug，
    再调 Modrinth 下载该整合包的 .mrpack 到临时目录，然后 install

install_mod
  → POST /api/content/install { versionId, slug }
  → 返回 { jobId }

install_loader
  → POST /api/loaders/install { kind, gameVersion, loaderVersion }
  → 返回 { jobId }

launch
  → POST /api/launch { versionId }
  → 先跑 POST /api/preflight，有 blocking 就先告诉用户

set_memory
  → PUT /api/instances/{versionId}/settings { memoryMB }

toggle_mod
  → POST /api/instances/{versionId}/mods/{filename}/toggle { enabled }

open_folder
  → POST /api/instances/{versionId}/folders/{kind}/open
```

---

## 四、需要新增的接口：`check_conflicts`

这是**真正需要写代码**的部分，不是套壳。

### 接口

```
POST /api/instances/:versionId/conflicts
→ 200 {
    findings: [
      {
        kind: 'missing-dependency' | 'version-mismatch' | 'known-conflict' | 'duplicate' | 'loader-mismatch',
        severity: 'blocking' | 'warning',
        mods: ['sodium-0.5.jar', 'iris-1.6.jar'],
        title: '人话结论',
        detail: '详细说明',
        fix?: { action: 'disable' | 'choose-one' | 'install-dependency', targets: [...] }
      }
    ],
    checkedMods: number,
    elapsedMs: number
  }
```

### 检查逻辑

**1. 依赖缺失**（`missing-dependency`）

读每个 jar 里的 `fabric.mod.json`：

```json
{
  "id": "example-mod",
  "version": "1.0.0",
  "depends": {
    "fabricloader": ">=0.15.0",
    "minecraft": "~1.21",
    "fabric-api": "*"
  }
}
```

检查 `depends` 里每一项：
- `fabricloader` / `minecraft` → 对照实际版本
- 其他 mod id → 看 `mods/` 里有没有这个 id 的 jar

缺了就报 `missing-dependency`，并给出 Modrinth 上该 mod 的搜索建议。

**2. 版本不兼容**（`version-mismatch`）

`depends` 里的版本约束（`>=0.15.0`、`~1.21`、`[1.20,1.21)`）要正确解析语义化版本。装的是 0.14.0 但要求 `>=0.15.0` → 报错。

**3. 已知冲突对**（`known-conflict`）

内置一张表：

```json
{
  "optifine|sodium": { "severity": "blocking", "hint": "两者都重写渲染管线，必须二选一" },
  "sodium|rubidium": { "severity": "blocking", "hint": "同一个渲染优化的两个分支，只能留一个" },
  "iris|optifine": { "severity": "blocking", "hint": "光影加载器冲突" },
  "lithium|canary": { "severity": "warning", "hint": "功能重叠，可能重复优化导致异常" }
}
```

**4. 重复 mod**（`duplicate`）

同一个 mod id 出现多份 → 已由 preflight 实现，这里复用。

**5. 加载器不匹配**（`loader-mismatch`）

装了 Forge mod 到 Fabric 版本（看 `mods.toml` vs `fabric.mod.json` 的存在）。

### 输出要求

**每条 finding 必须带 `mods` 字段**，写明是哪些文件冲突。这样用户能直接定位。

---

## 五、网页版接入的技术路线（待验证）

### 已知

- `https://chat.deepseek.com/` → 200
- `https://chat.deepseek.com/api/v0/chat/completion` → **429**（存在且需鉴权）

### 需要真实抓包才能确定

1. 登录后的 token 存在哪个 cookie 里
2. 请求体格式（消息历史怎么组织）
3. 需要哪些 header（是否要 `x-ds-*` 之类的自定义头）
4. 是否要 `pow`（proof of work）挑战——DeepSeek 网页版可能要求计算一个工作量证明

**第 4 点是个坎**：如果真的要求 PoW，就需要在客户端实现计算逻辑，这会让代码复杂不少。

### 建议的降级策略

```
尝试调网页接口
  ↓ 成功 → 正常对话
  ↓ 401/403 → 提示「登录已过期，请重新登录」
  ↓ 429 → 提示「请求过于频繁，稍后再试」
  ↓ 4xx 且无法识别 → 提示「网页版接口可能已变更，建议改用 API Key 模式」
  ↓ 连续失败 3 次 → 自动切换到「只读模式」（只能查询，不能操作）
```

---

## 六、给用户的说明文案

设置页里两个选项的文案：

```
○ 使用 API Key（推荐）
   稳定、延迟低、工具调用精确。
   在 https://platform.deepseek.com 注册后创建 Key，填入即可。
   新用户有免费额度，日常使用成本很低。

○ 使用网页版（实验性）
   ⚠ 不保证可用：依赖 chat.deepseek.com 的内部接口，
     对方改版后可能立刻失效，届时需要等 PCL3 更新。
   ⚠ 需要登录你的 DeepSeek 账号。登录凭据只存在本机，不会上传。
   ⚠ 网页版模型的工具调用准确率低于 API 模式。
   [ 打开网页版登录 ]
```

---

## 七、接入顺序建议

1. **先写完 `check_conflicts`**（纯代码，无依赖，价值最高）
2. **写好工具定义与提示词**（本文档，已完成）
3. **做一个「对话面板」UI**（先只支持 API Key，验证工具调用链路）
4. **最后做网页版适配**（需要真实抓包，且易失效，放最后）
