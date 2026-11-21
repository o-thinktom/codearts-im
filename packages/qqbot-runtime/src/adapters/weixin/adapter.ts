import { chunkMarkdownText, createNoopLogger } from "@codearts-qqbot/core";
import type { InboundMessage, Logger, PresentedFile, ReplyTarget } from "@codearts-qqbot/core";
import type { ChannelCapability, ImAdapter } from "../../transport/adapter.js";
import type { ImMessageHandler, SendKind } from "../../transport/outbound-types.js";
import { WeixinApi, WeixinApiError, type WeixinMessage } from "./weixin-api.js";
import type { WeixinStateStore } from "./weixin-state.js";

export const WEIXIN_CAPABILITY: ChannelCapability = {
  maxChars: 1800,
  streaming: false,
  typing: true,
  buttons: false,
  media: "cdn",
  maxFileBytes: 20 * 1024 * 1024,
};

export interface WeixinAdapterOptions {
  api: WeixinApi;
  botId: string;
  token: string;
  state: WeixinStateStore;
  logger?: Logger;
  maxChars?: number;
  reconnect?: { initialMs: number; maxMs: number };
  onStaleToken?: (reason: string) => void;
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
        for (const raw of this.order(updates.msgs)) this.dispatch(raw);
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

  private dispatch(raw: WeixinMessage): void {
    const text = this.extractText(raw);
    const from = raw.from_user_id;
    if (text === undefined || from === undefined || text.trim().length === 0) return;

    if (raw.context_token !== undefined) this.contextTokens.set(from, raw.context_token);

    const message: InboundMessage = {
      scope: "c2c",
      channel: "weixin",
      peerId: from,
      senderId: from,
      text,
      mentioned: true,
      messageId: raw.msg_id ?? raw.client_id ?? `weixin-${raw.seq ?? Date.now()}`,
      timestamp: raw.create_time_ms ?? Date.now(),
    };
    void Promise.resolve(this.handler?.(message)).catch((err) => {
      this.logger.error("weixin message handler failed", { err: String(err) });
    });
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
    // PR-3 实现 CDN 上传；当前降级为路径文本，避免静默丢文件
    for (const file of files) {
      await this.sendText(target, `文件：${file.name}\n${file.path}`, "file");
    }
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