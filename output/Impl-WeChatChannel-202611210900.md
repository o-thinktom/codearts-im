# 码道 CodeArts Agent 微信/企业微信接入 实现方案

| 项目 | 内容 |
|---|---|
| 文档类型 | 实现方案（TDD / 改造清单级） |
| 基线代码 | 工作区 `codearts-qqbots`，插件 0.3.1（113 项测试） |
| 参考实现 | `@xmanrui/dsh-im@5.10.0` 的 `src/channels/{weixin,wecom,wecom-app}` |
| 上游方案 | `Solution-WeChatIntegration-202611210830.md`（渠道评估） |
| 目标 | 在**不改动 KernelPort 与业务编排**的前提下，新增微信（iLink）、企微智能机器人、企微自建应用三个渠道 |

---

## 1. 方案概述

现有 QQ 链路的耦合点只有两处：

- `QqbotApp` 依赖 `ImTransport`（出站）与 `InboundSource`（入站）两个接口；
- `sidecar.ts` 里把 `QqImTransport` 与 `QqInboundSource` 直接 new 出来。

因此改造思路是：**把这两个接口合并为 `ImAdapter`，QQ 收进 `adapters/qq/`，微信与企微各实现一个 adapter**。`gateway`、`outbound`、`session`、`access`、`KernelPort`、`IPC`、`扩展容器` 均不改逻辑，只改"注入哪个 adapter"和"渠道能力参数"。

    QqbotApp ──> ImAdapter（唯一渠道边界）
                   ├─ adapters/qq        （现有 WS + msg_seq）
                   ├─ adapters/weixin    （iLink 扫码 + 长轮询）
                   ├─ adapters/wecom     （企微智能机器人 WS）
                   └─ adapters/wecom-app （企微自建应用 HTTP 回调）

---

## 2. 现状与可复用点（基于实际代码）

| 现有文件 | 处理方式 |
|---|---|
| `packages/qqbot-runtime/src/transport/outbound-types.ts` | `ImTransport` + `InboundSource` 合并为 `ImAdapter`（保留旧接口做兼容层） |
| `packages/qqbot-runtime/src/sidecar.ts` | 按 `config.im` 调用 `createAdapter()`，不再直接 new QQ 类 |
| `packages/qqbot-runtime/src/gateway.ts` | `QqbotAppOptions` 改为注入 `adapter`；`targetOf` 增加 channel |
| `packages/qqbot-runtime/src/session/registry.ts` | `sessionKeyOf(appId, scope, peerId)` 增加 channel 参数 |
| `packages/qqbot-runtime/src/transport/outbound.ts` | 切分上限从常量改为 `adapter.capability.maxChars` |
| `packages/qqbot-runtime/src/qq/{client,source,transport}.ts` | 原样保留，外层包一个 `QqAdapter` |
| `packages/qqbot-core/src/types.ts` | `InboundMessage` / `ReplyTarget` 增加 `channel` |
| `packages/vscode-extension/src/bind-qr.ts` | 抽象为 `BindProvider`；QQ 实现保持 `startQrConnect` |
| `packages/qqbot-ipc/src/protocol.ts` | `KernelConnection` 增加 `im` 与渠道配置；凭据按渠道命名 |
| `scripts/compat-matrix.mjs` | 增加 `--im` 维度 |

**不改**：`qqbot-kernel-port/*`、`normalize`、`compat`、访问控制逻辑、审批/提问状态机、媒体下载与 TTL、单实例锁。

---

## 3. 接口设计

### 3.1 渠道与能力

    export type ImChannel = "qq" | "weixin" | "wecom" | "wecom-app";

    export interface ChannelCapability {
      maxChars: number;          // QQ 4500 / weixin 1800 / wecom 2048
      streaming: boolean;
      typing: boolean;           // weixin 有 typing_ticket；企微机器人原生"正在思考"
      buttons: boolean;          // 企微机器人模板卡片
      media: "base64" | "cdn" | "sdk";
      maxFileBytes: number;
    }

### 3.2 ImAdapter

    export interface ImAdapter {
      readonly id: ImChannel;
      readonly capability: ChannelCapability;
      readonly connected: boolean;

      start(): Promise<void>;
      stop(): Promise<void>;

      onMessage(handler: (msg: InboundMessage) => void): void;
      sendText(target: ReplyTarget, text: string, kind: SendKind): Promise<void>;
      sendFile(target: ReplyTarget, files: PresentedFile[]): Promise<void>;

      /** 可选：输入状态（微信 typing / 企微"正在思考"） */
      sendTyping?(target: ReplyTarget, on: boolean): Promise<void>;
    }

