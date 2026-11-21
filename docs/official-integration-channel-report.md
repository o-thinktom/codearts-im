# 码道官方接入通道探测归档报告

| 项目 | 内容 |
|---|---|
| 文档类型 | 探测归档（结论 + 证据 + 待办） |
| 探测对象 | CodeArts Agent v26.11.100 / 内核 `126.11.1-20261110192452` |
| 探测日期 | 2026-11-19 |
| 结论 | **当前客户端版本不存在可用的第三方本地接入点**；`snap.registerExtension` 与 `/im/welink` 均无法用于 QQ 接入 |
| 后续动作 | 暂缓开发，等待官方提供 message bridge runtime 或 Space 支持 QQ |
| 关联文档 | `docs/kernel-probe-report.md`、`docs/solution-a-ipc.md` |

---

## 1. 背景

插件端到端链路卡在内核 Basic Auth：口令由码道扩展注入内存、不落盘，第三方扩展无法获取。为绕开这一限制，本次探测两个候选官方通道：

1. `snap.registerExtension` —— 扩展注册命令，原本推测可能暴露 host/client 能力；
2. `POST /im/welink/start`（数字分身）—— 内核自带的 IM 接入框架，原本推测可能支持自定义 `ideType` + 外部 webserver。

目标：判断是否存在**官方、可持续、无需口令**的接入点。

---

## 2. 探测方法

| 方法 | 说明 |
|---|---|
| 静态分析 | 从 `extensions/vscode-codebot/out/extension.js` 还原命令注册与函数实现 |
| 契约读取 | `GET /doc` 导出 OpenAPI 3.1.1（`docs/kernel-openapi.json`） |
| 隔离沙盒实测 | 独立端口 + 独立数据目录 + 自设 Basic Auth 启动内核，调用真实端点 |
| 二进制检索 | 在内核可执行文件中检索错误码与运行时符号 |
| 官方文档核对 | 华为云码道用户指南（智能体、MCP、IM 集成章节） |

**全程未使用口令牌，未修改用户数据，未消耗模型额度。**

---

## 3. `snap.registerExtension` 探测结论

### 3.1 真实签名（从 bundle 还原）

```js
function registerExtension(id, version, commandId, language, tasks) {
  for (const task of tasks) {
    if (!SUPPORTED_TASKS.includes(task)) {
      logger.error(`[ExtensionService] Unsupported extension task: ${task}.`);
      continue;
    }
    registry[language].push({ id, version, commandId, language, tasks });
  }
}
```

### 3.2 支持的任务类型

`CODE`、`UT`、`WIRELESSCODEGEN`、`WIRELESSRECORD`、`TERMINALUT`。

### 3.3 结论

| 判断项 | 结果 |
|---|---|
| 是否提供 Agent client / session / event | ❌ |
| 是否提供内核连接信息或口令 | ❌ |
| 实际用途 | 向 prompt-master 注册代码生成 / 单元测试的预处理与后处理命令 |
| 能否用于 QQ 接入 | ❌ 不相关 |

**已证伪**：该命令不是通用扩展点，继续投入没有意义。

---

## 4. `/im/welink/*` 数字分身探测结论

### 4.1 契约（OpenAPI）

```text
POST /im/welink/start
  body: {
    appid, appsecret, ideType, pluginName,
    webserverPath, scenario,
    config: { workspace, env }
  }

GET  /im/welink/status/{ideType}?appid=
POST /im/welink/stop { ideType, appid, appsecret?, force? }
GET  /im/welink/list?appid=&ideType=
```

### 4.2 参数实测纠正

| 参数 | OpenAPI 描述 | 实测 |
|---|---|---|
| `pluginName` | "预留字段，目前无业务" | **必填**，缺失返回 `appid, appsecret, ideType and pluginName are required` |
| `webserverPath` | "webserver 可执行文件路径" | 官方扩展实际传的是 **内核自身 exe 路径**（`AgentKernel_*.exe`），不是外部 webserver |

`webserverPath` 的语义纠正来自安装包内调用代码：

```js
const kernelExe = path.join(homedir(), ..., `AgentKernel_${version}${ext}`);
const payload = { scenario, webserverPath: kernelExe, ideType, appid, appsecret, pluginName,
                  config: { workspace } };
```

### 4.3 实测结果

| ideType | 结果 |
|---|---|
| `qq-probe` | 500 `SERVER_START_FAILED` / `message_bridge_runtime_not_loaded` |
| `welink` | 500 `SERVER_START_FAILED` / `message_bridge_runtime_not_loaded` |
| `dingtalk` | 500 `SERVER_START_FAILED` / `message_bridge_runtime_not_loaded` |
| `GET /im/welink/list` | 200 `{success:true,data:[]}` |

**关键点**：连官方 `welink` / `dingtalk` 也报同一错误，说明这不是 `ideType` 不支持，而是本机**没有部署 message bridge runtime**。

### 4.4 内核内部实现线索

在内核可执行文件中检索到：

