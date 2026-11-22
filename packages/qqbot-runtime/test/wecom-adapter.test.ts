import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "@codearts-qqbot/core";
import { WecomAdapter, type WecomClient } from "../src/adapters/wecom/adapter.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

class FakeClient implements WecomClient {
  readonly handlers = new Map<string, (...args: any[]) => void>();
  readonly streams: Array<{ streamId: string; content: string; finish: boolean }> = [];
  readonly messages: Array<{ chatId: string; body: any }> = [];
  readonly replies: Array<{ chatId: string; body: any }> = [];
  readonly uploads: Array<{ type: string; filename: string; size: number }> = [];
  readonly medias: Array<{ type: string; mediaId: string }> = [];
  readonly downloads: Array<{ url: string; aesKey?: string }> = [];
  payload = PNG;
  failStream = false;
  connected = false;

  connect(): this {
    this.connected = true;
    return this;
  }

  disconnect(): void {
    this.connected = false;
  }

  on(event: string, handler: (...args: any[]) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }

  async reply(_frame: unknown, body: any): Promise<unknown> {
    this.replies.push({ chatId: "", body });
    return {};
  }

  async replyStream(_frame: unknown, streamId: string, content: string, finish?: boolean): Promise<unknown> {
    if (this.failStream) throw new Error("stream unavailable");
    this.streams.push({ streamId, content, finish: finish === true });
    return {};
  }

  async sendMessage(chatId: string, body: any): Promise<unknown> {
    this.messages.push({ chatId, body });
    return {};
  }

  async uploadMedia(buffer: Buffer, options: { type: any; filename: string }): Promise<{ media_id: string }> {
    this.uploads.push({ type: options.type, filename: options.filename, size: buffer.length });
    return { media_id: "media-1" };
  }

  async replyMedia(_frame: unknown, type: any, mediaId: string): Promise<unknown> {
    this.medias.push({ type, mediaId });
    return {};
  }

  async sendMediaMessage(_chatId: string, type: any, mediaId: string): Promise<unknown> {
    this.medias.push({ type, mediaId });
    return {};
  }

  async downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    this.downloads.push({ url, ...(aesKey === undefined ? {} : { aesKey }) });
    return { buffer: this.payload, filename: "photo.png" };
  }
}

function setup(extra: { mediaRoot?: string; workspace?: string } = {}) {
  const client = new FakeClient();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wecom-adapter-"));
  const adapter = new WecomAdapter({
    client,
    ...(extra.mediaRoot === undefined ? {} : { mediaRoot: extra.mediaRoot }),
    ...(extra.workspace === undefined ? {} : { workspace: extra.workspace }),
  });
  const messages: InboundMessage[] = [];
  adapter.onMessage((m) => {
    messages.push(m);
  });
  return { client, adapter, messages, dir };
}

function textFrame(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headers: { req_id: "req-1" },
    body: {
      msgid: "msg-1",
      chattype: "single",
      from: { userid: "u1" },
      msgtype: "text",
      text: { content },
      ...extra,
    },
  };
}

describe("WecomAdapter 连接", () => {
  it("start 注册事件并连接，认证后 online", async () => {
    const { client, adapter } = setup();
    await adapter.start();
    expect(client.connected).toBe(true);
    expect(adapter.connected).toBe(false);
    client.emit("authenticated");
    expect(adapter.connected).toBe(true);
    client.emit("disconnected", "closed");
    expect(adapter.connected).toBe(false);
    await adapter.stop();
  });

  it("重复 start 不重复连接", async () => {
    const { client, adapter } = setup();
    await adapter.start();
    await adapter.start();
    expect(client.handlers.size).toBeGreaterThan(0);
    await adapter.stop();
  });
});

