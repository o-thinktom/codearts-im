import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WeixinAdapter } from "../src/adapters/weixin/adapter.js";
import { WeixinStateStore } from "../src/adapters/weixin/weixin-state.js";
import { WeixinApi, WeixinApiError } from "../src/adapters/weixin/weixin-api.js";
import type { InboundMessage } from "@codearts-qqbot/core";

class FakeApi {
  readonly sent: Array<{ to: string; text: string; contextToken?: string }> = [];
  readonly typing: Array<{ to: string; status: number }> = [];
  updates: Array<{ msgs: unknown[]; getUpdatesBuf: string }> = [];
  failWithStale = false;
  typingTicket: string | undefined = "ticket-1";

  async notifyStart(): Promise<void> {}
  async notifyStop(): Promise<void> {}

  async getUpdates(_token: string, buf: string): Promise<{ msgs: unknown[]; getUpdatesBuf: string }> {
    if (this.failWithStale) throw new WeixinApiError("stale-token", "expired");
    const next = this.updates.shift();
    return next ?? { msgs: [], getUpdatesBuf: buf };
  }

  async sendText(_token: string, to: string, text: string, contextToken?: string): Promise<void> {
    this.sent.push({ to, text, ...(contextToken === undefined ? {} : { contextToken }) });
  }

  async getTypingTicket(): Promise<string | undefined> {
    return this.typingTicket;
  }

  async sendTyping(_token: string, _to: string, _ticket: string, status: 1 | 2): Promise<void> {
    this.typing.push({ to: _to, status });
  }
}

function setup(api: FakeApi): { adapter: WeixinAdapter; messages: InboundMessage[]; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "weixin-adapter-"));
  const adapter = new WeixinAdapter({
    api: api as unknown as WeixinApi,
    botId: "bot-1",
    token: "tok",
    state: new WeixinStateStore(path.join(dir, "weixin-state.json")),
  });
  const messages: InboundMessage[] = [];
  adapter.onMessage((m) => {
    messages.push(m);
  });
  return { adapter, messages, dir };
}

describe("WeixinAdapter", () => {
  it("长轮询解析私聊文本并保留 context_token", async () => {
    const api = new FakeApi();
    api.updates = [
      {
        msgs: [
          {
            msg_id: "m1",
            seq: 1,
            from_user_id: "wx-1",
            context_token: "ctx-1",
            create_time_ms: 1000,
            item_list: [{ type: 1, text_item: { text: "你好" } }],
          },
        ],
        getUpdatesBuf: "buf-1",
      },
    ];
    const { adapter, messages } = setup(api);
    await adapter.start();
    await new Promise((r) => setTimeout(r, 120));

    expect(messages[0]).toMatchObject({
      scope: "c2c",
      channel: "weixin",
      peerId: "wx-1",
      text: "你好",
      messageId: "m1",
    });

    await adapter.sendText({ scope: "c2c", channel: "weixin", targetId: "wx-1" }, "收到", "reply");
    expect(api.sent[0]).toMatchObject({ to: "wx-1", text: "收到", contextToken: "ctx-1" });
    await adapter.stop();
  });

  it("按渠道上限切分长文本", async () => {
    const api = new FakeApi();
    const { adapter } = setup(api);
    const text = "a".repeat(2000);
    await adapter.sendText({ scope: "c2c", channel: "weixin", targetId: "wx-1" }, text, "reply");
    expect(api.sent.length).toBe(2);
    expect(api.sent.every((s) => s.text.length <= 1800)).toBe(true);
  });

  it("-14 停止连接并触发回调", async () => {
    const api = new FakeApi();
    api.failWithStale = true;
    const dir = mkdtempSync(path.join(os.tmpdir(), "weixin-stale-"));
    let stale = "";
    const adapter = new WeixinAdapter({
      api: api as unknown as WeixinApi,
      botId: "bot-1",
      token: "tok",
      state: new WeixinStateStore(path.join(dir, "weixin-state.json")),
      onStaleToken: (reason) => {
        stale = reason;
      },
    });
    await adapter.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(stale).toBe("token expired");
    expect(adapter.connected).toBe(false);
    await adapter.stop();
  });

  it("typing 开启与关闭", async () => {
    const api = new FakeApi();
    const { adapter } = setup(api);
    await adapter.sendTyping({ scope: "c2c", channel: "weixin", targetId: "wx-1" }, true);
    await adapter.sendTyping({ scope: "c2c", channel: "weixin", targetId: "wx-1" }, false);
    expect(api.typing.map((t) => t.status)).toEqual([1, 2]);
    await adapter.stop();
  });
});