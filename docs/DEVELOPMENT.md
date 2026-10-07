# 开发、测试与构建

## 环境

源码使用 CommonJS JavaScript，浏览器端为 HTML/CSS/JavaScript；便携启动器使用 C#，构建入口使用 PowerShell。没有第三方 npm 运行依赖，`package.json` 主要用于脚本入口和项目元数据，不需要安装包。

日常源码运行准备 Node.js 24.x 和现代浏览器。正式便携包构建固定 **官方 Node.js v24.18.1 Windows x64**，使用 Windows 的 `.NET\Framework64\v4.0.30319\csc.exe`。构建脚本会拒绝其他 Node 版本、架构或被修改的运行时。官方 [Windows x64 ZIP](https://nodejs.org/dist/v24.18.1/node-v24.18.1-win-x64.zip) 可解压使用，不要求安装到固定机器路径。

正式 EXE 的目标为 Windows 10/11 x64；源码目前在 Windows x64 与 Windows GitHub Actions 上验证。Linux/macOS 的源码运行、ARM 仿真和其他物理电脑尚未验证。

## 启动与检查

在项目根目录：

```powershell
node app/server.cjs --open
node scripts/quality-gate.cjs
```

`npm start` 和 `npm test` 为相同入口，可选。源码启动优先端口 18741，遇到其他服务自动换端口，控制台输出 `GAME_URL=...`。`Ctrl+C` 关闭服务与工作线程。

质量检查扫描 `app/`、`scripts/` 和 `tests/` 中所有 JS/CJS 顶层脚本语法，串行运行 13 项回归：规则观察、规则/搜索、循环、胜率、预算、预推演、动态预推演、布局、HTTP 服务、完整对局、精确残局、档位及发布一致性。输出存入忽略的 `reports/`。部分深层搜索用时较长，单项超时 10 分钟；整个 CI 预留 30 分钟。

脚本无单独的 lint、格式或 TypeScript 工具链；不把不存在的检查当作已完成。`tests/reference-rules.cjs` 使用简单数组和 BFS 作为独立规则参考；生产代码使用不同的图与缓存实现。

## 构建单文件 EXE

用准确版本的 `node.exe` 执行第一步：

```powershell
node scripts/prepare-payload.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1
node tests/verify-portable.cjs
```

`prepare-payload.cjs` 验证运行时官方 SHA256，复制 15 个稳定运行文件、完整 Node 许可及使用说明，生成载荷清单和 C# 载荷 ID。`build-portable.ps1` 以标准 `/` 路径打 ZIP，生成自己的棋盘图标，再编译 Windows x64 启动器。最终为 `build/release/力墙棋.exe`。

便携测试使用独立目录、中文/空格/`&` 路径、独立 LOCALAPPDATA、只保留系统工具的 PATH，并注入无效的 NODE_OPTIONS。测试真实自动落子、两档切换、重复启动、缓存损坏修复、撤销与一次性迁移，并在收尾时只关闭该测试目录的 Node 进程。

默认测试刚构建的 EXE。也可指定另一份 EXE 与配套载荷清单：

```powershell
node tests/verify-portable.cjs <EXE路径> <载荷清单JSON路径>
```

## 发布一致性与后续版本

1.8.0 的稳定运行文件散列保存在 `release/v1.8.0.json`，载荷清单保存在 `release/v1.8.0-payload.json`。Git 属性对运行文件关闭换行转换，确保克隆后字节一致。**本次正式 Release 使用原已验证 EXE**，散列在 README 和 Release 中公布。

重编译 C# 和压缩 ZIP 会受到时间戳等影响，不保证 EXE 位级复现；载荷 ID 与运行内容必须一致。当前构建脚本为 1.8.0 固定版本构建，会阻止无声更改运行文件。后续版本需要同时更新版本字段、源码散列清单、载荷清单、运行时记录、启动器、文档和测试，再创建新的标签。

`build/`、`reports/`、`dist/`、二进制、模型和个人日志不提交。不要把原站下载脚本引入正式源码，也不要把本地用户名、绝对路径或凭据写入公开文件。