### 3.3 消息与会话

    // core/types.ts
    interface InboundMessage { channel: ImChannel; /* 其余不变 */ }
    interface ReplyTarget { channel: ImChannel; /* 其余不变 */ }

    // registry.ts
    sessionKeyOf(channel, appId, scope, peerId)
      // qq:1906473114:c2c:443F...
      // weixin:bot:c2c:<wxid>
      // wecom:<corpId>:c2c:<userid>

迁移期兼容：`channel` 缺省视为 `"qq"`，`sessionKeyOf` 保留旧签名重载，确保现有测试不改断言。

### 3.4 绑定提供者

    export interface BindProvider {
      id: ImChannel;
      start(handlers: BindHandlers, signal: AbortSignal): () => void;
    }

    export interface BindHandlers {
      onQr(url: string): void;
      onSuccess(credentials: ChannelCredentials): void;
      onExpired(): void;
      onFailure(reason: string): void;
      onVerificationRequired?(url: string): void;
    }

    export type ChannelCredentials =
      | { channel: "qq"; appId: string; appSecret: string }
      | { channel: "weixin"; botId: string; token: string; baseUrl: string }
      | { channel: "wecom"; botId: string; secret: string }
      | { channel: "wecom-app"; corpId: string; agentId: string; secret: string; token: string; aesKey: string };

---

## 4. 改造清单（按 PR 拆分）

### PR-1：抽象层（零行为变化）

| 文件 | 改动 |
|---|---|
| `runtime/src/transport/adapter.ts`（新增） | `ImAdapter`、`ChannelCapability`、`SendKind` |
| `runtime/src/adapters/qq/adapter.ts`（新增） | 包装 `QqInboundSource` + `QqImTransport` |
| `runtime/src/sidecar.ts` | `createAdapter(config, deps)` 工厂，默认 `qq` |
| `runtime/src/gateway.ts` | 注入 `adapter`；内部 `transport/source` 指向 adapter |
| `core/src/types.ts` | `channel` 字段（缺省 qq） |
| `runtime/src/session/registry.ts` | `sessionKeyOf` 加 channel，保留重载 |

验收：现有 113 项测试全绿；QQ 端到端行为不变。

### PR-2：微信 iLink 适配器

新增 `runtime/src/adapters/weixin/`：

    weixin-api.ts        iLink 协议客户端（fetch）
    weixin-adapter.ts    ImAdapter 实现
    weixin-state.ts      get_updates_buf / botId 持久化
    weixin-media.ts      图片 AES 解密、CDN 上传

### PR-3：扫码绑定

- 抽象 `bind-qr.ts` → `bind-providers/{qq,weixin,wecom}.ts`；
- `bind-panel.ts` 增加渠道选择（QQ / 微信 / 企业微信）；
- 凭据按渠道写入 SecretStorage：`qq/*`、`weixin/*`、`wecom/*`。

### PR-4：企微智能机器人

    adapters/wecom/wecom-adapter.ts   @wecom/aibot-node-sdk
    adapters/wecom/wecom-bind.ts      work.weixin.qq.com/ai/qc/generate + query_result

### PR-5：企微自建应用

    adapters/wecom-app/callback-server.ts   HTTP 回调 + 验签 + AES
    adapters/wecom-app/wecom-app-adapter.ts 应用消息 + 素材上传

---

## 5. 微信 iLink 适配器设计

### 5.1 协议端点（来自 dsh-im 实测）

| 用途 | 端点 |
|---|---|
| 取二维码 | `POST {base}/ilink/bot/get_bot_qrcode?bot_type=3` |
| 轮询扫码 | `GET {base}/ilink/bot/get_qrcode_status?qrcode=<token>` |
| 收消息 | `POST {base}/ilink/bot/getupdates`（35s 长轮询） |
| 取 typing | `POST {base}/ilink/bot/getconfig` |
| 发送 typing | `POST {base}/ilink/bot/sendtyping` |
| 发文本 | `POST {base}/ilink/bot/sendmessage` |
| 上传文件 | `POST {base}/ilink/bot/getuploadurl` → CDN `c2c/upload` |

