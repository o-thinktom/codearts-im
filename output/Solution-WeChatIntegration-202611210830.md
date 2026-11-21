# 码道 CodeArts Agent 微信接入方案（基于 dsh-im 参考实现）

| 项目 | 内容 |
|---|---|
| 文档类型 | 技术方案（渠道扩展设计） |
| 参考实现 | `@xmanrui/dsh-im@5.10.0`（npm 包，含 9 个 IM 渠道源码） |
| 参考渠道 | `src/channels/weixin`（个人微信）、`wecom`（企微智能机器人）、`wecom-app`（企微自建应用） |
| 目标宿主 | 码道 CodeArts Agent 0.3.1（VSIX + sidecar + KernelPort） |
| 结论 | **可行，且复用度约 60%~70%**；个人微信可用腾讯 iLink AI 扫码 + 长轮询，无需公网 IP |

> 说明：dsh-im 的微信协议来自社区对腾讯 iLink AI 接口的实测实现，并非腾讯公开文档。
> 协议版本 `2.4.6`、端点与字段可能随平台调整，方案中已设计兼容与降级。

---

## 1. 结论摘要

1. **个人微信不是"无官方 API"**：dsh-im 使用腾讯 **iLink AI**（`https://ilinkai.weixin.qq.com/`）的机器人接口，扫码绑定后通过**长轮询**收发，部署形态与 QQ 长连接类似，**不需要公网回调**。
2. 企业微信有两条路：**智能机器人**（官方 SDK + WebSocket，扫码创建）与**自建应用**（HTTP 回调，需要公网/代理）。
3. 码道现有架构可复用 **KernelPort、gateway、outbound、access、IPC、sidecar 生命周期、单实例、扫码绑定 UI**；需要新写的是 `weixin/wecom` 传输适配器与媒体上传。
4. 最大的工程差异不是协议，而是**单条长度（1800 字符）**、**长轮询游标**、**图片 AES 密钥**与**凭据失效重扫码（-14）**。

---

## 2. 参考实现：dsh-im 的微信协议事实

### 2.1 个人微信（iLink AI）

| 项 | 值（来自 dsh-im 源码） |
|---|---|
| 基址 | `https://ilinkai.weixin.qq.com/` |
| 协议版本 | `2.4.6`（`app_id="bot"`，`bot_type=3`） |
| 获取二维码 | `GET ilink/bot/get_bot_qrcode?bot_type=3` → `{ qrcode, qrcode_img_content }` |
| 轮询扫码 | `GET ilink/bot/get_qrcode_status?qrcode=<token>` |
| 扫码状态 | `wait` / `scaned` / `confirmed` / `expired` / `scaned_but_redirect` / `need_verifycode` / `verify_code_blocked` / `binded_redirect` |
| 收消息 | `POST ilink/bot/getupdates`，body `{ get_updates_buf, base_info }`，**长轮询 35s** |
| 发文本 | `POST ilink/bot/sendmessage`，`message_type=2`，`item_list=[{type:1,text_item}]` |
| 输入状态 | `POST ilink/bot/getconfig`（取 `typing_ticket`）+ `POST ilink/bot/sendtyping` |
| 媒体上传 | `https://novac2c.cdn.weixin.qq.com/c2c/upload`（64KB 分片） |
| 文件消息 | `item_list=[{type:4,file_item:{media,file_name,len}}]` |
| 图片加密 | 图片带 AES key（hex 或 base64 两种编码） |
| 单条上限 | **1800 字符**（超出按 Markdown 感知切分） |
| 凭据失效 | `ret/errcode = -14` → 必须移除账号并重新扫码 |

要点：
- 收消息是"长轮询 + 游标"：每次返回 `get_updates_buf`，下次带上；35s 超时视为空响应，不视为错误。
- 连续失败 3 次才判定连接失败，退避 2s/4s/8s（上限 10s）。
- `context_token` 用于回复上下文，`client_id` 保证幂等。

### 2.2 企业微信智能机器人

| 项 | 值 |
|---|---|
| 扫码创建 | `https://work.weixin.qq.com/ai/qc/generate?source=<source>&plat=<1|2|3>` → `scode` + `auth_url` |
| 轮询结果 | `https://work.weixin.qq.com/ai/qc/query_result?scode=<scode>` → `bot_info.botid` + `bot_info.secret` |
| 收发 | `@wecom/aibot-node-sdk@1.0.7`（官方 WebSocket 长连接） |
| 特性 | 原生"正在思考中"、工具进度、流式回答 |

