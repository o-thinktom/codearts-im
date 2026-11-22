# 文档索引

> codearts-im（CodeArts IM Gateway）· 维护者 ThinkTom · 更新 2026-11-22

| 文档 | 内容 | 状态 |
|---|---|---|
| [solution-a-ipc.md](solution-a-ipc.md) | 方案 A：扩展 ↔ sidecar ↔ 内核的连接与鉴权落地说明 | 现行实现依据 |
| [kernel-endpoints.md](kernel-endpoints.md) | 内核端点清单（由 OpenAPI 生成） | 参考，随内核版本复核 |
| [kernel-probe-report.md](kernel-probe-report.md) | 内核契约实测报告（端口、SSE、事件字段） | 历史探测，结论已固化到代码 |
| [official-integration-channel-report.md](official-integration-channel-report.md) | 官方接入通道（数字分身等）探测归档 | 已归档，不开发 |
| [kernel-openapi.json](kernel-openapi.json) | 内核 OpenAPI 描述（只读样本） | 参考 |

## 阅读顺序

1. 先读根目录 [README.md](../README.md) 了解安装与使用；
2. 需要理解架构与限制时读 [PRIVACY.md](../PRIVACY.md) 与 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)；
3. 排查内核契约变化时读 `kernel-endpoints.md` 与 `kernel-probe-report.md`；
4. 需要追溯历史决策时读 `official-integration-channel-report.md`（已归档）。

## 维护约定

- `solution-a-ipc.md` 随实现变化更新；
- 探测类文档保留当时的证据与命令，**不随代码回填结论**，避免污染历史；
- 新增设计文档命名：`Solution-<主题>-<时间>.md`，放入本目录并在上表登记。