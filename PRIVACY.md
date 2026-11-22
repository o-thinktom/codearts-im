# 隐私说明 / Privacy Notice

> 适用于 codearts-im（扩展 ID `codearts-im`）· 维护者 ThinkTom · 更新日期 2026-11-22

## 1. 这个插件做什么

codearts-im 把 IM（QQ / 微信 / 企业微信）中的消息转发给**你本机的码道 CodeArts Agent**，再把 Agent 的最终回答发回 IM。它不提供云端中转服务，也不运营任何服务器。

## 2. 数据流向

```
你的 IM 客户端
  → 平台服务器（腾讯 QQ / 微信 / 企业微信）
  → 本机 sidecar（命名管道 IPC）
  → 本机码道 Agent Kernel
  → 模型服务（由你在码道中配置的 provider）
  → 本机 sidecar → 平台 → 你的 IM 客户端
```

- 消息内容会经过上述平台与模型服务，受各自隐私政策约束；
- 插件本身不向第三方上传数据；
- 内核与平台凭据只在本机使用。

## 3. 本机存储

| 数据 | 位置 | 说明 |
|---|---|---|
| QQ AppSecret、微信 token、企微 secret | 系统凭据库（SecretStorage） | 不写入配置文件、仓库或日志 |
| 码道内核口令 | 由码道以加密形式存储，插件只读解密 | 仅在内存中使用 |
| 会话映射、访问名单、偏好 | `<globalStorage>/…/codearts-im/*.json` | 可删除，删除后会话与白名单重置 |
| 入站媒体 | `<globalStorage>/…/codearts-im/media/` | 按 TTL 清理，可手动删除 |
| 运行日志 | `<globalStorage>/…/codearts-im/logs/sidecar.log` | 4 MB × 5 轮转，已脱敏 |

## 4. 我们不收集什么

- 不收集遥测、使用统计或崩溃上报；
- 不上传代码、文件或对话到插件作者；
- 不在日志中记录 AppSecret、token、secret 或 openid 明文；
- 不保存思维链与系统提示。

## 5. 日志与诊断包

- 日志仅保存在本机，包含会话 ID、消息长度、错误原因等排障信息；
- 「导出诊断包」会在写出前执行 `[REDACTED]` 脱敏，替换 `appSecret` / `secret` / `token` / `password` 等字段值；
- 诊断包可能包含内核端口与版本、配置快照（口令仅显示 `set` / `empty`）、最近 300 行日志与兼容矩阵；
- 将诊断包发送给他人前，请自行确认其中是否含业务敏感内容。

## 6. 你的控制权

- 「QQ Bot: 停止」可随时停止 sidecar；
- 切换通道会暂停其他通道；旧凭据保留，可重新扫码切回；
- 访问名单支持 open / allowlist / disabled、配对码与撤销；
- 删除 `<globalStorage>/…/codearts-im/` 可清空会话、白名单与媒体缓存；
- 在系统凭据库中删除对应条目可移除通道凭据。

## 7. 第三方服务

| 服务 | 用途 | 政策入口 |
|---|---|---|
| 腾讯 QQ 开放平台 | QQ 消息收发、扫码绑定 | 腾讯相关协议 |
| 微信 iLink | 微信消息收发、扫码绑定 | 腾讯相关协议 |
| 企业微信开放平台 | 企微消息收发、扫码绑定 | 腾讯相关协议 |
| 模型供应商（默认 `inferhub-provider`） | 推理 | 由你在码道中配置的服务条款 |

## 8. 合规提示

- 仅在你拥有相应权限的账号与设备上使用；
- 群聊场景请遵守所在组织的信息披露要求；
- 企业微信需管理员授权智能机器人；请勿绕过组织策略；
- 本项目为个人开源项目，不代表华为云或腾讯的官方立场。

---

# Privacy Notice (English)

## What it does

codearts-im relays IM messages (QQ / WeChat / WeCom) to the **local** CodeArts Agent and returns the final answer. There is no cloud relay operated by the project.

## Data flow

Your IM client → platform servers (Tencent) → local sidecar (named-pipe IPC) → local CodeArts Agent kernel → model provider configured in CodeArts → back to your IM client.

## Local storage

- Channel credentials: system SecretStorage only; never in config, repository or logs.
- Kernel password: stored encrypted by CodeArts; the plugin only decrypts read-only in memory.
- Session mappings, access lists, preferences: `<globalStorage>/…/codearts-im/*.json`.
- Inbound media: `<globalStorage>/…/codearts-im/media/` (TTL-cleaned).
- Runtime logs: `<globalStorage>/…/codearts-im/logs/sidecar.log` (4 MB × 5, redacted).

## Not collected

No telemetry, usage analytics or crash reporting. No code/file/conversation upload to the project author. No plaintext credentials or openids in logs. No chain-of-thought or synthetic prompts stored.

## Diagnostics

The export command applies a `[REDACTED]` pass to `appSecret` / `secret` / `token` / `password` fields before writing. Review the file before sharing it, since it may contain business-sensitive log lines.

## Your controls

Stop the sidecar at any time; switch channels by scanning again; configure open / allowlist / disabled access with pairing codes and revocation; delete `<globalStorage>/…/codearts-im/` to reset sessions and media; remove credentials from the system secret store.

## Third parties

Tencent QQ / WeChat iLink / WeCom handle message transport and onboarding; the configured model provider handles inference. Their own terms and privacy policies apply.

## Compliance

Use only with accounts and devices you are authorized to operate. Group usage must follow your organization’s disclosure rules. WeCom requires an administrator-authorized bot. This is a personal open-source project and is not an official statement of Huawei Cloud or Tencent.