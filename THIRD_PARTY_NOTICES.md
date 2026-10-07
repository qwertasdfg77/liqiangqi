# 第三方来源与许可

本项目 [MIT 许可](LICENSE) 覆盖自行编写的游戏、AI、界面、启动器、测试与项目文档，不替代第三方许可。

## Node.js

便携版内置官方 Node.js **v24.18.1，Windows x64**，原始文件不作修改。没有额外 npm 运行依赖。

- 官方二进制：[win-x64/node.exe](https://nodejs.org/dist/v24.18.1/win-x64/node.exe)
- 官方校验：[SHASUMS256.txt](https://nodejs.org/dist/v24.18.1/SHASUMS256.txt)
- 官方许可源：[Node.js v24.18.1 LICENSE](https://github.com/nodejs/node/blob/v24.18.1/LICENSE)
- 本仓库完整副本：[Node-LICENSE.txt](third-party/Node-LICENSE.txt)
- 记录的官方校验清单：[node-v24.18.1-SHASUMS256.txt](third-party/node-v24.18.1-SHASUMS256.txt)
- `node.exe` SHA256：`ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582`

Node.js 本体及其附带组件包含不同许可声明。完整 LICENSE 中列明 V8、OpenSSL、libuv 等组件，分发时应保留完整文本。正式 EXE 解包到当前用户缓存后，其中的 `runtime/LICENSE.txt` 与仓库副本完全一致。

## 游戏玩法参考

参考站点为 [HullQin 的“路墙棋”](https://game.hullqin.cn/lqq)，本地产品沿用“力墙棋”名称。仅作为玩法来源说明；本项目不授予原站代码、素材、商标或服务的权利。

原站下载代码曾用于本地比对规则，其代码包没有纳入此仓库或正式运行包。仓库测试包含我们生成的功能性棋盘输入输出观察数据，以及另行编写的规则参考实现，详见 [来源说明](docs/PROVENANCE.md)。

## 系统组件及 CI

Windows 系统浏览器、.NET Framework 与系统 DLL 不随包另行分发。CI 使用 GitHub 官方 `actions/checkout` 和 `actions/setup-node`，固定到提交 SHA；这些 Actions 不嵌入游戏运行包。
