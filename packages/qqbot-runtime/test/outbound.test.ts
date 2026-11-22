import path from "node:path";
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

describe("交付物路径解析", () => {
  it("相对路径按工作区解析后发送文件", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, workspace: "E:/ws/demo" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", {
      type: "deliverable",
      sessionId: "s1",
      files: [{ path: "out/chart.png", name: "chart.png", size: 10 }],
    });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.files[0]?.files[0]?.path).toBe(path.join("E:/ws/demo", "out/chart.png"));
  });

  it("绝对路径保持不变且同轮去重", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, workspace: "E:/ws/demo" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", {
      type: "deliverable",
      sessionId: "s1",
      files: [{ path: "E:/abs/a.png", name: "a.png" }],
    });
    router.route("s1", {
      type: "deliverable",
      sessionId: "s1",
      files: [{ path: "E:/abs/a.png", name: "a.png" }],
    });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.files[0]?.files).toHaveLength(1);
    expect(transport.files[0]?.files[0]?.path).toBe("E:/abs/a.png");
  });

  it("browser 预览工作区内图片时作为交付物发送", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, workspace: "E:/ws/demo" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", {
      type: "tool/call",
      sessionId: "s1",
      callId: "c1",
      name: "browser",
      args: { url: "file:///E:/ws/demo/output/chart.png" },
    });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.files[0]?.files).toHaveLength(1);
    expect(transport.files[0]?.files[0]?.path).toBe(path.join("E:/ws/demo", "output", "chart.png"));
    expect(transport.files[0]?.files[0]?.name).toBe("chart.png");
  });

  it("工具名带命名空间前缀时仍识别 browser 预览", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, workspace: "E:/ws/demo" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", {
      type: "tool/call",
      sessionId: "s1",
      callId: "c1",
      name: "builtin:browser",
      args: { url: "file:///E:/ws/demo/output/chart.png" },
    });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.files[0]?.files[0]?.name).toBe("chart.png");
  });

  it("正文里的本地图片标记会发送并从文本中剥离", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, workspace: "E:/ws/demo" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", {
      type: "text/delta",
      sessionId: "s1",
      turn: 0,
      attemptId: "m1",
      text: "图如下\n![预览](output/chart.png)",
    });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.files[0]?.files[0]?.path).toBe(path.join("E:/ws/demo", "output", "chart.png"));
    expect(transport.sent.map((s) => s.text)).toEqual(["图如下"]);
  });

  it("远程图片与工作区外路径不会被当作交付物", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, workspace: "E:/ws/demo" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", {
      type: "text/delta",
      sessionId: "s1",
      turn: 0,
      attemptId: "m1",
      text: "![a](https://example.com/a.png) ![b](../secret.png) [[file:E:/other/x.png]]",
    });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.files).toHaveLength(0);
  });

  it("turn/end 之后迟到的交付物仍会补发", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, workspace: "E:/ws/demo" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });
    router.route("s1", {
      type: "deliverable",
      sessionId: "s1",
      files: [{ path: "output/late.png", name: "late.png" }],
    });

    await router.flushAll();
    expect(transport.files[0]?.files[0]?.path).toBe(path.join("E:/ws/demo", "output", "late.png"));
  });

  it("browser 打开工作区外、非白名单或远程地址时不发送", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, workspace: "E:/ws/demo" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", {
      type: "tool/call",
      sessionId: "s1",
      callId: "c1",
      name: "browser",
      args: { url: "file:///E:/other/secret.png" },
    });
    router.route("s1", {
      type: "tool/call",
      sessionId: "s1",
      callId: "c2",
      name: "browser",
      args: { url: "file:///E:/ws/demo/output/page.html" },
    });
    router.route("s1", {
      type: "tool/call",
      sessionId: "s1",
      callId: "c3",
      name: "browser",
      args: { url: "https://example.com/a.png" },
    });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });

    await router.flushAll();
    expect(transport.files).toHaveLength(0);
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
describe("流式回复", () => {
  function streamingSetup(intervalMs = 10): { router: OutboundRouter; transport: MockImTransport } {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, streaming: true, deltaIntervalMs: intervalMs, workspace: "E:/ws" });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    return { router, transport };
  }

  it("按节流推送增量，并用 finish 帧收尾（不重复整段）", async () => {
    const { router, transport } = streamingSetup();
    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m1", text: "你" });
    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m1", text: "好" });
    await new Promise((r) => setTimeout(r, 260));

    expect(transport.deltas[0]).toMatchObject({ text: "你好", finish: false });
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });
    await router.flushAll();

    expect(transport.deltas[transport.deltas.length - 1]).toMatchObject({ text: "你好", finish: true });
    expect(transport.sent).toHaveLength(0);
  });

  it("未启用 streaming 时整段发送", async () => {
    const transport = new MockImTransport();
    const router = new OutboundRouter({ transport, streaming: false, deltaIntervalMs: 10 });
    router.beginTurn("s1", target, 0);
    router.route("s1", { type: "turn/start", sessionId: "s1", turn: 0 });
    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m1", text: "整段" });
    await new Promise((r) => setTimeout(r, 30));
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });
    await router.flushAll();

    expect(transport.deltas).toHaveLength(0);
    expect(transport.sent[0]?.text).toBe("整段");
  });

  it("增量发送失败时回退为整段发送", async () => {
    const { router, transport } = streamingSetup();
    transport.sendDelta = async () => {
      throw new Error("ack timeout");
    };
    router.route("s1", { type: "text/delta", sessionId: "s1", turn: 0, attemptId: "m1", text: "回退内容" });
    await new Promise((r) => setTimeout(r, 260));
    router.route("s1", { type: "turn/end", sessionId: "s1", turn: 0 });
    await router.flushAll();

    expect(transport.sent[0]?.text).toBe("回退内容");
  });
});