describe("WecomAdapter 入站", () => {
  it("单聊文本消息", async () => {
    const { client, adapter, messages } = setup();
    await adapter.start();
    client.emit("message", textFrame("你好"));
    await new Promise((r) => setTimeout(r, 30));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      scope: "c2c",
      channel: "wecom",
      peerId: "u1",
      senderId: "u1",
      text: "你好",
      messageId: "msg-1",
    });
    await adapter.stop();
  });

  it("群聊以 chatid 作为 peerId", async () => {
    const { client, adapter, messages } = setup();
    await adapter.start();
    client.emit("message", textFrame("群消息", { chattype: "group", chatid: "g1" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(messages[0]).toMatchObject({ scope: "group", peerId: "g1", senderId: "u1" });
    await adapter.stop();
  });

  it("重复 msgid 只处理一次", async () => {
    const { client, adapter, messages } = setup();
    await adapter.start();
    client.emit("message", textFrame("a"));
    client.emit("message", textFrame("b"));
    await new Promise((r) => setTimeout(r, 30));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("a");
    await adapter.stop();
  });

  it("图片消息解密落盘", async () => {
    const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "wecom-media-"));
    const { client, adapter, messages } = setup({ mediaRoot });
    await adapter.start();
    client.emit("message", {
      headers: { req_id: "req-2" },
      body: {
        msgid: "msg-2",
        chattype: "single",
        from: { userid: "u1" },
        msgtype: "image",
        image: { url: "https://example.com/x", aeskey: "key-1" },
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const attachment = messages[0]?.attachments?.[0];
    expect(attachment).toMatchObject({ kind: "image", filename: "photo.png", size: PNG.length });
    expect(attachment?.localPath?.endsWith(".png")).toBe(true);
    expect(attachment?.localPath === undefined ? false : existsSync(attachment.localPath)).toBe(true);
    expect(client.downloads[0]).toEqual({ url: "https://example.com/x", aesKey: "key-1" });
    await adapter.stop();
  });

  it("文件下载失败时保留元数据", async () => {
    const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "wecom-media-"));
    const { client, adapter, messages } = setup({ mediaRoot });
    client.downloadFile = async () => {
      throw new Error("download failed");
    };
    await adapter.start();
    client.emit("message", {
      headers: { req_id: "req-3" },
      body: {
        msgid: "msg-3",
        chattype: "single",
        from: { userid: "u1" },
        msgtype: "file",
        file: { url: "https://example.com/f", aeskey: "k" },
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(messages[0]?.attachments?.[0]).toEqual({ kind: "file" });
    await adapter.stop();
  });

  it("图文混排拆出文本与图片", async () => {
    const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "wecom-media-"));
    const { client, adapter, messages } = setup({ mediaRoot });
    await adapter.start();
    client.emit("message", {
      headers: { req_id: "req-4" },
      body: {
        msgid: "msg-4",
        chattype: "single",
        from: { userid: "u1" },
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "看这张图" } },
            { msgtype: "image", image: { url: "https://example.com/y", aeskey: "k" } },
          ],
        },
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(messages[0]?.text).toBe("看这张图");
    expect(messages[0]?.attachments).toHaveLength(1);
    await adapter.stop();
  });
});

describe("WecomAdapter 出站", () => {
  it("有被动帧时用流式回复", async () => {
    const { client, adapter } = setup();
    await adapter.start();
    client.emit("message", textFrame("hi"));
    await new Promise((r) => setTimeout(r, 20));

    await adapter.sendText({ scope: "c2c", channel: "wecom", targetId: "u1" }, "回复内容");
    expect(client.streams[0]).toMatchObject({ content: "回复内容", finish: true });
    await adapter.stop();
  });

  it("流式失败降级为被动 markdown 回复", async () => {
    const { client, adapter } = setup();
    client.failStream = true;
    await adapter.start();
    client.emit("message", textFrame("hi"));
    await new Promise((r) => setTimeout(r, 20));

    await adapter.sendText({ scope: "c2c", channel: "wecom", targetId: "u1" }, "降级内容");
    expect(client.replies[0]?.body).toMatchObject({ msgtype: "markdown", markdown: { content: "降级内容" } });
    await adapter.stop();
  });

  it("无被动帧时主动推送", async () => {
    const { client, adapter } = setup();
    await adapter.start();
    await adapter.sendText({ scope: "c2c", channel: "wecom", targetId: "u9" }, "主动消息");
    expect(client.messages[0]).toMatchObject({ chatId: "u9", body: { msgtype: "markdown" } });
    await adapter.stop();
  });

  it("超长文本按上限切分", async () => {
    const client = new FakeClient();
    const adapter = new WecomAdapter({ client, maxChars: 4 });
    await adapter.start();
    await adapter.sendText({ scope: "c2c", channel: "wecom", targetId: "u1" }, "0123456789");
    expect(client.messages.map((m) => m.body.markdown.content)).toEqual(["0123", "4567", "89"]);
    await adapter.stop();
  });

  it("sendFile 上传图片并被动回复媒体", async () => {
    const { client, adapter, dir } = setup();
    const file = path.join(dir, "chart.png");
    writeFileSync(file, PNG);
    await adapter.start();
    client.emit("message", textFrame("hi"));
    await new Promise((r) => setTimeout(r, 20));

    await adapter.sendFile({ scope: "c2c", channel: "wecom", targetId: "u1" }, [{ path: file, name: "chart.png" }]);
    expect(client.uploads[0]).toMatchObject({ type: "image", filename: "chart.png", size: PNG.length });
    expect(client.medias[0]).toEqual({ type: "image", mediaId: "media-1" });
    await adapter.stop();
  });

  it("sendFile 超过上限时降级文本", async () => {
    const { client, adapter, dir } = setup();
    const file = path.join(dir, "big.zip");
    writeFileSync(file, "");
    const { truncateSync } = await import("node:fs");
    truncateSync(file, 21 * 1024 * 1024);
    await adapter.start();
    await adapter.sendFile({ scope: "c2c", channel: "wecom", targetId: "u1" }, [{ path: file, name: "big.zip" }]);
    expect(client.uploads).toHaveLength(0);
    expect(client.messages[0]?.body.markdown.content).toContain("文件过大");
    await adapter.stop();
  });

  it("sendFile 相对路径按工作区解析", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "wecom-ws-"));
    const { client, adapter } = setup({ workspace });
    writeFileSync(path.join(workspace, "out.pdf"), "%PDF-1.4");
    await adapter.start();
    await adapter.sendFile(
      { scope: "c2c", channel: "wecom", targetId: "u1" },
      [{ path: "out.pdf", name: "out.pdf" }],
    );
    expect(client.uploads[0]).toMatchObject({ type: "file", filename: "out.pdf" });
    await adapter.stop();
  });
});