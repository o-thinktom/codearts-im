# codearts-im 待办事项

> 维护者：ThinkTom
> 项目：codearts-im（CodeArts IM Gateway）
> 更新时间：2026-11-21
> 说明：本文件跟踪项目介绍、功能与工程事项；完成后勾选并注明提交。

## 0. 项目信息

- [ ] 补充项目介绍（中文 / English / Русский / فارسی / Türkçe / Español），包含定位、典型场景、架构图、演示截图或 GIF
- [ ] 在 README 顶部加入项目主体与许可证信息（ThinkTom / MIT）
- [ ] 统一项目标识：仓库 `codearts-im`；扩展 ID 暂为 `codearts-qqbot-cn`（变更需评估升级路径与市场影响）
- [ ] 补充 Gitee 仓库描述与 Topics（`codearts-agent`、`qqbot`、`im-gateway`、`wechat`、`wecom`）

## 1. 功能

- [ ] 微信 iLink 通道（PR-2）：扫码、长轮询、文本、typing、1800 切分、`-14` 重新扫码
- [ ] 微信媒体：图片 AES 解密、CDN 分片上传
- [ ] 企业微信智能机器人：扫码 + WebSocket SDK + 流式
- [ ] 企业微信自建应用：回调验签 + 素材上传
- [ ] 审批 / 提问按钮卡片（当前为数字/字母文本交互）
- [ ] 主动推送与驻留模式

## 2. 工程

- [ ] 兼容矩阵增加 `--im` 维度（qq / weixin / wecom）
- [ ] 微信 / 企微 adapter 契约测试
- [ ] 诊断包增强（日志片段、配置快照、兼容矩阵）
- [ ] 代码签名（sidecar 与 VSIX）
- [ ] 市场发布、灰度与回滚演练

## 3. 合规

- [ ] 确认 `@tencent-connect/qqbot-connector`（UNLICENSED）对外分发授权
- [ ] SBOM 与第三方许可证清单随包分发
- [ ] 隐私说明：消息与代码片段发送至 QQ/云端模型的告知与开关