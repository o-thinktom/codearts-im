# CodeArts IM

通过 QQ / 微信（iLink）/ 企业微信智能机器人驱动本机码道（CodeArts Agent）的 VS Code 扩展。手机发一句话，本地 IDE 里的 Agent 执行并把结果回传。

## 架构

    QQ 开放平台 / 微信 iLink / 企业微信智能机器人
      ↕  （WebSocket / HTTPS 长轮询）
    sidecar（独立进程，内置 Node 运行时）
      ↕ 本机 IPC（命名管道，token 鉴权）
    VS Code 扩展（发现内核端口、解密口令、下发连接、扫码绑定）
      ↕ 本地回环 HTTP + SSE
    码道内核 agentkernelServer（会话 / 工具 / 模型）

- sidecar 负责通道长连接、会话映射、消息合并/切分/流式与发送；
- 扩展负责生命周期、配置、内核连接下发与渠道切换；
- 内核只监听 `127.0.0.1`，sidecar 不直连公网。

## 安装

要求：Windows 10/11 x64；码道 v26.11.x；无需安装 Node。

方式一（命令行，推荐）：

```powershell
& "<码道安装目录>\bin\codearts-agent.cmd" --install-extension "<路径>\codearts-im-0.4.0.vsix"
```

方式二（图形界面）：扩展视图 → `...` → 从 VSIX 安装 → 选择 `.vsix` →「Developer: Reload Window」。

> 0.4.0 起扩展 ID 改为 `codearts-community.codearts-im`。安装前请卸载旧版 `codearts-qqbot-cn`，避免两个扩展同时运行。

## 首次使用

1. 启动码道并完成一次对话，确保内核已运行；
2. 命令面板执行对应扫码绑定：
   - 「CodeArts IM: 扫码绑定机器人」（QQ）
   - 「CodeArts IM: 扫码绑定微信」
   - 「CodeArts IM: 扫码绑定企业微信」
3. 手机扫码并确认授权，凭据写入系统凭据库，插件自动启动连接；
4. 在对应 IM 内给机器人发消息。

无法扫码时可用「CodeArts IM: 手动填写凭据」。内核端口读自 `server_config.properties`，口令通过官方加密存储只读解密；失败时可执行「CodeArts IM: 设置内核连接」手动录入。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `codeartsIm.enabled` | `true` | 随码道启动自动拉起，并等待内核就绪（最多 5 分钟） |
| `codeartsIm.workspace` | 当前工作区 | Agent 工作目录 |
| `codeartsIm.provider` | `inferhub-provider` | 模型供应商 |
| `codeartsIm.model` | `deepseek-v4.1-flash-1017` | 模型 ID；**不要留空**，否则可能被路由到空模型 |
| `codeartsIm.agent` | `build` | 使用的 Agent |
| `codeartsIm.requireMention` | `true` | 群聊必须 @ |
| `codeartsIm.textChunkLimit` | `4500` | 单条消息最大字符数（实际取通道能力表） |
| `codeartsIm.access.c2cMode` | `open` | 私聊访问：open / allowlist / disabled |
| `codeartsIm.access.groupMode` | `allowlist` | 群聊访问：正式使用请保持 allowlist |
| `codeartsIm.access.commandMode` | `allowlist` | 命令权限 |
| `codeartsIm.media.*` | 见设置 | 图片/文件开关、大小与保留时长 |
| `codeartsIm.sendFile.restrict` | `true` | 限制可发送的文件路径 |
| `codeartsIm.debug` | `false` | 打开输出面板详细日志 |

## 聊天命令

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

- **一轮合并一条**：多步生成的文本在 `session.idle` 时合并发送，避免漏段；
- **长回复切分**：按通道上限切分；QQ 被动回复自动递增 `msg_seq`（最多 5 条）；
- **流式**：企业微信使用 token 级增量（600ms 节流，ack 慢时跳过中间帧），失败回退整段；
- **会话隔离**：每个对端一个内核会话，重启后自动恢复；
- **模型显式指定**：避免内核 auto-router 选到不可用的 `speed` 模型导致“无回复”；
- **只发最终回答**：思维链与系统提示不会进入 IM。

## 已知限制

| 项 | 说明 |
|---|---|
| 平台 | 仅 Windows x64 产物；macOS/Linux 需在对应平台构建 |
| 码道版本 | 契约按 126.11.x 实测校准，升级后需回归验证 |
| 口令 | 来自官方加密存储；格式变化时回退为手动录入 |
| 可执行文件 | 未做代码签名，可能触发 SmartScreen / 杀软提示 |
| 群聊默认 | 联调可临时设 `groupMode=open`，正式使用请改回 `allowlist` |
| 计费 | 每条对话会消耗码道 Credits |
| 文件发送 | 三通道仅支持“机器人主动推送”；码道随回复自动发文件受平台限制 |
| 按钮卡片 | 企业微信模板卡片未实现，审批/提问为文本交互 |

## 故障排查

输出面板：`CodeArts IM`。日志落盘：`<globalStorage>/codearts-community.codearts-im/codearts-im/logs/sidecar.log`。

| 日志 | 含义 |
|---|---|
| `sidecar binary not found` | VSIX 缺少 `bin/`，重装 |
| `ipc bridge connected` | 扩展与 sidecar 已连通 |
| `已从码道加密存储获取内核口令` | 口令自动获取成功 |
| `kernel connection received` | 已下发内核地址（`hasAuth=true` 表示带口令） |
| `sidecar running` / `channel online` | 服务与通道就绪 |
| `inbound accepted` / `kernel prompt sending` | 已进入内核处理 |
| `reply buffered` → `reply sending (flush)` | 回复合并后发送 |
| `reply sending (stream finish)` | 企微流式收尾 |
| `listen EADDRINUSE` | 残留 sidecar 占用管道，先执行 `taskkill /IM codearts-im-sidecar-win32-x64.exe /F` |
| `sendFile failed` | 文件发送失败，原因随回复返回 |

也可以执行「CodeArts IM: 导出诊断包」一次性导出状态、配置快照、日志尾部与兼容矩阵（自动脱敏）。

## 构建

```bash
npm install
npm run check            # 分层 / 类型 / 单测
npm run build:sidecar    # Node SEA 单文件可执行
npm run package:vsix     # 构建扩展并出 VSIX
```

## 安全

- 通道密钥与内核口令只存系统凭据库或内存，不写入配置与仓库；
- 日志与诊断包对密钥、token、openid 脱敏；
- sidecar 与内核均只使用回环地址；IPC 使用一次性 token；
- 建议定期重置通道密钥，并删除本地临时明文文件（如 `.local/`）。