# codearts-im

> CodeArts IM Gateway · 维护者：ThinkTom · MIT

[简体中文](README.md) | [English](README.en.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Türkçe](README.tr.md) | [Español](README.es.md)

通过 IM 驱动本地 **码道 CodeArts Agent** 的网关：手机发一句话，桌面 IDE 里的 Agent 执行任务并把结果回传。当前支持 **QQ、微信（iLink）与企业微信智能机器人** 三个通道，可在凭据库中切换。

## 功能特性

- **三通道**：QQ（官方连接器）、微信 iLink、企业微信智能机器人（`@wecom/aibot-node-sdk`）
- **扫码绑定**：QQ / 微信 / 企微均支持扫码接入，无需手动填写密钥；手动录入仅作兜底
- **会话治理**：每个对端独立内核会话，持久化映射，IDE 重启后自动恢复
- **可靠投递**：多步合并、Markdown 感知切分、按通道限额切分、失败降级
- **流式回复**：企业微信支持 token 级增量（600ms 节流，ack 慢时自动跳过中间帧）
- **人机协作**：审批（`1` / `2`）与提问（`A/B/C`）文本交互，仅会话对端可决策
- **只推送结论**：过滤思维链、系统提示与工具噪声，IM 只收到最终回答
- **媒体**：入站图片/文件下载与解密落盘；出站文件按通道能力上传
- **访问控制**：open / allowlist / disabled、配对码、撤销名单、单实例锁
- **可观测**：sidecar 日志落盘、一键导出诊断包（含脱敏与兼容矩阵）

## 通道能力

能力表由 `packages/qqbot-runtime/src/transport/capabilities.json` 统一提供，适配器不得单独声明。

| 通道 | 单条上限 | 流式 | 输入状态 | 按钮 | 媒体方式 | 群聊 |
|---|---|---|---|---|---|---|
| QQ | 4500 | — | — | — | base64 上传 | 支持（默认需 @） |
| 微信 iLink | 1800 | — | 支持 | — | CDN 加密 | 仅单聊 |
| 企业微信 | 3500 | 支持 | — | 未实现 | SDK 素材上传 | 支持 |

### 文件发送的能力边界

三个通道的**主动推送文件**均可用（扫码直连 API 已验证）。但**码道随回复自动发文件**受平台与内核事件限制，当前不支持：

- 内核不推送交付物事件（`round.artifacts.updated` 定义存在但运行时不发）；
- 兜底路径已实现：识别 `browser` 预览的本地 `file://` 图片/PDF，以及正文中的 `![alt](path)`、`[[file:path]]`；
- 若通道或平台拒绝，会以"文件发送失败：原因"回到对话，绝不静默丢弃。

## 架构

    QQ 开放平台 / 微信 iLink / 企业微信智能机器人
      ↕  （WebSocket / HTTPS 长轮询）
    sidecar（Node SEA 单文件进程）
      ↕ 本机 IPC（命名管道 + 一次性 token）
    VS Code 扩展（VSIX）
      ↕ 本地回环 HTTP + SSE
    码道 Agent Kernel（Session / Tools / Permission / Skills）

- 内核与凭据只在本机；sidecar 不暴露公网监听；
- `KernelPort` 是唯一内核耦合层；通道实现在 `adapters/{qq,weixin,wecom}`；
- 扩展负责生命周期、扫码绑定、内核端口发现、口令解密与渠道切换。

## 兼容性

| 项 | 支持范围 | 备注 |
|---|---|---|
| 操作系统 | Windows 10 1809+ / Windows 11（x64） | 发布产物为 win32-x64；macOS/Linux 需在对应平台构建 |
| 码道 CodeArts Agent | ≥ 26.11.100 | 实测 26.11.x |
| Agent Kernel | 126.11.x | 实测 `126.11.2-20261117200150` |
| VS Code API | `^1.109.0` | 仅使用稳定 API |
| QQ 开放平台 | 机器人 WebSocket API v2 | 沙箱或正式机器人 |
| 微信 iLink | 协议 2.4.6（`bot_type=3`） | 需手机微信扫码确认 |
| 企业微信 | 智能机器人 WebSocket | 需企业管理员授权智能机器人 |
| Node.js（仅开发） | ≥ 20.3 | 终端用户无需安装 |

兼容性验证：

    npm run compat                      # 只读 + 会话创建/删除 + 三通道能力校验
    npm run compat -- --im wecom        # 仅校验指定通道
    npm run compat -- --with-prompt     # 追加一次真实推理（消耗少量额度）

产物为 `compat-matrix.json`，可随诊断包一并导出。

## 版本

- 当前版本：**0.3.2**（语义化版本，0.x 阶段接口可能调整）
- 兼容基线：码道 26.11.100 / 内核 126.11.2
- 升级策略：码道或内核升级后先跑兼容矩阵，再升级插件
- 变更记录：见仓库提交历史；本版新增三通道、企微流式与诊断增强

## 安装

要求：Windows x64、码道 26.11.x；无需安装 Node.js。

    & "<码道安装目录>\bin\codearts-agent.cmd" --install-extension "<路径>\codearts-qqbot-cn-0.3.2.vsix"

也可在码道扩展面板选择「从 VSIX 安装」。安装后执行「Developer: Reload Window」。

> 升级前建议先结束残留进程：`taskkill /IM qqbot-sidecar-win32-x64.exe /F`，避免旧 sidecar 占用 IPC 管道。

## 快速开始

1. 启动码道并完成一次对话，确保内核已运行；
2. 命令面板执行对应的扫码绑定：
   - 「QQ Bot: 扫码绑定机器人」
   - 「QQ Bot: 扫码绑定微信」
   - 「QQ Bot: 扫码绑定企业微信」