### 2.3 企业微信自建应用

| 项 | 值 |
|---|---|
| 凭据 | 企业 ID、AgentId、Secret、Token、EncodingAESKey |
| 收消息 | HTTP 回调（需公网可达，可配置代理地址） |
| 发消息 | 应用消息 API（文本/图文/文件，支持流式时降级） |
| 特性 | 支持图片输入、文件回传；成员关注企业微信插件后可在微信内使用 |

---

## 3. 三种微信渠道对比

| 维度 | QQ（现状） | 个人微信 iLink | 企微智能机器人 | 企微自建应用 |
|---|---|---|---|---|
| 连接方式 | WebSocket 长连接 | **长轮询 35s** | WebSocket | HTTP 回调 |
| 是否需要公网 IP | 否 | **否** | **否** | **是**（或代理） |
| 凭据获取 | 扫码（官方 connector） | 扫码（iLink） | 扫码（企微） | 后台配置 |
| 单条上限 | 4500 | **1800** | 以 SDK 为准 | 2048（长文本需分段） |
| 流式 | 增量事件 | 批量/分段 | 原生流式 | 降级为分段 |
| 交互按钮 | 无 | 无（文本命令） | 模板卡片 | 模板消息 |
| 媒体回传 | base64 + `msg_type=7` | CDN 上传 + `file_item` | SDK 能力 | 素材上传 |
| 部署复杂度 | 低 | **低** | 低 | 中高 |

> 对码道最有价值的是：**个人微信 iLink 与企微智能机器人都无需公网**，部署形态与现有 QQ 一致；
> 企微自建应用适合企业内网有回调入口的场景。

---

## 4. 码道现有代码复用度

| 模块 | 复用度 | 说明 |
|---|---|---|
| `qqbot-kernel-port` | **100%** | 与 IM 无关 |
| `gateway`（会话/命令/审批/提问/优先路径） | **85%** | 需把渠道能力参数化（长度、typing、按钮） |
| `outbound`（回合归属/分段/合并/过滤） | **80%** | 分段上限从 4500 改为渠道能力值 |
| `qqbot-core`（inbound/chunker/access/commands） | **75%** | 身份字段与文案按渠道调整 |
| `media` | **60%** | 入站下载复用；出站新增 CDN/素材上传 |
| `qqbot-ipc` + 扩展容器 + 单实例 | **100%** | 原样复用 |
| 扫码绑定 UI（`bind-qr`/`bind-panel`） | **70%** | 状态机复用；二维码获取换成 iLink/企微端点 |
| QQ 传输层（`qq/*`） | **0%** | 新增 `weixin/*`、`wecom/*` |
| 兼容矩阵 | **80%** | 增加 `im` 维度 |

---

## 5. 目标架构

    L5 扩展（VSIX）
      ├─ 扫码绑定面板（复用 bind-panel，按渠道选择二维码来源）
      ├─ 管理访问名单 / 设置内核连接（复用）
      └─ 状态栏（复用）

    L4 sidecar
      ├─ gateway（复用）
      ├─ adapters/
      │   ├─ qq/        现有（WebSocket + msg_seq）
      │   ├─ weixin/    iLink：扫码、长轮询、sendmessage、CDN
      │   ├─ wecom/     智能机器人：扫码、WS SDK
      │   └─ wecom-app/ 自建应用：回调服务、素材上传
      ├─ media（复用下载；新增渠道上传策略）
      └─ ops（单实例锁、熔断、日志复用）

    L3 KernelPort（不变）
    L2 码道内核（不变）

### 5.1 ImAdapter 抽象

    interface ImAdapter {
      id: "qq" | "weixin" | "wecom" | "wecom-app";
      capability: {
        maxChars: number;          // QQ 4500 / weixin 1800
        streaming: boolean;
        typing: boolean;           // weixin 有 typing_ticket
        buttons: boolean;
        media: "base64" | "cdn" | "sdk";
      };
      start(): Promise<void>;
      stop(): Promise<void>;
      onMessage(handler: (msg: InboundMessage) => void): void;
      sendText(target: ReplyTarget, text: string, kind: SendKind): Promise<void>;
      sendFile(target: ReplyTarget, files: PresentedFile[]): Promise<void>;
      sendTyping?(target: ReplyTarget, on: boolean): Promise<void>;
    }

