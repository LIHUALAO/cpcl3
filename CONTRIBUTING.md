# 贡献指南

## 分支

- `main` 受保护，只接受 PR
- 功能分支：`feat/<模块>-<简述>`，例如 `feat/download-retry`
- 修复分支：`fix/<简要描述>`

## 提交信息

用 Conventional Commits：

```
<type>(<scope>): <subject>

feat(download): 支持断点续传
fix(launch): 修正 rules 求值在 osx 上的误判
docs(readme): 补充镜像配置说明
test(auth): 增加离线 UUID 向量
refactor(version): 抽出缓存层
```

scope 取值：`version` / `download` / `install` / `launch` / `auth` / `cli` / `web` / `docs` / `ci`

## 代码规范

- TypeScript strict 模式，`tsc --noEmit` 必须零错误
- 不引入第三方运行时依赖。核心模块只用 Node 内置模块
- 每个模块自带测试，测试放在 `test/<模块>.test.ts`
- 提交前本地跑：`pnpm typecheck && pnpm test`

## 模块边界

修改 `src/core/types.ts` 前，先开 issue 讨论。它是跨模块契约，改动会波及所有人。

## 许可

贡献的代码默认以 MIT 许可发布。
