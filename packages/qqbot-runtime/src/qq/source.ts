import { ErrorCode, QqbotError, createNoopLogger } from "@codearts-qqbot/core";
import type { InboundMessage, Logger } from "@codearts-qqbot/core";
import type { QqApi } from "./client.js";
import {
  INTENTS_GROUP_AND_C2C,
  defaultWebSocketFactory,
  parseQqMessage,
  type QqMessageData,
  type QqPayload,
  type WebSocketFactory,
  type WebSocketLike,
} from "./types.js";

export interface QqInboundSourceOptions {
  api: QqApi;
  intents?: number;
  wsFactory?: WebSocketFactory;
  logger?: Logger;
  reconnect?: { initialMs: number; maxMs: number };
}

type MessageHandler = (message: InboundMessage) => void | Promise<void>;

/**
 * QQ 官方 WebSocket 长连接接入。
 *
 * 协议要点：
 * - 先用 AppID/AppSecret 换 access_token，再取 gateway；
 * - 收到 OP10(Hello) 后按 heartbeat_interval 发 OP1；
 * - 发 OP2(Identify)，token 形如 `QQBot <access_token>`；
 * - OP0 中 C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE 转统一入站消息；
 * - 断线按指数退避重连，OP7/OP9 主动断开走重连。
 */
export class QqInboundSource {
  private readonly api: QqApi;
  private readonly intents: number;
  private readonly wsFactory: WebSocketFactory;
  private readonly logger: Logger;
  private readonly reconnectCfg: { initialMs: number; maxMs: number };
  private handlers: MessageHandler[] = [];
  private ws: WebSocketLike | undefined;
  private stopped = true;
  private online = false;
  private loopPromise: Promise<void> | undefined;

  constructor(options: QqInboundSourceOptions) {
    this.api = options.api;
    this.intents = options.intents ?? INTENTS_GROUP_AND_C2C;
    this.wsFactory = options.wsFactory ?? defaultWebSocketFactory;
    this.logger = options.logger ?? createNoopLogger();
    this.reconnectCfg = options.reconnect ?? { initialMs: 1000, maxMs: 60000 };
  }

  get connected(): boolean {
    return this.online;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.online = false;
    this.ws?.close(1000, "client shutdown");
    this.ws = undefined;
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = undefined;
  }

  private async loop(): Promise<void> {
    let backoff = this.reconnectCfg.initialMs;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        backoff = this.reconnectCfg.initialMs;
      } catch (err) {
        if (this.stopped) return;
        this.logger.warn("qq ws disconnected", { err: err instanceof Error ? err.message : String(err), backoff });
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, this.reconnectCfg.maxMs);
    }
  }

  private async connectOnce(): Promise<void> {
    const token = await this.api.getToken();
    const url = await this.api.getGateway();
    const ws = this.wsFactory(url);
    this.ws = ws;

    await new Promise<void>((resolve) => {
      let heartbeat: NodeJS.Timeout | undefined;
      let seq = 0;
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        this.online = false;
        if (this.ws === ws) this.ws = undefined;
        resolve();
      };

      const send = (payload: unknown): void => {
        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          this.logger.warn("qq ws send failed", { err: String(err) });
        }
      };

      ws.addEventListener("open", () => {
        this.logger.info("qq ws opened");
      });

      ws.addEventListener("message", (event: unknown) => {
        const raw = typeof (event as { data?: unknown }).data === "string"
          ? ((event as { data: string }).data)
          : String((event as { data?: unknown }).data ?? "");
        let payload: QqPayload;
        try {
          payload = JSON.parse(raw) as QqPayload;
        } catch {
          return;
        }
        if (typeof payload.s === "number") seq = payload.s;

        switch (payload.op) {
          case 10: {
            const interval = Number((payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 30000);
            const beat = (): void => send({ op: 1, d: seq });
            beat();
            heartbeat = setInterval(beat, Math.max(1000, interval));
            heartbeat.unref?.();
            send({
              op: 2,
              d: {
                token: `QQBot ${token}`,
                intents: this.intents,
                shard: [0, 1],
                properties: {},
              },
            });
            break;
          }
          case 0: {
            if (payload.t === "READY") {
              this.online = true;
              this.logger.info("qq bot ready");
            } else if (payload.t !== undefined && payload.d !== undefined) {
              this.dispatch(payload.t, payload.d as QqMessageData);
            }
            break;
          }
          case 7:
            this.logger.info("qq ws asked to reconnect");
            ws.close(4000, "reconnect");
            break;
          case 9:
            this.logger.warn("qq ws invalid session");
            ws.close(4010, "invalid session");
            break;
          default:
            break;
        }
      });

      ws.addEventListener("close", () => finish());
      ws.addEventListener("error", () => finish());
    });
  }

  private dispatch(eventType: string, data: QqMessageData): void {
    const message = parseQqMessage(eventType, data);
    if (message === undefined) return;
    this.logger.info("qq message received", {
      scope: message.scope,
      peerId: message.peerId,
      messageId: message.messageId,
    });
    for (const handler of this.handlers) {
      void Promise.resolve(handler(message)).catch((err) => {
        this.logger.error("qq message handler failed", { err: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  /** 连通性自检：token + gateway + 一次 identify 是否成功 */
  async probe(timeoutMs = 15000): Promise<{ tokenOk: boolean; gatewayOk: boolean; wsOk: boolean }> {
    const basic = await this.api.probe();
    if (!basic.gatewayOk) return { ...basic, wsOk: false };

    let token: string;
    try {
      token = await this.api.getToken();
      await this.api.getGateway();
    } catch (err) {
      throw new QqbotError(ErrorCode.WS_CONNECT_FAILED, "probe failed", { cause: err });
    }

    return { ...basic, wsOk: token.length > 0 };
  }
}