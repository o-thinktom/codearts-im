import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chunkMarkdownText, createNoopLogger } from "@codearts-qqbot/core";
import type { Attachment, InboundMessage, Logger, PresentedFile, ReplyTarget } from "@codearts-qqbot/core";
import type { ChannelCapability, ImAdapter } from "../../transport/adapter.js";
import capabilities from "../../transport/capabilities.json" with { type: "json" };
import type { ImMessageHandler, SendKind } from "../../transport/outbound-types.js";
import { WeixinApi, WeixinApiError, type WeixinMessage } from "./weixin-api.js";
import { WeixinMedia, detectImageExt, type WeixinMediaItem, type WeixinMediaRef } from "./weixin-media.js";
import type { WeixinStateStore } from "./weixin-state.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function safeSegment(value: string, limit = 64): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, limit);
}

function imageExtFromBytes(buffer: Buffer, filename?: string): string {
  return detectImageExt(buffer) ?? fileExt(filename, ".img");
}

function fileExt(filename?: string, fallback = ".bin"): string {
  const ext = path.extname(filename ?? "");
  return /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : fallback;
}

function mediaRefOf(value: unknown): WeixinMediaRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const out: WeixinMediaRef = {};
  if (typeof rec["encrypt_query_param"] === "string") out.encrypt_query_param = rec["encrypt_query_param"];
  if (typeof rec["full_url"] === "string") out.full_url = rec["full_url"];
  if (typeof rec["aes_key"] === "string") out.aes_key = rec["aes_key"];
  if (typeof rec["encrypt_type"] === "number") out.encrypt_type = rec["encrypt_type"];
  return Object.keys(out).length === 0 ? undefined : out;
}

function toMediaItem(item: unknown, extra: { file_name?: string; len?: string } = {}): WeixinMediaItem | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const rec = item as Record<string, unknown>;
  const media = mediaRefOf(rec["media"]);
  if (media === undefined) return undefined;
  const out: WeixinMediaItem = { media };
  if (typeof rec["aeskey"] === "string") out.aeskey = rec["aeskey"];
  if (extra.file_name !== undefined) out.file_name = extra.file_name;
  if (extra.len !== undefined) out.len = extra.len;
  return out;
}

export const WEIXIN_CAPABILITY: ChannelCapability = capabilities.weixin as ChannelCapability;

export interface WeixinAdapterOptions {
  api: WeixinApi;
  botId: string;
  token: string;
  state: WeixinStateStore;
  logger?: Logger;
  maxChars?: number;
  reconnect?: { initialMs: number; maxMs: number };
  onStaleToken?: (reason: string) => void;
  /** 媒体下载/上传；未提供时媒体能力降级 */
  media?: WeixinMedia;
  /** 入站媒体落盘根目录 */
  mediaRoot?: string;
  /** 工作区根目录：解析交付物的相对路径 */
  workspace?: string;
}

/**
 * 个人微信（腾讯 iLink AI）适配器。
 *
 * - 长轮询 `getupdates`（35s），游标持久化；
 * - 同一 `msg_id` 的文本按渠道上限（1800）切分；
 * - 通过 `typing_ticket` 维持"正在输入"，5s 保活；
 * - `-14` 立即停止，交由上层提示重新扫码。
 */
export class WeixinAdapter implements ImAdapter {
  readonly id = "weixin" as const;
  readonly capability: ChannelCapability;

  private readonly logger: Logger;
  private readonly maxChars: number;
  private readonly reconnectCfg: { initialMs: number; maxMs: number };
  private readonly contextTokens = new Map<string, string>();
  private readonly typingState = new Map<string, { ticket: string; timer?: NodeJS.Timeout; on: boolean }>();
  private handler: ImMessageHandler | undefined;
  private abort: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private online = false;
  private stopping = false;

