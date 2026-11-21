# 方案 A 实施说明：扩展 ↔ sidecar 内核连接下发

| 项目 | 内容 |
|---|---|
| 方案 | A（扩展持有连接信息，通过本机 IPC 下发给 sidecar） |
| 涉及包 | `qqbot-ipc`（新增）、`vscode-extension`、`qqbot-runtime` |
| 状态 | 框架完成并已验证；口令可通过官方加密存储**只读解密**（实测 `health=OK`），自动化集成待做 |
| 上游 | `docs/kernel-probe-report.md`（内核契约探测） |

---

## 1. 目标与约束

**目标**：不把内核地址/凭据硬编码进 sidecar，由扩展在运行时发现并下发，sidecar 只负责 QQ 通道与会话编排。

**硬约束（探测已确认）**：
1. 内核只监听 `127.0.0.1`，使用 HTTP Basic（`realm="Secure Area"`，用户名 `codearts`）。
2. 口令由码道扩展生成，并以 **AES-256-GCM + scrypt** 加密落盘在 `KERNEL_DATA_DIR/custom-dir`（早期误判为"仅内存"，已纠正）。
3. 扩展可在本机**只读复现官方解密流程**取得口令（已实测可用）；方案 A 仍需区分"地址自动发现"与"口令来源"。

---

## 2. 时序

    ┌────────────┐         ┌──────────────┐        ┌─────────────────┐        ┌──────────────┐
    │ VS Code    │         │ qqbot 扩展    │        │ sidecar          │        │ 码道内核      │
    └────────────┘         └──────────────┘        └─────────────────┘        └──────────────┘
          │  启动扩展             │                        │                          │
          │────────────────────>│  spawn(sidecar,          │                          │
          │                     │   --ipc-pipe,--ipc-token)│                          │
          │                     │───────────────────────>│  IpcServer.start()        │
          │                     │  读取 server_config.properties                     │
          │                     │  （端口/版本，不含口令）    │                          │
          │                     │  IPC kernel.set ───────>│  记录连接信息              │
          │                     │                        │  HttpKernelPort(baseUrl,  │
          │                     │                        │    basicAuth?) ─────────>│ /global/health
          │                     │  IPC status.get <──────│                          │
          │                     │  IPC status.changed <──│  状态广播                 │

---

## 3. IPC 协议

传输：NDJSON over Windows 命名管道（`\\.\pipe\codearts-qqbot-vscode`）或 UDS。

| 方法 | 方向 | 参数 | 返回 |
|---|---|---|---|
| `ipc.auth` | client→server | `{token}` | `{ok:true}` |
| `ipc.ping` | client→server | — | `{pong:true, at}` |
| `kernel.get` | client→server | — | `KernelConnection \| null` |
| `kernel.set` | client→server | `KernelConnection` | `{ok:true}` |
| `status.get` | client→server | — | `{online, kernel}` |
| `status.changed` | server→client | `{state}` | 通知 |

`KernelConnection`：

    {
      "baseUrl": "http://127.0.0.1:20553",
      "basicAuth": { "username": "codearts", "password": "***" },   // 可缺省
      "source": "discovered" | "manual" | "config",
      "version": "126.11.1-20261110192452"
    }

---

## 4. 安全设计

| 风险 | 措施 |
|---|---|
| 任意本机进程伪造扩展 | IPC token 由扩展每次启动生成（`randomUUID`），随进程参数注入 sidecar；未认证连接一律拒绝 |
| 凭据泄露 | 口令只存在于扩展 SecretStorage 与 sidecar 内存；不写配置、不进日志、不进诊断包 |
| 网络暴露 | 只使用命名管道/UDS，不监听 TCP |
| 权限提升 | 内核连接只允许回环地址（`HttpKernelPort` 构造时校验） |
| 重放/超时 | 请求按 id 配对，默认 8–15s 超时；连接断开时挂起请求统一失败 |

---

## 5. 口令来源（按优先级）

| 优先级 | 来源 | 状态 |
|---|---|---|
| 1 | 复现官方加密存储解密（`KERNEL_DATA_DIR/custom-dir` + `4/data`） | **已实测可用**：`health=OK`、`agents=66`、`providers=2`；只读，不打断码道 |
| 2 | 官方接口（扩展命令） | 待确认；`snap.registerExtension` 已证伪（prompt 任务扩展，非 Agent 接入） |
| 3 | 用户在「QQ Bot: 设置内核连接」中录入 | 已实现（写入 SecretStorage） |
| 4 | 配置文件（不推荐） | 未提供，避免明文 |

> 解密格式（脚本：`scripts/read-kernel-secret.mjs`）：
> `secret = base64(4/data)`；`salt/iv` 取自 `2/data`、`3/data`；`authTag/ciphertext` 在 `custom-dir/data`；算法见 `1/data`；
> 以 `scrypt(secret, salt, 32, {N:65536,r:8,p:1})` 派生密钥，AES-256-GCM 解密。
> 明文只写入 `.local/kernel-password.txt`（0600，已加入 `.gitignore`），不打印到 stdout。

---

## 6. 失败与降级

| 场景 | 行为 |
|---|---|
| sidecar 未启动 | 扩展按 2s/4s/…/20s 退避重连 IPC |
| 未发现内核 | 下发跳过，日志提示检查码道是否启动 |
| 口令缺失 | 只下发 `baseUrl`；sidecar 健康检查返回 401 → 退出码 4 并给出明确提示 |
| 内核不健康 | sidecar 以退出码 4 结束；扩展状态灯转红，可一键重启 |
| 需要回退 mock | `QQBOT_KERNEL_MODE=mock npm run run:qq` |

---

## 7. 已验证

| 项 | 结果 |
|---|---|
| IPC 认证 / 拒绝错误 token / 未认证拒绝 | 通过（5 项单测） |
| `kernel.set` → `kernel.get` 回读 | 通过 |
| 服务端广播通知 | 通过 |
| 内核端口自动发现 | 通过（读取 `server_config.properties`） |
| 全量门禁 | `layers ok`、`tsc` 0 error、**81 项测试全绿（12 文件）** |

---

## 8. 待办

1. 与官方确认 `snap.registerExtension` 的参数与能力（能否直接拿到 kernel client / 会话事件）。
2. 扩展打包（esbuild + VSIX）后做一次真实联调：启动码道 → 扩展 → sidecar → QQ 发消息。
3. 口令录入 UI 增加"仅本机有效"的校验（尝试 `/global/health` 后再保存）。
4. 诊断包加入 IPC 连接状态与内核版本（已加版本，连接状态待补）。