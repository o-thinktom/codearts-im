import { describe, expect, it } from "vitest";
import { AccessController, MemoryAccessStore } from "@codearts-qqbot/core";
import { MockKernelPort } from "@codearts-qqbot/kernel-port";
import { QqbotApp } from "../src/gateway.js";
import { MemoryPrefsStore, SessionRegistry } from "../src/session/registry.js";
import { MockImTransport, MockInboundSource } from "../src/transport/outbound-types.js";

async function setup(): Promise<{
  app: QqbotApp;
  kernel: MockKernelPort;
  transport: MockImTransport;
  registry: SessionRegistry;
}> {
  const kernel = new MockKernelPort({ responder: () => ({ text: "ok" }) });
  const transport = new MockImTransport();
  const source = new MockInboundSource();
  const access = new AccessController(new MemoryAccessStore());
  const registry = new SessionRegistry({
    port: kernel,
    prefs: new MemoryPrefsStore("app"),
    appId: "app",
    workspace: "C:/ws",
  });
  const app = new QqbotApp({
    port: kernel,
    transport,
    source,
    access,
    registry,
    config: {
      appId: "app",
      workspace: "C:/ws",
      requireMention: false,
      streaming: true,
      textChunkLimit: 4500,
      showToolResults: false,
      processingTimeoutMs: 3000,
      maxQueue: 3,
      access: { c2cMode: "open", groupMode: "open", commandMode: "open" },
      media: { enabled: false, maxMB: 200, ttlHours: 24 },
      sendFile: { restrict: true, extraRoots: [] },
    },
  });
  await app.start();
  return { app, kernel, transport, registry };
}

function message(text: string) {
  return {
    scope: "c2c" as const,
    peerId: "u1",
    senderId: "u1",
    text,
    mentioned: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
  };
}

describe("提问交互", () => {
  it("question 事件推送到 QQ，字母回复提交给内核", async () => {
    const { app, kernel, transport, registry } = await setup();
    await app.handleInbound(message("hi"));
    const record = await registry.getOrCreate("c2c", "u1", "u1");

    kernel.emitQuestion(record.kernelSessionId, "que_1", [
      {
        header: "下一步操作",
        question: "选择下一步操作",
        options: [
          { label: "A 继续", description: "继续执行" },
          { label: "B 停止", description: "停止执行" },
        ],
      },
    ]);

    await new Promise((r) => setTimeout(r, 10));
    const prompt = transport.sent.find((s) => s.text.includes("需要你选择"));
    expect(prompt?.text).toContain("A. A 继续");
    expect(prompt?.text).toContain("B. B 停止");

    await app.handleInbound(message("B"));
    expect(kernel.questionAnswers).toEqual([{ requestId: "que_1", answers: [["B 停止"]] }]);
    expect(transport.sent.some((s) => s.text.includes("已提交选择"))).toBe(true);

    await app.stop();
  });

  it("没有待答问题时，字母按普通消息处理", async () => {
    const { app, kernel, transport } = await setup();

    await app.handleInbound(message("A"));
    await new Promise((r) => setTimeout(r, 10));

    expect(kernel.questionAnswers).toHaveLength(0);
    expect(kernel.calls.some((c) => c.method === "prompt")).toBe(true);
    expect(transport.sent.some((s) => s.text === "ok")).toBe(true);

    await app.stop();
  });
});