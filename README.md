# PCL3

PCL2 的重置版。因为不可抗力，目前的 PCL2 已经无法正常下载 Minecraft，这个项目把「下载、安装、启动」这条链路重新做一遍：**直接对接 Mojang 官方元数据，镜像可切换，不依赖任何单一第三方渠道。**

> `PCL3` 是占位名，随时可改。对外展示名统一从 `package.json` 的 `productName` 读取。

![status](https://img.shields.io/badge/tests-146%20passing-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D22-blue)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 现在能做什么

```sh
# 列出可用版本（实时拉 Mojang 元数据）
pcl3 versions --limit 20

# 环境自检：逐项探测每个端点，告诉你到底哪一段网络不通
pcl3 doctor

# 安装一个版本（只算不下：先看计划）
pcl3 install 1.21 --dry-run
pcl3 install 1.21

# 微软账户登录（设备码，浏览器输码）
pcl3 account login
pcl3 account offline Steve

# 启动
pcl3 launch 1.21 --username Steve
```

## 实测链路（2026-10，中国网络）

| 端点 | 用途 | 结果 |
|---|---|---|
| `launchermeta.mojang.com` | 版本清单 | ✅ 200 / 919 个版本 / 最新 26.3 |
| `assets.piston-meta.mojang.com` | 版本 JSON、asset index | ✅ 200 |
| `libraries.minecraft.net` | 依赖库 | ✅ 200 |
| `resources.download.minecraft.net` | 游戏资源 | ✅ 200 |
| `bmclapi2.bangbang93.com` | 国内镜像 | ✅ 200（`/assets/` 走 302 重定向，已支持跟随） |
| `launcher.game.minecraft.net` | 官方启动器站 | ❌ DNS 无法解析 |
| `authserver.mojang.com` | 传统认证 | ❌ 已废弃，改用微软 OAuth |

**关键结论：Mojang 元数据与库文件在本机直连可用。**卡住 PCL2 的不是「连不上」，而是第三方渠道的单点依赖——PCL3 把这条依赖去掉，镜像降级为可选的加速层。

## 架构

```
src/
├─ core/
│  ├─ version/    版本清单、版本 JSON、缓存、继承链合并
│  ├─ download/   并发下载、SHA1 校验、断点续传、镜像回退、重定向跟随
│  ├─ install/    安装计划、libraries / assets / natives 落盘
│  ├─ launch/     rules 求值、17 个占位符、classpath、natives 解压、JVM 拉起
│  └─ auth/       微软 OAuth 设备码、XBL/XSTS/MC 三步换令牌、离线账户
├─ cli/           命令行（零第三方依赖，进度条与表格自己写的）
└─ web/           （规划中）
```

设计约束：

- **核心零第三方运行时依赖**，只用 Node 内置模块
- 每个模块可独立测试，依赖通过注入传入
- 数据目录只有一个真源 `getDataRoot()`，见 [docs/DATA-LAYOUT.md](docs/DATA-LAYOUT.md)

## 开发

```sh
pnpm install
pnpm typecheck                      # tsc --noEmit，必须零错误
pnpm test                           # 756 个测试
pnpm check:encoding                 # UTF-8 无 BOM / LF 校验
pnpm check:hygiene                  # 仓库卫生（调试残留 / 临时目录）
pnpm verify                         # 上面全部一起跑
pnpm build                          # 产出 dist/

pnpm test:real                      # 含真实下载的完整验证（慢，默认关）
pnpm clean:tmp                      # 清理 %TEMP% 里的测试残留
```

测试直接跑 `.ts` 源码（经 `test/ts-resolve.mjs` 解析钩子），不需要先构建。

**接手维护？** 先读 [docs/MAINTAINER-GUIDE.md](docs/MAINTAINER-GUIDE.md) ——
里面有架构决策的理由、踩过的坑、和修改后的验证清单。

## 文档

- [**维护手册（写给 AI 的）**](docs/MAINTAINER-GUIDE.md) —— 架构决策、已知的坑、修改后的验证清单
- [架构与接口契约](docs/ARCHITECTURE.md)
- [数据中心目录布局](docs/DATA-LAYOUT.md)
- [编码规约](docs/ENCODING.md)（Windows 上踩过坑，必读）
- [对标 PCL2 的差距清单](docs/PCL2-GAP-ANALYSIS.md)
- [AI 助手设计](docs/AI-ASSISTANT.md)（未实现）
- [需要真人验证的清单](docs/NEED-MANUAL-TEST.md)
- [一些想说的话](docs/LETTER.md) —— 不属于技术文档
- [贡献指南](CONTRIBUTING.md)

## 合规

- 只下载 Mojang 官方分发的资源，**不包含、不分发任何游戏本体文件**
- 不内置离线破解或盗版资源渠道
- 登录走微软官方 OAuth，不接触用户密码
- 遵循 [Minecraft EULA](https://www.minecraft.net/eula)

Minecraft 是 Mojang Studios 的商标，本项目与 Mojang Studios 及 Microsoft 无关联。

## 许可

MIT
