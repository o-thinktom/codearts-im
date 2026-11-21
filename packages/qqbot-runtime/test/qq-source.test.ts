import { describe, expect, it } from "vitest";
import type { InboundMessage } from "@codearts-qqbot/core";
import { QqApi } from "../src/qq/client.js";
import { QqInboundSource } from "../src/qq/source.js";
import type { WebSocketLike } from "../src/qq/types.js";

class FakeWs implements WebSocketLike {
  static last: FakeWs | undefined;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, (event: unknown) => void>();
  constructor(readonly url: string) {
    FakeWs.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
    this.handlers.set(type, listener);
  }

  emit(type: string, event: unknown): void {
    this.handlers.get(type)?.(event);
  }

  payloads(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("getAppAccessToken")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 });
    }
    if (url.endsWith("/gateway/bot")) {
      return new Response(JSON.stringify({ url: "wss://fake" }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startSource(): Promise<{ source: QqInboundSource; ws: FakeWs; received: InboundMessage[] }> {
  const api = new QqApi({ appId: "app", appSecret: "sec", fetchImpl: fakeFetch() });
  const source = new QqInboundSource({ api, wsFactory: (url) => new FakeWs(url) });
  const received: InboundMessage[] = [];
  source.onMessage((m) => {
    received.push(m);
  });
  await source.start();
  await wait(30);
  const ws = FakeWs.last;
  if (ws === undefined) throw new Error("ws not created");
  return { source, ws, received };
}

describe("QqInboundSource", () => {
  it("取网关并在 Hello 后发送 Identify", async () => {
    const { source, ws } = await startSource();
    expect(ws.url).toBe("wss://fake");

    ws.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }) });
    const payloads = ws.payloads();
    expect(payloads.some((p) => p.op === 1)).toBe(true);
    const identify = payloads.find((p) => p.op === 2);
    expect(identify).toBeDefined();
    expect((identify?.d as { token: string }).token).toBe("QQBot tok");
    expect((identify?.d as { intents: number }).intents).toBe(1 << 25);

    await source.stop();
  });

  it("READY 后 connected 为真", async () => {
    const { source, ws } = await startSource();
    ws.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }) });
    expect(source.connected).toBe(false);
    ws.emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: {} }) });
    expect(source.connected).toBe(true);
    await source.stop();
    expect(source.connected).toBe(false);
  });

  it("私聊消息解析为 c2c 入站消息", async () => {
    const { source, ws, received } = await startSource();
    ws.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }) });
    ws.emit("message", {
      data: JSON.stringify({
        op: 0,
        s: 2,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "m1",
          content: "你好",
          timestamp: "2026-11-19T12:00:00.000Z",
          author: { user_openid: "u1" },
          attachments: [{ content_type: "image/png", filename: "a.png", url: "https://x/a.png", size: 10 }],
        },
      }),
    });
    await wait(20);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ scope: "c2c", peerId: "u1", senderId: "u1", text: "你好", mentioned: false });
    expect(received[0]?.attachments?.[0]).toMatchObject({ kind: "image", filename: "a.png" });
    await source.stop();
  });

  it("群 @ 消息解析为 group 且 mentioned=true", async () => {
    const { source, ws, received } = await startSource();
    ws.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }) });
    ws.emit("message", {
      data: JSON.stringify({
        op: 0,
        s: 3,
        t: "GROUP_AT_MESSAGE_CREATE",
        d: { id: "m2", content: "@bot 看下构建", group_openid: "g1", author: { member_openid: "u2" } },
      }),
    });
    await wait(20);

    expect(received[0]).toMatchObject({ scope: "group", peerId: "g1", senderId: "u2", mentioned: true });
    await source.stop();
  });

  it("忽略未支持的事件", async () => {
    const { source, ws, received } = await startSource();
    ws.emit("message", { data: JSON.stringify({ op: 0, t: "GUILD_CREATE", s: 1, d: {} }) });
    await wait(10);
    expect(received).toHaveLength(0);
    await source.stop();
  });
});