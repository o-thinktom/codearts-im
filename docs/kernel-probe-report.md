# 码道内核端点探测报告

| 项目 | 内容 |
|---|---|
| 探测对象 | CodeArts Agent 本地内核 `AgentKernel_Vscode_26_11_100_126_11_1-20261110192452.exe` |
| 内核版本 | `126.11.1-20261110192452`（码道 v26.11.100） |
| 探测方式 | 只读探测已运行实例 + 隔离沙盒实例 + OpenAPI 导出 + SSE 采样 |
| 产物 | `docs/kernel-openapi.json`（136 KB）、`docs/kernel-endpoints.md` |
| 结论 | **契约已可落地**：session 生命周期、消息发送、SSE 事件、Basic Auth 全部实测通过；仅"assistant 生成事件"需模型凭据后补验 |

---

## 1. 结论摘要

| 项 | 实测结果 |
|---|---|
| 监听地址 | `127.0.0.1:20553`（仅回环） |
| 进程 | `AgentKernel_Vscode_26_11_100_126_11_1-...exe`，PID 记录在 `server_config.properties` |
| 启动参数 | `--port=20553 serve` |
| 鉴权 | HTTP Basic：`WWW-Authenticate: Basic realm="Secure Area"`，用户名为 `codearts` |
| 口令来源 | 由码道扩展在启动内核时注入，**未落盘**（`server_config.properties` 只有 pid/port/version） |
| API 前缀 | 无统一前缀：`/session`、`/event`、`/global/*`、`/v1/*`、`/cag/*`、`/permission/*` |
| OpenAPI | `GET /doc` → OpenAPI 3.1.1，`title=opencode`、`version=0.0.3`、37 个路径 |
| 会话创建 | `POST /session` → 200，返回 `{id:"ses_...", slug, version, projectID, directory, title, time}` |
| 会话查询 | `GET /session/{id}` → 200 |
| 发送消息 | `POST /session/{id}/message` → 200（**不是 `/prompt`**，后者返回 500） |
| 事件流 | `GET /event?directory=<path>` → SSE，`server.connected` / `session.created` / `session.updated` 等 |
| 目录作用域 | 通过 `?directory=` 传递（`x-opencode-directory` 头同时保留兼容） |

---

## 2. 探测方法

1. **只读探测已运行实例**：从 `netstat` 定位 PID 59408 → 端口 20553；读取 `server_config.properties` 得到 pid/port/version；`wmic` 得到启动命令行。
2. **隔离沙盒实例**：用同一二进制在独立端口（20600–20602）+ 独立数据目录 + 自设 Basic Auth 启动，避免影响正在使用的码道实例。脚本见 `scripts/kernel-sandbox.mjs`、`scripts/kernel-contract.mjs`、`scripts/kernel-session-probe.mjs`。
3. **OpenAPI 导出**：`GET /doc` 保存为 `docs/kernel-openapi.json`，并生成 `docs/kernel-endpoints.md`。
4. **SSE 采样**：订阅 `/event` 后创建会话，采集事件帧并比对类型。

> 未对已运行实例做任何写操作；沙盒实例的会话写入独立临时目录，结束后进程被清理。

---

## 3. 端点契约

### 3.1 已实测可用（沙盒 200）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/session` | 创建会话；body 可带 `title`（实测 `{title:"qqbot-probe"}` 成功） |
| GET | `/session` | 会话列表（返回 `[]`） |
| GET | `/session/{id}` | 会话详情；不存在时 404 |
| POST | `/session/{id}/message` | 发送消息（body `{parts:[{type:"text",text:"..."}]}`） |
| GET | `/event?directory=` | SSE 事件流 |
| GET | `/global/health` | 健康检查（`{healthy:true}`） |
| GET | `/config` | 完整配置（`agent`、`provider` 等） |
| GET | `/v1/skill` | 技能列表（中文描述，来自用户/内置技能） |
| GET | `/cag/agent` | Agent 定义与工具集 |
| GET | `/cag/rules` | 规则列表 |
| GET | `/doc` | OpenAPI 3.1.1 |

### 3.2 OpenAPI 中的其他能力（37 路径节选）

| 路径 | operationId | 用途 |
|---|---|---|
| `POST /im/welink/start` | `digitalAvatar.start` | 官方"数字分身"接入：`appid`/`appsecret`/`ideType`/`pluginName`/`webserverPath` |
| `GET /im/welink/status/{ideType}` | `digitalAvatar.status` | 查询外部 IM 接入状态 |
| `POST /im/welink/stop` | `digitalAvatar.stop` | 停止外部 IM 接入 |
| `GET/PUT /permission/global` | `permission.global.*` | 全局工具权限 |
| `POST /permission/bash/mode` | `permission.bash.mode.set` | bash 权限模式 |
| `GET/POST/PUT/DELETE /v1/skills` | `skills.*` | 技能管理 |
| `PATCH /v1/skills/sync` | `skills.syncByNameList` | 技能同步 |
| `POST /comm/create` | `comm.create` | 通信/会话创建（候选入口） |

> `session` 路由**未出现在 OpenAPI**，但实际存在并可用；说明 OpenAPI 只覆盖部分路由，不能作为唯一契约来源。

---

## 4. 事件契约（SSE）

