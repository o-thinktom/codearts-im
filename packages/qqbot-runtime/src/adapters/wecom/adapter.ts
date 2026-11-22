import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chunkMarkdownText, createNoopLogger } from "@codearts-qqbot/core";
import type { Attachment, InboundMessage, Logger, PresentedFile, ReplyTarget } from "@codearts-qqbot/core";
import type { ChannelCapability, ImAdapter } from "../../transport/adapter.js";
import type { ImMessageHandler, SendKind } from "../../transport/outbound-types.js";
import { detectImageExt } from "../weixin/weixin-media.js";

type WecomMediaType = "file" | "image" | "voice" | "video";

export const WECOM_CAPABILITY: ChannelCapability = {
  maxChars: 3500,
  streaming: true,
  typing: false,
  buttons: true,
  media: "sdk",
  maxFileBytes: 20 * 1024 * 1024,
};

/** 企业微信 WS 帧（只需要 body 与 req_id） */
export interface WecomFrame {
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
}

/**
 * 适配层需要的最小客户端面：生产用官方 WSClient，测试可注入桩。
 * 只声明本适配器实际调用的能力，避免把 SDK 版本细节泄漏到业务层。
 */
export interface WecomClient {
  connect(): unknown;
  disconnect(): void;
  on(event: string, handler: (...args: any[]) => void): unknown;
  reply(frame: unknown, body: unknown, cmd?: string): Promise<unknown>;
  replyStream?(frame: unknown, streamId: string, content: string, finish?: boolean): Promise<unknown>;
  sendMessage?(chatId: string, body: unknown): Promise<unknown>;
  uploadMedia?(buffer: Buffer, options: { type: WecomMediaType; filename: string }): Promise<{ media_id: string }>;
  replyMedia?(frame: unknown, mediaType: WecomMediaType, mediaId: string): Promise<unknown>;
  sendMediaMessage?(chatId: string, mediaType: WecomMediaType, mediaId: string): Promise<unknown>;
  downloadFile?(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

export interface WecomAdapterOptions {
  client: WecomClient;
  logger?: Logger;
  maxChars?: number;
  /** 入站媒体落盘根目录 */
  mediaRoot?: string;
  /** 工作区根目录：解析交付物的相对路径 */
  workspace?: string;
  /** 认证失败等需要重新扫码时回调 */
  onStaleCredential?: (reason: string) => void;
}

function asRec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function safeSegment(value: string, limit = 64): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, limit);
}

function fileExt(filename?: string, fallback = ".bin"): string {
  const ext = path.extname(filename ?? "");
  return /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : fallback;
}

/**
 * 企业微信智能机器人适配器（WebSocket 长连接）。
 *
 * - 入站：文本 / 语音转写 / 图片 / 文件 / 图文混排，图片与文件解密落盘；
 * - 出站：优先用收到帧做被动回复（stream finish 或 markdown），失败降级主动推送；
 * - 媒体：uploadMedia 换 media_id 后 replyMedia / sendMediaMessage。
 */
export class WecomAdapter implements ImAdapter {
  readonly id = "wecom" as const;
  readonly capability: ChannelCapability;
  private readonly client: WecomClient;
  private readonly logger: Logger;
  private readonly mediaRoot: string | undefined;
  private readonly workspace: string | undefined;
  private readonly onStaleCredential: ((reason: string) => void) | undefined;
  /** peerId → 最近一次收到的帧，用于被动回复 */
  private readonly frames = new Map<string, { frame: unknown; chatId: string }>();
  private readonly seen = new Set<string>();
  private handler: ImMessageHandler | undefined;
  private online = false;
  private started = false;

