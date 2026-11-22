# 第三方组件与许可证 / Third-Party Notices

> codearts-im（扩展 ID `codearts-qqbot-cn`）· 更新日期 2026-11-22

本文件列出直接依赖、开发依赖与参考实现。传递依赖请以各包内 `LICENSE` 为准；发布前建议生成完整 SBOM（见文末命令）。

## 1. 运行时依赖（随 VSIX / sidecar 分发）

| 组件 | 版本 | 用途 | 许可证 | 备注 |
|---|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | QQ 扫码绑定、WebSocket 长连接 | **UNLICENSED** | 腾讯专有；分发前必须确认腾讯条款 |
| `@wecom/aibot-node-sdk` | 1.0.7 | 企业微信智能机器人 WebSocket、流式、媒体上传 | 见包内条款 | 腾讯企业微信官方 SDK |
| `qrcode` | 1.5.4 | 二维码渲染（微信/企微绑定面板） | MIT | — |
| `eventemitter3` | 5.x（传递） | 事件分发（随企微 SDK） | MIT | 传递依赖 |
| `ws` | 8.x（传递） | WebSocket 客户端（随企微 SDK） | MIT | 传递依赖 |

> **分发红线**：`@tencent-connect/qqbot-connector` 标记为 `UNLICENSED`。在将本项目打包为 VSIX / sidecar 对外分发前，请先取得或确认腾讯的相关许可；未确认前仅限个人/内部使用。

## 2. 开发与构建依赖（不随产物分发）

| 组件 | 版本 | 用途 | 许可证 |
|---|---|---|---|
| `TypeScript` | 5.x | 类型系统与编译 | Apache-2.0 |
| `esbuild` | 0.24.x | sidecar 打包 | MIT |
| `Vitest` | 2.1.x | 单元测试 | MIT |
| `tsx` | 4.23.x | 开发期运行 TypeScript | MIT |
| `postject` | 1.x | Node SEA 注入 | MIT |

## 3. 参考实现（未直接依赖）

| 项目 | 版本 | 用途 | 许可证 |
|---|---|---|---|
| `@xmanrui/dsh-im` | 5.10.0 | 微信 iLink / 企业微信协议参考 | MIT |
| `dsh-qqbot`（DeepSeek Harness 社区） | — | QQ 交互设计参考 | 见其仓库 |

参考实现仅用于理解协议字段与交互流程，未复制代码；相关协议字段以官方接口文档与实测为准。

## 4. 宿主与平台

| 组件 | 用途 | 条款 |
|---|---|---|
| 码道 CodeArts Agent / Agent Kernel | 宿主 IDE 与本地内核 | 华为云产品条款 |
| QQ 开放平台 | 消息通道 | 腾讯 QQ 机器人相关协议 |
| 微信 iLink | 消息通道 | 腾讯相关协议 |
| 企业微信开放平台 | 消息通道 | 腾讯相关协议 |
| 模型供应商（默认 `inferhub-provider`） | 推理服务 | 由用户在码道中配置 |

## 5. 生成完整 SBOM / 许可证清单

在仓库根目录执行（需要联网安装工具）：

```bash
# CycloneDX SBOM（Node 20+ 内置）
npm sbom --sbom-format=cyclonedx > sbom.cdx.json

# 仅查看直接依赖许可证
npx license-checker --production --summary
```

产物 `sbom.cdx.json` 不建议入库（包含完整依赖图），随发布附件分发即可。

## 6. 合规清单（发布前）

- [ ] 确认 `@tencent-connect/qqbot-connector` 的分发授权；
- [ ] 确认 `@wecom/aibot-node-sdk` 的分发授权与版本条款；
- [ ] 随包附带本文件与 `LICENSE`；
- [ ] 生成并附带 SBOM；
- [ ] 在 README / 应用商店页注明非官方项目。

---

# Third-Party Notices (English)

**Runtime:** `@tencent-connect/qqbot-connector` 1.2.0 (**UNLICENSED**, Tencent proprietary — confirm terms before distribution), `@wecom/aibot-node-sdk` 1.0.7 (see package terms), `qrcode` 1.5.4 (MIT), plus transitive `eventemitter3` / `ws` (MIT).

**Build/dev:** TypeScript (Apache-2.0), esbuild (MIT), Vitest (MIT), tsx (MIT), postject (MIT).

**References (not dependencies):** `@xmanrui/dsh-im` 5.10.0 (MIT), `dsh-qqbot` (see its repository). Only protocol behavior was studied; no code was copied.

**Hosts/platforms:** CodeArts Agent / Kernel (Huawei Cloud terms), QQ Open Platform / WeChat iLink / WeCom (Tencent terms), and the model provider configured by the user.

**SBOM:** `npm sbom --sbom-format=cyclonedx > sbom.cdx.json` and `npx license-checker --production --summary`. Do not commit the SBOM; attach it to releases.

**Before publishing:** confirm Tencent distribution terms for the QQ connector and the WeCom SDK, ship this file together with `LICENSE`, attach an SBOM, and state clearly that this is an unofficial project.