`base` 默认 `https://ilinkai.weixin.qq.com/`；鉴权头为 `Authorization: Bearer <token>`（`AuthorizationType: ilink_bot_token`）。

### 5.2 启动与长轮询

    async start() {
      await this.api.notifyStart({ baseUrl, token });
      this.monitor = this.#runMonitor(this.abort.signal);
    }

    async #runMonitor(signal) {
      let failures = 0;
      while (!signal.aborted) {
        try {
          const res = await this.api.getUpdates({
            baseUrl, token,
            getUpdatesBuf: await this.state.getCursor(),
            timeoutMs: 35_000,
            signal,
          });
          failures = 0;
          for (const raw of orderBySeq(res.msgs)) {
            const msg = this.#toInbound(raw);
            if (msg) this.handler?.(msg);
          }
          if (res.get_updates_buf) await this.state.setCursor(res.get_updates_buf);
        } catch (err) {
          if (signal.aborted) return;
          if (isStaleToken(err)) { this.#emitStale(); return; }   // -14：要求重新扫码
          if (++failures >= 3) throw err;
          await sleep(Math.min(2000 * 2 ** (failures - 1), 10_000));
        }
      }
    }

### 5.3 入站消息映射

| iLink 结构 | InboundMessage |
|---|---|
| `item.type=1` + `text_item.text` | `text` |
| `item.type=2` + `image_item` | `attachments[{kind:"image", url, aesKey}]` |
| `item.type=4` + `file_item` | `attachments[{kind:"file", filename, url}]` |
| `from_user_id` | `senderId` / `peerId`（c2c） |
| `context_token` | 存入 `target.msgId` 的等价位置（回复上下文） |

图片处理：下载后按 `aeskey`（hex 或 base64）AES-ECB 解密，写入 `media/<peer>/`，填 `localPath`；不做二次下载。

### 5.4 出站

    async sendText(target, text, kind) {
      const chunks = chunkMarkdownText(text, 1800);
      for (const chunk of chunks) {
        await this.api.sendText({
          baseUrl, token,
          toUserId: target.targetId,
          text: chunk,
          contextToken: target.contextToken,
          runId: target.runId,
        });
      }
    }

    async sendFile(target, files) {
      for (const file of files) {
        try {
          await this.media.sendFile({ baseUrl, token, toUserId: target.targetId, file });
        } catch {
          await this.sendText(target, `文件：${file.name}\n${file.path}`, "file");  // 降级
        }
      }
    }

### 5.5 失效与重扫码

- `ret/errcode = -14`：停止轮询，状态置 `stale`，通过 IPC `status.changed` 通知扩展；
- 扩展提示"微信登录已失效，请重新扫码"，清除 `weixin/*` 凭据；
- 其余错误：连续 3 次失败才断开，退避 2s/4s/8s（上限 10s）。

---

## 6. 企业微信适配器

### 6.1 智能机器人（推荐）

- 扫码：`GET https://work.weixin.qq.com/ai/qc/generate?source=codearts-agent&plat=2` → `scode` + `auth_url`；
- 轮询：`GET .../query_result?scode=` → `bot_info.botid` + `bot_info.secret`；
- 收发：`@wecom/aibot-node-sdk` 的 WebSocket 客户端（事件 → `InboundMessage`；发送文本/文件）；
- 能力：`maxChars` 以 SDK 为准（先按 2048），`streaming: true`，`typing: true`（原生"正在思考"），`buttons: true`（模板卡片，P2）。

### 6.2 自建应用

- 回调服务 `callback-server.ts`（`node:http`）：
  - 校验 `msg_signature`（sha1(token+timestamp+nonce+encrypt)）；
  - AES-256-CBC 解密 `Encrypt`（PKCS#7，EncodingAESKey 解码）；
  - 5 秒内返回 `success`，业务异步处理；
  - 发送走应用消息 API（文本/图文/文件），素材先 `media/upload`；
- 能力：`maxChars: 2048`，`streaming: false`（降级分段），`typing: false`；
- 部署：回调地址需公网或企业内网代理，配置 `proxyBaseUrl`。

---

## 7. 配置、凭据与数据

