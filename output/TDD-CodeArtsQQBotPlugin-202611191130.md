# 码道 CodeArts Agent QQ Bot 插件 方案设计文档（TDD）

| 项目 | 内容 |
|---|---|
| 文档类型 | 技术设计文档（TDD / HLD+LLD 混合） |
| 文档定位 | 落地实现设计，回答"怎么做"，不重复"能不能做" |
| 上游文档 | `Solution-CodeArtsQQBotPlugin-202611191030.md`（评估报告，结论：有条件可行） |
| 设计基线 | CodeArts Agent v26.11.100；内核 `126.11.2-20261117200150`；dsh-qqbot v0.5.5 |
| 实现基线 | 插件 **0.3.1**（113 项测试通过）；sidecar SEA + VSIX 已产出 |
| 目标读者 | 插件开发、内核对接、安全评审、测试、运维 |
| 环境基线 | 开发环境见 1.4，运行环境见 1.5，构建与分发见 1.6 |
| 版本 | **v1.1（2026-11-20 增量更新，替代 v1.0）** |

### v1.1 变更摘要

| 章节 | 变更 |
|---|---|
| 2.1 / 3.1 | 架构与代码结构按实际实现更新（扫码绑定、访问名单、媒体、单实例、兼容矩阵） |
| 4.1 | 首次绑定改为**官方二维码扫码**，扫码成功自动启动；手动填写仅兜底 |
| 4.6 | 新增提问交互（`question` 工具）与思维链过滤 |
| 5.1 / 5.2 | `KernelPort` 新增 `waitStreamReady`、`respondQuestion`、`cancel`；事件新增 `question/request`、`question/closed` |
| 5.3 | IPC 新增 `credentials.set`、`access.get`、`access.mutate` |
| 6.1 | 持久化目录新增 `access.json`、`prefs.json`、`media/`、`locks/` |
| 7 | 兼容性改为按真实内核校准，并新增 `npm run compat` 矩阵 |
| 8 / 9 | 新增扫码凭据、路径白名单、单实例锁、`msg_seq`、prompt 长超时 |
| 14 | 交付状态按实际完成度更新 |

---

## 1. 设计范围

### 1.1 目标

让开发者通过 QQ 私聊/群聊，驱动本地码道 Agent 完成编码任务，并把结果（文本、代码块、文件）回送到 QQ。

具体能力目标（与 dsh-qqbot 0.5.5 对齐）：

1. 私聊与群聊（@bot）双通道；群聊默认要求 @。
2. 每个 QQ 对端一个独立会话，跨进程重启可恢复。
3. 流式输出（可降级为整段）；Markdown 感知切分。
4. 工具调用可展示（成功结果默认隐藏、错误始终展示）。
5. 关键操作审批（允许/拒绝按钮）与提问（单选按钮/编号回复）回流。
6. 会话命令：`/new` `/compact` `/model` `/stop` `/bot-status` `/bot-help` `/bot-ping`。
7. 访问控制三模式（open / allowlist / disabled）+ 配对码。
8. 媒体：图片理解、文件回传（路径白名单）、TTL 清理。
9. 主动推送（定时任务/桌面续聊回合）。
10. 凭据安全存储、日志脱敏、一键诊断。

### 1.2 非目标（本期不做）

| 非目标 | 原因 |
|---|---|
| 自建 QQ 协议客户端（非官方） | 合规与封号风险，只用官方 `qqbot-connector` |
| 修改码道 Workbench 核心 | 发行版校验和受保护，且无必要 |
| 依赖内核私有 API proposal | 审核不可控，改用稳定扩展 API + 旁路 |
| 多租户 SaaS 托管 | 走企业版独立设计 |
| 语音实时通话 | 仅做语音转写文本（依赖 QQ 侧 ASR 字段） |
| 自研模型路由/计费 | 复用码道既有 provider 与计费 |

### 1.3 设计约束

| ID | 约束 | 影响 |
|---|---|---|
| C1 | 内核为闭源二进制，契约无公开版本承诺 | 必须有 `KernelPort` 适配层与能力位降级 |
| C2 | 内核随 IDE 发版升级 | 必须有版本探测 + 回归矩阵，禁止硬编码行为 |
| C3 | 扩展分发仅 VS Code 兼容市场（码道市场/OpenVSX/VSIX） | sidecar 必须能随 VSIX 一起分发或独立安装 |
| C4 | QQ 官方 WS 长连接，被动回复需 msgid，有频控 | 传输层必须做 msgid 缓存与限流（沿用 dsh 经验） |
| C5 | 用户模型调用计入 CodeArts Credits | 必须有配额提示与单用户日限 |
| C6 | 企业环境可能禁用出网/要求私有化 | 提供"仅内网"模式与策略开关 |

### 1.4 开发环境

#### 1.4.1 开发机支持矩阵

| 项 | 开发主环境（已验证） | 兼容目标 | 说明 |
|---|---|---|---|
| 操作系统 | Windows 10/11 x64 | macOS 13+（arm64/x64）、Linux x64（glibc ≥ 2.31） | 码道内核产物实测为 `agentkernelServer-win32-x64.exe`；其他平台需确认对应内核二进制后再纳入 |
| 码道版本 | v26.11.100（VS Code 1.109.5 / Electron 39.3.0） | ≥ v26.11.100 | 低版本可能缺 `chatEditing` 等能力，仅影响可选特性 |
| 安装路径 | `D:\apps\CodeArts Agent`（可自定义） | 任意 | 调试配置用变量引用，不硬编码 |
| WSL / 容器 | **不支持作为运行环境** | — | 内核是 Windows 原生二进制，WSL 无法驱动；可用于跑单测与 lint |

#### 1.4.2 工具链版本

| 工具 | 版本要求 | 用途 | 备注 |
|---|---|---|---|
| Node.js | ≥ 20.3，建议 22 LTS | 开发、构建、单测 | 与 dsh-qqbot `engines.node >= 20.3` 对齐 |
| pnpm | ≥ 9 | workspace 管理 | 严禁 npm/yarn 混用（锁文件唯一） |
| TypeScript | 5.x，`strict: true` | 全量 TS | 与码道内置扩展 TS 5.4~6.0 兼容 |
| 打包 | esbuild（sidecar）+ `@vscode/vsce`（VSIX） | 产物 | 见 1.6 |
| 单测 | Vitest | core/port | 覆盖率门禁见第 10 章 |
| 扩展类型 | `@types/vscode@^1.109` | 扩展开发 | 不使用未授权的私有 API proposal |
| 可选 | Docker Desktop | Linux 构建验证 | CI 复用同一镜像 |

#### 1.4.3 码道侧准备

