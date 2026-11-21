# 码道（CodeArts Agent）QQ Bot 插件可行性与技术方案评估报告

| 项目 | 内容 |
|---|---|
| 文档类型 | 方案评审（Solution Review）＋ 技术方案（HLD 级） |
| 评估对象 | 为华为云码道 CodeArts Agent 开发一个与 `tencent-connect/dsh-qqbot` 等价的 QQ Bot 插件 |
| 评估基准 | 本机 `D:\apps\CodeArts Agent`（v26.11.100，VS Code 1.109.5 底座）静态分析 ＋ `github.com/tencent-connect/dsh-qqbot`（v0.5.5）源码分析 ＋ OpenCode 插件/服务端公开契约 |
| 结论 | **有条件可行。功能对齐度可达 80%~90%，但不能 1:1 照搬。推荐"VS Code 扩展做容器 + 独立 sidecar 做运行时 + 内核适配层隔离"的组合形态，而非 dsh 的 Cordis 进程内插件形态。** |
| 置信度 | 架构判断：高（有安装包与运行时目录直接证据）；内核契约判断：中（闭源二进制＋压缩 bundle 推断，需官方确认） |

---

## 1. 执行摘要

### 1.1 一句话结论

码道的 AI 内核是一个以 **OpenCode 为血脉、华为定制化改造**的本地 Agent Kernel（独立可执行文件 `agentkernelServer-*.exe`），插件模型沿用 `@opencode-ai/plugin`，会话与事件通过本地 HTTP/SSE 客户端驱动。因此"QQ 消息 → 码道 Agent → QQ 回复"这条链路在技术上完全成立，**dsh-qqbot 的传输层、会话路由、限流、切分、媒体处理等 60%+ 代码可以复用或平移**；真正的成本不在"接 QQ"，而在**跨越闭源内核的契约不稳定性和官方分发/审核门槛**。

### 1.2 三条关键判断

1. **dsh-qqbot 不是"外挂"，是"宿主内插件"。** 它的入口是 `apply(ctx, config)`，通过 `inject = ['agents']` 拿到宿主的 Agent 注册表，直接 `agent.followup(message)` 灌入消息、监听 `ctx.on('session/event')` 收流。这种能力**只有在内核进程内才拿得到**。码道的等价能力是 OpenCode 的 `Plugin` 钩子，但该 SDK 是内部版本（`@cloud/agentkernel-plugin-sdk@126.11.1-*`），**不属于公开稳定 API**。
2. **码道已经具备"IM 接入"的产品化先例。** 产品配置中存在 `imPlatformGuideUrls`：钉钉 / 飞书 / 企业微信 / Slack / Lark，说明"码道 Space 侧接 IM"是既有能力，**QQ 是渠道缺口而不是能力缺口**。这既降低了产品风险，也意味着可能应该优先"在 Space 侧加 QQ 通道"，而不是"在桌面端做插件"。
3. **推荐的落地形态是"扩展容器 + sidecar 运行时"。** 用 VS Code 扩展（码道插件市场可分发）承担安装、配置、扫码绑定、托盘守护与 UI；用独立 Node sidecar 承担 QQ 长连接与会话编排；用一层 `KernelPort` 适配层隔离内核 API 变更。这样既拿到了 dsh-qqbot 的工程红利，又避免把 QQ 长连接塞进 IDE 扩展宿主造成稳定性连带风险。

### 1.3 决策建议

| 选项 | 建议 |
|---|---|
| 直接 fork dsh-qqbot 改依赖 | **不推荐**。Cordis 插件模型与 OpenCode 插件模型不同构，改造量接近重写。 |
| 只在 Space 云端加 QQ 渠道 | **推荐作为并行主线**。零客户端分发成本，覆盖企业群场景，与现有钉钉/飞书能力复用。 |
| 桌面端插件（本案） | **推荐作为差异化主线**。可访问本地工作区、本地工具链、本地模型凭证，是"手机远程指挥本地 IDE"的独特价值。 |
| 先做 PoC 再投人 | **必须**。P0 只验证 3 件事：能否稳定创建/恢复 session、能否拿到 assistant 增量、能否把工具审批回传到 QQ。 |

---

## 2. 码道 CodeArts Agent 目录结构与技术架构

### 2.1 安装目录结构（实测）

    D:\apps\CodeArts Agent\
    ├─ codearts-agent.exe                 Electron 主程序
    ├─ bin\
    │   ├─ codearts-agent                shell 启动器
    │   └─ codearts-agent.cmd            ELECTRON_RUN_AS_NODE=1 跑 out\cli.js（VS Code CLI）
    ├─ resources\
    │   ├─ app\
    │   │   ├─ package.json              name=codearts-agent, version=26.11.100, main=./out/main.js
    │   │   ├─ product.json              品牌/服务端点/市场/扩展白名单/API proposal 授权
    │   │   ├─ out\                      main.js、cli.js、bootstrap-fork.js、vs\（Workbench 产物）
    │   │   ├─ extensions\               107 个内置扩展（VS Code 自带 + 华为内置）
    │   │   │   ├─ vscode-codebot\        ★ 码道 AI 主体扩展（displayName=CodeArts Agent）
    │   │   │   │   ├─ out\extension.js   单文件 bundle（约 4.2k 行超长行）
    │   │   │   │   ├─ agentkernelServer-win32-x64.exe  ★ 本地 Agent 内核
    │   │   │   │   ├─ dist\              Vue3 WebView（index.html + assets）
    │   │   │   │   ├─ skills\            33 个技能包（doc-expert、prd、pptx…）
    │   │   │   │   ├─ src\agents\example 子代理样例（dependency.json / example.gpt.json）
    │   │   │   │   └─ manifest.xml       CodeMate-WebView 子仓（repo 管理）
    │   │   │   ├─ huaweicloud.authentication\  华为云登录 / 凭据
    │   │   │   ├─ huaweicloud.codearts-agent-support\  埋点、满意度、消息通道
    │   │   │   ├─ huaweicloud.codearts-snap\  同 codearts-snap
    │   │   │   ├─ codearts-pay\          计费/额度
    │   │   │   └─ theme-*\languagepacks（品牌主题、中文语言包）
    │   │   ├─ profile\ai-HC.code-profile  首发 profile（配色、布局）
    │   │   ├─ node_modules.asar(.unpacked) 运行时依赖
    │   │   └─ ThirdPartyNotices.txt / LICENSE.txt
    │   ├─ win32\  workbenchModes\         平台资源
    └─ tools\  inno_updater.exe（Squirrel/Inno 增量升级器）

