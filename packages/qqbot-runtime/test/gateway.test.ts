import { describe, expect, it } from "vitest";
import { AccessController, MemoryAccessStore } from "@codearts-qqbot/core";
import { MockKernelPort } from "@codearts-qqbot/kernel-port";
import type { MockKernelOptions } from "@codearts-qqbot/kernel-port";
import { QqbotApp } from "../src/gateway.js";
import { MemoryPrefsStore, SessionRegistry } from "../src/session/registry.js";
import { MockImTransport, MockInboundSource } from "../src/transport/outbound-types.js";

interface Harness {
  app: QqbotApp;
  kernel: MockKernelPort;
  transport: MockImTransport;
  source: MockInboundSource;
  registry: SessionRegistry;
}

async function harness(responder?: MockKernelOptions["responder"]): Promise<Harness> {
  const kernel = new MockKernelPort({
    responder: responder ?? ((prompt) => ({ text: `echo:${prompt}` })),
    latencyMs: 0,
  });
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
      requireMention: true,
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
  return { app, kernel, transport, source, registry };
}

function inbound(text: string, extra: Partial<Parameters<QqbotApp["handleInbound"]>[0]> = {}) {
  return {
    scope: "c2c" as const,
    peerId: "u1",
    senderId: "u1",
    text,
    mentioned: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    ...extra,
  };
}

describe("QqbotApp 端到端（mock QQ + mock kernel）", () => {
  it("私聊消息走完整链路并回复", async () => {
    const h = await harness();
    await h.app.handleInbound(inbound("你好"));
    await h.app.stop();

    expect(h.transport.sent.some((s) => s.text === "echo:你好")).toBe(true);
    expect(h.kernel.calls.some((c) => c.method === "createSession")).toBe(true);
    expect(h.kernel.calls.some((c) => c.method === "prompt")).toBe(true);
  });

  it("同一 peer 的第二条消息复用会话", async () => {
    const h = await harness();
    await h.app.handleInbound(inbound("第一句"));
    await h.app.handleInbound(inbound("第二句"));
    await h.app.stop();

    expect(h.kernel.calls.filter((c) => c.method === "createSession")).toHaveLength(1);
    expect(h.transport.sent.map((s) => s.text)).toEqual(["echo:第一句", "echo:第二句"]);
  });

  it("/bot-help 返回命令清单且不触发内核", async () => {
    const h = await harness();
    await h.app.handleInbound(inbound("/bot-help"));
    await h.app.stop();

    expect(h.transport.sent.some((s) => s.text.includes("/compact"))).toBe(true);
    expect(h.kernel.calls.some((c) => c.method === "prompt")).toBe(false);
  });

  it("未知命令给出建议", async () => {
    const h = await harness();
    await h.app.handleInbound(inbound("/hep"));
    await h.app.stop();
    expect(h.transport.sent.some((s) => s.text.includes("/bot-help"))).toBe(true);
  });

  it("/new 之后创建新会话", async () => {
    const h = await harness();
    await h.app.handleInbound(inbound("hi"));
    await h.app.handleInbound(inbound("/new"));
    await h.app.handleInbound(inbound("again"));
    await h.app.stop();
    expect(h.kernel.calls.filter((c) => c.method === "createSession")).toHaveLength(2);
  });

  it("工具失败结果会推送到 QQ", async () => {
    const h = await harness(() => ({
      text: "已完成",
      toolCall: { name: "bash", ok: false, summary: "exit 1" },
    }));
    await h.app.handleInbound(inbound("跑测试"));
    await h.app.stop();
    expect(h.transport.sent.some((s) => s.kind === "tool" && s.text.includes("执行失败"))).toBe(true);
  });

  it("成功的工具结果默认不刷屏", async () => {
    const h = await harness(() => ({ text: "done", toolCall: { name: "bash", ok: true, summary: "ok" } }));
    await h.app.handleInbound(inbound("跑测试"));
    await h.app.stop();
    expect(h.transport.sent.some((s) => s.kind === "tool")).toBe(false);
  });

  it("审批请求可被 /allow 批准", async () => {
    const h = await harness(() => ({
      text: "需要执行",
      permission: { action: "shell", detail: "rm -rf dist" },
    }));
    await h.app.handleInbound(inbound("清理"));
    await h.app.handleInbound(inbound("/allow"));
    await h.app.stop();

    expect(h.kernel.permissions.at(-1)).toMatchObject({ decision: "allow" });
  });

  it("访问被拒时私聊提示且不调用内核", async () => {
    const h = await harness();

    const denied = new QqbotApp({
      port: h.kernel,
      transport: h.transport,
      source: h.source,
      access: new AccessController(new MemoryAccessStore({
        revision: 0,
        c2c: { mode: "disabled", allow: [] },
        group: { mode: "disabled", allow: [] },
        command: { mode: "disabled", allow: [] },
        pairing: [],
        revoked: [],
      })),
      registry: h.registry,
      config: {
        appId: "app",
        workspace: "C:/ws",
        requireMention: true,
        streaming: true,
        textChunkLimit: 4500,
        showToolResults: false,
        processingTimeoutMs: 3000,
        maxQueue: 3,
        access: { c2cMode: "disabled", groupMode: "disabled", commandMode: "disabled" },
        media: { enabled: false, maxMB: 200, ttlHours: 24 },
        sendFile: { restrict: true, extraRoots: [] },
      },
    });
    await denied.handleInbound(inbound("hi"));
    await h.app.stop();

    expect(h.transport.sent.some((s) => s.kind === "error" && s.text.includes("使用名单"))).toBe(true);
  });

  it("群聊未 @ 不响应", async () => {
    const h = await harness();
    await h.app.handleInbound(inbound("大家好", { scope: "group", peerId: "g1" }));
    await h.app.stop();
    expect(h.transport.sent).toHaveLength(0);
  });
});