  constructor(options: WecomAdapterOptions) {
    this.client = options.client;
    this.logger = options.logger ?? createNoopLogger();
    this.mediaRoot = options.mediaRoot;
    this.workspace = options.workspace;
    this.onStaleCredential = options.onStaleCredential;
    this.capability = { ...WECOM_CAPABILITY, ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }) };
  }

  get connected(): boolean {
    return this.online;
  }

  onMessage(handler: ImMessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.client.on("message", (...args: unknown[]) => {
      const frame = asRec(args[0]);
      if (frame !== undefined) void this.ingest(frame as WecomFrame);
    });
    this.client.on("authenticated", () => {
      this.online = true;
      this.logger.info("wecom authenticated");
    });
    this.client.on("disconnected", (...args: unknown[]) => {
      this.online = false;
      this.logger.warn("wecom disconnected", { reason: String(args[0] ?? "") });
    });
    this.client.on("reconnecting", (...args: unknown[]) => {
      this.online = false;
      this.logger.warn("wecom reconnecting", { attempt: String(args[0] ?? "") });
    });
    this.client.on("error", (...args: unknown[]) => {
      const err = args[0];
      const message = err instanceof Error ? err.message : String(err ?? "");
      this.logger.error("wecom client error", { err: message });
      if (/auth|secret|forbidden/i.test(message)) this.onStaleCredential?.(message);
    });

    this.client.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.online = false;
    this.frames.clear();
    this.client.disconnect();
  }

  async sendText(target: ReplyTarget, text: string, _kind?: SendKind): Promise<void> {
    const chunks = chunkMarkdownText(text, this.capability.maxChars);
    for (const chunk of chunks) {
      await this.deliver(target, chunk);
    }
  }

  async sendFile(target: ReplyTarget, files: PresentedFile[]): Promise<void> {
    for (const file of files) {
      const resolved = this.resolvePath(file.path);
      let size = 0;
      try {
        size = statSync(resolved).size;
      } catch {
        await this.sendText(target, `文件不存在：${file.name}\n${resolved}`, "error");
        continue;
      }
      if (size > this.capability.maxFileBytes) {
        await this.sendText(target, `文件过大（${(size / 1024 / 1024).toFixed(1)}MB）：${file.name}`, "error");
        continue;
      }
      if (this.client.uploadMedia === undefined) {
        await this.sendText(target, `文件：${file.name}\n${resolved}`, "file");
        continue;
      }

      try {
        const buffer = readFileSync(resolved);
        const kind: WecomMediaType = detectImageExt(buffer) !== undefined ? "image" : "file";
        const uploaded = await this.client.uploadMedia(buffer, { type: kind, filename: path.basename(resolved) });
        const cached = this.frames.get(target.targetId);
        if (cached !== undefined && this.client.replyMedia !== undefined) {
          await this.client.replyMedia(cached.frame, kind, uploaded.media_id);
        } else if (this.client.sendMediaMessage !== undefined) {
          await this.client.sendMediaMessage(cached?.chatId ?? target.targetId, kind, uploaded.media_id);
        } else {
          throw new Error("企业微信客户端不支持发送媒体");
        }
        this.logger.info("wecom file sent", { name: file.name, kind, bytes: size });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn("wecom sendFile failed", { name: file.name, err: reason });
        await this.sendText(target, `文件发送失败：${file.name}\n原因：${reason}`, "error");
      }
    }
  }

  private async deliver(target: ReplyTarget, chunk: string): Promise<void> {
    const cached = this.frames.get(target.targetId);
    const body = { msgtype: "markdown", markdown: { content: chunk } };

    if (cached !== undefined && this.client.replyStream !== undefined) {
      try {
        await this.client.replyStream(cached.frame, `codearts-im-${randomUUID()}`, chunk, true);
        return;
      } catch (err) {
        this.logger.warn("wecom passive stream reply failed, falling back", { err: String(err) });
      }
    }
    if (cached !== undefined) {
      try {
        await this.client.reply(cached.frame, body);
        return;
      } catch (err) {
        this.logger.warn("wecom passive reply failed, falling back", { err: String(err) });
      }
    }
    if (this.client.sendMessage !== undefined) {
      await this.client.sendMessage(cached?.chatId ?? target.targetId, body);
      return;
    }
    throw new Error("企业微信客户端不支持发送文本");
  }

  private async ingest(frame: WecomFrame): Promise<void> {
    const body = asRec(frame.body);
    if (body === undefined) return;

    const msgId = str(body["msgid"]);
    if (msgId === undefined || this.seen.has(msgId)) return;
    this.remember(msgId);

    const from = asRec(body["from"]);
    const senderId = str(from?.["userid"]);
    const chatId = str(body["chatid"]);
    const group = body["chattype"] === "group";
    const peerId = group ? chatId : senderId;
    if (peerId === undefined) {
      this.logger.warn("wecom message without peer", { msgtype: String(body["msgtype"] ?? "") });
      return;
    }

    if (group && chatId !== undefined) {
      this.frames.set(peerId, { frame, chatId });
    } else {
      this.frames.set(peerId, { frame, chatId: chatId ?? peerId });
    }
    this.trimFrames();

    const msgtype = str(body["msgtype"]) ?? "";
    let text = "";
    const attachments: Attachment[] = [];

    if (msgtype === "text") {
      text = str(asRec(body["text"])?.["content"]) ?? "";
    } else if (msgtype === "voice") {
      text = str(asRec(body["voice"])?.["content"]) ?? "";
    } else if (msgtype === "image") {
      const attachment = await this.saveMedia(body["image"], "image", msgId, 0, senderId ?? peerId);
      if (attachment !== undefined) attachments.push(attachment);
    } else if (msgtype === "file") {
      const attachment = await this.saveMedia(body["file"], "file", msgId, 0, senderId ?? peerId);
      if (attachment !== undefined) attachments.push(attachment);
    } else if (msgtype === "mixed") {
      const items = asRec(body["mixed"])?.["msg_item"];
      if (Array.isArray(items)) {
        for (const [index, raw] of items.entries()) {
          const item = asRec(raw);
          if (item === undefined) continue;
          if (item["msgtype"] === "text") {
            const part = str(asRec(item["text"])?.["content"]) ?? "";
            text = text.length === 0 ? part : `${text}\n${part}`;
          } else if (item["msgtype"] === "image") {
            const attachment = await this.saveMedia(item["image"], "image", msgId, index, senderId ?? peerId);
            if (attachment !== undefined) attachments.push(attachment);
          }
        }
      }
    }

    const trimmed = text.trim();
    if (trimmed.length === 0 && attachments.length === 0) return;

    const message: InboundMessage = {
      scope: group ? "group" : "c2c",
      channel: "wecom",
      peerId,
      senderId: senderId ?? peerId,
      text: trimmed,
      mentioned: true,
      messageId: msgId,
      timestamp: typeof body["create_time"] === "number" ? body["create_time"] : Date.now(),
      ...(attachments.length === 0 ? {} : { attachments }),
    };
    void Promise.resolve(this.handler?.(message)).catch((err) => {
      this.logger.error("wecom message handler failed", { err: String(err) });
    });
    this.logger.info("wecom inbound accepted", { scope: message.scope, length: trimmed.length, attachments: attachments.length });
  }

  private async saveMedia(
    content: unknown,
    kind: "image" | "file",
    msgId: string,
    index: number,
    peerId: string,
  ): Promise<Attachment | undefined> {
    const rec = asRec(content);
    if (rec === undefined) return undefined;
    const url = str(rec["url"]);
    if (url === undefined) return undefined;
    const aesKey = str(rec["aeskey"]);

    if (this.client.downloadFile === undefined || this.mediaRoot === undefined) return { kind };

    try {
      const { buffer, filename } = await this.client.downloadFile(url, aesKey);
      if (buffer.length > this.capability.maxFileBytes) {
        this.logger.warn("wecom media exceeds limit", { kind, bytes: buffer.length });
        return { kind, ...(filename === undefined ? {} : { filename }), size: buffer.length };
      }
      const ext = kind === "image" ? (detectImageExt(buffer) ?? fileExt(filename, ".img")) : fileExt(filename);
      const dir = path.join(this.mediaRoot, safeSegment(peerId));
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${safeSegment(msgId, 48)}-${index}${ext}`);
      writeFileSync(file, buffer, { mode: 0o600 });
      return {
        kind,
        ...(filename === undefined ? {} : { filename }),
        localPath: file,
        size: buffer.length,
      };
    } catch (err) {
      this.logger.warn("wecom media download failed", { kind, err: String(err) });
      return { kind };
    }
  }

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return this.workspace === undefined ? path.resolve(filePath) : path.join(this.workspace, filePath);
  }

  private remember(msgId: string): void {
    this.seen.add(msgId);
    if (this.seen.size > 500) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
  }

  private trimFrames(): void {
    while (this.frames.size > 300) {
      const first = this.frames.keys().next().value;
      if (first === undefined) return;
      this.frames.delete(first);
    }
  }
}