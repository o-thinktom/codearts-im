# CodeArts QQ Bot

通过 QQ 私聊或群聊驱动本机码道（CodeArts Agent）的 VS Code 扩展。手机 QQ 发一句话，本地 IDE 里的 Agent 执行并把结果回传。

## 架构

    QQ 开放平台（WebSocket）
      ↕
    sidecar（独立进程，内置 Node 运行时）
      ↕ 本机 IPC（命名管道，token 鉴权）
    VS Code 扩展（发现内核端口、解密口令、下发连接）
      ↕ 本地回环 HTTP + SSE
    码道内核 agentkernelServer（会话 / 工具 / 模型）

- sidecar 负责 QQ 长连接、会话映射、消息合并与发送；
- 扩展负责生命周期、配置、内核连接信息下发；
- 内核只监听 `127.0.0.1`，sidecar 不直连公网。

## 安装

要求：Windows 10/11 x64；码道 v26.11.x；无需安装 Node。

方式一（命令行，推荐）：

```powershell
& "<码道安装目录>\bin\codearts-agent.cmd" --install-extension "<路径>\codearts-qqbot-cn-0.3.2.vsix"
```

方式二（图形界面）：扩展视图 → `...` → 从 VSIX 安装 → 选择 `.vsix` → 重新加载窗口。

## 首次使用

1. 启动码道并完成一次对话，确保内核已运行；
2. 命令面板 →「QQ Bot: 扫码绑定机器人」→ 用手机 QQ 扫描面板中的官方二维码，在腾讯页面完成创建/绑定；
3. 扫码成功后凭据自动写入系统凭据库，插件会自动启动连接；
4. 私聊机器人发送消息。

无法扫码时，可用「QQ Bot: 手动填写凭据」输入 AppID / AppSecret 作为兜底。

内核连接信息（端口与口令）由扩展自动获取：端口读自 `server_config.properties`，口令通过官方加密存储只读解密。若解密失败，可执行「QQ Bot: 设置内核连接」手动录入。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `codeartsQqbot.enabled` | `false` | 随窗口启动时自动拉起 |
| `codeartsQqbot.workspace` | 当前工作区 | Agent 工作目录 |
| `codeartsQqbot.provider` | `inferhub-provider` | 模型供应商 |
| `codeartsQqbot.model` | `deepseek-v4.1-flash-1017` | 模型 ID；**不要留空**，否则可能被路由到空模型 |
| `codeartsQqbot.agent` | `build` | 使用的 Agent |
| `codeartsQqbot.requireMention` | `true` | 群聊必须 @ |
| `codeartsQqbot.textChunkLimit` | `4500` | 单条消息最大字符数 |
| `codeartsQqbot.access.c2cMode` | `open` | 私聊访问：open / allowlist / disabled |
| `codeartsQqbot.access.groupMode` | `allowlist` | 群聊访问：正式使用请保持 allowlist |
| `codeartsQqbot.access.commandMode` | `allowlist` | 命令权限 |
| `codeartsQqbot.media.*` | 见设置 | 图片/文件开关、大小与保留时长 |
| `codeartsQqbot.sendFile.restrict` | `true` | 限制可发送的文件路径 |
| `codeartsQqbot.debug` | `false` | 打开输出面板详细日志 |

## 命令

| 命令 | 作用 |
|---|---|
| `/new`（`/reset` `/clear`） | 新建会话 |
| `/compact` | 压缩上下文 |
| `/model` | 查看 / 切换模型 |
| `/stop` | 中止当前生成 |
| `/allow` / `/deny` | 批准 / 拒绝审批请求 |
| `/bot-status` | 会话与内核状态 |
| `/bot-ping` | 时延与队列 |
| `/bot-help` | 命令清单 |

## 行为说明

- **一轮合并一条**：Agent 多步生成的文本在 `session.idle` 时合并发送，避免漏段；
- **长回复切分**：超过 `textChunkLimit` 自动切分；同一 `msg_id` 的被动回复会自动递增 `msg_seq`（QQ v2 限制最多 5 条）；
- **会话隔离**：每个 QQ 对端一个内核会话，重启后自动恢复；
- **模型显式指定**：避免内核 auto-router 选到不可用的 `speed` 模型导致"无回复"。

## 已知限制

| 项 | 说明 |
|---|---|
| 平台 | 仅 Windows x64 产物；macOS/Linux 需在对应平台构建 |
| 码道版本 | 契约按 126.11.x 实测校准，升级后需回归验证 |
| 口令 | 来自官方加密存储；若格式变化会回退为手动录入 |
| 可执行文件 | 未做代码签名，可能触发 SmartScreen / 杀软提示 |
| 群聊默认 | 联调阶段可临时设 `groupMode=open`，正式使用请改回 `allowlist` |
| 计费 | 每条对话会消耗码道 Credits |
| 被动回复窗口 | QQ 侧限制约 5 分钟 / 5 条，超长回复可能降级为主动消息 |

## 故障排查

打开输出面板「CodeArts QQ Bot」，按日志定位：

| 日志 | 含义 |
|---|---|
| `未找到 sidecar 可执行文件` | VSIX 缺少 `bin/`，重装 |
| `ipc bridge connected` | 扩展与 sidecar 已连通 |
| `已从码道加密存储获取内核口令` | 口令自动获取成功 |
| `kernel connection received` | 已下发内核地址（`hasAuth=true` 表示带口令） |
| `sidecar running` | 服务就绪 |
| `qq message received` | 已收到 QQ 消息 |
| `inbound accepted` / `kernel prompt sending` | 已进入内核处理 |
| `reply buffered` → `reply sending (flush)` | 回复合并后发送 |
| `outbound send failed` | 看错误里的 QQ 响应体（`msg_seq` / 频率 / 内容） |
| `prompt request interrupted, continue waiting for stream` | 请求超时但内核仍在生成，会继续等待并投递 |

## 构建

```bash
npm install
npm run check            # 分层 / 类型 / 单测
npm run build:sidecar    # Node SEA 单文件可执行
npm run package:vsix     # 构建扩展并出 VSIX
```

## 安全

- AppSecret 与内核口令只存系统凭据库或内存，不写入配置与仓库；
- 日志对密钥、token 做脱敏；
- sidecar 与内核均只使用回环地址；IPC 使用一次性 token；
- 建议定期重置 QQ AppSecret，并删除本地临时明文文件（如 `.local/`）。