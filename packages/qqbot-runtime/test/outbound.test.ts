import { describe, expect, it } from "vitest";
import { normalizeEvent } from "@codearts-qqbot/kernel-port";
import { OutboundRouter } from "../src/transport/outbound.js";
import { MockImTransport } from "../src/transport/outbound-types.js";

const target = { scope: "c2c" as const, targetId: "u1" };

function setup(): { router: OutboundRouter; transport: MockImTransport } {
  const transport = new MockImTransport();
  const router = new OutboundRouter({ transport, textChunkLimit: 4500 });
  router.beginTurn("s1", target, 0);
  router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
  return { router, transport };
}

describe("OutboundRouter 多消息合并", () => {
  it("同一轮内多条 assistant 消息合并为一条发送", async () => {
    const { router, transport } = setup();

    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m1", text: "第一段" });
    router.route("s1", { type: "message/complete", sessionId: "s1", turn: 0, messageId: "m1", blocks: [] });
    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m2", text: "第二段" });
    router.route("s1", { type: "message/complete", sessionId: "s1", turn: 0, messageId: "m2", blocks: [] });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.sent.map((s) => s.text)).toEqual(["第一段\n\n第二段"]);
  });

  it("未收到完成事件时，turn/end 会合并剩余分段", async () => {
    const { router, transport } = setup();

    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m1", text: "A" });
    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m2", text: "B" });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.sent.map((s) => s.text)).toEqual(["A\n\nB"]);
  });

  it("只有完成事件（无 delta）时，用 blocks 文本兜底", async () => {
    const { router, transport } = setup();

    router.route("s1", { type: "message/complete", sessionId: "s1", turn: 0, blocks: [{ type: "text", text: "hello" }] });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.sent.map((s) => s.text)).toEqual(["hello"]);
  });

  it("长回复按上限切分", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, textChunkLimit: 10 });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m1", text: "0123456789ABCDEF" });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.sent.map((s) => s.text)).toEqual(["0123456789", "ABCDEF"]);
  });
});

describe("增量事件过滤", () => {
  it("reasoning 增量不会混入回复", () => {
    const ev = normalizeEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "reasoning",
        delta: "思考中",
      },
    });
    expect(ev).toBeUndefined();
  });

  it("text 增量正常映射", () => {
    const ev = normalizeEvent({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "收到" },
    });
    expect(ev).toMatchObject({ type: "text/delta", text: "收到", attemptId: "msg_1" });
  });
});