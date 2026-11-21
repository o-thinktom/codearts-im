# CodeArts IM

[简体中文](README.md) | **English** | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Türkçe](README.tr.md) | [Español](README.es.md)

An IM gateway that drives the local **Huawei Cloud CodeArts Agent** through QQ (WeChat / WeCom planned). Send one message from your phone and the Agent in your desktop IDE executes the task and returns the result.

## Features

- **QR onboarding**: bind/create a bot with the official Tencent connector — no manual AppID/AppSecret entry
- **Two chat modes**: direct messages and group mentions (mention required by default)
- **Session governance**: one kernel session per peer, persisted mapping, automatic resume after IDE restart
- **Reliable delivery**: streaming deltas, multi-step merging, Markdown-aware chunking, `msg_seq` throttling with fallback
- **Human-in-the-loop**: approvals (`1` / `2`) and questions (`A/B/C`)
- **Final answers only**: chain-of-thought and synthetic prompts are filtered out
- **Media**: inbound image/file download and decryption, outbound file delivery with text-path fallback
- **Access control**: open / allowlist / disabled, pairing codes, revocation, single-instance lock
- **Verifiable**: `npm run compat` kernel compatibility matrix for upgrade regression

## Architecture

    QQ Open Platform (WebSocket)
      ↕
    sidecar (single Node SEA binary)
      ↕ local IPC (named pipe + one-time token)
    VS Code extension (VSIX)
      ↕ loopback HTTP + SSE
    CodeArts Agent Kernel (Session / Tools / Permission / Skills)

- Credentials and the kernel stay on the local machine; the sidecar never exposes a public listener;
- `KernelPort` is the only kernel boundary; the QQ transport lives in `adapters/qq`;
- The extension owns lifecycle, QR onboarding, kernel port discovery and secret decryption.

## Compatibility

| Item | Supported | Notes |
|---|---|---|
| OS | Windows 10 1809+ / Windows 11 (x64) | Published artifact is win32-x64; macOS/Linux must be built on the target platform |
| CodeArts Agent | ≥ 26.11.100 | Verified on 26.11.x |
| Agent Kernel | 126.11.x | Verified on `126.11.2-20261117200150` |
| VS Code API | `^1.109.0` | Stable APIs only |
| QQ Open Platform | Bot WebSocket API v2 | Sandbox or production bot |
| Node.js (development only) | ≥ 20.3 | End users need nothing; the sidecar bundles its runtime |

Compatibility checks:

    npm run compat                    # read-only + session create/delete
    npm run compat -- --with-prompt   # adds one real inference (small quota cost)

## Version

- Current: **0.3.2** (Semantic Versioning; interfaces may change during 0.x)
- Compatibility baseline: CodeArts Agent 26.11.100 / Kernel 126.11.2
- Upgrade policy: run the compatibility matrix after any IDE/kernel upgrade before upgrading the plugin
- Change history: repository commits and the design documents under `output/`

## Installation

Requirements: Windows x64, CodeArts Agent 26.11.x. Node.js is **not** required.

    & "<CodeArts install dir>\bin\codearts-agent.cmd" --install-extension "<path>\codearts-qqbot-cn-0.3.2.vsix"

Alternatively use “Install from VSIX” in the Extensions view, then run “Developer: Reload Window”.

## Quick start

1. Start CodeArts Agent and complete one chat so the kernel is running;
2. Command Palette → “QQ Bot: 扫码绑定机器人” (Scan QR to bind);
3. Scan the official QR code with mobile QQ and finish creation/binding on Tencent’s page;
4. Credentials are stored in the system secret storage and the connection restarts automatically;
5. Send a direct message to the bot.