### 2.2 架构分层

    ┌──────────────────────────────────────────────────────────────┐
    │ 表现层  Electron 39.3.0 + VS Code 1.109.5 Workbench          │
    │  - out/main.js、out/vs/workbench（编辑器/终端/SCM/Debug）      │
    │  - 码道侧栏 WebView（Vue3 + importmap，dist/index.html）       │
    ├──────────────────────────────────────────────────────────────┤
    │ 扩展宿主  VS Code Extension Host（Node.js 独立进程）          │
    │  - 扩展 API：VS Code 兼容 + 码道私有能力                       │
    │  - product.json 的 enabledApiProposals 控制私有 API 授权        │
    │    （codearts-snap 已获批 chatParticipantPrivate / chatEditing）│
    ├──────────────────────────────────────────────────────────────┤
    │ AI 编排层  extensions\vscode-codebot（codearts-snap）          │
    │  - Agent/Command/Rule/Skill/SubAgent 资产管理                  │
    │  - KernelManage：拷贝、拉起、连接、日志、升级 agentkernelServer │
    │  - 客户端 SDK（代码内置）访问 /session、/cag/*、/v1/skill      │
    ├──────────────────────────────────────────────────────────────┤
    │ Agent 内核  agentkernelServer-<ver>.exe（每用户一份，独立进程） │
    │  - OpenCode 衍生：Session / Agent Loop / Tool / Permission     │
    │  - 配置目录：~/.codeartsdoer（商用）或 ~/.config/opencode（内部）│
    │  - 插件：@opencode-ai/plugin@126.11.1-2026xxxx（内部版本号）   │
    ├──────────────────────────────────────────────────────────────┤
    │ 模型/云服务  华为云 CodeArts 网关（inferhub-provider 等）       │
    │  - GLM-5.1 / GLM-4.7 / deepseek-v3.2 等（kernel.jsonc 声明）   │
    │  - 鉴权：huaweicloud.authentication；计费：codearts-pay        │
    │  - 遥测：OpenTelemetry（experimental.openTelemetry=true）      │
    └──────────────────────────────────────────────────────────────┘

### 2.3 关键证据链

| # | 观察点 | 证据位置 | 推论 |
|---|---|---|---|
| E1 | `"vscodeVersion": "1.109.5"`、`"target": "system"`、`electron: 39.3.0` | `resources\app\product.json`、`package.json` | 标准 VS Code 桌面发行版，扩展生态可直接复用 |
| E2 | `main: ./out/main.js`、`out\vs\workbench\workbench.desktop.main.js` 校验和 | `resources\app\package.json`、`product.json.checksums` | 未改造 Workbench 核心，改造集中在扩展层 |
| E3 | `extensions\vscode-codebot\agentkernelServer-win32-x64.exe` | 目录 | AI 能力由**独立二进制进程**提供，非纯 JS |
| E4 | `getKernelConfigDir()` 返回 `.config/opencode` / `.codeartsdoer` | `out\extension.js`（约 3638 行） | 内核是 OpenCode 分支 |
| E5 | `~/.codeartsdoer/package.json` 依赖 `@opencode-ai/plugin: 126.11.1-20261110192452` | 本机运行时目录 | 插件系统 = OpenCode 插件系统，版本被华为重编号 |
| E6 | `@cloud/agentkernel-plugin-sdk` 导出 `./client`、`./server`、`./agent-server`、`./v2` | `out\extension.js`（约 2838 行内嵌 manifest） | 存在插件/客户端/服务端三段式 SDK，但为内部包 |
| E7 | 客户端调用 `/v1/skill`、`/v1/skills`、`/cag/agent`、`/cag/rules`、`/cag/extension/list`，统一带 `x-opencode-directory` 头 | `out\extension.js`（约 2830 行） | 内核以 HTTP + 目录作用域对外提供 API |
| E8 | `startDigitalAvatar({ ideType, appid, appsecret, pluginName, webserverPath })` | `out\extension.js`（约 3309 行） | 已存在"外部 IM 数字分身"接入形态（appid/appsecret 语义与 IM 机器人一致） |
| E9 | `AgentKernel_${PLUGIN_VERSION}_${KERNEL_VERSION}` 资产目录、`KernelManage` 拷贝/拉起/连接/日志 | `out\extension.js`（约 3890 行） | 内核随扩展版本捆绑、自升级、有独立日志目录 |
| E10 | `product.json.userGuide.imPlatformGuideUrls` 含 dingtalk / feishu / wecom / slack / lark | `product.json` | **IM 接入是既有产品能力，缺 QQ 渠道** |
| E11 | `~/.codeartsdoer/{agents,skills,rule,extensions,agent-team,evolve,memory,kernel.jsonc}` | 本机运行时目录 | 用户级扩展面：子代理、技能、规则、扩展、记忆 |
| E12 | `kernel.jsonc` 声明 `provider.inferhub-provider`、`experimental.openTelemetry` | 本机运行时目录 | 模型路由与遥测由内核配置驱动，可被插件读取 |

### 2.4 与 dsh（DeepSeek Harness）的架构对照

| 维度 | dsh | 码道 CodeArts Agent | 对齐度 |
|---|---|---|---|
| 宿主形态 | Node 进程（Desktop/CLI/Web） | Electron + VS Code 扩展宿主 + 独立 kernel 二进制 | 中 |
| 插件模型 | Cordis 插件：`export const inject`、`export function apply(ctx, config)` | OpenCode 插件：`export const Plugin: Plugin = async ({ client, $, directory }) => ({ tool, event, "chat.message" })` | 中（理念同构，API 不同） |
| 会话事件 | `ctx.on('session/event')`，事件类型 `turn/start`、`assistant/chunk`、`tool/call`、`turn/end` | `client.event.subscribe()`（SSE）或 SDK v2 事件流；类型名不同 | **低（必须重写事件归一化）** |
| 消息投递 | `agent.followup(userMessage)` | `POST /session/{id}/prompt`（durably admit） | 中 |
| 流式增量 | `agent/assistant-stream` 瞬态帧 | 事件流中的 part delta | 中 |
| 工具审批 | `approval/request` + 按钮 | Permission 请求（OpenCode permission） | 中 |
| 配置 | `cordis.yml` / `cordis.patch.yml`，热更新 | `kernel.jsonc` / 扩展配置，内核随 IDE 升级 | 低 |
| 插件分发 | npm + `dsh plugin add` + Desktop「插件」页 | VS Code VSIX（码道市场/OpenVSX/离线）+ 内核插件目录 | 中 |
| UI 扩展位 | `dsh.client` Web Bundle（侧栏 Tab、设置页） | VS Code views/webview + 私有 API proposal | 中 |

> 结论：**"照抄一份"不成立，"移植一层"成立。** 可平移的是传输、会话映射、切分、限流、媒体、命令；必须重写的是事件契约、会话创建/恢复、插件生命周期、UI 宿主绑定。

---

## 3. dsh-qqbot 源码拆解（可复用资产盘点）

### 3.1 工程形态

- npm 包 `@tencent-connect/dsh-qqbot@0.5.5`，ESM，`main: ./lib/index.js`，`dsh.bundle.patch: ./cordis.patch.yml`，`dsh.client.platform: web`。
- peerDependencies 直接声明宿主内核：`@deepseek-ai/cordis`、`dsh-agent`、`dsh-session`、`dsh-llm`、`dsh-user-approval`、`schemastery`。**这意味着它与宿主是"同一依赖树"关系，不是 RPC 关系。**
- 运行依赖：`@tencent-connect/qqbot-connector`（QQ 官方 WS 连接器）、`@tencent-connect/qqbot-nodejs`（中间件链）、`qrcode`、`yaml`。

### 3.2 核心模块与职责

    src/
    ├─ index.ts               插件入口：name=im-qqbot, inject=['agents'], Config=Schema
    │                         apply() 内：凭据缺失→异步扫码（不阻塞 boot）；已绑定→注册路由+启动网关
    ├─ config.ts              Schema 配置（appId/appSecret/provider/model/cwd/requireMention/...
    │                          access / proactiveDelivery / media / vision / sendFile）
    ├─ setup/                 扫码绑定状态机、端内绑定页路由、二维码 SVG、凭据写回 patch.yml（触发 HMR）
    ├─ client/                浏览器半边（侧栏 Tab、绑定页轮询）
    ├─ gateway/               bootstrap（监听 session/event）、middleware 链装配
    ├─ transport/
    │   ├─ inbound.ts         QQ 消息 → 5 层上下文组装 → agent.followup()
    │   ├─ outbound.ts        session/event → 路由 → QQ sendMarkdown（turn 归属、工具展示、交付文件）
    │   ├─ outbound-buffer.ts 流式缓冲（全量替换语义）
    │   ├─ chunker.ts         Markdown 感知切分（代码块/表格不劈裂）
    │   ├─ msgid-cache / reply-limiter  被动回复 msgid 复用与频控
    │   └─ tool-presenter.ts  工具调用结果结构化展示
    ├─ session/               peer → Agent 映射、singleflight、idle evict、fork 换模型、compact
    ├─ model/                 provider/model 路由、per-peer 偏好持久化
    ├─ features/              ask_user_question 按钮通道、approval 审批通道、答案解析
    ├─ media/                 图片理解、发文件、TTL 清理
    └─ commands/              /new /compact /model /preset /stop /bot-ping /bot-version ...

### 3.3 三个必须学的设计（与内核解耦无关，属通用工程经验）

1. **入站五层组装**（`inbound.ts`）：用户文本 → 引用消息 → 发送者标签 → 媒体元数据 → 群历史。好处是"群聊上下文"与"单聊"共用一条可测试的纯函数管线，任何一层可单测，不依赖 QQ SDK。
2. **出站回合归属**（`outbound.ts` + `TurnTracker`）：用 `turn/start` 建立、`turn/end` 收敛、`user/message` 认领归属，避免"多用户并发时把 A 的回复发给 B"。流式帧用 `attemptId` 校验丢弃迟到帧。**这是 IM 场景最容易翻车的地方，值得整段移植。**
3. **会话映射与恢复优先级**（`session-manager.ts`）：`进程内复用 → 持久化恢复 → 全新创建`，sessionKey 为 `qqbot:${appId}:${scope}:${peerId}`；resume 失败时**只有确认会话确实不在盘上才允许新建**（防止同一 sessionId 写入多个 project 导致会话列表整体损坏）。这条"fail-loud"经验在码道上同样适用。

---

## 4. 可行性评估

### 4.1 能力对齐矩阵

| 能力 | dsh-qqbot 实现 | 码道可用手段 | 可行性 | 备注 |
|---|---|---|---|---|
| QQ 私聊/群聊接入 | `qqbot-connector` WS 长连接 | 同一官方连接器（与宿主无关） | ✅ 高 | 不需要公网 IP/回调 |
| 消息 → Agent | `agent.followup()` | `POST /session/{id}/prompt` 或 SDK `session.prompt` | ✅ 高 | 需 sessionId 生命周期管理 |
| Agent → QQ 回复 | `ctx.on('session/event')` | 事件流订阅（SSE/WS） | ⚠️ 中 | **事件类型名不同，必须写归一化层** |
| 流式输出 | `agent/assistant-stream` | 事件流 part delta | ⚠️ 中 | 需验证 daemon 是否对插件暴露全量 delta |
| 工具调用展示 | `tool/call`、`tool/result` | 事件流 tool part | ✅ 中高 | 结构不同，展示层需重写 |
| 提问/审批回流 | `ask_user_question`、`approval/request` | Permission 请求 + `session.command` | ⚠️ 中 | 需验证 QQ 侧按钮 → 内核批准的回传路径 |
| 会话隔离 | 每 peer 一个 Agent | 每 peer 一个 session（cwd 隔离） | ✅ 高 | 码道侧 session 是一等公民 |
| 模型切换 | `fork + 重建` | `POST /session/{id}/model` | ✅ 高 | 码道原生支持，比 dsh 更简单 |
| 会话压缩 | `compaction` 服务 | `POST /session/{id}/compact` | ✅ 高 | 直接调用 |
| 技能/预设 | `agent-presets` | `skills/` + `agents/` + `rules/` | ✅ 高 | 码道资产更丰富 |
| 图片理解 | 内置 vision provider | 多模态模型 + 本地文件路径注入 | ✅ 中高 | 需选定多模态 provider |
| 文件回传 | `deliverables/presented` + 路径白名单 | 事件 deliverables / 自建工具 | ⚠️ 中 | 需确认内核是否有等价事件 |
| 扫码绑定 | dsh 绑定页 + 二维码 | 自建 VS Code WebView 绑定页 | ✅ 高 | UI 宿主换为 VS Code |
| 访问控制 | open/allowlist/disabled + 配对码 | 同构自研（与内核无关） | ✅ 高 | 直接移植语义 |
| 主动推送 | `proactiveDelivery` | 同构自研（定时任务 → session） | ✅ 中高 | 依赖内核可被定时器触发 |
| 插件市场分发 | npm + dsh 插件页 | VSIX（码道市场 / OpenVSX / 离线） | ⚠️ 中 | 需过审；内核插件无公开商店 |
| 内核内钩子（tool 拦截） | Cordis 中间件 | `@opencode-ai/plugin` 钩子 | ⚠️ 低中 | SDK 为内部版本 |

**结论：核心链路（QQ ↔ 会话 ↔ 模型）可行性高；边缘能力（审批回传、交付文件、内核钩子）需要 PoC 逐项验证。**

### 4.2 三个结构性差距

1. **契约稳定性差距**：dsh-qqbot 的 peerDependencies 是语义化版本可锁定的公开包；码道内核是随 IDE 发版的二进制，事件/端点无公开版本承诺。**这决定了必须做适配层 + 版本探测 + 回归矩阵，而不是直接调 API。**
2. **分发合法性差距**：dsh 有官方插件页与 `dsh plugin add`；码道只有 VS Code 扩展市场，**内核插件目录（`~/.codeartsdoer/extensions`）没有公开的上架与审核流程**。若走内核插件，等于依赖未公开面，企业客户难以接受。
3. **产品定位差距**：码道 Space 已支持钉钉/飞书/企微/Slack/Lark，QQ 更偏 C 端/开发者社区。**桌面端插件是"个人开发者远程指挥本地 IDE"，Space 渠道是"企业群协作"，两者不是替代关系。**

---

## 5. 技术方案

### 5.1 总体架构（推荐形态）

    QQ 用户
      │  私聊 / 群聊 @bot
      ▼
    QQ 开放平台 WebSocket（qqbot-connector，官方长连接，无需公网回调）
      │
      ▼
    ┌───────────────────────── 码道 QQ Bot 运行时（Node sidecar）─────────────────────────┐
    │  transport/inbound   消息归一化、引用解析、媒体下载、5 层上下文组装                    │
    │  session/registry    peer → kernelSessionId 映射、singleflight、idle evict、持久化    │
    │  kernel/KernelPort   ★ 唯一与码道内核耦合的边界（HTTP/SSE 客户端 + 事件归一化）        │
    │  transport/outbound  回合归属、流式缓冲、Markdown 切分、频控、幂等                     │
    │  features            question 通道、approval 通道、命令、白名单、配对码               │
    │  media               vision、sendFile（路径白名单）、TTL 清理                         │
    │  security            凭据（DPAPI/keytar）、脱敏日志、策略引擎                          │
    │  ops                 健康检查、指标、诊断包、日志滚动                                  │
    └───────────────────────────────────┬─────────────────────────────────────────────────┘
                                        │ 本地回环 HTTP/SSE（仅 127.0.0.1，带 token）
                                        ▼
    ┌──────────────────── 码道 Agent Kernel（agentkernelServer.exe）────────────────────┐
    │  Session / Agent Loop / Tools / Permission / Skills / SubAgents / Rules            │
    │  模型：华为云 CodeArts 网关（GLM-5.1 / deepseek-v3.2 …）                             │
    └───────────────────────────────────┬─────────────────────────────────────────────────┘
                                        │ 由扩展暴露的桥接面（推荐）
                                        ▼
    ┌──────────────── 码道 VS Code 扩展（qqbot-container，VSIX 分发）──────────────────┐
    │  生命周期：检测 IDE/内核 → 拉起 sidecar → 守护/重启 → 卸载清理                       │
    │  UI：侧栏「QQ 机器人」Tab（状态、绑定、白名单、日志、诊断）                            │
    │  桥：把 sidecar 请求转发到内核客户端（复用扩展内已有的 client 与鉴权上下文）           │
    └────────────────────────────────────────────────────────────────────────────────────┘

**为什么不是纯内核插件（形态 A）？**
内核插件能拿到 tool 钩子与进程内事件，最接近 dsh-qqbot，但：SDK 为内部版本、随 IDE 强制升级、崩溃直接污染内核、无法独立灰度。**建议把它作为 P2 的"增强适配器"，而不是 P0 的主路径。**

### 5.2 三种落地形态对比

| 维度 | A. 内核插件（OpenCode Plugin） | B. 独立 sidecar（进程外） | C. VS Code 扩展内嵌 |
|---|---|---|---|
| 与 dsh-qqbot 相似度 | 最高 | 中高（传输层直接复用） | 中 |
| 契约稳定性 | 低（内部 SDK） | 中（取决于桥接面） | 中高（VS Code API 稳定） |
| 独立发版/灰度 | 否（随 IDE） | 是 | 是（VSIX 版本） |
| 故障隔离 | 差（拖垮内核） | 好 | 中（扩展宿主独立进程） |
| UI 能力 | 无（需另做 client bundle） | 无（需扩展配合） | 强（views/webview/命令/配置） |
| 安装门槛 | 高（需改内核配置） | 中 | 低（市场一键装） |
| 企业可接受度 | 低 | 中高 | 高 |
| 建议 | P2 增强 | **P0/P1 主运行时** | **P0/P1 主容器** |

**推荐组合：C（容器）＋ B（运行时）＋ A（可选增强）。**

### 5.3 模块划分（按 dsh-qqbot 目录平移）

    packages/
    ├─ qqbot-core/                 与宿主无关，可直接从 dsh-qqbot 移植
    │   ├─ transport/inbound.ts    5 层上下文组装（纯函数，去掉 dsh 类型）
    │   ├─ transport/chunker.ts    Markdown 感知切分
    │   ├─ transport/reply-limiter.ts
    │   ├─ features/access.ts      open/allowlist/disabled + 配对码 + revision 乐观锁
    │   ├─ features/question.ts    单选按钮 → 编号回复 → 逐题推进 → 题级超时
    │   └─ shared/                 脱敏、错误文案、时间/大小格式化
    ├─ qqbot-kernel-port/          ★ 唯一耦合层
    │   ├─ port.ts                 接口：createSession / resume / prompt / events / compact / setModel / permission
    │   ├─ http-port.ts            HTTP + SSE 实现（首选）
    │   ├─ plugin-port.ts          OpenCode Plugin 实现（P2）
    │   ├─ normalize.ts            内核事件 → 内部统一事件（turn/message/tool/permission/deliverable）
    │   └─ compat.ts               版本探测、能力位（capability flags）、降级策略
    ├─ qqbot-runtime/              sidecar 主程序
    │   ├─ gateway/bootstrap.ts    装配、健康检查、优雅退出
    │   ├─ session/registry.ts     peer 映射、singleflight、idle evict、持久化
    │   ├─ transport/outbound.ts   回合归属、流式缓冲、交付文件
    │   ├─ security/credentials.ts DPAPI/keytar
    │   └─ ops/                    日志、指标、诊断包
    └─ vscode-extension/           VSIX 容器
        ├─ extension.ts            激活、守护 sidecar、命令、状态栏
        ├─ views/bind-page.ts      扫码绑定 + 状态轮询
        └─ bridge/                 sidecar ↔ 内核客户端转发

### 5.4 关键接口设计

**（1）内部统一事件模型**（隔离内核差异的核心）

    type KernelEvent =
      | { type: "turn/start"; sessionId: string; turn: number }
      | { type: "text/delta"; sessionId: string; turn: number; attemptId: string; text: string }
      | { type: "message/complete"; sessionId: string; turn: number; blocks: Block[] }
      | { type: "tool/call"; sessionId: string; callId: string; name: string; args: unknown }
      | { type: "tool/result"; sessionId: string; callId: string; ok: boolean; summary?: string }
      | { type: "permission/request"; sessionId: string; requestId: string; action: string; detail: string }
      | { type: "deliverable"; sessionId: string; files: PresentedFile[] }
      | { type: "turn/end"; sessionId: string; turn: number; reason?: TurnError };

**（2）KernelPort 契约**

    interface KernelPort {
      info(): Promise<{ version: string; capabilities: Set<Capability> }>;
      createSession(input: { cwd: string; agent?: string; title?: string }): Promise<{ id: string }>;
      resumeSession(id: string): Promise<{ id: string } | undefined>;
      sessionExists(id: string): Promise<boolean | undefined>;
      prompt(id: string, parts: PromptPart[]): Promise<void>;
      subscribe(handler: (e: KernelEvent) => void): () => void;
      compact(id: string): Promise<void>;
      setModel(id: string, provider: string, model: string): Promise<void>;
      respondPermission(id: string, requestId: string, decision: "allow" | "deny"): Promise<void>;
      disposeSession(id: string): Promise<void>;
    }

> 设计要点：**上层只依赖 `KernelPort`**。内核换 API、换版本、甚至换回 dsh，只改 `http-port.ts` 与 `normalize.ts`。

**（3）会话键与映射**

    sessionKey = `qqbot:${appId}:${scope}:${peerId}`          // scope = c2c | group
    prefs.json = {
      version: 1,
      peers: {
        "<sessionKey>": {
          kernelSessionId: "<uuid>",
          createdAt, lastActiveAt,
          agent, provider, model,
          preset
        }
      }
    }

恢复策略与 dsh-qqbot 一致：`进程内 → prefs 恢复 → 新建`；**重建前必须 `sessionExists()` 求证**；`sessionExists` 不可用时记录告警并按"存在"处理（fail-loud）。

**（4）配置模型**（对齐 dsh-qqbot，去掉宿主专属项）

    {
      "appId": "",                       // 或环境变量 QQBOT_APPID
      "appSecretRef": "dpapi:qqbot/app-secret",
      "workspace": "${workspaceFolder}",
      "agent": "standard",
      "provider": "", "model": "",
      "requireMention": true,
      "textChunkLimit": 4500,
      "streaming": true,
      "sessionIdleTimeoutMs": 1800000,
      "processingTimeoutMs": 1800000,
      "maxQueue": 20,
      "historyLimit": 10,
      "askTimeoutMs": 300000,
      "showToolResults": false,
      "access": {
        "c2cMode": "open", "c2cAllow": [],
        "groupMode": "open", "groupAllow": [],
        "commandMode": "open", "revision": 0
      },
      "proactiveDelivery": { "externalTurns": "c2c" },
      "media": { "enabled": true, "maxMB": 200, "ttlHours": 24 },
      "sendFile": { "restrictPaths": true, "extraRoots": [] },
      "debug": false
    }

**（5）绑定流程（3 步内完成）**

    安装 VSIX → 侧栏「QQ 机器人」→ 扫码 / 粘贴 AppID+Secret
      → 凭据写入 DPAPI → sidecar 热加载 → 状态灯变绿 → 私聊发 "hi" 验收

---

## 6. 五维专项设计

### 6.1 开发与使用便利性（Developer Experience）

| 措施 | 说明 |
|---|---|
| 一条命令本地起服 | `pnpm dev:sidecar` 起 mock 内核（fixtures 回放事件），无需登录码道即可开发传输层 |
| 契约快照测试 | 把真实内核事件流录制为 `fixtures/*.jsonl`，CI 回放校验 `normalize.ts` 输出，内核升级即报警 |
| 端口适配层 | 新内核版本只改一个文件；提供 `KernelPort` 的 3 个实现（http/plugin/mock） |
| 调试开关 | `debug=true` 输出结构化日志（含 sessionKey、turn、callId），日志按天滚动，一键导出诊断包（脱敏） |
| 独立发版 | sidecar 与 VSIX 版本解耦；VSIX 只做容器，小步快跑 |

### 6.2 易用性（End-User UX）

| 措施 | 说明 |
|---|---|
| 零命令行 | 扫码绑定 + 状态灯 + 一键重启，对齐 dsh-qqbot 桌面版体验 |
| 人话错误 | 内核不可用 → "码道内核未启动，点此重启"；额度不足 → 展示计费入口；超时 → 可重试按钮 |
| 内置命令 | `/new` `/compact` `/model` `/stop` `/bot-status` `/bot-help` `/bot-ping`（语义直接沿用） |
| 群聊默认静默 | `requireMention=true`，避免刷屏；群历史仅在被 @ 时注入，且限制条数 |
| 渐进披露 | 高级配置（白名单、路径根、媒体上限）折叠在"高级"里，默认值即可用 |

### 6.3 可维护性（Maintainability）

| 措施 | 说明 |
|---|---|
| 三层解耦 | `qqbot-core`（纯逻辑，无宿主依赖）/ `kernel-port`（唯一耦合）/ `runtime+extension`（装配） |
| 兼容性矩阵 | 每次码道发版跑"内核冒烟矩阵"：create→prompt→stream→tool→permission→compact→resume，输出兼容性报告 |
| 能力位而非版本号 | `capabilities: { streaming, permission, deliverable, compact }`，缺失即降级，不硬编码版本判断 |
| 错误码表 | 统一 `QqbotError(code, userMessage, retryable)`，禁止把内核原始错误直出给用户 |
| 可观测性 | 每 turn 一条结构化日志 + 指标（首字延迟、轮次时长、发送成功率、重连次数） |

### 6.4 安全性（Security）

| 风险面 | 措施 |
|---|---|
| 凭据泄露 | AppSecret 存 Windows DPAPI / macOS Keychain（keytar）；配置文件只存引用；日志脱敏（复用 `fast-redact` 思路） |
| 任意人触发本地 Agent | 默认 `access.mode=open` 仅限私聊；**群聊与命令默认 allowlist**；配对码一次性、可撤销、撤销后旧码失效 |
| 远程代码执行 | 默认 `workspace-write` 权限；危险工具（shell/网络）走审批；复用码道沙箱（`@anthropic-ai/sandbox-runtime` 已在发行版依赖中） |
| 文件外泄 | `sendFile.restrictPaths=true`，仅允许 media 目录 + workspace + 显式 extraRoots；发送前 realpath 校验，防符号链接穿越 |
| 供应链 | 依赖精确锁版本、SBOM、VSIX 签名、sidecar 二进制签名校验；禁止运行时 `npm install` |
| 越权访问内核 | sidecar ↔ kernel 仅 127.0.0.1，短时 token + Origin/Host 校验；token 每会话轮换 |
| 合规 | 首次使用明示"代码片段将发送至 QQ 与云端模型"；企业策略可强制 `disabled` 或私有化网关 |

### 6.5 稳定性（Stability）

| 场景 | 策略 |
|---|---|
| WS 断线 | 指数退避重连（1s→2s→4s…封顶 60s）+ 抖动；重连后复位会话状态，不重放未确认消息 |
| 内核崩溃/升级 | 看门狗探测 `/api/info` 健康；连续失败进入熔断，UI 提示；恢复后**自动 resume** 会话 |
| 消息洪峰 | 每 peer 串行队列（`maxQueue`），超限回"排队中"；全局并发上限 |
| 流式乱序/迟到 | `attemptId` 校验，版本号单调递增，迟到帧丢弃（沿用 dsh-qqbot 经验） |
| 重复投递 | `messageId` 幂等表（TTL 24h）；工具结果按 `callId` 去重 |
| 长会话内存 | 闲置回收（默认 30min）+ `WeakMap` 持有 prompt 句柄 + 回收时清理待答问题/待审批 |
| 发送失败 | 分块重试（最多 3 次）+ 失败聚合提示；避免"部分送达"造成的语义断裂 |
| 优雅退出 | SIGTERM 时停止接新消息、等待在途 turn 收敛、落盘 prefs、释放 session |
| 单实例 | 同 appId 多开用文件锁/互斥量拒绝，防止 QQ 侧消息被两个进程争抢 |

---

## 7. 实施路线图（按验收标准推进，不做时间承诺）

### P0 — 可行性验证（PoC，必须先做）

范围：单聊文本、单会话、无 UI（配置文件手填 AppID/Secret）。

| 验收项 | 通过标准 |
|---|---|
| 内核连接 | sidecar 能探测到内核并拿到版本/能力位 |
| 会话 | create → prompt → 收到完整回复 → resume 后历史仍在 |
| 流式 | 能收到增量并合并为一条 QQ 消息（或明确判定不可用，降级整段） |
| 故障 | 杀掉内核后 sidecar 不崩溃，恢复后能继续对话 |
| 结论 | 产出《内核契约验证报告》，明确事件名、字段、权限语义 |

**决策门：P0 不通过（尤其是拿不到 assistant 增量或无法创建独立 session），则转向"Space 侧 QQ 渠道"方案。**

### P1 — 可用版本

范围：私聊 + 群聊 @、白名单、配对码、Markdown 切分、扫码绑定、VSIX 容器、状态与日志、`/new` `/compact` `/model` `/stop`。

验收：连续 24h 压测无进程崩溃；断网 10 次可自愈；群聊非 @ 不响应；越权用户被拒且有审计日志。

### P2 — 生产增强

范围：工具调用展示、审批按钮、文件回传、图片理解、主动推送、多实例互斥、诊断包、兼容性矩阵自动化、内核插件增强（tool 钩子）。

验收：与 dsh-qqbot 0.5.5 的功能对照表覆盖 ≥90%；内核升级回归全绿；安全评审通过。

---

## 8. 风险与收益

### 8.1 风险清单（按可控性排序）

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 内核事件/端点契约非公开，升级即破坏 | 高 | 高 | `KernelPort` 适配层 + 能力位 + 契约快照 + 版本矩阵；与内核团队建立变更通知 |
| R2 | 官方不背书/市场审核不通过 | 中高 | 高 | 先内部/开源 VSIX 侧载；同步走官方合作；避免依赖私有 API proposal |
| R3 | 计费与额度：QQ 触发消耗码道 Credits | 高 | 中高 | 配额提示、单用户日限、超限转人工；复用 `codearts-pay` 展示入口 |
| R4 | 安全：陌生人远程驱动本地 Agent | 中 | 极高 | 默认私聊 open + 群聊 allowlist；危险操作审批；沙箱；审计日志 |
| R5 | 合规：代码/文件出域到 QQ 与云端 | 中 | 高 | 首次授权确认；企业策略开关；敏感路径排除（.env、密钥文件） |
| R6 | QQ 平台政策：机器人审核、频控、被动回复窗口 | 中 | 中 | 使用官方 SDK 的被动回复 msgid 机制；限流；不群发 |
| R7 | 多实例/多窗口争抢同一机器人 | 中 | 中 | appId 级文件锁 + 单实例守护 |
| R8 | 长连接与 IDE 生命周期耦合 | 中 | 中 | sidecar 独立于 IDE 窗口；IDE 关闭时可选"驻留模式"或明确退出 |
| R9 | 代码规模膨胀导致维护困难 | 中 | 中 | 三层包结构 + 契约测试 + 覆盖率门槛 |

### 8.2 收益

| 维度 | 收益 | 度量方式 |
|---|---|---|
| 用户价值 | 手机 QQ 随时向本地 IDE 下达任务，离开工位也能推进 | 周活用户、移动端发起占比、平均响应时延 |
| 能力复用 | 直接复用码道的 skills / subagents / rules / MCP / 模型路由 | 技能调用次数、任务成功率 |
| 工程复用 | dsh-qqbot 的传输、切分、限流、会话映射可直接平移（预估 50%~65% 传输层代码） | 代码复用率、首版缺陷密度 |
| 生态示范 | 首个"码道 × 第三方 IM"桌面插件样板，可复制到企微/飞书 | 后续渠道接入成本下降幅度 |
| 商业 | 提升 CodeArts Agent 粘性与时长；带动 Credits 消耗 | 留存、ARPU、Credits 消耗 |

### 8.3 可推广性

1. **横向：一套 `ImAdapter` 覆盖多 IM。** 把 `qqbot-core` 抽象为 `ImAdapter`（收消息/发消息/按钮/文件/身份），QQ 只是第一个实现。码道 Space 已有钉钉/飞书/企微/Slack/Lark 的账号体系与文档，**桌面插件可复用同一套运行时**，边际成本显著下降。
2. **纵向：个人版 → 企业版。** 企业版可把 sidecar 部署在内网跳板机，接企业自建机器人网关；桌面端只做"配对与策略下发"。
3. **形态：插件市场商品化。** 以 VSIX 形式上架码道市场/OpenVSX，配合"模板化配置 + 一键诊断"，可被 ISV 二次开发（如教育、外包交付场景）。
4. **反向：与 dsh 生态互通。** `KernelPort` 若再加一个 `dsh-port`，同一 QQ 运行时即可同时服务码道与 dsh，形成"跨 Agent 宿主的 IM 网关"，这是比单一插件更大的复用面。

> 推广前置条件：R1（契约）与 R2（分发）必须先有官方口径，否则只能停留在内部工具层面。

---

## 9. 五维评分（1~5，5 为最优）

| 维度 | 当前方案评分 | 主要短板 | 提升动作 |
|---|---|---|---|
| 开发便利性 | 4 | 内核契约需摸索 | P0 录制 fixtures，先固化契约再写业务 |
| 易用性 | 4 | 首次配置仍可能卡在 AppID | 扫码优先、手动兜底、失败给可操作指引 |
| 可维护性 | 3.5 | 内核随 IDE 升级 | 适配层 + 能力位 + 兼容矩阵自动化 |
| 安全性 | 3.5 | 远程驱动本地 Agent 天然高危 | 默认最小权限 + 审批 + 沙箱 + 审计 |
| 稳定性 | 3.5 | 长连接 + 长会话 + 外部内核三重不确定性 | 看门狗、熔断、幂等、优雅退出、单实例 |

综合可行性：**4/5（有条件可行）**。

---

## 10. 结论与待确认事项

### 10.1 结论

1. **能写，但不是"复制一份"。** 码道内核是 OpenCode 系，插件与事件模型与 dsh 的 Cordis 不同构；dsh-qqbot 可直接复用约一半的传输与编排逻辑，事件层与会话层必须重写。
2. **最优路径是"旁路优先"**：VSIX 做容器与 UI，sidecar 做 QQ 长连接与会话编排，`KernelPort` 做唯一耦合边界；内核插件留作 P2 增强。
3. **商业上更稳的并行主线是 Space 侧 QQ 渠道**：复用既有钉钉/飞书/企微能力，零客户端分发成本；桌面插件负责"本地工作区"这一差异化场景。
4. **必须先做 P0 契约验证**，三个硬指标：独立 session 创建、assistant 增量可得、审批可回传。任一不成立，方案降级。

### 10.2 待官方/内核团队确认的问题

1. `agentkernelServer` 的本地监听方式（端口分配、鉴权 token、是否仅回环）与对外稳定性承诺。
2. 事件流的完整类型清单与字段语义（是否有等价 `turn/start`、`assistant/chunk`、`tool/call`、`deliverable`）。
3. `~/.codeartsdoer/extensions` 的加载规则、插件上架/签名要求，以及 `@opencode-ai/plugin` 的版本兼容策略。
4. Permission 请求能否被外部客户端应答；QQ 按钮回调 → 内核批准的完整链路。
5. 是否存在官方"数字分身/外部 IM"接入协议（`startDigitalAvatar` 的 `ideType` 枚举与协议文档）。
6. 商用条款：第三方插件调用模型是否计入用户 Credits；是否需要单独计费协议。

---

## 附录 A：证据索引

| 证据 | 路径 |
|---|---|
| 产品与版本 | `D:\apps\CodeArts Agent\resources\app\product.json` |
| 主程序与依赖 | `D:\apps\CodeArts Agent\resources\app\package.json` |
| AI 扩展清单 | `D:\apps\CodeArts Agent\resources\app\extensions\vscode-codebot\package.json` |
| 内核二进制 | `...\extensions\vscode-codebot\agentkernelServer-win32-x64.exe` |
| 内核配置目录判定 | `...\vscode-codebot\out\extension.js`（`getKernelConfigDir`） |
| 内核客户端端点 | `...\vscode-codebot\out\extension.js`（`/v1/skill`、`/cag/*`、`x-opencode-directory`） |
| 插件 SDK manifest | `...\vscode-codebot\out\extension.js`（`@cloud/agentkernel-plugin-sdk` exports） |
| 运行时用户目录 | `C:\Users\<user>\.codeartsdoer\`（`kernel.jsonc`、`package.json`、`agents/`、`skills/`、`rule/`、`extensions/`） |
| dsh-qqbot 入口 | `github.com/tencent-connect/dsh-qqbot` → `src/index.ts` |
| dsh-qqbot 入站/出站 | `src/transport/inbound.ts`、`src/transport/outbound.ts` |
| dsh-qqbot 会话 | `src/session/session-manager.ts` |
| dsh-qqbot 包契约 | `package.json`（peerDependencies、dsh.bundle/client） |
| OpenCode 插件/服务端契约 | `opencode.ai/docs/plugins/`、`opencode.ai/docs/api` |

## 附录 B：与 dsh-qqbot 的功能对照（节选）

| 功能 | dsh-qqbot | 本方案 | 实现方式 |
|---|---|---|---|
| 扫码绑定 | 宿主绑定页 + 二维码 | VS Code WebView | 自研，复用 qrcode |
| 凭据持久化 | `cordis.patch.yml` + HMR | DPAPI + 配置引用 | 更安全 |
| 会话隔离 | 每 peer 一个 Agent | 每 peer 一个 session | 等价 |
| 闲置回收 | dispose Agent | dispose session + 映射保留 | 等价 |
| 流式 | `agent/assistant-stream` | 内核事件 delta | 需 P0 验证 |
| 群历史 | 内存缓冲 10 条 | 同构 | 直接移植 |
| 工具展示 | tool/call + tool/result | 事件 tool part | 重写展示层 |
| 审批 | approval 按钮 | Permission 按钮 | 需 P0 验证 |
| 发文件 | deliverables + 路径白名单 | 等价事件或自建工具 | 需确认 |
| 访问控制 | 三模式 + 配对码 + revision | 同构 | 直接移植 |
| 模型切换 | fork 重建 | `/session/{id}/model` | 更简单 |
| 命令 | 9 个 | 同构 | 直接移植 |