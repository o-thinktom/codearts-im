import { describe, expect, it } from "vitest";
import { assembleAgentBody } from "../src/transport/inbound.js";
import type { InboundMessage } from "../src/types.js";

function msg(partial: Partial<InboundMessage>): InboundMessage {
  return {
    scope: "c2c",
    peerId: "u1",
    senderId: "u1",
    text: "",
    mentioned: false,
    messageId: "m1",
    timestamp: 0,
    ...partial,
  };
}

describe("assembleAgentBody", () => {
  it("私聊纯文本原样透传", () => {
    expect(assembleAgentBody(msg({ text: "帮我看看这个 bug" }))).toBe("帮我看看这个 bug");
  });

  it("群聊未 @ 且无内容时返回 null", () => {
    expect(assembleAgentBody(msg({ scope: "group", peerId: "g1", text: "" }))).toBeNull();
  });

  it("群聊 @ 时带发送者标签与 @ 标记", () => {
    const body = assembleAgentBody(
      msg({ scope: "group", peerId: "g1", senderId: "u2", senderName: "小明", text: "看下构建", mentioned: true }),
    );
    expect(body).toContain("[小明 (u2)] 看下构建 (@你)");
  });

  it("群聊 @ 时注入历史并包裹", () => {
    const body = assembleAgentBody(
      msg({
        scope: "group",
        peerId: "g1",
        senderId: "u2",
        text: "继续",
        mentioned: true,
        history: [{ senderId: "u3", senderName: "小红", content: "先跑测试", timestamp: 1, messageId: "h1" }],
      }),
    );
    expect(body).toContain("[群聊历史开始]");
    expect(body).toContain("[小红 (u3)] 先跑测试");
    expect(body).toContain("[当前消息]");
  });

  it("引用消息与媒体路径进入上下文", () => {
    const body = assembleAgentBody(
      msg({
        text: "这个报错怎么解",
        quote: { text: "TypeError: x is undefined" },
        attachments: [{ kind: "image", filename: "err.png", localPath: "C:/tmp/err.png" }],
      }),
    );
    expect(body).toContain("[引用消息开始]");
    expect(body).toContain("TypeError: x is undefined");
    expect(body).toContain("- 图片: C:/tmp/err.png");
    expect(body).toContain("[图片]");
  });

  it("语音消息使用 ASR 文本", () => {
    const body = assembleAgentBody(
      msg({ attachments: [{ kind: "voice", asrText: "帮我重构登录模块", durationSec: 3 }] }),
    );
    expect(body).toContain("[语音消息 (3s)] 帮我重构登录模块");
  });
});