If scanning is unavailable, use “QQ Bot: 手动填写凭据” (manual credentials) as a fallback.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `codeartsQqbot.provider` | `inferhub-provider` | Model provider |
| `codeartsQqbot.model` | `deepseek-v4.1-flash-1017` | Model ID — do not leave empty |
| `codeartsQqbot.agent` | `build` | Agent to use |
| `codeartsQqbot.access.c2cMode` | `open` | Direct-message access mode |
| `codeartsQqbot.access.groupMode` | `allowlist` | Group access mode (keep for production) |
| `codeartsQqbot.textChunkLimit` | `4500` | Max characters per message |
| `codeartsQqbot.media.maxMB` | `200` | Inbound media size limit |
| `codeartsQqbot.sendFile.restrict` | `true` | Restrict outbound file paths |

## Commands

| Command | Purpose |
|---|---|
| `/new` | Start a new session |
| `/compact` | Compact context |
| `/model` | Show / switch model |
| `/stop` | Abort the current turn |
| `/allow`, `/deny` | Approve / reject a request |
| `/bot-status`, `/bot-ping`, `/bot-help` | Status, latency, help |

## Security and data

- AppSecret and kernel password live only in the system secret storage or memory — never in config, repo or logs;
- The kernel password is read from the official encrypted store via read-only decryption, with manual fallback;
- Outbound files are validated with `realpath` allowlists (workspace + media), 20 MB per file;
- Logs and diagnostics redact secrets, tokens and openids;
- Only final answers are delivered; reasoning and synthetic prompts never reach QQ.

## Build

Development environment: Windows x64, Node.js ≥ 20.3, CodeArts Agent 26.11.x for integration.

    npm install
    npm run check            # layer rules / types / unit tests
    npm run build:sidecar    # Node SEA single executable
    npm run package:vsix     # build the extension and package a VSIX

## Open source components & acknowledgements

| Component | Version | Purpose | License |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | QQ QR onboarding and WebSocket connection | **UNLICENSED** (Tencent proprietary; subject to its terms) |
| `qrcode` | 1.5.4 | QR rendering | MIT |
| `esbuild` | 0.24.x | Bundling | MIT |
| `TypeScript` | 5.x | Type system and build | Apache-2.0 |
| `Vitest` | 2.1.x | Unit tests | MIT |
| `tsx` | 4.23.x | Run TypeScript in development | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | WeChat/WeCom protocol reference (not a direct dependency) | MIT |
| CodeArts Agent / Agent Kernel | 26.11.x / 126.11.x | Host and kernel | Huawei Cloud product terms |

Acknowledgements: Tencent QQ Open Platform and the DeepSeek Harness community (`dsh-qqbot`, `dsh-im`) for publicly documented protocol and interaction practices.

> **Distribution note**: `@tencent-connect/qqbot-connector` is marked UNLICENSED. Confirm Tencent’s licensing terms before distributing packaged VSIX/sidecar artifacts.

## Known limitations

- Windows x64 artifacts only; other platforms require a native build;
- Tightly coupled to CodeArts Agent/kernel versions — regression testing is required after upgrades;
- QQ passive-reply window is about 5 minutes and at most 5 replies per message;
- Groups default to allowlist; `open` is only for local integration;
- Approvals and questions are text-based (digits/letters); button cards are not implemented yet.

## Troubleshooting

Open the “CodeArts QQ Bot” output channel and read the log markers:

| Log | Meaning |
|---|---|
| `sidecar binary not found` | The VSIX lacks `bin/`; reinstall |
| `ipc bridge connected` | Extension and sidecar are connected |
| `已从码道加密存储获取内核口令` | Kernel password obtained automatically |
| `sidecar running` / `qq bot ready` | Service and QQ connection ready |
| `qq message received` | Inbound QQ message received |
| `inbound accepted` / `kernel prompt sending` | Forwarded to the kernel |
| `reply sending` / `outbound send failed` | Delivery result and failure reason |

## Contributing

Issues and pull requests are welcome. Please ensure `npm run check` passes, add tests for new logic, and explain the *why* in commit messages.

## License

Project code is licensed under **MIT**. Third-party components keep their own licenses; `@tencent-connect/qqbot-connector` is UNLICENSED — verify authorization before redistribution.