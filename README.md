# codearts-im

> CodeArts IM Gateway · 维护者：ThinkTom

[简体中文](README.md) | [English](README.en.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Türkçe](README.tr.md) | [Español](README.es.md)

通过 QQ（后续扩展微信 / 企业微信）驱动本地 **码道 CodeArts Agent** 的 IM 网关。手机发一句话，本地 IDE 中的 Agent 执行任务并把结果回传。

## 功能特性

- **扫码绑定**：使用腾讯官方连接器扫码创建/绑定机器人，无需手动填写 AppID / AppSecret
- **双通道**：私聊与群聊（@ 机器人），群聊默认要求 @
- **会话治理**：每个对端独立会话，持久化映射，IDE 重启后自动恢复
- **可靠投递**：流式增量、多步合并、Markdown 感知切分、`msg_seq` 限流与超限降级
- **人机协作**：审批（回复 `1` / `2`）与提问（回复 `A/B/C`）
- **只推送结论**：过滤思维链与系统提示，QQ 只收到最终回答
- **媒体**：图片/文件入站下载与解密、文件回传（失败自动降级为路径文本）
- **访问控制**：open / allowlist / disabled 三模式、配对码、撤销名单、单实例锁
- **可验证**：`npm run compat` 内核兼容矩阵，内核升级后可一键回归

## 架构

    QQ 开放平台（WebSocket 长连接）
      ↕
    sidecar（Node SEA 单文件进程）
      ↕ 本机 IPC（命名管道 + 一次性 token）
    VS Code 扩展（VSIX）
      ↕ 本地回环 HTTP + SSE
    码道 Agent Kernel（Session / Tools / Permission / Skills）

- 内核与凭据只在本机；sidecar 不直连公网；
- `KernelPort` 是唯一内核耦合层，QQ 传输位于 `adapters/qq`；
- 扩展负责生命周期、扫码绑定、内核端口发现与口令解密。

## 兼容性

| 项 | 支持范围 | 备注 |
|---|---|---|
| 操作系统 | Windows 10 1809+ / Windows 11（x64） | 当前发布产物为 win32-x64；macOS/Linux 需在对应平台构建 |
| 码道 CodeArts Agent | ≥ 26.11.100 | 实测 26.11.x |
| Agent Kernel | 126.11.x | 实测 `126.11.2-20261117200150` |
| VS Code API | `^1.109.0` | 仅使用稳定 API |
| QQ 开放平台 | 机器人 WebSocket API v2 | 需沙箱或正式机器人 |
| Node.js（仅开发） | ≥ 20.3 | 终端用户无需安装，sidecar 内置运行时 |

兼容性验证：

    npm run compat                    # 只读 + 会话创建/删除
    npm run compat -- --with-prompt   # 追加一次真实推理（消耗少量额度）

## 版本

- 当前版本：**0.3.2**（语义化版本，0.x 阶段接口可能调整）
- 兼容基线：码道 26.11.100 / 内核 126.11.2
- 升级策略：码道或内核升级后先跑兼容矩阵，再升级插件
- 变更记录：见仓库提交历史与 `output/` 下的设计与评估文档

## 安装

要求：Windows x64、码道 26.11.x；无需安装 Node.js。

    & "<码道安装目录>\bin\codearts-agent.cmd" --install-extension "<路径>\codearts-qqbot-cn-0.3.2.vsix"

也可在码道扩展面板选择「从 VSIX 安装」。安装后执行「Developer: Reload Window」。

## 快速开始

1. 启动码道并完成一次对话，确保内核已运行；
2. 命令面板 →「QQ Bot: 扫码绑定机器人」；
3. 手机 QQ 扫描面板中的官方二维码，在腾讯页面完成创建/绑定；
4. 凭据自动写入系统凭据库，插件自动重启连接；
5. 私聊机器人发送消息即可。

无法扫码时，可使用「QQ Bot: 手动填写凭据」作为兜底。

