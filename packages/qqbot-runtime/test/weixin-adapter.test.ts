import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WeixinAdapter } from "../src/adapters/weixin/adapter.js";
import { WeixinStateStore } from "../src/adapters/weixin/weixin-state.js";
import { WeixinApi, WeixinApiError } from "../src/adapters/weixin/weixin-api.js";
import type { WeixinMedia } from "../src/adapters/weixin/weixin-media.js";
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

class FakeMedia {
  readonly uploaded: Array<{ filePath: string; kind: "image" | "file" }> = [];
  readonly sent: Array<{ to: string; item: Record<string, unknown>; contextToken?: string }> = [];
  payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
  failUpload = false;
  failDownload = false;

  async download(): Promise<{ buffer: Buffer; size: number }> {
    if (this.failDownload) throw new Error("download failed");
    return { buffer: this.payload, size: this.payload.length };
  }

  async upload(
    _token: string,
    _to: string,
    filePath: string,
    kind: "image" | "file",
  ): Promise<{ item: Record<string, unknown> }> {
    if (this.failUpload) throw new Error("upload failed");
    this.uploaded.push({ filePath, kind });
    return { item: { type: kind === "image" ? 2 : 4 } };
  }

  async sendMedia(
    _token: string,
    to: string,
    item: Record<string, unknown>,
    contextToken?: string,
  ): Promise<void> {
    this.sent.push({ to, item, ...(contextToken === undefined ? {} : { contextToken }) });
  }
}

function setup(
  api: FakeApi,
  extra: { media?: FakeMedia; mediaRoot?: string } = {},
): { adapter: WeixinAdapter; messages: InboundMessage[]; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "weixin-adapter-"));
  const adapter = new WeixinAdapter({
    api: api as unknown as WeixinApi,
    botId: "bot-1",
    token: "tok",
    state: new WeixinStateStore(path.join(dir, "weixin-state.json")),
    ...(extra.media === undefined ? {} : { media: extra.media as unknown as WeixinMedia }),
    ...(extra.mediaRoot === undefined ? {} : { mediaRoot: extra.mediaRoot }),
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

  it("图片消息解密后落盘并携带 localPath", async () => {
    const api = new FakeApi();
    const media = new FakeMedia();
    const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "weixin-media-root-"));
    api.updates = [
      {
        msgs: [
          {
            msg_id: "img-1",
            seq: 1,
            from_user_id: "wx-1",
            item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "q", aes_key: "key" } } }],
          },
        ],
        getUpdatesBuf: "buf-1",
      },
    ];
    const { adapter, messages } = setup(api, { media, mediaRoot });
    await adapter.start();
    await new Promise((r) => setTimeout(r, 150));

    expect(messages.length).toBe(1);
    const attachment = messages[0]?.attachments?.[0];
    expect(attachment).toMatchObject({ kind: "image", size: media.payload.length });
    expect(attachment?.localPath).toBeDefined();
    expect(attachment?.localPath?.endsWith(".png")).toBe(true);
    expect(attachment?.localPath === undefined ? false : existsSync(attachment.localPath)).toBe(true);
    expect(attachment?.localPath === undefined ? 0 : statSync(attachment.localPath).size).toBe(media.payload.length);
    await adapter.stop();
  });

  it("文件消息保留下载失败时的元数据", async () => {
    const api = new FakeApi();
    const media = new FakeMedia();
    media.failDownload = true;
    const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "weixin-media-root-"));
    api.updates = [
      {
        msgs: [
          {
            msg_id: "file-1",
            seq: 1,
            from_user_id: "wx-1",
            item_list: [
              {
                type: 4,
                file_item: { media: { encrypt_query_param: "q" }, file_name: "报告.pdf", len: "2048" },
              },
            ],
          },
        ],
        getUpdatesBuf: "buf-1",
      },
    ];
    const { adapter, messages } = setup(api, { media, mediaRoot });
    await adapter.start();
    await new Promise((r) => setTimeout(r, 150));

    expect(messages[0]?.attachments?.[0]).toEqual({ kind: "file", filename: "报告.pdf", size: 2048 });
    await adapter.stop();
  });

  it("未配置媒体能力时仍上报附件元数据", async () => {
    const api = new FakeApi();
    api.updates = [
      {
        msgs: [
          {
            msg_id: "img-2",
            seq: 1,
            from_user_id: "wx-1",
            item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "q" } } }],
          },
        ],
        getUpdatesBuf: "buf-1",
      },
    ];
    const { adapter, messages } = setup(api);
    await adapter.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(messages[0]?.attachments?.[0]).toEqual({ kind: "image" });
    await adapter.stop();
  });

  it("sendFile 通过 CDN 上传并发送富媒体", async () => {
    const api = new FakeApi();
    const media = new FakeMedia();
    const { adapter, dir } = setup(api, { media });
    const file = path.join(dir, "chart.png");
    writeFileSync(file, "png-bytes");

    await adapter.sendFile(
      { scope: "c2c", channel: "weixin", targetId: "wx-1" },
      [{ path: file, name: "chart.png", size: 9 }],
    );

    expect(media.uploaded).toEqual([{ filePath: file, kind: "image" }]);
    expect(media.sent[0]).toMatchObject({ to: "wx-1", item: { type: 2 } });
    expect(api.sent).toHaveLength(0);
  });

  it("sendFile 上传失败时降级为路径文本", async () => {
    const api = new FakeApi();
    const media = new FakeMedia();
    media.failUpload = true;
    const { adapter, dir } = setup(api, { media });
    const file = path.join(dir, "report.pdf");
    writeFileSync(file, "pdf");

    await adapter.sendFile(
      { scope: "c2c", channel: "weixin", targetId: "wx-1" },
      [{ path: file, name: "report.pdf", size: 3 }],
    );

    expect(media.sent).toHaveLength(0);
    expect(api.sent[0]?.text).toContain("report.pdf");
  });

  it("sendFile 超过上限时直接降级为路径文本", async () => {
    const api = new FakeApi();
    const media = new FakeMedia();
    const { adapter, dir } = setup(api, { media });
    const file = path.join(dir, "big.zip");

    await adapter.sendFile(
      { scope: "c2c", channel: "weixin", targetId: "wx-1" },
      [{ path: file, name: "big.zip", size: 21 * 1024 * 1024 }],
    );

    expect(media.uploaded).toHaveLength(0);
    expect(api.sent[0]?.text).toContain("文件过大");
  });
});