`gateway`/`outbound` 只依赖该接口与 `capability`，不感知渠道协议。

### 5.2 会话模型

    sessionKey = `<channel>:<appId>:<scope>:<peerId>`
    例：
      qq:1906473114:c2c:443F...
      weixin:bot:c2c:<wxid>
      wecom:<corpId>:c2c:<userid>

- `InboundMessage` 增加 `channel` 字段；
- `prefs.json` 按 channel 分区，避免多渠道路由串话；
- 命令/审批/提问的待答状态按 `sessionKey` 隔离。

---

## 6. 扫码绑定设计

### 6.1 个人微信

    扩展                          腾讯 iLink                 sidecar
     │ 选择「微信」并扫码            │                          │
     │ GET get_bot_qrcode ─────────>│                          │
     │<── qrcode + qrcode_img_content                          │
     │ 渲染二维码（复用 QRCode.toString）                        │
     │ 轮询 get_qrcode_status ─────>│                          │
     │<── scaned / confirmed / expired / need_verifycode        │
     │ confirmed 后拿到 token                                   │
     │ 写 SecretStorage（weixin/token、weixin/botId）             │
     │ IPC: credentials.set ───────────────────────────────────>│
     │ 启动长轮询（getupdates）                                  │

要点：
- 二维码 5 分钟有效；`expired` 自动重建；`need_verifycode` 提示输入验证码；
- token 失效（-14）时清除凭据并回到扫码态；
- 复用现有 `bind-panel` 的状态机，仅替换"获取二维码 / 轮询结果"两个回调。

### 6.2 企微智能机器人

    GET work.weixin.qq.com/ai/qc/generate?source=codearts-agent&plat=2
      → scode + auth_url（渲染二维码）
    GET work.weixin.qq.com/ai/qc/query_result?scode=...
      → success: bot_info { botid, secret }
    写入凭据 → 启动 @wecom/aibot-node-sdk WebSocket

### 6.3 企微自建应用

不提供扫码：在管理后台创建应用，填写 `corpid/agentid/secret/token/aeskey`，启动回调服务（需公网或代理）。可在绑定面板提供"高级：自建应用"表单。

---

## 7. 消息收发与渲染

| 场景 | 处理 |
|---|---|
| 文本 | 直接发送；超过 `capability.maxChars` 按 Markdown 感知切分 |
| 流式 | iLink 无 token 级流式：按批次合并后分段发送；企微机器人可用原生流式 |
| 长回复 | 微信 1800 字符切分；相邻分片加序号提示（可选） |
| 输入状态 | iLink 用 `getconfig` 取 `typing_ticket` + `sendtyping`，每 5s 保活；失败 60s 后重试 |
| 思维链 | 沿用现有 `partID → type` 过滤，不发送 reasoning |
| 审批 | 文本 `1/2`（复用）；企微机器人可后续升级模板卡片 |
| 提问 | 字母 `A/B/C`（复用）；多问题 `A;B` |

---

## 8. 媒体

### 8.1 入站

- 复用 `MediaService.ingest` 下载与 TTL；
- 微信图片需按 `aeskey`（hex/base64 两种编码）解密后再落盘；
- 语音：iLink 提供转写文本时按文本处理，否则提示不支持。

### 8.2 出站

| 渠道 | 方式 |
|---|---|
| iLink | CDN `c2c/upload` 分片上传 → 返回 `media` → `file_item`/`image_item` 发送 |
| 企微机器人 | SDK 素材上传 |
| 企微应用 | 素材上传 `media_id` → 应用消息 |

失败降级：与 QQ 一致，回退为"文件路径 + 说明"文本，不静默丢文件。

---

## 9. 安全

| 面 | 措施 |
|---|---|
| 凭据 | iLink token / 企微 secret 只写 SecretStorage；日志与诊断包脱敏 |
| 图片解密 | AES key 仅内存使用，不落盘 |
| 回调（企微应用） | 校验签名 + AES 解密 + 时间戳防重放 |
| 路径 | 文件回传沿用 realpath 白名单（workspace + media） |
| 访问 | 三模式 + 配对码按渠道独立配置 |
| 单实例 | appId/channel 级文件锁，避免同账号多开 |
| 合规 | 首次启用提示"消息将发送至微信/企业微信"；企业策略可禁用 |

---

## 10. 稳定性

