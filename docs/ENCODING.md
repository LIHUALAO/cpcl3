# 编码规约

## 规定

**仓库内所有文本文件一律 UTF-8（无 BOM）、LF 换行。**

`.gitattributes` 与 `.editorconfig` 已强制这一点，编辑器会自动遵守。手写脚本时请自己保证。

## 为什么写这一条

本项目在 Windows 上用 PowerShell 开发时踩过一次坑：`Get-Content -Raw` 会用系统 ANSI 代码页（简体中文机器上是 GBK）解码文件，`Set-Content -Encoding UTF8` 再把已经解码错误的内容写回去，结果是**中文全变乱码且不可逆**（原始字节已被丢弃）。

正确做法：

```powershell
# 读：显式指定编码
$text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

# 写：显式指定无 BOM UTF-8
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

或者干脆不要用 PowerShell 改源码——用编辑工具，或 `node` 脚本（`node:fs` 默认就是 UTF-8）。

## 检查

```sh
node scripts/check-encoding.mjs
```

会扫 `src/`、`test/`、`docs/`、根目录的 `*.md`，报告 BOM、非法 UTF-8 字节序列、包含 `\uFFFD` 的行。
