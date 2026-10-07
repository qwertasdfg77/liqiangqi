# 力墙棋 · 本地人机对弈

[![Release](https://img.shields.io/github/v/release/qwertasdfg77/liqiangqi)](https://github.com/qwertasdfg77/liqiangqi/releases/latest)
[![CI](https://github.com/qwertasdfg77/liqiangqi/actions/workflows/verify.yml/badge.svg)](https://github.com/qwertasdfg77/liqiangqi/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**唯一正式稳定版：1.8.0。** 在九乘九棋盘上走棋、放墙，与本地电脑玩家对弈。界面中文，可选择先后手及电脑位于棋盘上方或下方。

**最推荐：** 从 [正式 Release](https://github.com/qwertasdfg77/liqiangqi/releases/tag/v1.8.0) 下载 `liqiangqi-v1.8.0-windows-x64.exe`，双击即可玩。游戏与运行环境均包含在一个文件中，运行时不需要联网或安装 Node.js、Python、模型及 GPU 工具。可以把 EXE 单独复制到其他位置使用。

这是一份参照 [HullQin 原网站“路墙棋”](https://game.hullqin.cn/lqq) 两人玩法制作的独立本地实现，沿用本地产品名“力墙棋”。本仓库由 `qwertasdfg77` 维护，不是原网站作者的官方发布；不包含原网站下载的 JavaScript 包、美术、账号系统或联机服务。来源和许可范围见 [来源说明](docs/PROVENANCE.md)。

## 下载和使用

1. 打开 [Releases](https://github.com/qwertasdfg77/liqiangqi/releases/latest)，下载 `liqiangqi-v1.8.0-windows-x64.exe`（中文标签“力墙棋.exe”）。
2. 双击 EXE，默认浏览器自动打开本地游戏页面。
3. 选择“走棋”“横墙”或“竖墙”，点击合法目标。你行动后电脑自动落子。
4. “新的一局”选择先后手；“棋盘方位”可在对局中切换电脑上方/下方。
5. 可切换 **快速档：20 秒上限** 和 **最高难度：30 秒上限**，默认最高难度。两档都允许在搜索结果稳定后提前落子。

还提供含 EXE、说明及许可文件的 `liqiangqi-v1.8.0-windows-x64.zip`。解压后双击 EXE；GitHub 自动生成的 `Source code` ZIP 是开发源码，需要 Node.js 才能运行。

便携包目标平台为 **Windows 10/11 x64**，使用系统浏览器和 Windows 自带的 .NET Framework。已在当前 Windows x64 环境完成独立位置、独立用户数据和无开发工具 PATH 的启动测试；尚未在另一台物理电脑、Windows 10、ARM 或非 Windows 系统上验证便携 EXE。源码和便携版的要求不同，见 [开发与构建](docs/DEVELOPMENT.md)。

## 玩法和电脑玩家

- 双方各有 10 面墙，每步走棋或放一面墙，不能堵死任何一方到终点的所有道路。
- 可以直跳过相邻对方；直跳受墙或边界阻挡时允许侧跳。
- **先手到达终点后，后手仍有最后一步；同一轮双方到达则共同获胜。** 重复局面不会自动判和。
- 电脑使用 **Minimax + Alpha-Beta + PVS**，迭代加深、置换表和跨回合缓存。最高搜索深度 32，最多共用 8 个 CPU 工作线程。
- 根据双方棋子、全部墙位、剩余墙量及道路结构进行评估与墙组合规划。布局规划用于排序，正式搜索保留全部合法行动。
- 玩家思考时进行动态预推演：先浅层覆盖候选，再集中约 6 个重点，深入 2～4 个，并继续分批扩大覆盖。落子后只复用真实局面和历史完全匹配的结果。
- 实时百分比是 **AI 分数转换的估算值，未经实战校准**；共同获胜时双方均可显示 100%。它不是承诺的实际胜率。

本版本没有 MCTS、GPU 推演或神经网络模型；“最高难度”是当前产品的最高用时档位，整个游戏尚未被求解，不能保证必胜或全局最优。

## 文档

- [操作说明、启动问题及缓存位置](docs/USAGE.md)
- [完整两人规则与行动编码](docs/RULES.md)
- [AI、全局布局、预推演及胜率含义](docs/AI.md)
- [模块架构与本地 HTTP 接口](docs/ARCHITECTURE.md)
- [开发环境、完整测试及便携构建](docs/DEVELOPMENT.md)
- [验证方法、正式对局结果与证据边界](docs/VALIDATION.md)
- [版本记录](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md)
- [来源](docs/PROVENANCE.md) · [项目许可](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)

## 从源码启动

准备 Node.js 24.x，在项目根目录运行：

```powershell
node app/server.cjs --open
```

没有 npm 运行依赖，无需 `npm install`。完整质量检查：

```powershell
node scripts/quality-gate.cjs
```

构建 Windows 便携包要求准确版本的官方 Node.js **24.18.1 x64**：

```powershell
node scripts/prepare-payload.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1
node tests/verify-portable.cjs
```

输出仅在忽略的 `build/`、`reports/` 下。构建流程验证官方运行时 SHA256、15 个稳定版运行文件和完整载荷；测试包含独立规则实现、原站输入输出观察样本、完整对局、撤销与取消、预推演、残局及复制启动。详见 [验证说明](docs/VALIDATION.md)。

## 校验下载

Release 提供 `SHA256SUMS.txt`。1.8.0 正式 EXE：

```text
487027f161d9f9725fe3ec91af8d44b6c1df453239294c19d7fff751259f2a22
```

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\liqiangqi-v1.8.0-windows-x64.exe
```

本项目自行编写的源码采用 MIT。随程序附带的 Node.js 及其组件适用各自许可，完整文本保存在 [Node-LICENSE.txt](third-party/Node-LICENSE.txt)，也嵌入 EXE 载荷。