### 4.1 已采集的真实帧

    {"type":"server.connected","properties":{...}}
    {"type":"session.created","properties":{"sessionID":"ses_...","info":{...}}}
    {"type":"session.updated","properties":{"sessionID":"ses_...","info":{...}}}

### 4.2 事件命名与结构

- **点号命名**：`session.created`、`session.updated`、`session.idle`、`session.error`、`message.updated`、`message.part.updated`、`permission.asked`。
- **统一包装**：`{ type, properties }`，会话标识在 `properties.sessionID`。
- **消息分片**：`message.part.updated` 的 `properties.part` 携带 `type`（`text` / `tool`）、`messageID`、`callID`、`state.status`。

### 4.3 与统一事件模型的映射（已固化在 `normalize.ts` + 单测）

| 内核事件 | 统一事件 | 判定条件 |
|---|---|---|
| `message.updated`（role=user） | `turn/start` | 用户消息写入 |
| `message.part.updated`（part.type=text） | `text/delta` | 用 `messageID` 作 attemptId |
| `message.updated`（role=assistant 且 `time.completed`） | `message/complete` | 从 `info` 提取文本块 |
| `message.part.updated`（tool, status=running/pending） | `tool/call` | `callID` + `tool` |
| `message.part.updated`（tool, 其他 status） | `tool/result` | `status!=="error"` 为成功 |
| `session.idle` | `turn/end` | 本轮收敛 |
| `session.error` | `turn/end` + reason | 取 `error.name/message` |
| `permission.asked` | `permission/request` | 取 `properties.id` |
| `session.created` / `session.updated` | 忽略 | 仅会话元数据 |

---

## 5. 鉴权结论与影响

1. 已运行实例对全部端点返回 401，且**口令不在磁盘**，只存在于扩展进程内存中。
2. 沙盒实例证明：Basic Auth 由内核读取环境变量（`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`）控制，用户名为 `codearts`。
3. 因此插件**不能也不应**去"猜"或"读取"用户实例的口令。可行路径只有两条：

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A（推荐）** | 与码道扩展集成：扩展把自己持有的 `baseUrl + Basic Auth` 通过本机 IPC 交给 sidecar | 零额外进程，复用用户现有会话与凭据 | 需要扩展侧改造，且依赖内部实现 |
| **B** | 插件自启内核：自选端口 + 自设口令 + 独立或共享数据目录 | 完全自主、可版本化 | 多一份内核进程与内存；共享数据目录存在并发风险 |

> 当前代码采用方案 B 的形态（`KernelHttpOptions.basicAuth` 可注入），方案 A 只需替换连接参数来源，`KernelPort` 不变。

---

## 6. 与设计文档的差异（已修正）

| 设计初稿 | 实测契约 | 修正 |
|---|---|---|
| `POST /session/{id}/prompt` | `POST /session/{id}/message` | `DEFAULT_HTTP_PATHS.prompt` 已改 |
| `GET /api/info` | `GET /global/health` + `GET /config` | `info()` 已改 |
| 事件为 `turn/start`、`assistant/chunk` | 点号事件 + `properties` | `normalize.ts` 增加 `dotEvent` 分支 |
| `x-opencode-directory` 头 | `?directory=` 查询参数（头仍兼容） | 请求统一拼 query |
| Bearer token | Basic `codearts:<password>` | `HttpKernelOptions.basicAuth` |
| 端口靠探测 | `server_config.properties` 记录 pid/port | 可优先读取该文件 |

---

## 7. 限制与残余风险

| ID | 风险 | 说明 | 缓解 |
|---|---|---|---|
| K1 | 真实实例口令不可得 | 只能走扩展集成或自启内核 | 优先与内核/扩展团队确认方案 A |
| K2 | 沙盒无模型凭据 | `message` 已 200，但未观察到 assistant 事件 | 用真实账号跑一条 prompt 验证（会消耗额度，需授权） |
| K3 | 会话路由不在 OpenAPI | 升级可能变更 | 契约测试 + 能力探测 + 只读兼容模式 |
| K4 | 多实例共享数据目录 | SQLite 并发写风险 | 默认独立 data 目录；共享模式需压测 |
| K5 | 版本随 IDE 强升 | 二进制与扩展绑定 | 每次码道升级跑 `kernel-*` 探测脚本回归 |

---

## 8. 下一步验证清单

1. 用真实账号（授权后）跑一条 prompt，采集 `message.part.updated` / `message.updated` / `session.idle` 全序列，确认 `message/complete` 的文本块位置。
2. 确认 `permission.asked` 的真实字段与应答路径（`/permission/*` 或事件回写）。
3. 确认 `compact`、`model.set`、`cancel` 的真实路由（当前为推断路径）。
4. 与扩展团队确认方案 A 的 IPC 形态（端口 + 口令下发）。
5. 将本报告的事件样本固化进 `fixtures/`，作为内核升级回归基线。

---

## 附录：可复现命令

    node scripts/probe-kernel.mjs --port 20553 --dir "E:/ws/codearts-qqbots"
    node scripts/kernel-sandbox.mjs --port 20600
    node scripts/kernel-contract.mjs
    node scripts/kernel-session-probe.mjs

> 沙盒脚本会自行清理进程；不会写入用户真实数据目录。