1. 安装码道并使用华为云账号登录（`huaweicloud.authentication` 完成鉴权）。
2. 至少完成一次对话，确认内核已落地并被拉起：
   `%USERPROFILE%\.codeartsdoer\`（`kernel.jsonc`、`agents/`、`skills/` 存在）。
3. 确认内核二进制存在：
   `<安装目录>\resources\app\extensions\vscode-codebot\agentkernelServer-win32-x64.exe`。
4. QQ 侧准备：
   - QQ 开放平台开发者账号，创建机器人，取得 `AppID` / `AppSecret`；
   - 配置沙箱环境与测试群；
   - 开发期可用环境变量注入凭据，**不要提交到仓库**。
5. CLI 可用性（用于脚本化调试）：
   `<安装目录>\bin\codearts-agent.cmd --version`。

#### 1.4.4 调试运行方式

方式一：扩展开发宿主（推荐，能调试扩展与 UI）

    // .vscode/launch.json
    {
      "type": "extensionHost",
      "request": "launch",
      "name": "码道扩展调试",
      "runtimeExecutable": "D:/apps/CodeArts Agent/codearts-agent.exe",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}/packages/vscode-extension",
        "--disable-extensions"
      ]
    }

方式二：命令行挂载（无 UI 调试，适合 CI / 远程）

    "D:\apps\CodeArts Agent\bin\codearts-agent.cmd" \
      --extensionDevelopmentPath="E:\ws\codearts-qqbots\packages\vscode-extension" \
      --user-data-dir="%TEMP%\qqbot-dev-profile"

方式三：脱离码道（只调业务逻辑）

    pnpm --filter qqbot-runtime dev      # 启动 sidecar（MOCK_KERNEL=1）
    pnpm --filter qqbot-runtime fixture:record   # 连真实内核录制事件流

**验收自检**：`pnpm doctor` 必须全部为 PASS（见 1.4.7）。

#### 1.4.5 开发期环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `QQBOT_APPID` | 开发期 AppID（覆盖配置） | 空 |
| `QQBOT_SECRET` | 开发期 AppSecret（**仅本地**） | 空 |
| `CODEARTS_QQBOT_HOME` | 覆盖数据目录（隔离多套实验） | `~/.codeartsdoer/qqbot` |
| `CODEARTS_QQBOT_LOG_LEVEL` | `debug`/`info`/`warn`/`error` | `info` |
| `MOCK_KERNEL` | `1` 时使用 `mock-port` + fixtures | `0` |
| `MOCK_QQ` | `1` 时使用本地假 QQ 网关（不发真实消息） | `0` |
| `HTTP_PROXY` / `HTTPS_PROXY` | 企业代理 | 空 |

#### 1.4.6 开发机网络与权限

| 项 | 要求 |
|---|---|
| 出网 | 443 到 QQ 开放平台（API + WS）；到华为云模型网关由码道内核负责，插件不直连 |
| 回环 | 允许 `127.0.0.1` 本地 HTTP/SSE（sidecar ↔ 内核） |
| IPC | 允许创建命名管道 `\\.\pipe\codearts-qqbot-*` |
| 文件 | 对 `%USERPROFILE%\.codeartsdoer` 有读写权限 |
| 代理 | 若走代理，QQ WS 需直连或配置 PAC；代理环境下需验证 WS 升级握手 |
| 杀软/EDR | 需放行 sidecar 二进制与命名管道；企业环境提前报备 |

#### 1.4.7 环境自检清单（`pnpm doctor` 输出）

    [PASS] OS             Windows 11 23H2 x64
    [PASS] Node           22.14.0 (>= 20.3)
    [PASS] pnpm           9.12.0
    [PASS] 码道安装        D:\apps\CodeArts Agent (26.11.100)
    [PASS] 内核二进制       agentkernelServer-win32-x64.exe
    [PASS] 内核健康        /api/info 200 (version=..., capabilities=8)
    [PASS] 数据目录        %USERPROFILE%\.codeartsdoer\qqbot (可写)
    [PASS] 命名管道        可创建
    [WARN] 出网探测        wss 握手超时（如为离线开发，可忽略）
    [PASS] 凭据            DPAPI 可读写（仅探测，不落盘）

### 1.5 运行环境（终端用户）

#### 1.5.1 客户端矩阵

| 项 | 最低要求 | 推荐 | 说明 |
|---|---|---|---|
| 操作系统 | Windows 10 1809 x64 | Windows 11 x64 | 与码道官方支持范围一致；arm64 待验证 |
| 码道 | v26.11.100 | 最新稳定版 | `engines.vscode ^1.109` 通过即可加载；内核能力按能力位协商 |
| 内存 | 8 GB | 16 GB | 码道本身占用为主，sidecar 为增量 |
| 磁盘 | 500 MB 可用 | 2 GB | 含媒体缓存与 7 天日志 |
| Node 运行时 | **用户无需安装** | — | sidecar 以 SEA 单文件分发，内置 Node 22 LTS |
| QQ | 手机 QQ / PC QQ 最新版 | — | 仅作为消息客户端 |
| 显示 | 无需 GUI（驻留模式） | — | sidecar 可无窗口运行 |

#### 1.5.2 资源基线（估算，P1 实测校准）

| 指标 | 空闲 | 峰值 | 控制手段 |
|---|---|---|---|
| sidecar RSS | 80–150 MB | ≤ 300 MB | 队列上限、流式 buffer 上限、媒体及时释放 |
| CPU | < 1% | 短时 10%（下载/切分） | 下载限速、并发上限 4 |
| 磁盘/天 | 日志 ≤ 20 MB | 媒体按 `media.maxMB × ttlHours` | TTL 清理、日志滚动保留 7 天 |
| 句柄 | < 200 | < 500 | 媒体下载后立即关闭 fd |

#### 1.5.3 网络要求

| 方向 | 目标 | 端口 | 必需 |
|---|---|---|---|
| 出网 | QQ 开放平台 API / WS（域名以官方文档为准） | 443 | 是 |
| 出网 | 华为云 CodeArts 模型网关 | 443 | 是（由码道内核发起） |
| 本地 | `127.0.0.1` sidecar ↔ 内核 | 动态高位端口 | 是 |
| 本地 | 命名管道 | — | 是 |
| 入网 | 无 | — | **不需要公网 IP / 回调地址** |

企业网络需白名单：QQ 开放平台域名、码道既有域名（保持一致，不新增）。**插件不引入新的外部服务依赖**，这是可推广性的关键。

#### 1.5.4 文件系统与权限

| 路径 | 用途 | 权限 |
|---|---|---|
| `%USERPROFILE%\.codeartsdoer\qqbot\` | 配置、映射、日志、媒体 | 仅当前用户 |
| `%USERPROFILE%\.codeartsdoer\` | 码道既有目录（技能/规则/子代理） | 只读复用 |
| 工作区目录 | Agent 读写范围 | 继承码道权限 |
| 临时目录 | 下载中转、诊断包 | 系统默认 |

不写入系统目录、不注册全局服务、不修改码道安装目录（升级时不被覆盖）。

#### 1.5.5 账号与配额

1. 需已登录华为云账号且 CodeArts Agent 处于可用套餐（模型调用计 Credits）。
2. 建议为 QQ 场景设置日限额（`quota.dailyCredits`），超限回复提示并保留会话。
3. 机器人 AppID/AppSecret 属于**用户自有资产**，插件不代持、不上传。

#### 1.5.6 共存与冲突

| 场景 | 处理 |
|---|---|
| 同时打开多个码道窗口 | 允许多窗口，但 sidecar 单实例；主窗口持有运行时，副窗口只做状态展示 |
| 同一 AppID 另开一台机器 | 视为冲突：第二台启动时提示"该机器人已在其他设备在线"，可强制接管（踢下线） |
| 已装旧版插件 | 版本协商：VSIX 高版本覆盖；sidecar 保留上一版用于回滚 |
| 与 Space 渠道同时启用 | 允许，但同一 QQ 用户消息只由一处响应（以 Space 优先，桌面端静默） |

#### 1.5.7 明确不支持的场景

1. WSL / Wine / 容器内运行 Windows 内核。
2. 无网络的离线环境（无法连 QQ 平台）。
3. 未登录码道账号（无模型可用；仅能返回"请先登录"）。
4. 多个 QQ 机器人共用同一份数据目录（appId 隔离，不支持热切换）。

### 1.6 构建与分发环境

#### 1.6.1 构建矩阵

| 目标 | Runner | 产物 |
|---|---|---|
| Windows x64 | windows-2022 | `qqbot-sidecar-win32-x64.exe`、`*.vsix` |
| macOS arm64/x64 | macos-14 | `qqbot-sidecar-darwin-*.bin`（内核产物确认后再启用） |
| Linux x64 | ubuntu-22.04 | `qqbot-sidecar-linux-x64`（同上） |

#### 1.6.2 sidecar 打包选型

| 方案 | 结论 | 理由 |
|---|---|---|
| Node SEA（Single Executable Application） | **采用** | Node 官方能力，产物单文件，免装 Node |
| pkg | 不采用 | 已停止维护 |
| 随扩展附带 node 二进制 | 备选 | 体积大（~80MB），但便于排查 |
| 纯 JS + 用户 Node | 不采用 | 终端用户不可控 |

要求：SEA 产物带签名与 sha256；启动时自校验；版本号写入二进制元数据，供 `doctor` 读取。

#### 1.6.3 VSIX 打包与引擎声明

    // package.json（扩展）
    {
      "engines": { "vscode": "^1.109.0" },
      "extensionKind": ["workspace", "ui"],
      "main": "./dist/extension.js"
    }

- 第三方扩展**只声明 `engines.vscode`**，不声明内部 `engines.codearts`（避免被判定为内置扩展）。
- 不使用 `enabledApiProposals` 中的私有 proposal（如 `chatParticipantPrivate`），只用稳定 API。
- `vsce package --no-dependencies`，依赖全部打入 `dist`。

#### 1.6.4 CI 门禁与产物清单

    qqbot-plugin-<version>/
    ├─ codearts-qqbot-<version>.vsix          扩展（含 sidecar 或引用下载）
    ├─ qqbot-sidecar-win32-x64.exe            独立二进制
    ├─ sbom.spdx.json                          依赖清单
    ├─ checksums.sha256                        全部产物校验
    ├─ compat-matrix.json                      内核兼容矩阵
    └─ docs/                                   安装、配置、排障、隐私

门禁：lint → typecheck → 单测覆盖率 → 契约回放 → 打包 → 冒烟（mock）→ 签名 → 发布。

#### 1.6.5 分发渠道

| 渠道 | 方式 | 审核 | 适用 |
|---|---|---|---|
| 码道插件市场 | VSIX 上架 | 需审核 | 主渠道 |
| OpenVSX | VSIX 上架 | 轻审核 | 海外/开源 |
| 离线侧载 | VSIX + sha256 | 无 | 企业内网 |
| 企业私有仓库 | 自建 registry | 内部 | 大型客户 |

> sidecar 的下载与升级必须校验签名；离线环境提供"随包内置 sidecar"模式，避免二次下载。

---

## 2. 总体架构

### 2.1 分层视图

    L5 表现层      VS Code 扩展（codearts-qqbot-cn, VSIX）
                   ├─ 扫码绑定 WebView：官方二维码 / 刷新 / 手动兜底
                   ├─ 命令：启动、重启、扫码绑定、手动填写、管理访问名单、设置内核连接、诊断
                   └─ 状态栏：sidecar 三态 + 最近错误

    L4 运行时      sidecar（Node SEA 单文件，独立进程，随扩展拉起）
                   ├─ transport（inbound / outbound / chunker / msg_seq 限流）
                   ├─ session registry（peer → kernelSessionId，prefs.json 持久化）
                   ├─ features（access 持久化 / question / approval / commands / 配对码）
                   ├─ media（下载落盘 / 富媒体回传 / TTL 清理）
                   └─ ops（健康熔断 / 单实例锁 / 日志）

    L3 适配层      KernelPort ★ 唯一与码道内核耦合的边界
                   ├─ http-port（HTTP + SSE，首选）
                   ├─ plugin-port（OpenCode Plugin，P2）
                   ├─ mock-port（fixtures 回放，开发/CI）
                   ├─ normalize（内核事件 → 统一事件）
                   └─ compat（版本探测 / 能力位 / 降级）

    L2 内核        agentkernelServer.exe
                   Session / Agent Loop / Tools / Permission / Skills / SubAgents

    L1 平台        QQ 开放平台 WS ←→ 华为云 CodeArts 模型网关

### 2.2 进程模型

    codearts-agent.exe (Electron)
      └─ Extension Host (Node)
           └─ qqbot-container 扩展
                ├─ 持有 kernel 客户端（扩展内既有能力）
                └─ spawn → qqbot-sidecar.exe / node sidecar.js
                              │
                              ├─ WS → QQ 开放平台
                              └─ HTTP/SSE → agentkernelServer（127.0.0.1）

    ┌─ 关键决策 ────────────────────────────────────────────────┐
    │ sidecar 独立进程，不随 IDE 窗口关闭而销毁（可选驻留模式）。   │
    │ 扩展崩溃/重载不影响 QQ 长连接；内核崩溃由 sidecar 看门狗处理。 │
    └───────────────────────────────────────────────────────────┘

### 2.3 部署形态

| 形态 | 说明 | 适用 |
|---|---|---|
| D1 单机个人版 | 扩展 + sidecar + 内核同机 | 开发者个人 |
| D2 驻留版 | IDE 关闭后 sidecar 继续运行，仅文本对话（无本地工具） | 远程值守 |
| D3 企业内网版 | sidecar 部署在内网跳板机，桌面只做配对/策略 | 企业 |
| D4 Space 渠道版 | QQ 接入 Space 云端，无客户端 | 企业群协作（并行主线） |

本期实现 D1，预留 D2；D3/D4 由推广阶段承接。

---

## 3. 组件设计

### 3.1 代码结构

    codearts-qqbot/
    ├─ package.json                   workspace 与 scripts（check / compat / build / package）
    ├─ packages/
    │   ├─ qqbot-core/                纯逻辑，零宿主依赖
    │   │   ├─ src/transport/inbound.ts        5 层上下文组装
    │   │   ├─ src/transport/chunker.ts        Markdown 感知切分（代码块补围栏）
    │   │   ├─ src/features/access.ts          三模式 + 配对码 + 撤销 + revision
    │   │   ├─ src/features/commands.ts        命令解析与建议
    │   │   ├─ src/errors.ts                   错误码与用户文案
    │   │   └─ src/redact.ts                   日志脱敏
    │   ├─ qqbot-ipc/                 ★ 扩展 ↔ sidecar 通道
    │   │   ├─ src/protocol.ts                 方法 / 事件 / KernelConnection / AccessAction
    │   │   ├─ src/server.ts                   NDJSON 服务端（token 鉴权）
    │   │   └─ src/client.ts                   客户端（断线通知 + 请求配对）
    │   ├─ qqbot-kernel-port/         ★ 唯一耦合层
    │   │   ├─ src/port.ts                     接口与统一事件
    │   │   ├─ src/http-port.ts                HTTP + SSE（reasoning 过滤、prompt 长超时）
    │   │   ├─ src/mock-port.ts                测试替身（可 emitQuestion）
    │   │   ├─ src/normalize.ts                事件归一化 + part 类型追踪
    │   │   └─ src/compat.ts                   能力位与降级
    │   ├─ qqbot-runtime/             sidecar 主程序
    │   │   ├─ src/bin/sidecar-entry.ts        SEA 入口（--ipc-pipe / --ipc-token）
    │   │   ├─ src/sidecar.ts                  装配：IPC → 内核 → QQ 链路
    │   │   ├─ src/gateway.ts                  接入 / 鉴权 / 会话 / 投递 / 提问 / 审批
    │   │   ├─ src/session/registry.ts         会话映射与持久化（FilePrefsStore）
    │   │   ├─ src/access/store.ts             访问名单持久化
    │   │   ├─ src/media/service.ts            媒体下载 / TTL 清理
    │   │   ├─ src/qq/{client,source,transport}.ts  HTTP / WS / 出站（msg_seq）
    │   │   ├─ src/ops/{health,single-instance}.ts 熔断与单实例锁
    │   │   └─ src/security/credentials.ts     凭据抽象（DPAPI / keytar / 兜底）
    │   └─ vscode-extension/          VSIX 容器
    │       ├─ src/extension.ts                命令、状态、生命周期
    │       ├─ src/sidecar.ts                  拉起 / 看门狗 / 退避重启
    │       ├─ src/bridge.ts                   IPC 客户端与自动重下发
    │       ├─ src/bind-qr.ts                  官方扫码状态机
    │       ├─ src/bind-panel.ts               绑定 WebView
    │       ├─ src/kernel-discovery.ts         端口发现
    │       └─ src/kernel-secret.ts            口令只读解密
    ├─ scripts/                        doctor / compat / probe / build
    ├─ docs/                           契约、探测归档、方案说明
    └─ output/                         评估报告、TDD、开发计划

### 3.2 包依赖规则（强制）

    qqbot-core        不得依赖 vscode / @cloud / qqbot-kernel-port
    qqbot-kernel-port 可依赖 qqbot-core 的类型；不得依赖 vscode
    qqbot-runtime     可依赖 core + kernel-port；不得依赖 vscode
    vscode-extension  可依赖 core 类型；通过 IPC 调 runtime，不直接写业务

> CI 增加依赖方向检查（类似 `valid-layers-check`），违规则失败。

### 3.3 各组件职责边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| qqbot-core | 消息组装、切分、限流、访问控制、提问/审批状态机、命令解析 | 网络、进程、存储、宿主 API |
| qqbot-kernel-port | 内核通信、事件归一化、能力探测、降级 | 业务编排、QQ 协议 |
| qqbot-runtime | 生命周期、会话编排、投递、安全、可观测 | UI |
| vscode-extension | 安装/配置/绑定/状态/诊断 UI、sidecar 守护 | 消息业务逻辑 |

---

## 4. 关键流程设计

### 4.1 首次绑定（扫码）

    用户                扩展                          腾讯官方页面          sidecar
     │ 命令「扫码绑定」   │                               │                   │
     │───────────────────>│ 打开绑定 WebView              │                   │
     │                    │ startQrConnect(...) ─────────>│                   │
     │                    │<── onQrDisplayed(url) ────────│                   │
     │  手机 QQ 扫码      │ QRCode.toString(url) → SVG    │                   │
     │──────────────────────────────────────────────────>│ 创建/绑定机器人     │
     │                    │<── onSuccess([{appId,secret}])│                   │
     │                    │ 写 SecretStorage（app-id / app-secret）            │
     │  面板显示成功       │ IPC: credentials.set ─────────│──────────────────>│
     │                    │ IPC: kernel.set ──────────────│──────────────────>│
     │  状态灯变绿         │<──────────────────────────────│ sidecar running    │
     │  私聊发 "hi"       │                               │ 建会话 → 调 KernelPort
     │<─────────────────── 回复 ──────────────────────────│                   │

失败分支：扫码失败或无机器人权限 → 面板显示原因，可「刷新二维码」或切「手动填写」；二维码过期自动刷新。

兜底：`QQ Bot: 手动填写凭据` 输入 AppID/AppSecret，写入 SecretStorage 后调用 `restart()`，确保新凭据生效。

### 4.2 普通对话（含流式）

    QQ 消息
      → inbound：附件下载 → 5 层组装 → 命中访问控制
      → registry.getOrCreate(scope, peerId)
          ├─ 内存命中 → 复用
          ├─ prefs 命中 → KernelPort.resume(id)
          └─ 未命中 → KernelPort.create({cwd, agent})
      → KernelPort.prompt(id, parts)
      → 事件流：
          turn/start      → 建 Turn 记录，确定投递目标（被动回复 msgid）
          text/delta      → OutboundBuffer 追加（debounce 300ms）
          message/complete→ flush 或整段发送
          tool/call       → 记录，不发送
          tool/result     → 错误必发，成功按配置
          permission      → 转 QQ 按钮，挂起
          turn/end        → 等待在途发送，投递交付文件，清理状态
      → 发送：chunkMarkdownText(4500) → sendMarkdown（失败重试 ≤3）

**幂等**：`messageId` 入幂等表（TTL 24h）；`callId` 去重；流式帧 `attemptId` 不匹配即丢弃。

### 4.3 审批回流

    内核 permission/request
      → approval.raise(sessionId, requestId, detail)
      → QQ 发送卡片：标题 + 摘要 + [允许] [拒绝]
      → 用户点击 → 回调携带 requestId
      → 校验：requestId 未过期 && 发送者在 allowlist（或会话所有者）
      → KernelPort.respondPermission(id, requestId, decision)
      → 超时（默认 5min）→ 自动拒绝 + 提示

**安全约束**：审批按钮**只认会话对端**，群聊内其他人点击无效；同一 requestId 只能决策一次。

### 4.4 断线/崩溃恢复

    WS 断开 → 停止接新消息 → 重连（1s/2s/4s/…/60s + 抖动）
    重连成功 → 复位 Online 状态 → 丢弃未确认发送队列（避免重复）

    内核不可用（health 连续 3 次失败）
      → 熔断 OPEN：所有新消息回"内核未就绪，已排队"
      → 每 10s 探测 /api/info
      → 恢复 → HALF_OPEN：放行 1 条试探 → 成功则 CLOSED
      → 会话恢复：按 prefs 逐个 resume（并发 ≤2，失败保留映射，下次消息重试）

### 4.5 IDE 关闭 / 升级

    扩展 deactivate → IPC: runtime.prepareShutdown
      → 停止接入 → 等待在途 turn（≤10s）→ 落盘 prefs → 退出
    （驻留模式 D2）：扩展不发送 shutdown，sidecar 继续以"仅文本"运行，
      工具类请求返回"IDE 未运行，无法执行本地命令"

    码道升级 → 扩展重启 → 探测内核版本
      → 版本未见过 → 进入"只读兼容模式"：仅 create/prompt/event，禁用审批/文件
      → 写兼容性报告到诊断包

---

## 5. 接口设计

### 5.1 KernelPort（唯一耦合面）

    export type Capability =
      | "session.create" | "session.resume" | "session.exists"
      | "prompt" | "event.stream" | "event.delta"
      | "compact" | "model.set" | "permission" | "deliverable";

    export interface KernelInfo {
      version: string;
      endpoint: string;          // 仅回环
      capabilities: Set<Capability>;
      agentIds: string[];
      providers: string[];
    }

    export interface KernelPort {
      info(): Promise<KernelInfo>;
      health(): Promise<boolean>;
      createSession(i: { cwd: string; agent?: string; title?: string }): Promise<{ id: string }>;
      resumeSession(id: string): Promise<{ id: string }>;
      sessionExists(id: string): Promise<boolean | undefined>;
      /** 发送消息；HTTP 实现使用独立的 promptTimeoutMs（默认 300s），不阻塞其他消息 */
      prompt(id: string, parts: PromptPart[]): Promise<void>;
      cancel?(id: string): Promise<void>;
      subscribe(h: (e: KernelEvent) => void): () => void;
      /** 等待 SSE 就绪，避免首条消息早于订阅 */
      waitStreamReady?(timeoutMs?: number): Promise<boolean>;
      compact(id: string): Promise<void>;
      setModel(id: string, provider: string, model: string): Promise<void>;
      respondPermission(id: string, requestId: string, decision: Decision): Promise<void>;
      /** 回答内核 question；answers 为二维数组（每题一组选中项） */
      respondQuestion?(sessionId: string, requestId: string, answers: string[][]): Promise<void>;
      disposeSession(id: string): Promise<void>;
      close(): Promise<void>;
    }

> `HttpKernelPort` 构造参数包含：`baseUrl`（仅回环）、`directory`、`basicAuth`、`paths`（端点可注入）、
> `promptTimeoutMs`、`model: { providerID, modelID }`、`agent`。模型必须显式传入，避免 auto-router 选到空模型。

    export type PromptPart =
      | { kind: "text"; text: string }
      | { kind: "file"; path: string; mime?: string }
      | { kind: "image"; path: string; mime?: string };

### 5.2 统一事件模型

    export type KernelEvent =
      | { type: "turn/start"; sessionId: string; turn: number }
      | { type: "text/delta"; sessionId: string; turn: number; attemptId: string; text: string }
      | { type: "message/complete"; sessionId: string; turn: number; messageId?: string; blocks: Block[] }
      | { type: "tool/call"; sessionId: string; callId: string; name: string; args: unknown }
      | { type: "tool/result"; sessionId: string; callId: string; ok: boolean; summary?: string }
      | { type: "permission/request"; sessionId: string; requestId: string; action: string; detail: string }
      | { type: "question/request"; sessionId: string; requestId: string; questions: QuestionItem[] }
      | { type: "question/closed"; sessionId: string; requestId: string }
      | { type: "deliverable"; sessionId: string; files: PresentedFile[] }
      | { type: "turn/end"; sessionId: string; turn: number; reason?: { code: string; message: string } };

**事件映射表（按内核 `126.11.2` 实测校准）**

| 统一事件 | 内核事件 / 字段 | 说明 |
|---|---|---|
| turn/start | `message.updated`（role=user） | 用户消息写入 |
| text/delta | `message.part.delta`（`field="text"`） | 用 `partID → part.type` 过滤 reasoning；`part.updated` 不再作为增量 |
| message/complete | `message.updated`（assistant 且 `time.completed`） | 携带 `messageId`；blocks 排除 reasoning / synthetic |
| tool/call | `message.part.updated`（tool，status=running） | `callID` + `tool` |
| tool/result | `message.part.updated`（tool，status=completed/error） | `status!=="error"` 为成功 |
| permission/request | `permission.asked` | 统一为数字审批（1 允许 / 2 拒绝） |
| question/request | `question.asked` | `properties.id` + `questions[{header,question,options}]` |
| question/closed | `question.replied` / `question.rejected` | 清理待答状态 |
| deliverable | `deliverables/presented` | 文件回传 |
| turn/end | `session.idle` / `session.error` | 收敛本轮；错误带 reason |

> 该表是 `normalize.ts` 的规格来源，也是契约测试与 `npm run compat` 的断言依据。内核升级先改此表，再改代码。

### 5.3 扩展 ↔ sidecar IPC

| 项 | 设计 |
|---|---|
| 通道 | Windows 命名管道 `\\.\pipe\codearts-qqbot-vscode`；macOS/Linux UDS |
| 鉴权 | 扩展每次启动生成随机 token，经 `--ipc-token` 注入 sidecar；未认证连接直接拒绝 |
| 协议 | JSON-RPC 2.0 / NDJSON |
| 方法 | `ipc.auth` `ipc.ping` `kernel.get` `kernel.set` `credentials.set` `access.get` `access.mutate` `status.get` |
| 事件 | `status.changed` |
| 断线 | 客户端触发 `close`；桥接退避重连，并在就绪后**自动重新下发**内核连接与凭据 |
| 超时 | 单次 15s；`kernel.set` / `credentials.set` 8s |

### 5.4 配置 Schema（扩展 contributes.configuration）

    codeartsQqbot.enabled            boolean   默认 false
    codeartsQqbot.workspace          string    默认 ${workspaceFolder}
    codeartsQqbot.agent              string    默认 ""（内核默认 agent）
    codeartsQqbot.provider           string    默认 ""（跟随码道）
    codeartsQqbot.model              string    默认 ""（跟随码道）
    codeartsQqbot.requireMention     boolean   默认 true
    codeartsQqbot.streaming          boolean   默认 true
    codeartsQqbot.textChunkLimit     number    默认 4500   [500, 8000]
    codeartsQqbot.sessionIdleTimeout number    默认 1800000
    codeartsQqbot.processingTimeout  number    默认 1800000
    codeartsQqbot.maxQueue           number    默认 20      [1, 200]
    codeartsQqbot.historyLimit       number    默认 10      [0, 50]
    codeartsQqbot.askTimeoutMs       number    默认 300000
    codeartsQqbot.showToolResults    boolean   默认 false
    codeartsQqbot.access.c2cMode     enum      open | allowlist | disabled
    codeartsQqbot.access.groupMode   enum      open | allowlist | disabled
    codeartsQqbot.access.commandMode enum      open | allowlist | disabled
    codeartsQqbot.media.enabled      boolean   默认 true
    codeartsQqbot.media.maxMB        number    默认 200
    codeartsQqbot.media.ttlHours     number    默认 24
    codeartsQqbot.sendFile.restrict  boolean   默认 true
    codeartsQqbot.sendFile.extraRoots array    默认 []
    codeartsQqbot.residentMode       boolean   默认 false
    codeartsQqbot.quota.dailyCredits number    默认 0（不限额）
    codeartsQqbot.debug              boolean   默认 false

**敏感项不入配置**：`appSecret` 只存 DPAPI，配置里只出现 `appSecretRef`。

---

## 6. 数据设计

### 6.1 持久化目录

    %USERPROFILE%\.codeartsdoer\qqbot\        （可用 CODEARTS_QQBOT_DATA 覆盖）
    ├─ prefs.json          会话映射（appId + peer → kernelSessionId，原子写）
    ├─ access.json         访问名单 / 配对码 / 撤销（revision 乐观锁）
    ├─ media\<peerId>\     下载的图片 / 视频 / 文件（TTL 清理，0600）
    ├─ locks\app-<appId>.lock   单实例锁（pid + 存活检测 + 死锁清理）
    ├─ logs\sidecar-YYYYMMDD.log
    ├─ state\health.json   最近一次健康快照
    └─ diagnostics\<ts>.zip

### 6.2 prefs.json

    {
      "version": 1,
      "appId": "<appId>",
      "peers": {
        "qqbot:<appId>:c2c:<openid>": {
          "kernelSessionId": "<uuid>",
          "createdAt": 1732000000000,
          "lastActiveAt": 1732003600000,
          "agent": "standard",
          "provider": "inferhub-provider",
          "model": "deepseek-v3.2"
        }
      }
    }

写入策略：临时文件 + `fsync` + 原子 rename；损坏时备份为 `prefs.corrupt.<ts>.json` 并从空表启动（会话可重建）。

### 6.3 access.json（含撤销语义）

    {
      "revision": 12,
      "c2c":   { "mode": "open",  "allow": ["<openid>"] },
      "group": { "mode": "allowlist", "allow": ["<group_openid>"] },
      "command": { "mode": "allowlist", "allow": [] },
      "pairing": [
        { "code": "K7F2QM", "kind": "c2c", "createdAt": 0, "usedBy": ["<openid>"] }
      ],
      "revoked": [{ "kind": "c2c", "id": "<openid>", "at": 0 }]
    }

规则：
1. 更新必须携带 `revision`，不匹配返回 `409`（防并发覆盖，沿用 dsh 语义）。
2. 配对码一次性/可续用由配置决定；`revoked` 中的身份**不能被旧码加回**。
3. 撤销后立即断开该 peer 的在途会话（取消 turn）。

### 6.4 凭据

| 平台 | 存储 |
|---|---|
| Windows | DPAPI（`CryptProtectData`，CurrentUser 作用域） |
| macOS | Keychain（`keytar`） |
| Linux | Secret Service（`libsecret`），不可用时降级 0600 文件 + 明示风险 |

密钥项：`codearts-qqbot/appId`、`codearts-qqbot/appSecret`、`codearts-qqbot/ipcToken`。

---

## 7. 兼容性设计

### 7.1 版本探测

    info() →
      1) 优先 /api/info（若存在）
      2) 退化为 /v1/* 探针（HEAD /v1/skill）
      3) 全部失败 → 判定 "unknown"，进入只读兼容模式

### 7.2 能力位与降级矩阵

| 能力缺失 | 行为 |
|---|---|
| `event.delta` | 关闭流式，仅整段发送；UI 标注"当前内核不支持流式" |
| `permission` | 使用静态策略（workspace-write），不弹按钮；日志记 `permission_unavailable` |
| `deliverable` | 仅文本告知文件路径；不主动发文件 |
| `session.exists` | 按"存在"处理，拒绝同名重建（fail-loud） |
| `compact` | `/compact` 返回"当前内核不支持" |
| `model.set` | `/model` 只读展示 |
| `session.resume` | 每次新建会话，历史丢失需提示 |

### 7.3 兼容性矩阵与回归

    npm run compat                    # health / config / session.create / event / delete
    npm run compat -- --with-prompt   # 追加一次真实推理验证（消耗少量额度）

输出 `compat-matrix.json`：`{ kernelVersion, capabilities, cases, events, ok }`；
核心用例失败退出码 1，未发现运行中内核退出码 2。

**实测基线（2026-11-20）**：内核 `126.11.2-20261117200150`，5 项用例全 PASS；
事件包含 `server.connected / message.updated / message.part.updated / message.part.delta / session.idle`。

每次码道升级：先跑该矩阵确认契约，再合并业务改动。**任一核心用例失败即阻断发布。**

---

## 8. 安全性设计

### 8.1 威胁模型（STRIDE 摘要）

| 威胁 | 场景 | 对策 |
|---|---|---|
| Spoofing | 伪造 QQ 用户/群身份 | 只信官方 WS 下发的 openid；不解析昵称做鉴权 |
| Tampering | 篡改本地配置/prefs | 配置文件 ACL 收紧；IPC token；写入原子化 |
| Repudiation | 谁批准了危险操作 | 审计日志（who/what/when/decision/requestId） |
| Information disclosure | 代码/密钥外泄到 QQ | 敏感文件排除（`.env*`、`*.pem`、`id_rsa`）；发送前路径白名单 + 内容扫描 |
| DoS | 群内刷屏触发大量 turn | 每 peer 队列上限 + 全局并发 + 频控 + 熔断 |
| Elevation of privilege | 陌生人驱动本地 shell | 默认私聊 open / 群聊 allowlist；危险工具审批；沙箱 |

### 8.2 权限矩阵

| 操作 | 私聊所有者 | 群成员（@） | 白名单外 |
|---|---|---|---|
| 文本问答 | ✅ | ✅（默认 requireMention） | ❌ |
| 读取工作区文件 | ✅（workspace-write） | ✅ | ❌ |
| 执行 shell / 网络 | ⚠️ 需审批 | ⚠️ 需审批 + 群管理员 | ❌ |
| 发送本地文件 | ✅（白名单路径） | ⚠️ 需审批 | ❌ |
| 切换模型 / compact | ✅ | ❌ | ❌ |
| 修改白名单 | ✅（本机 UI） | ❌ | ❌ |

### 8.3 安全实现要点

1. **最小权限默认值**：`access.c2cMode=open`（个人场景便利），`groupMode=allowlist`，`commandMode=allowlist`。
2. **审批不可绕过**：即使配置 `showToolResults=false`，审批卡片始终发送。
3. **路径校验**：`realpath` 后必须在 `{media, workspace, extraRoots}` 内；拒绝符号链接穿越与 UNC 路径。
4. **日志脱敏**：`appSecret`、`access_token`、`openid`（部分掩码）、文件内容摘要不入日志。
5. **供应链**：依赖精确锁版本 + SBOM；sidecar 二进制签名校验；禁用运行时安装。
6. **数据出境提示**：首次启用弹一次确认，勾选后写 `consent.json`（可撤销）。
7. **审计**：append-only `audit.jsonl`，保留 30 天，仅本人可读。

---

## 9. 稳定性设计

### 9.1 SLO

| 指标 | 目标 | 采集 |
|---|---|---|
| 消息接入成功率 | ≥ 99.5% | 收到即计数 |
| 首字延迟 P95 | ≤ 3s（不含模型时间） | turn/start→首个 delta |
| 回复投递成功率 | ≥ 99.9% | 发送结果 |
| 重连恢复时间 | ≤ 30s | 断开→online |
| 进程崩溃率 | ≤ 1 次/7 天 | 看门狗计数 |

### 9.2 关键机制

| 机制 | 设计 |
|---|---|
| 单实例 | appId 级文件锁（`locks/app-<appId>.lock`，`wx` 原子创建 + pid 存活检测 + 死锁清理）；第二个实例直接退出 |
| 看门狗 | 扩展每 15s 检查 sidecar；失败退避重启（5s→…→60s，最多 5 次；稳定运行 60s 后重置计数） |
| 内核健康 | `health()` + 熔断 CLOSED/OPEN/HALF_OPEN；401 明确提示口令问题 |
| 背压 | 每 peer 队列 `maxQueue`；命令 / 配对码 / 审批 / 问答回答走**优先路径**，不被阻塞的 prompt 卡住 |
| 幂等 | `messageId` 表 + `callId` 去重 + `requestId` 单次决策 |
| 超时 | `promptTimeoutMs` 默认 300s；超时后继续等 `session.idle`，不中断整轮 |
| 流式容错 | 按 `messageId` 分段；`partID → type` 过滤 reasoning；`turn/end` 合并兜底 |
| 出站限流 | 同一 `msg_id` 第 2 条起递增 `msg_seq`；超过 5 条自动降级主动消息 |
| 优雅退出 | SIGTERM → 停止接入 → 等在途 ≤10s → 落盘 → 释放锁 |
| 资源回收 | 闲置 session dispose；media TTL 清理；日志按天滚动保留 7 天 |

### 9.3 故障演练清单

1. 拔网 30s / 5min / 断网期间用户发消息。
2. 杀 sidecar、杀内核、杀 IDE。
3. QQ 侧限频（429）连续 10 次。
4. 大文件（200MB）上传/下载中断。
5. 时钟跳变、磁盘满、权限被收回。

---

## 10. 可维护性设计

### 10.1 分层与契约测试

| 层 | 测试方式 | 门禁 |
|---|---|---|
| qqbot-core | 纯函数单测，覆盖率 ≥ 85% | PR 必过 |
| kernel-port | fixtures 回放（真实事件流） | 内核升级必跑 |
| runtime | 集成测试（mock QQ + mock kernel） | PR 必过 |
| extension | VS Code 扩展测试（命令/视图注册） | 发布前 |
| e2e | 真机 + 真实内核冒烟 | 发布前 |

### 10.2 可观测性

**结构化日志字段**：`ts, level, module, sessionKey, sessionId, turn, callId, requestId, elapsedMs, code, msg`（msg 必脱敏）。

**指标（本地 JSON，可选上报）**：`msg_in_total`、`turn_total`、`turn_error_total{code}`、`first_token_ms`、`send_fail_total`、`ws_reconnect_total`、`kernel_health_fail_total`、`queue_depth`。

**诊断包**：版本矩阵 + 最近 3 天日志（脱敏）+ 配置快照（去密钥）+ 健康快照 + prefs 摘要（不含内容）。一键导出 zip。

### 10.3 发布与回滚

| 项 | 设计 |
|---|---|
| 版本 | sidecar 与 VSIX 独立版本号，但 `engines.codearts` 声明兼容范围 |
| 灰度 | sidecar 支持 `channel=stable|beta` 配置，beta 走独立目录 |
| 回滚 | VSIX 可安装旧版；sidecar 保留上一版本二进制，扩展可 `runtime.rollback` |
| 变更通知 | 内核升级前由对接人同步"事件映射表"变更，先改表再改码 |

---

## 11. 便利性与易用性设计

### 11.1 开发者便利

| 能力 | 说明 |
|---|---|
| 零依赖起步 | `mock-port` + `fixtures`，不装码道也能跑通传输层与对话编排 |
| 一键录制 | `pnpm fixture:record` 连真实内核录事件流，自动脱敏后入 `fixtures/` |
| 契约先行 | 改行为先改 `normalize.spec.ts` 与映射表，代码跟着测试走 |
| 本地联调 | `pnpm dev` 同时起 sidecar(mock) + 扩展调试宿主（F5） |
| 类型安全 | 全 TS，`strict`；IPC 与配置用 zod 校验，边界即运行时校验 |
| 快速定位 | 每条日志带 `sessionKey`，QQ 消息 ID 与 `turn` 可双向检索 |

### 11.2 终端用户易用

| 场景 | 设计 |
|---|---|
| 首次使用 | 「QQ Bot: 扫码绑定机器人」→ 手机 QQ 扫码官方页面 → 成功即自动启动；失败可刷新或手动填写 |
| 访问管理 | 「QQ Bot: 管理访问名单」QuickPick：查看 / 增删 / 撤销 / 切模式 / 生成配对码（自动复制） |
| 提问交互 | Agent 提问时推送字母选项（A/B/C），回复字母或 `A,C`；多问题用 `A;B` |
| 审批 | 回复 `1` 允许 / `2` 拒绝；`/allow` `/deny` 仍可用 |
| 状态可见 | 状态栏三态；「显示状态」输出管道、sidecar 路径、内核地址/版本、口令来源等诊断 |
| 错误人话化 | 保留原有文案，新增"文件不在允许范围""二维码已过期，正在刷新"等 |
| 群聊可控 | 默认必须 @；`groupMode` 默认 allowlist，联调可临时 open |
| 无感恢复 | IDE 重启后自动 resume；端口与口令漂移自动重新发现 / 解密 |
| 思维链 | 只推送最终回答，reasoning 增量按 `partID → type` 过滤 |

### 11.3 配置体验

- 90% 场景零配置：装完扫码即可用。
- 高级项集中在侧栏"高级"折叠区，带默认值与说明。
- 修改配置后**热生效**（sidecar 监听 IPC `config.set`），仅需重启的部分明确标注"需重启"。

---

## 12. 风险与收益

### 12.1 设计层面的残余风险

| ID | 风险 | 触发信号 | 设计对冲 |
|---|---|---|---|
| R1 | 内核事件契约变更 | 兼容矩阵核心用例失败 | 映射表 + 能力位 + 只读兼容模式 + 快速回滚 |
| R2 | 微内核端点不公开导致 P0 失败 | 无法创建独立 session | 降级为"扩展桥接 + 同进程客户端"，必要时转 Space 渠道 |
| R3 | 审批链路不通 | permission 事件收不到 | 静态策略兜底（workspace-write）+ 明确告知用户 |
| R4 | Credits 消耗超预期 | 单用户日消耗突增 | 日限 + 告警 + 群聊更严的并发 |
| R5 | 长会话内存增长 | RSS 曲线上升 | 闲置回收 + 会话上限 + 流式 buffer 上限 |
| R6 | 安全事件（越权执行） | 审计异常 | 默认最小权限 + 审批 + 沙箱 + 审计 |
| R7 | 扩展市场审核不通过 | 审核驳回 | 侧载渠道 + 开源仓库 + 官方合作 |

### 12.2 收益结构

| 类型 | 内容 |
|---|---|
| 用户价值 | 手机随时下达任务；离开工位仍可推进；群内协作共享同一 Agent |
| 工程价值 | 传输/切分/限流/会话映射约 50%~65% 可复用；`KernelPort` 可复用给其他宿主 |
| 生态价值 | 首个"码道 × 第三方 IM"样板，沉淀 ImAdapter |
| 商业价值 | 提升时长与留存，带动 Credits 消耗；企业版可售 |

---

## 13. 可推广性

### 13.1 横向：ImAdapter 抽象

    interface ImAdapter {
      id: "qq" | "wecom" | "feishu" | "dingtalk" | "slack";
      start(cfg): Promise<void>;
      onMessage(h: (m: InboundMessage) => void): void;
      send(target: Target, payload: OutPayload): Promise<void>;
      askButtons(target, q: Question): Promise<Answer>;
      uploadFile(target, file: Path): Promise<void>;
      resolveIdentity(raw): PeerIdentity;
    }

QQ 只是第一个实现；`qqbot-core` 中除 `transport/limiter`（QQ msgid 语义）外均可复用。接第二个渠道预计只新增一个 adapter + 少量策略。

### 13.2 纵向：个人 → 企业

- 个人版：D1 单机，DPAPI，私聊为主。
- 企业版：D3 内网 sidecar + 统一策略下发（白名单、禁用工具、审计上报）。
- 云端版：D4 Space 渠道，复用既有钉钉/飞书账号体系与文档。

### 13.3 跨宿主：KernelPort 多实现

同一运行时可挂 `http-port`（码道）、`plugin-port`（码道内核插件）、`dsh-port`（DeepSeek Harness）。**"跨 Agent 宿主的 IM 网关"** 是比单一插件更大的复用面，也是对外开源时最有说服力的定位。

### 13.4 推广前置条件

1. 内核契约有官方口径（至少承诺事件名与端点稳定性窗口）。
2. 分发渠道明确（市场审核规则 / 侧载政策）。
3. 计费口径明确（第三方插件调用是否计费、如何计）。

---

## 14. 交付计划与验收

> 以"验收标准"驱动，不做时间承诺。

### 14.0 当前实现状态（0.3.1）

| 能力 | 状态 |
|---|---|
| 扫码绑定（官方 `startQrConnect`）+ 自动启动 | ✅ 已实现并打包 |
| 私聊 / 群聊、会话持久化、流式、多步合并 | ✅ |
| 访问名单持久化 + 管理命令 + 配对码 | ✅ |
| 审批（数字 1/2）/ 提问（字母）/ 思维链过滤 | ✅ |
| 媒体下载 / 文件回传（失败降级为路径文本） | ✅ |
| 单实例锁 / 熔断 / 兼容矩阵脚本 | ✅ |
| 审批按钮卡片、主动推送、驻留模式、多 IM Adapter、市场发布 | ⬜ 未实现 |

### P0 契约验证（决策门）

| 交付物 | 验收标准 |
|---|---|
| `KernelPort` 的 http 实现 + `normalize` 骨架 | 能 create/resume/prompt 并收到完整回复 |
| 事件映射表 v1 | 8 类统一事件中至少 5 类可稳定产出 |
| 兼容性报告 | 明确能力位清单与不可用项 |
| fixtures 基线 | 录制 ≥10 条真实事件流并回放通过 |

**决策门**：无法创建独立 session 或拿不到 `message/complete` → 方案降级（转扩展桥接或 Space 渠道）。

### P1 可用版本

| 模块 | 验收标准 |
|---|---|
| 私聊/群聊 | 群内非 @ 不响应；@ 后正确回复 |
| 会话 | 重启 IDE 后自动恢复；20 并发 peer 不串话 |
| 流式 | 单聊流式可用；断开流式自动降级 |
| 访问控制 | 三模式 + 配对码 + 撤销生效 + revision 冲突返回 409 |
| 绑定 UI | 扫码 3 步内完成；失败有可操作提示 |
| 命令 | 7 个命令全部可用且有帮助文案 |
| 稳定 | 24h 压测无崩溃；断网 10 次自愈；单实例互斥有效 |

### P2 生产增强

| 模块 | 验收标准 |
|---|---|
| 审批/提问 | 按钮决策唯一生效；非对端点击无效；超时自动拒绝 |
| 媒体 | 图片理解可用；文件回传受路径白名单约束；TTL 清理生效 |
| 主动推送 | 定时任务回合可推送到 QQ；可关闭 |
| 可观测 | 诊断包一键导出且不含密钥；指标可用于定位 |
| 兼容 | 内核升级后回归矩阵全绿；只读兼容模式可回滚 |

### 发布门禁

1. 单测覆盖率：core ≥ 85%，port ≥ 75%。
2. 安全评审：路径穿越、越权审批、凭据存储三项必过。
3. 兼容矩阵：核心 6 用例全绿。
4. 文档：安装、配置、命令、故障排查、隐私说明齐备。

---

## 15. 待确认问题（阻塞设计冻结）

| # | 问题 | 影响 | 责任方 |
|---|---|---|---|
| Q1 | 内核本地监听方式（端口分配/鉴权/是否仅回环） | 决定 http-port 可行性 | 内核团队 |
| Q2 | 事件类型与字段的稳定承诺 | 决定映射表与兼容策略 | 内核团队 |
| Q3 | `~/.codeartsdoer/extensions` 加载规则与签名要求 | 决定 plugin-port 是否可做 | 内核团队 |
| Q4 | Permission 是否可被外部客户端应答 | 决定审批方案 | 内核团队 |
| Q5 | 第三方插件调用模型是否计费 | 决定产品策略 | 产品/计费 |
| Q6 | 市场审核对"外部长连接 + 凭据"类插件的要求 | 决定分发路径 | 生态/审核 |
| Q7 | `startDigitalAvatar` 的 `ideType` 枚举与协议 | 可能直接复用官方 IM 协议 | 内核/产品 |

---

## 附录 A：错误码表（节选）

| 码 | 含义 | 用户文案 | 可重试 |
|---|---|---|---|
| QB-1001 | 凭据无效 | QQ 机器人密钥无效，请重新绑定 | 否 |
| QB-1002 | WS 连接失败 | 正在重连 QQ…（第 N 次） | 是 |
| QB-2001 | 内核未就绪 | 码道内核未启动，点此重启 | 是 |
| QB-2002 | 会话创建失败 | 会话创建失败，请稍后重试 | 是 |
| QB-2003 | 会话恢复失败 | 上次会话无法恢复，已为你新建 | 否 |
| QB-3001 | 轮次超时 | 本次任务超时已中止，可重新发起 | 是 |
| QB-3002 | 模型额度不足 | 当前账号额度不足，去查看用量 | 否 |
| QB-4001 | 越权访问 | 你不在本机器人的使用名单中 | 否 |
| QB-4002 | 路径不允许 | 该文件不在允许发送的范围内 | 否 |
| QB-5001 | 消息过长 | 内容过长，已分成多条发送 | — |

## 附录 B：命令清单

| 命令 | 别名 | 作用 | 权限 |
|---|---|---|---|
| `/new` | `/reset` `/clear` | 新建会话 | 白名单 |
| `/compact` | — | 压缩历史 | 白名单 |
| `/model` | — | 查看/切换模型 | 白名单 |
| `/stop` | — | 中止当前生成 | 白名单 |
| `/allow` | `/approve` `/yes` | 批准审批请求 | 白名单 |
| `/deny` | `/reject` `/no` | 拒绝审批请求 | 白名单 |
| `/bot-status` | — | 会话与内核状态 | 所有人 |
| `/bot-ping` | — | 传输/处理时延 | 所有人 |
| `/bot-help` | — | 命令清单 | 所有人 |

## 附录 C：配置最小示例

    {
      "codeartsQqbot.enabled": true,
      "codeartsQqbot.workspace": "E:\\ws\\my-project",
      "codeartsQqbot.requireMention": true,
      "codeartsQqbot.access.groupMode": "allowlist",
      "codeartsQqbot.access.commandMode": "allowlist",
      "codeartsQqbot.sendFile.restrict": true,
      "codeartsQqbot.media.ttlHours": 24
    }

## 附录 D：与评估报告的差异说明

| 项 | 评估报告 | 本设计文档 |
|---|---|---|
| 定位 | 判断可行性与形态选型 | 冻结实现契约与验收标准 |
| 形态 | 三种形态对比 | 选定 C+B，A 留 P2 |
| 事件层 | 指出需重写 | 给出统一事件模型与映射表 |
| 安全 | 列风险 | 给出威胁模型、权限矩阵、审计格式 |
| 稳定 | 列策略 | 给出 SLO、状态机、演练清单 |
| 交付 | 路线图 | 以验收门禁驱动，明确 P0 决策门 |