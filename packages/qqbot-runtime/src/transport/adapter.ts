import type { ImChannel, ReplyTarget } from "@codearts-qqbot/core";
import type { InboundSource, ImTransport } from "./outbound-types.js";

/**
 * 渠道能力：把"平台差异"收敛为参数，业务层不再关心协议。
 */
export interface ChannelCapability {
  /** 单条消息最大字符数（QQ 4500 / weixin 1800 / wecom 2048） */
  maxChars: number;
  /** 是否支持 token 级流式 */
  streaming: boolean;
  /** 是否支持输入状态（微信 typing / 企微"正在思考"） */
  typing: boolean;
  /** 是否支持交互按钮 */
  buttons: boolean;
  /** 媒体出站方式 */
  media: "base64" | "cdn" | "sdk";
  maxFileBytes: number;
}

/** QQ 能力基线（与现有实现一致） */
export const QQ_CAPABILITY: ChannelCapability = {
  maxChars: 4500,
  streaming: true,
  typing: false,
  buttons: false,
  media: "base64",
  maxFileBytes: 20 * 1024 * 1024,
};

/**
 * IM 渠道适配器：同时承担入站与出站，是业务层与平台之间唯一的边界。
 *
 * 继承 `ImTransport` 与 `InboundSource`，因此可直接注入现有 `QqbotApp`，
 * 迁移期无需改业务代码。
 */
export interface ImAdapter extends ImTransport, InboundSource {
  readonly id: ImChannel;
  readonly capability: ChannelCapability;
  /** 可选：输入状态 */
  sendTyping?(target: ReplyTarget, on: boolean): Promise<void>;
}