## 常用配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `codeartsQqbot.provider` | `inferhub-provider` | 模型供应商 |
| `codeartsQqbot.model` | `deepseek-v4.1-flash-1017` | 模型 ID，请勿留空 |
| `codeartsQqbot.agent` | `build` | 使用的 Agent |
| `codeartsQqbot.access.c2cMode` | `open` | 私聊访问模式 |
| `codeartsQqbot.access.groupMode` | `allowlist` | 群聊访问模式（正式使用建议保持） |
| `codeartsQqbot.textChunkLimit` | `4500` | 单条消息最大字符数 |
| `codeartsQqbot.media.maxMB` | `200` | 入站媒体大小上限 |
| `codeartsQqbot.sendFile.restrict` | `true` | 限制可回传的文件路径 |

## 常用命令

| 命令 | 作用 |
|---|---|
| `/new` | 新建会话 |
| `/compact` | 压缩上下文 |
| `/model` | 查看 / 切换模型 |
| `/stop` | 中止当前生成 |
| `/allow`、`/deny` | 批准 / 拒绝审批 |
| `/bot-status`、`/bot-ping`、`/bot-help` | 状态、时延、帮助 |

## 安全与数据

- AppSecret 与内核口令仅存系统凭据库或内存，不写入配置、仓库与日志；
- 内核口令通过官方加密存储只读解密，失败时回退为手动录入；
- 文件回传使用 `realpath` 白名单（工作区 + 媒体目录），单文件上限 20MB；
- 日志与诊断包对密钥、token、openid 脱敏；
- 只输出最终回答，思维链与系统提示不会发送到 QQ。

## 构建

开发环境：Windows x64、Node.js ≥ 20.3、码道 26.11.x（用于联调）。

    npm install
    npm run check            # 分层依赖 / 类型 / 单元测试
    npm run build:sidecar    # Node SEA 单文件可执行
    npm run package:vsix     # 构建扩展并产出 VSIX

## 开源组件与致谢

| 组件 | 版本 | 用途 | 许可证 |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | QQ 扫码绑定、WebSocket 长连接 | **UNLICENSED**（腾讯专有，遵循其自身条款） |
| `qrcode` | 1.5.4 | 二维码渲染 | MIT |
| `esbuild` | 0.24.x | 打包 | MIT |
| `TypeScript` | 5.x | 类型系统与构建 | Apache-2.0 |
| `Vitest` | 2.1.x | 单元测试 | MIT |
| `tsx` | 4.23.x | 开发期运行 TypeScript | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | 微信/企业微信协议参考（未直接依赖） | MIT |
| 码道 CodeArts Agent / Agent Kernel | 26.11.x / 126.11.x | 宿主与内核 | 华为云产品条款 |

致谢：腾讯 QQ 开放平台、DeepSeek Harness 社区（`dsh-qqbot`、`dsh-im`）在协议与交互设计上的公开实践。

> **分发提示**：`@tencent-connect/qqbot-connector` 标记为 UNLICENSED。将本项目打包为 VSIX/sidecar 对外分发前，请确认腾讯相关许可条款。

## 已知限制

- 仅 Windows x64 产物；跨平台需在对应平台构建；
- 与码道/内核版本强相关，升级后需回归；
- QQ 被动回复窗口约 5 分钟、同一消息最多 5 条；
- 群聊默认 allowlist，联调可临时改为 open；
- 审批与提问为文本交互（数字/字母），按钮卡片尚未实现。

## 故障排查

打开输出面板「CodeArts QQ Bot」，按日志定位：

| 日志 | 含义 |
|---|---|
| `未找到 sidecar 可执行文件` | VSIX 缺少 `bin/`，请重装 |
| `ipc bridge connected` | 扩展与 sidecar 已连通 |
| `已从码道加密存储获取内核口令` | 口令自动获取成功 |
| `sidecar running` / `qq bot ready` | 服务与 QQ 连接就绪 |
| `qq message received` | 已收到 QQ 消息 |
| `inbound accepted` / `kernel prompt sending` | 已进入内核处理 |
| `reply sending` / `outbound send failed` | 发送结果与失败原因 |

## 贡献

欢迎提交 Issue 与 Pull Request。请确保：`npm run check` 通过、新增逻辑附带测试、提交信息说明“为什么”。

## 许可证

本项目代码采用 **MIT License**。第三方组件遵循各自许可证；`@tencent-connect/qqbot-connector` 为 UNLICENSED，分发前请自行确认授权。