3. 手机扫码并在官方页面确认授权；
4. 凭据写入系统凭据库，`im/channel` 切换到对应通道，插件自动重启连接；
5. 在对应 IM 里给机器人发消息即可。

说明：

- 同一时间只启用一个通道；切换通道会暂停其他通道，旧凭据仍保留，重新扫码即可切回；
- 无法扫码时使用「QQ Bot: 手动填写凭据」；
- sidecar 首次启动约需 5~10 秒（SEA 解包），绑定面板会自动等待。

## 常用配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `codeartsQqbot.enabled` | `false` | 是否随 IDE 启动 sidecar |
| `codeartsQqbot.provider` | `inferhub-provider` | 模型供应商 |
| `codeartsQqbot.model` | `deepseek-v4.1-flash-1017` | 模型 ID，请勿留空（auto-router 可能命中不可用模型） |
| `codeartsQqbot.agent` | `build` | 使用的 Agent |
| `codeartsQqbot.access.c2cMode` | `open` | 私聊访问模式 |
| `codeartsQqbot.access.groupMode` | `allowlist` | 群聊访问模式（正式使用建议保持） |
| `codeartsQqbot.textChunkLimit` | `4500` | 单条消息最大字符数（实际上限取通道能力表） |
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

- AppSecret / 微信 token / 企微 secret 仅存系统凭据库或内存，不写入配置、仓库与日志；
- 内核口令通过官方加密存储只读解密，失败时回退为手动录入；
- 出站文件使用工作区白名单（`realpath`）校验，单文件上限 20MB；
- 日志与诊断包对密钥、token、openid 脱敏（导出前再次 `[REDACTED]`）；
- 只输出最终回答，思维链与系统提示不会发送到 IM；
- 详见 [PRIVACY.md](PRIVACY.md)。

## 诊断与故障排查

- 日志落盘：`<globalStorage>/codearts-community.codearts-qqbot-cn/qqbot/logs/sidecar.log`（4MB × 5 轮转）
- 一键导出：「QQ Bot: 导出诊断包」，内容包含扩展/侧车状态、管道、配置快照、最近 300 行日志与兼容矩阵
- 输出面板：`CodeArts QQ Bot`

| 日志 | 含义 |
|---|---|
| `sidecar binary not found` | VSIX 缺少 `bin/`，请重装 |
| `ipc bridge connected` | 扩展与 sidecar 已连通 |
| `已从码道加密存储获取内核口令` | 口令自动获取成功 |
| `sidecar running` / `channel online` | 服务与 IM 通道就绪 |
| `weixin` / `wecom` / `qq message received` | 已收到对应通道消息 |
| `inbound accepted` / `kernel prompt sending` | 已进入内核处理 |
| `reply sending (flush)` / `reply sending (stream finish)` | 整段 / 流式收尾发送 |
| `sendFile failed` | 文件发送失败，原因随回复返回 |
| `listen EADDRINUSE` | 存在残留 sidecar，先执行 `taskkill` |

## 构建

开发环境：Windows x64、Node.js ≥ 20.3、码道 26.11.x（用于联调）。

    npm install
    npm run check            # 分层依赖 / 类型 / 单元测试（212 项）
    npm run build:sidecar    # Node SEA 单文件可执行
    npm run package:vsix     # 构建扩展并产出 VSIX

## 开源组件与致谢

| 组件 | 版本 | 用途 | 许可证 |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | QQ 扫码绑定、WebSocket | **UNLICENSED**（腾讯专有，遵循其自身条款） |
| `@wecom/aibot-node-sdk` | 1.0.7 | 企业微信智能机器人 WebSocket / 流式 / 媒体 | 见其包内条款 |
| `qrcode` | 1.5.4 | 二维码渲染 | MIT |
| `esbuild` | 0.24.x | 打包 | MIT |
| `TypeScript` | 5.x | 类型系统与构建 | Apache-2.0 |
| `Vitest` | 2.1.x | 单元测试 | MIT |
| `tsx` | 4.23.x | 开发期运行 TypeScript | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | 微信/企业微信协议参考（未直接依赖） | MIT |
| 码道 CodeArts Agent / Agent Kernel | 26.11.x / 126.11.x | 宿主与内核 | 华为云产品条款 |

致谢：腾讯 QQ 开放平台、企业微信开放平台、DeepSeek Harness 社区（`dsh-qqbot`、`dsh-im`）在协议与交互设计上的公开实践。

> **分发提示**：`@tencent-connect/qqbot-connector` 标记为 UNLICENSED。打包为 VSIX/sidecar 对外分发前，请确认腾讯相关许可条款。第三方清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 已知限制

- 仅 Windows x64 产物；跨平台需在对应平台构建；
- 与码道/内核版本强相关，升级后需回归；
- QQ 被动回复窗口约 5 分钟、同一消息最多 5 条；
- 微信 iLink 仅单聊；`ret=-14` 需重新扫码；
- 企业微信模板卡片（按钮审批）尚未实现，当前为文本交互；
- 群聊默认 allowlist，联调可临时改为 open；
- 码道随回复自动发文件受平台限制，见上文「文件发送的能力边界」。

## 贡献

欢迎提交 Issue 与 Pull Request。请确保：`npm run check` 通过、新增逻辑附带测试、提交信息说明“为什么”。

## 文档索引

- [PRIVACY.md](PRIVACY.md)：数据与隐私说明
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：第三方组件与许可证
- [TODO.md](TODO.md)：路线图与待办
- [docs/](docs/)：内核契约、探测报告与方案设计

## 许可证

MIT License，`Copyright (c) 2026 ThinkTom`。完整文本见 [LICENSE](LICENSE)。