# codearts-im

> CodeArts IM Gateway · Maintainer: ThinkTom · MIT

[简体中文](README.md) | **English** | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Türkçe](README.tr.md) | [Español](README.es.md)

An IM gateway that drives the local **Huawei Cloud CodeArts Agent** from your phone. Current channels: **QQ, WeChat (iLink) and WeCom (WeChat Work) smart bot**. One channel is active at a time; credentials are kept in the system secret store and can be switched by scanning again.

## Features

- **Three channels**: QQ (official connector), WeChat iLink, WeCom smart bot (`@wecom/aibot-node-sdk`)
- **QR onboarding**: scan to bind on all channels; manual entry is only a fallback
- **Session governance**: one kernel session per peer, persisted mapping, automatic resume after IDE restart
- **Reliable delivery**: multi-step merging, Markdown-aware chunking, per-channel limits, graceful fallback
- **Streaming**: WeCom supports token-level deltas (600 ms throttle, non-blocking frames when acks lag)
- **Human-in-the-loop**: approvals (`1` / `2`) and questions (`A/B/C`); only the session peer can decide
- **Final answers only**: reasoning, synthetic prompts and tool noise are filtered out
- **Media**: inbound image/file download and decryption to disk; outbound upload per channel capability
- **Access control**: open / allowlist / disabled, pairing codes, revocation, single-instance lock
- **Observability**: sidecar logs on disk, one-click diagnostics bundle (redacted, includes compat matrix)

## Channel capabilities

The capability table is defined once in `packages/qqbot-runtime/src/transport/capabilities.json`; adapters must not declare their own values.

| Channel | Max chars | Streaming | Typing | Buttons | Media | Groups |
|---|---|---|---|---|---|---|
| QQ | 4500 | — | — | — | base64 upload | Yes (mention by default) |
| WeChat iLink | 1800 | — | Yes | — | encrypted CDN | Direct only |
| WeCom | 3500 | Yes | — | Not implemented | SDK media upload | Yes |

### File delivery boundaries

**Proactive file push** works on all three channels (verified against the platform APIs). **Automatic file delivery after a reply** is not supported today:

- The kernel does not emit deliverable events (`round.artifacts.updated` is defined but never sent at runtime);
- Fallbacks are implemented: local `file://` images/PDFs opened via `browser`, plus `![alt](path)` and `[[file:path]]` markers in the answer;
- If a channel rejects a file, the reply contains `file send failed: <reason>` — nothing is dropped silently.

## Architecture

    QQ Open Platform / WeChat iLink / WeCom smart bot
      ↕  (WebSocket / HTTPS long-poll)
    sidecar (single Node SEA binary)
      ↕ local IPC (named pipe + one-time token)
    VS Code extension (VSIX)
      ↕ loopback HTTP + SSE
    CodeArts Agent Kernel (Session / Tools / Permission / Skills)

- Credentials and the kernel stay local; the sidecar never opens a public listener;
- `KernelPort` is the only kernel boundary; channels live in `adapters/{qq,weixin,wecom}`;
- The extension owns lifecycle, QR onboarding, kernel discovery, secret decryption and channel switching.

## Compatibility

| Item | Supported | Notes |
|---|---|---|
| OS | Windows 10 1809+ / Windows 11 (x64) | Artifact is win32-x64; other platforms must build natively |
| CodeArts Agent | ≥ 26.11.100 | Verified on 26.11.x |
| Agent Kernel | 126.11.x | Verified on `126.11.2-20261117200150` |
| VS Code API | `^1.109.0` | Stable APIs only |
| QQ Open Platform | Bot WebSocket API v2 | Sandbox or production bot |
| WeChat iLink | Protocol 2.4.6 (`bot_type=3`) | Requires mobile WeChat scan |
| WeCom | Smart-bot WebSocket | Requires a bot authorized by an administrator |
| Node.js (development only) | ≥ 20.3 | End users need nothing |

Compatibility checks:

    npm run compat                      # read-only + session create/delete + channel checks
    npm run compat -- --im wecom        # validate one channel
    npm run compat -- --with-prompt     # adds one real inference (small quota cost)

The result is written to `compat-matrix.json` and can be embedded in the diagnostics bundle.

## Version

- Current: **0.3.2** (Semantic Versioning; interfaces may change during 0.x)
- Baseline: CodeArts Agent 26.11.100 / Kernel 126.11.2
- Upgrade policy: run the compatibility matrix after any IDE/kernel upgrade
- Change history: repository commits; this release adds the three channels, WeCom streaming and diagnostics

## Installation

Requirements: Windows x64, CodeArts Agent 26.11.x. Node.js is **not** required.

    & "<CodeArts install dir>\bin\codearts-agent.cmd" --install-extension "<path>\codearts-qqbot-cn-0.3.2.vsix"

You can also install from the extension panel via “Install from VSIX”, then run “Developer: Reload Window”.

> Before upgrading, terminate stale processes: `taskkill /IM qqbot-sidecar-win32-x64.exe /F` so the old sidecar releases the IPC pipe.

## Quick start

1. Start CodeArts Agent and finish one conversation so the kernel is running;
2. Run the matching onboarding command:
   - “QQ Bot: 扫码绑定机器人” (bind QQ)
   - “QQ Bot: 扫码绑定微信” (bind WeChat)
   - “QQ Bot: 扫码绑定企业微信” (bind WeCom)
3. Scan the QR code and confirm in the official page;
4. Credentials go to the system secret store, `im/channel` switches, and the plugin restarts the connection;
5. Send a message to the bot in that IM.

