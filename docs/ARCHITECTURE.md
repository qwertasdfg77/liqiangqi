# 项目架构

浏览器界面通过本机 HTTP 请求获取棋局并提交行动。Node.js 服务保存一局状态，负责规则检查、任务取消和电脑自动应对；CPU 工作线程执行搜索。便携启动器释放已校验的相同运行文件，启动自带 Node.js，再打开浏览器。

## 文件职责

- `app/index.html`、`app/app.js`、`app/style.css`：中文界面、SVG 棋盘、合法目标、方位翻转和状态轮询。
- `game.cjs`：游戏状态、合法行动、终局、撤销及历史。
- `engine.cjs`：墙道图、最短路径、行动生成、评分、串行 Minimax / Alpha-Beta / PVS 和置换表。
- `strategy.cjs`：墙库存价值、道路风险与根局面墙组合规划。
- `ai.cjs` / `ai-worker.cjs`：迭代加深、根分支并行、缓存、排序、搜索检查点及取消。
- `ponder.cjs`：玩家回合的分批浅层覆盖与重点应对调度。
- `time-control.cjs` / `difficulty.cjs`：两档预算及提前停止条件。
- `fixed-wall-oracle.cjs` / `exact-worker.cjs`：双方无墙库存时的固定图残局求解。
- `winrate.cjs`：当前局面估算值，不另开一轮搜索。
- `server.cjs`：本地服务、接口、启动和单个源码目录对应服务的复用。
- `launcher/PortableLauncher.cs`：Windows EXE 的 SHA256 载荷校验、修复、互斥启动、环境清理、服务确认与浏览器打开。
- `scripts/`：独立质量检查、固定版本运行时验证和构建。
- `tests/`：功能回归、独立规则参考及固定输入输出样本。

## 本地接口

仅绑定 IPv4 回环地址 `127.0.0.1`。这是桌面本地接口，没有提供联网对战协议。

- `GET /api/info`：服务标识、版本及当前运行目录。
- `GET /api/state`：棋局、合法行动、历史、搜索进度、难度及估算胜率。
- `POST /api/move`：`{revision, action}`。
- `POST /api/undo`：`{revision}`。
- `POST /api/new`：`{human: 0或1, difficulty: "quick"或"highest"}`；难度可省略。
- `POST /api/difficulty`：`{revision, difficulty}`。
- `POST /api/retry`：重新尝试未完成的电脑行动。

接口按方法、合法行动、当前行动方和局面修订号处理；过时或不合法的操作返回冲突状态。请求体上限 4096 字节，拒绝带有其他 Origin 的请求，页面设置 CSP。它没有实现互联网部署所需的账号、TLS、远程授权或攻击隔离，不应改成公网监听后直接开放。

## 任务生命周期

新局或撤销首先取消当前计算。电脑结果仅在任务与棋局仍匹配时应用；换档也取消旧任务，避免同一步落两次。预推演保存的是假设行动后局面检查点，实际落子后核对完整局面及历史才复用。新局清空搜索缓存，服务关闭销毁线程。

便携 EXE 按用户缓存路径使用互斥锁。启动前校验全部载荷文件，校验通过后才复用对应应用目录的服务或启动新的 Node.js。启动时清除继承的 `NODE_OPTIONS` 与 `NODE_PATH`，不依赖系统 PATH 中的 Node.js。