  constructor(private readonly options: WeixinAdapterOptions) {
    this.logger = options.logger ?? createNoopLogger();
    this.capability = { ...WEIXIN_CAPABILITY, ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }) };
    this.maxChars = this.capability.maxChars;
    this.reconnectCfg = options.reconnect ?? { initialMs: 2000, maxMs: 10_000 };
  }

  get connected(): boolean {
    return this.online;
  }

  onMessage(handler: ImMessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.loop !== undefined) return;
    this.stopping = false;
    this.abort = new AbortController();
    try {
      await this.options.api.notifyStart(this.options.token);
      // notifyStart 成功即表示 token 有效、通道可用；首次 getUpdates 可能挂起 35s 长轮询
      this.online = true;
    } catch (err) {
      this.logger.warn("weixin notifyStart failed", { err: String(err) });
    }
    this.loop = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.online = false;
    this.abort?.abort();
    this.abort = undefined;
    for (const [, state] of this.typingState) {
      if (state.timer !== undefined) clearInterval(state.timer);
    }
    this.typingState.clear();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    try {
      await this.options.api.notifyStop(this.options.token);
    } catch {
      // 停止通知失败不影响退出
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let buf = (await this.options.state.load()).getUpdatesBuf;

    while (!signal.aborted && !this.stopping) {
      try {
        const updates = await this.options.api.getUpdates(this.options.token, buf, 35_000);
        failures = 0;
        this.online = true;
        if (updates.getUpdatesBuf !== buf) {
          buf = updates.getUpdatesBuf;
          await this.options.state.setCursor(buf, this.options.botId).catch(() => undefined);
        }
        for (const raw of this.order(updates.msgs)) {
          void this.dispatch(raw).catch((err) => {
            this.logger.error("weixin dispatch failed", { err: String(err) });
          });
        }
        if (updates.msgs.length === 0) {
          // 服务端提前返回空响应时退避，避免紧循环占满事件循环
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch (err) {
        if (signal.aborted || this.stopping) return;

        if (err instanceof WeixinApiError && err.code === "stale-token") {
          this.online = false;
          this.logger.error("weixin token expired (-14), re-scan required");
          this.options.onStaleToken?.("token expired");
          return;
        }

        failures += 1;
        this.logger.warn("weixin long-poll failed", { failures, err: String(err) });
        if (failures >= 3) {
          this.online = false;
          this.logger.error("weixin connection failed after 3 attempts", { err: String(err) });
          return;
        }
        const delay = Math.min(this.reconnectCfg.initialMs * 2 ** (failures - 1), this.reconnectCfg.maxMs);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private order(messages: WeixinMessage[]): WeixinMessage[] {
    return [...messages].sort((a, b) => {
      const sa = a.seq ?? a.create_time_ms ?? 0;
      const sb = b.seq ?? b.create_time_ms ?? 0;
      return sa - sb;
    });
  }

  private async dispatch(raw: WeixinMessage): Promise<void> {
    const text = this.extractText(raw);
    const from = raw.from_user_id;
    if (from === undefined) return;

    if (raw.context_token !== undefined) this.contextTokens.set(from, raw.context_token);

    const messageId = raw.msg_id ?? raw.client_id ?? `weixin-${raw.seq ?? Date.now()}`;
    const attachments = await this.extractAttachments(raw, messageId, from);
    const trimmed = text?.trim() ?? "";
    if (trimmed.length === 0 && attachments.length === 0) return;

    const message: InboundMessage = {
      scope: "c2c",
      channel: "weixin",
      peerId: from,
      senderId: from,
      text: text ?? "",
      mentioned: true,
      messageId,
      timestamp: raw.create_time_ms ?? Date.now(),
      ...(attachments.length === 0 ? {} : { attachments }),
    };
    void Promise.resolve(this.handler?.(message)).catch((err) => {
      this.logger.error("weixin message handler failed", { err: String(err) });
    });
  }

  private async extractAttachments(raw: WeixinMessage, messageId: string, from: string): Promise<Attachment[]> {
    const items = raw.item_list ?? [];
    const out: Attachment[] = [];

    for (const [index, item] of items.entries()) {
      if (item.type === 2) {
        const media = toMediaItem(item.image_item);
        if (media === undefined) continue;
        out.push(await this.fetchAttachment(media, "image", undefined, messageId, index, from));
      } else if (item.type === 4) {
        const file = item.file_item;
        const filename = typeof file?.file_name === "string" ? file.file_name : undefined;
        const len = typeof file?.len === "string" ? file.len : undefined;
        const media = toMediaItem(file, { ...(filename === undefined ? {} : { file_name: filename }), ...(len === undefined ? {} : { len }) });
        if (media === undefined) continue;
        out.push(await this.fetchAttachment(media, "file", filename, messageId, index, from));
      }
    }
    return out;
  }

  private async fetchAttachment(
    item: WeixinMediaItem,
    kind: "image" | "file",
    filename: string | undefined,
    messageId: string,
    index: number,
    from: string,
  ): Promise<Attachment> {
    const sizeHint = Number(item.len ?? "") > 0 ? Number(item.len) : undefined;
    const base: Attachment = {
      kind,
      ...(filename === undefined ? {} : { filename }),
      ...(sizeHint === undefined ? {} : { size: sizeHint }),
    };

    if (this.options.media === undefined || this.options.mediaRoot === undefined) return base;

    try {
      const { buffer, size } = await this.options.media.download(item);
      if (size > this.capability.maxFileBytes) {
        this.logger.warn("weixin media exceeds limit", { kind, bytes: size, max: this.capability.maxFileBytes });
        return { ...base, size };
      }
      const ext = kind === "image" ? imageExtFromBytes(buffer, filename) : fileExt(filename);
      const dir = path.join(this.options.mediaRoot, safeSegment(from));
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${safeSegment(messageId, 48)}-${index}${ext}`);
      writeFileSync(file, buffer, { mode: 0o600 });
      return { ...base, localPath: file, size };
    } catch (err) {
      this.logger.warn("weixin media download failed", { kind, err: String(err) });
      return base;
    }
  }

  private extractText(raw: WeixinMessage): string | undefined {
    for (const item of raw.item_list ?? []) {
      if (item.type === 1 && item.text_item?.text !== undefined) return item.text_item.text;
    }
    return undefined;
  }

  async sendText(target: ReplyTarget, text: string, _kind: SendKind): Promise<void> {
    const contextToken = this.contextTokens.get(target.targetId);
    const chunks = chunkMarkdownText(text, this.maxChars);
    for (const chunk of chunks) {
      await this.options.api.sendText(this.options.token, target.targetId, chunk, contextToken);
    }
  }

  async sendFile(target: ReplyTarget, files: PresentedFile[]): Promise<void> {
    const media = this.options.media;
    const contextToken = this.contextTokens.get(target.targetId);
    for (const file of files) {
      const resolved = this.resolvePath(file.path);
      if (media === undefined) {
        await this.sendText(target, `文件：${file.name}\n${resolved}`, "file");
        continue;
      }

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

      const kind: "image" | "file" = IMAGE_EXTENSIONS.has(fileExt(file.name, "")) ? "image" : "file";
      try {
        const uploaded = await media.upload(this.options.token, target.targetId, resolved, kind);
        await media.sendMedia(this.options.token, target.targetId, uploaded.item, contextToken);
        this.logger.info("weixin file sent", { name: file.name, kind, bytes: size });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn("weixin sendFile failed", { name: file.name, err: reason });
        await this.sendText(target, `文件发送失败：${file.name}\n原因：${reason}\n路径：${resolved}`, "error");
      }
    }
  }

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    const base = this.options.workspace;
    return base === undefined ? path.resolve(filePath) : path.join(base, filePath);
  }

  async sendTyping(target: ReplyTarget, on: boolean): Promise<void> {
    const existing = this.typingState.get(target.targetId);
    if (!on) {
      if (existing?.timer !== undefined) clearInterval(existing.timer);
      if (existing !== undefined) {
        await this.options.api.sendTyping(this.options.token, target.targetId, existing.ticket, 2).catch(() => undefined);
        this.typingState.delete(target.targetId);
      }
      return;
    }

    const contextToken = this.contextTokens.get(target.targetId);
    const ticket = existing?.ticket ?? (await this.options.api.getTypingTicket(this.options.token, target.targetId, contextToken));
    if (ticket === undefined) return;

    await this.options.api.sendTyping(this.options.token, target.targetId, ticket, 1).catch(() => undefined);
    const entry = existing ?? { ticket, on: true };
    entry.ticket = ticket;
    entry.on = true;
    if (entry.timer !== undefined) clearInterval(entry.timer);
    entry.timer = setInterval(() => {
      void this.options.api
        .sendTyping(this.options.token, target.targetId, entry.ticket, 1)
        .catch((err) => this.logger.debug("weixin typing keepalive failed", { err: String(err) }));
    }, 5000);
    entry.timer.unref?.();
    this.typingState.set(target.targetId, entry);
  }
}