Notes:

- Only one channel is active; switching pauses the others, and the previous credentials remain — scan again to switch back;
- Use “QQ Bot: 手动填写凭据” (manual credentials) when scanning is unavailable;
- The first sidecar start takes about 5–10 s (SEA unpacking); the onboarding panel waits automatically.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `codeartsQqbot.enabled` | `false` | Start the sidecar with the IDE |
| `codeartsQqbot.provider` | `inferhub-provider` | Model provider |
| `codeartsQqbot.model` | `deepseek-v4.1-flash-1017` | Model ID; never leave empty (auto-router may pick an unusable model) |
| `codeartsQqbot.agent` | `build` | Agent name |
| `codeartsQqbot.access.c2cMode` | `open` | Direct-message access mode |
| `codeartsQqbot.access.groupMode` | `allowlist` | Group access mode (recommended) |
| `codeartsQqbot.textChunkLimit` | `4500` | Max chars per message (channel capability wins) |
| `codeartsQqbot.media.maxMB` | `200` | Inbound media size limit |
| `codeartsQqbot.sendFile.restrict` | `true` | Restrict outbound file paths |

## Commands

| Command | Purpose |
|---|---|
| `/new` | New session |
| `/compact` | Compact context |
| `/model` | Show / switch model |
| `/stop` | Abort current generation |
| `/allow`, `/deny` | Approve / reject |
| `/bot-status`, `/bot-ping`, `/bot-help` | Status, latency, help |

## Security and data

- AppSecret / WeChat token / WeCom secret live only in the system secret store or memory — never in config, repo or logs;
- The kernel password is read from the official encrypted store via read-only decryption, with manual fallback;
- Outbound files are validated against a workspace allowlist (`realpath`), 20 MB per file;
- Logs and diagnostics redact secrets, tokens and openids (a second `[REDACTED]` pass runs before export);
- Only final answers are delivered; reasoning and synthetic prompts never reach IM;
- See [PRIVACY.md](PRIVACY.md).

## Diagnostics and troubleshooting

- Log file: `<globalStorage>/codearts-community.codearts-qqbot-cn/qqbot/logs/sidecar.log` (4 MB × 5 rotation)
- One-click export: “QQ Bot: 导出诊断包” — includes extension/sidecar status, pipe state, config snapshot, last 300 log lines and the compat matrix
- Output channel: `CodeArts QQ Bot`

| Log | Meaning |
|---|---|
| `sidecar binary not found` | The VSIX lacks `bin/`; reinstall |
| `ipc bridge connected` | Extension and sidecar are connected |
| `已从码道加密存储获取内核口令` | Kernel password obtained automatically |
| `sidecar running` / `channel online` | Service and channel ready |
| `weixin` / `wecom` / `qq message received` | Inbound message received |
| `inbound accepted` / `kernel prompt sending` | Forwarded to the kernel |
| `reply sending (flush)` / `reply sending (stream finish)` | Whole-message / stream finish delivery |
| `sendFile failed` | File delivery failed; reason is returned in the reply |
| `listen EADDRINUSE` | A stale sidecar exists; run `taskkill` first |

## Build

Development: Windows x64, Node.js ≥ 20.3, CodeArts Agent 26.11.x for integration.

    npm install
    npm run check            # layer rules / types / unit tests (212)
    npm run build:sidecar    # Node SEA single executable
    npm run package:vsix     # build the extension and package a VSIX

## Open source components & acknowledgements

| Component | Version | Purpose | License |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | QQ QR onboarding and WebSocket | **UNLICENSED** (Tencent proprietary) |
| `@wecom/aibot-node-sdk` | 1.0.7 | WeCom smart-bot WebSocket / streaming / media | See the package terms |
| `qrcode` | 1.5.4 | QR rendering | MIT |
| `esbuild` | 0.24.x | Bundling | MIT |
| `TypeScript` | 5.x | Type system and build | Apache-2.0 |
| `Vitest` | 2.1.x | Unit tests | MIT |
| `tsx` | 4.23.x | Run TypeScript in development | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | WeChat/WeCom protocol reference (not a dependency) | MIT |
| CodeArts Agent / Agent Kernel | 26.11.x / 126.11.x | Host and kernel | Huawei Cloud product terms |

Acknowledgements: Tencent QQ Open Platform, WeCom Open Platform, and the DeepSeek Harness community (`dsh-qqbot`, `dsh-im`) for publicly documented protocol practices.

> **Distribution note**: `@tencent-connect/qqbot-connector` is UNLICENSED. Confirm Tencent’s terms before distributing packaged artifacts. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Known limitations

- Windows x64 artifacts only; build natively for other platforms;
- Tightly coupled to CodeArts Agent/kernel versions — regression testing is required after upgrades;
- QQ passive-reply window is about 5 minutes and at most 5 replies per message;
- WeChat iLink is direct-message only; `ret=-14` requires re-scanning;
- WeCom template cards (button approvals) are not implemented; text interaction is used;
- Groups default to allowlist; `open` is for local integration only;
- Automatic file delivery is limited by the platform, see “File delivery boundaries”.

## Contributing

Issues and pull requests are welcome. Ensure `npm run check` passes, add tests for new logic, and explain the *why* in commit messages.

## Documentation

- [PRIVACY.md](PRIVACY.md): data and privacy
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): third-party components and licenses
- [TODO.md](TODO.md): roadmap and backlog
- [docs/](docs/): kernel contract, probe reports and design documents

## License

MIT License, `Copyright (c) 2026 ThinkTom`. See [LICENSE](LICENSE) for the full text.