| 机制 | 设计 |
|---|---|
| 长轮询 | 35s 超时视为空；`get_updates_buf` 持久化，重启后续传 |
| 失败退避 | 连续 3 次失败才判定断开；2s/4s/8s（上限 10s） |
| 凭据失效 | `-14` 立即停止并提示重新扫码，不无限重试 |
| 消息顺序 | 按 `seq`/`create_time_ms` 排序后再处理 |
| 幂等 | `client_id` 去重；`context_token` 绑定回复上下文 |
| 限流 | 复用 per-peer 队列；命令/审批/回答走优先路径 |
| 媒体 | 上传分片 64KB，空闲 60s 超时；失败重试 3 次 |

---

## 11. 兼容矩阵与测试

    npm run compat -- --im qq
    npm run compat -- --im weixin        # 需真实扫码凭据
    npm run compat -- --im wecom

用例：
1. 扫码 → 凭据写入 → 长轮询建立；
2. 单聊文本 → 内核 → 分段回复；
3. 1800 字符切分；
4. 图片入站解密 → 内核；
5. 文件回传 → CDN 上传；
6. token 失效 → 回到扫码态；
7. 断网 30s → 恢复续传（游标不丢）。

CI 只跑 mock adapter；真实渠道用例作为发布前门禁。

---

## 12. 风险与收益

### 12.1 风险

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| W1 | iLink 协议非公开文档、版本可能变更 | 高 | 适配层隔离；契约测试；版本探测 |
| W2 | iLink 准入/资质未知 | 高 | P0 先验证扫码与收发；准备企微/应用备选 |
| W3 | 1800 字符限制导致分片多 | 中 | 合并发送 + 分片序号；重要内容压缩 |
| W4 | 图片 AES 双编码解析错误 | 中 | 双编码兼容 + 失败跳过 |
| W5 | 企微应用回调需公网 | 中 | 优先智能机器人；应用模式仅企业内网 |
| W6 | 个人微信账号风控 | 中 | 仅用官方 iLink；控制频率；不做群发 |
| W7 | 多渠道路由串话 | 中 | sessionKey 加 channel 前缀 |

### 12.2 收益

- 覆盖企业办公主场景（微信/企微），与 QQ 形成互补；
- 个人微信与企微机器人都**无需公网**，部署成本与 QQ 持平；
- 复用 Agent 编排、审批、提问、媒体与安全，边际成本低；
- `ImAdapter` 抽象后可继续接飞书/钉钉（dsh-im 已验证路径）。

### 12.3 可推广性

- 横向：同一 sidecar 多渠道并存，按 `--im` 选择；
- 纵向：企微应用模式可私有化部署到企业内网；
- 生态：可作为"码道多 IM 网关"，对 dsh 生态也可复用（`KernelPort` 多实现）。

---

## 13. 开发计划（按验收驱动）

### P0 协议验证（决策门）

| 项 | 验收 |
|---|---|
| iLink 扫码 | 能拿到二维码并完成 `confirmed` |
| 收消息 | `getupdates` 能拿到文本与 `get_updates_buf` |
| 发消息 | `sendmessage` 文本送达 |
| 企微扫码 | `generate` + `query_result` 返回 botid/secret |
| 结论 | 产出协议报告（端点、字段、限制、失败码） |

### P1 个人微信可用版

扫码绑定 → 长轮询 → 文本收发 → 1800 切分 → typing → 会话隔离 → 单实例 → 媒体入站。

### P2 企业微信

智能机器人（扫码 + WS SDK + 流式 + 卡片）→ 自建应用（回调 + 素材上传 + 文件回传）。

---

## 14. 待确认问题

1. iLink AI 的准入条件（企业资质、开发者认证、是否需要申请）；
2. `get_bot_qrcode` / `getupdates` 是否有官方版本承诺与配额；
3. 个人微信是否允许自动化机器人长期在线（风控边界）；
4. 企微智能机器人 SDK 的授权与计费；
5. 企微自建应用回调是否允许内网代理。

---

## 15. 结论

**建议按"先抽象、再接入"推进**：

1. 先把 QQ 的 `source/transport` 下沉为 `adapters/qq`，引入 `ImAdapter` 与 `channel` 字段，用现有 113 项测试做零行为回归；
2. P0 只验证 iLink 扫码与收发，不写业务；
3. 通过后接个人微信（P1），再接企微机器人/应用（P2）。

不建议直接复制 QQ 代码改微信——两套编排会迅速漂移，维护成本高于新写传输层。