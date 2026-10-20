# PCL3 数据中心目录布局

本文只描述**数据放在哪**。各模块的实现细节见 `ARCHITECTURE.md`。

## 根目录

按优先级确定（`src/core/download/paths.ts` 的 `getDataRoot()` 是唯一实现）：

1. 环境变量 `PCL3_DATA_ROOT`（测试与便携模式都用它）
2. Windows：`%APPDATA%\PCL3`
3. 其他平台：`~/.pcl3`

首次调用会自动创建。**任何模块都不得自己拼这个路径**，一律 import `getDataRoot()`。

## 子目录

```
<PCL3_DATA_ROOT>/
├─ meta/                     版本元数据缓存（version 模块）
│  ├─ version_manifest_v2.json
│  ├─ version_manifest_v2.meta.json      ← 拉取时间等旁挂元信息
│  └─ <versionId>.json / .meta.json
├─ libraries/                依赖库，按 Maven 路径展开（download / install）
│  └─ com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar
├─ assets/                   游戏资源（install）
│  ├─ indexes/<assetIndexId>.json
│  ├─ objects/<hash前2位>/<hash>
│  └─ virtual/legacy/        ← 老版本（virtual / map_to_resources）的虚拟目录
├─ versions/<versionId>/     各版本本体（install）
│  ├─ <versionId>.json
│  └─ <versionId>.jar
├─ instances/<name>/         实例（launch）
│  ├─ natives/               ← natives 解压目标
│  └─ logs/
├─ java/                     自动下载的 JRE（launch 选择用）
└─ accounts.json             账户（auth，权限尽量收紧到 0600）
```

## 约定

- **一切缓存都可删除**：删掉 `<PCL3_DATA_ROOT>` 后应当能重新装出完整环境，不需要任何手工修复。
- **`.part` 文件**：下载中途的临时文件叫 `.<basename>.part`，与目标**同目录**（跨设备 `rename` 会失败）。校验通过才 `rename` 到正式路径，保证正式路径上永远不存在半截文件。
- **不写进仓库**：`.gitignore` 已排除 `data/`、`instances/`、`cache/`。切勿把任何下载产物提交进 Git。
- **不提交用户数据**：`accounts.json` 含令牌，`.gitignore` 已排除，任何时候都不要 `git add -f`。

## 版本元数据的缓存语义

`meta/` 下的每个正文文件旁边有一个 `*.meta.json`，记录 `fetchedAt`：

- TTL 内（默认 10 分钟）→ 直接用缓存，不联网
- 超过 TTL → 联网刷新；**网络失败时回退到过期缓存**并打 warning，而不是抛错
- 正文与 meta 都缺失 → 视为无缓存，必须联网