### 7.1 RuntimeConfig 扩展

    im: "qq" | "weixin" | "wecom" | "wecom-app";

    weixin: {
      baseUrl: string;         // 默认 https://ilinkai.weixin.qq.com/
      botType: number;         // 3
      maxChars: number;        // 1800
      typingKeepaliveMs: number; // 5000
    };

    wecom: {
      corpId?: string;
      agentId?: string;
      callbackPath: string;    // /wecom-app/callback
      proxyBaseUrl?: string;
    };

### 7.2 凭据（SecretStorage）

| 渠道 | 键 |
|---|---|
| QQ | `qqbot/app-id`、`qqbot/app-secret` |
| 微信 | `weixin/token`、`weixin/bot-id`、`weixin/base-url` |
| 企微机器人 | `wecom/bot-id`、`wecom/secret` |
| 企微应用 | `wecom-app/corp-id`、`wecom-app/agent-id`、`wecom-app/secret`、`wecom-app/token`、`wecom-app/aes-key` |

### 7.3 数据

    ~/.codeartsdoer/qqbot/
    ├─ prefs.json            <!-- 按 channel 分区 -->
    ├─ access.json           <!-- 按 channel 分区 -->
    ├─ weixin-state.json     <!-- get_updates_buf、botId -->
    ├─ wecom-state.json
    ├─ media/<channel>/<peer>/
    └─ locks/<channel>-<appId>.lock

---

## 8. 扫码绑定改造

    extension.ts
      └─ 「QQ Bot: 扫码绑定机器人」→ 选择渠道
           ├─ QQ      → QqBindProvider（startQrConnect，现状）
           ├─ 微信     → WeixinBindProvider（get_bot_qrcode + 轮询）
           └─ 企业微信  → WecomBindProvider（qc/generate + 轮询）

成功后的动作统一：

    await context.secrets.store(...)   // 按渠道键
    await bridge.pushCredentials({ channel, credentials })
    sup.restart()                       // 新凭据必须重启 sidecar

`bind-panel` 的 HTML 复用，仅新增渠道选择步骤与"验证码输入"（微信 `need_verifycode`）。

---

## 9. 交互与渲染

| 项 | 设计 |
|---|---|
| 分段 | `adapter.capability.maxChars`（QQ 4500 / 微信 1800 / 企微 2048） |
| 合并 | 沿用 `turn/end` 合并；微信按 1800 分片后带序号 |
| 审批 | 文本 `1/2`（复用）；企微机器人 P2 升级模板卡片 |
| 提问 | 字母 `A/B/C`（复用），多问题 `A;B` |
| 思维链 | 沿用 `partID → type` 过滤，不发送 reasoning |
| 输入状态 | 微信 `typing_ticket` + `sendtyping`（5s 保活；失败 60s 重试）；企微机器人原生 |
| 媒体降级 | 上传失败回退"文件路径"文本 |

---

## 10. 安全

| 面 | 措施 |
|---|---|
| 凭据 | 仅 SecretStorage；IPC 只传内存值；日志/诊断包脱敏 |
| 微信图片 | AES key 仅内存；解密后文件 0600 |
| 企微回调 | 签名校验 + AES 解密 + 时间戳防重放 + 5 秒 ACK |
| 文件回传 | 沿用 realpath 白名单（workspace + media），按渠道设大小上限 |
| 访问控制 | 按 channel 独立名单；配对码独立 |
| 单实例 | `<channel>-<appId>` 级文件锁 |
| 合规 | 首次启用提示消息将发送至微信/企业微信 |

---

## 11. 稳定性

| 机制 | 设计 |
|---|---|
| 长轮询 | 35s 超时视为空；游标持久化，重启续传 |
| 失效 | `-14` 停止并提示重扫码，不无限重试 |
| 退避 | 连续 3 次失败；2s/4s/8s（上限 10s） |
| 顺序 | 按 `seq` / `create_time_ms` 排序 |
| 幂等 | `client_id` 去重；`context_token` 绑定回复上下文 |
| 企微回调 | 立即 ACK，业务异步；失败重试由平台驱动 |
| 媒体 | CDN 分片 64KB；空闲 60s 超时；最多 3 次 |
| 熔断 | 沿用 `CircuitBreaker`，按渠道独立 |

---

## 12. 测试与兼容矩阵

### 12.1 单测