```js
Symbol.for("agent-plugin.message-bridge.runtime-api")

async function loadMessageBridge() {
  if (!runtimePath) throw Error("message_bridge_runtime_not_loaded");
  const runtime = await import(runtimePath, "explicit");
  ...
}
```

说明数字分身依赖一个**独立的 message bridge 运行时模块**；当前安装未提供该模块，扩展 bundle 中也没有注入入口（无相关环境变量或参数）。

### 4.5 结论

| 判断项 | 结果 |
|---|---|
| 是否为通用 IM 网关（任意 ideType + 外部 webserver） | ❌ |
| 是否需要官方 bridge runtime | ✅ 必需 |
| 当前客户端是否已部署 | ❌ `message_bridge_runtime_not_loaded` |
| 第三方是否有注入点 | ❌ 未发现 |
| 能否用于 QQ 接入 | ❌ 当前不可行 |

---

## 5. 官方文档现状

核对华为云码道用户指南（`support.huaweicloud.com/usermanual-codeartsagent`）：

| 官方能力 | 内容 | 是否可用作本地接入 |
|---|---|---|
| 自定义智能体 | Markdown 配置 prompt / skills / tools / model | ❌ 不是插件 API |
| MCP 工具 | 给智能体挂外部工具（被动调用） | ❌ 不能接收 IM 消息 |
| IM 集成（Space 模式） | 钉钉 / 飞书 / 企业微信，Webhook 回调方式 | ❌ 无 QQ，且不走本地内核 |
| 第三方扩展接入 Agent 内核 | **无公开文档** | ❌ |

`snap.registerExtension` 与 `/im/welink` 均未出现在官方用户指南中。

---

## 6. 现状与影响

| 项 | 状态 |
|---|---|
| QQ 通道（收/发消息、会话映射、切分、白名单、审批） | ✅ 已实现并单测通过 |
| 内核契约（session / message / SSE） | ✅ 已实测校准 |
| VSIX + sidecar 打包 | ✅ 已产出可安装产物 |
| 内核鉴权 | ❌ 第三方扩展无法获得口令 |
| 官方本地接入点 | ❌ 不存在可用通道 |

**净结果**：插件可以安装、可以拉起 sidecar、可以连 QQ；但**无法连上用户正在运行的内核实例**，因此当前无法端到端回复。

---

## 7. 待官方开放的能力（对接清单）

建议直接发给码道内核/生态团队确认：

1. **内核连接信息下发接口**：允许可信扩展获取 `baseUrl + Basic Auth`（或直接获取 client 句柄），用于第三方工具接入。
2. **message bridge runtime 规范**：公开 `agent-plugin.message-bridge.runtime-api` 的接口定义、加载方式与示例。
3. **第三方 Agent 接入 API**：是否有计划提供稳定的"扩展驱动 Agent"能力（类似 Claude Code / OpenCode 的 session API）。
4. **Space 渠道支持 QQ**：若本地通道不开放，是否可在 Space IM 集成中增加 QQ。
5. **兼容性承诺**：若开放上述任一接口，需明确版本窗口与弃用策略。

---

## 8. 备选路径（当前不实施）

| 路径 | 可行性 | 代价 | 备注 |
|---|---|---|---|
| B：自启内核兜底 | ✅ 可立即跑通 | 多一个内核进程（约 500MB RSS）；共享 `codearts-data` 需验证 SQLite 并发；验证会消耗少量额度 | 用户已选择暂缓 |
| Space 云端 QQ 渠道 | ⚠️ 依赖产品排期 | 需平台支持 QQ 机器人 | 最合规，但不可控 |
| 逆向 bridge runtime | ⚠️ 不确定 | 无注入点，可能永远无法加载 | 不建议投入 |

---

## 9. 复现方式

```bash
# 1) 内核契约与端点
node scripts/kernel-contract.mjs
node scripts/kernel-session-probe.mjs

# 2) 内核鉴权现状（401 判定）
npx tsx scripts/diagnose.ts

# 3) 数字分身参数语义验证（沙盒，不影响本机码道）
node scripts/probe-welink.mjs

# 4) 官方命令清单（静态）
rg -o 'registerCommand\("([^"]+)"' "<安装目录>/resources/app/extensions/vscode-codebot/out/extension.js"
```

产物：`docs/kernel-openapi.json`、`docs/kernel-endpoints.md`、`docs/kernel-probe-report.md`。

---

## 10. 结论

1. `snap.registerExtension` 是 prompt 任务扩展注册，**与 Agent 接入无关**。
2. 数字分身（`/im/welink`）需要官方 message bridge runtime，当前客户端**未部署且无第三方注入点**。
3. 官网没有第三方本地接入 Agent 的公开 API；IM 集成只覆盖 Space 模式的钉钉/飞书/企微。
4. 在官方开放能力之前，本项目**不具备端到端可用的本地接入路径**。

建议保持现有代码（QQ 通道 + 内核适配层 + VSIX/sidecar 打包）不变，待官方接口明确后再接入；届时只需替换 `KernelPort` 的连接来源，业务层无需改动。