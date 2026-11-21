import type { InboundMessage, Logger, PresentedFile, ReplyTarget } from "@codearts-qqbot/core";
import { QQ_CAPABILITY, type ChannelCapability, type ImAdapter } from "../../transport/adapter.js";
import type { ImMessageHandler, SendKind } from "../../transport/outbound-types.js";
import { QqApi } from "../../qq/client.js";
import { QqInboundSource } from "../../qq/source.js";
import { QqImTransport } from "../../qq/transport.js";

export interface QqAdapterOptions {
  api: QqApi;
  logger?: Logger;
  allowedRoots?: string[];
  maxFileBytes?: number;
}

/**
 * QQ 渠道适配器：包装现有 WS 接入与出站实现，行为保持不变。
 *
 * 这样微信/企微只需新增 adapter，gateway / outbound / session 无需感知协议。
 */
export class QqAdapter implements ImAdapter {
  readonly id = "qq" as const;
  readonly capability: ChannelCapability = QQ_CAPABILITY;

  private readonly source: QqInboundSource;
  private readonly transport: QqImTransport;

  constructor(options: QqAdapterOptions) {
    this.source = new QqInboundSource({ api: options.api, ...(options.logger ? { logger: options.logger } : {}) });
    this.transport = new QqImTransport(options.api, {
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.allowedRoots === undefined ? {} : { allowedRoots: options.allowedRoots }),
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    });
  }

  get connected(): boolean {
    return this.source.connected;
  }

  async start(): Promise<void> {
    await this.transport.start();
    await this.source.start();
  }

  async stop(): Promise<void> {
    await this.source.stop();
    await this.transport.stop();
  }

  onMessage(handler: ImMessageHandler): void {
    this.source.onMessage(handler);
  }

  async sendText(target: ReplyTarget, text: string, kind: SendKind): Promise<void> {
    await this.transport.sendText(target, text, kind);
  }

  async sendFile(target: ReplyTarget, files: PresentedFile[]): Promise<void> {
    await this.transport.sendFile(target, files);
  }

  /** 兼容：部分调用方直接读取原始 source/transport（迁移期） */
  get raw(): { source: QqInboundSource; transport: QqImTransport } {
    return { source: this.source, transport: this.transport };
  }
}

export type { InboundMessage };