- `weixin-adapter.test.ts`：假 API（getUpdates 序列、sendmessage、-14、超时空响应）；
- `weixin-media.test.ts`：AES hex/base64 解密、CDN 分片、降级；
- `wecom-app-callback.test.ts`：签名、AES、5 秒 ACK；
- `adapter-contract.test.ts`：同一套契约用例跑 QQ/微信/企微 mock。

### 12.2 兼容矩阵

    npm run compat -- --im qq
    npm run compat -- --im weixin     # 需真实扫码
    npm run compat -- --im wecom

新增用例：扫码、长轮询续传、1800 切分、图片解密、文件上传、失效重扫。

---

## 13. 迁移步骤与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 抽象 `ImAdapter` + QQ 下沉 + channel 字段 | 113 项测试全绿；QQ 端到端无变化 |
| P1 | 微信 iLink：扫码、长轮询、文本、typing、1800 | 单聊文本往返；断网续传；-14 回扫码 |
| P2 | 微信媒体：图片解密、文件 CDN | 图片可入内核；文件可回传；失败降级 |
| P3 | 企微智能机器人：扫码 + WS + 流式 | 单聊往返；流式/思考中可见 |
| P4 | 企微自建应用：回调 + 素材 | 回调 ACK < 5s；文本/文件往返 |
| P5 | 多渠道路由、兼容矩阵、文档 | 同机多渠道并存；矩阵全绿 |

**决策门（P1 前）**：iLink 能否扫码并收发文本。不通过则只做企微两条线。

---

## 14. 风险、收益与可推广性

### 14.1 风险

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| W1 | iLink 协议非公开、可能变更 | 高 | adapters 隔离 + 契约测试 + 版本探测 |
| W2 | iLink 准入资质未知 | 高 | P1 决策门；备选企微 |
| W3 | 1800 字符导致分片多 | 中 | 合并 + 序号；重要内容压缩 |
| W4 | 图片 AES 双编码 | 中 | 双编码兼容 + 失败跳过 |
| W5 | 企微应用回调需公网 | 中 | 优先智能机器人；应用仅内网 |
| W6 | 个人微信风控 | 中 | 只用官方 iLink，控频，不群发 |
| W7 | 多渠道路由串话 | 中 | sessionKey 加 channel |

### 14.2 收益

- 覆盖微信/企微办公场景，与 QQ 互补；
- 微信与企微机器人都**无需公网**，部署成本与 QQ 持平；
- 复用 KernelPort、编排、审批、提问、媒体与安全，边际成本低；
- `ImAdapter` 抽象后可继续接飞书/钉钉（dsh-im 已验证 9 渠道）。

### 14.3 可推广性

- 横向：同机多渠道并存（`--im` 或配置切换）；
- 纵向：企微应用可私有化到企业内网；
- 生态：形成"码道多 IM 网关"，对 dsh 也可复用（KernelPort 多实现）。

---

## 15. 五维评估

| 维度 | 评分 | 说明与措施 |
|---|---|---|
| 开发便利性 | 4 | 适配器隔离、mock API、契约用例；P0 先做零行为重构 |
| 易用性 | 4 | 统一扫码面板；微信/企微都是扫码，无需手填 |
| 可维护性 | 3.5 | 协议非公开，需版本探测与契约测试；能力位参数化 |
| 安全性 | 4 | 凭据安全存储、回调验签、路径白名单、日志脱敏 |
| 稳定性 | 3.5 | 长轮询游标、-14 重扫、退避、分片重试、熔断 |

---

## 16. 待确认问题

1. iLink AI 的准入条件与协议稳定性（是否面向第三方开放、有无配额）；
2. 扫码 `confirmed` 响应中 token/botId 的准确字段名（P0 实测校准）；
3. 企微智能机器人 SDK 的授权与计费；
4. 企微自建应用回调是否允许内网代理；
5. 个人微信长期在线是否触碰平台风控边界。

---

## 17. 结论

改造的**核心不是协议，而是抽象**：先把 `ImAdapter` 与 `channel` 维度引入、把 QQ 下沉，保证零行为变化；随后按"微信 iLink → 企微机器人 → 企微应用"的顺序接入。这样可以做到：

- 现有 QQ 功能不回归；
- 微信/企微只新增 `adapters/*` 与 `bind-providers/*`；
- 内核、编排、安全、打包完全不改。

建议从 PR-1（抽象层）开始，用现有 113 项测试做回归基线。