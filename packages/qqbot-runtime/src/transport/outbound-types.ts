import type { PresentedFile, ReplyTarget } from "@codearts-qqbot/core";

export type SendKind = "reply" | "tool" | "notice" | "error" | "file";

export interface ImTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(target: ReplyTarget, text: string, kind: SendKind): Promise<void>;
  sendFile(target: ReplyTarget, files: PresentedFile[]): Promise<void>;
  /** 可选：token 级流式增量；finish=true 表示结束本次流 */
  sendDelta?(target: ReplyTarget, text: string, finish?: boolean): Promise<void>;
}

export type ImMessageHandler = (message: import("@codearts-qqbot/core").InboundMessage) => void | Promise<void>;

export interface InboundSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: ImMessageHandler): void;
  readonly connected: boolean;
}

export interface MockSend {
  target: ReplyTarget;
  text: string;
  kind: SendKind;
}

export class MockImTransport implements ImTransport {
  readonly sent: MockSend[] = [];
  readonly files: Array<{ target: ReplyTarget; files: PresentedFile[] }> = [];
  readonly deltas: Array<{ target: ReplyTarget; text: string; finish: boolean }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendText(target: ReplyTarget, text: string, kind: SendKind): Promise<void> {
    this.sent.push({ target, text, kind });
  }

  async sendFile(target: ReplyTarget, files: PresentedFile[]): Promise<void> {
    this.files.push({ target, files });
  }

  async sendDelta(target: ReplyTarget, text: string, finish = false): Promise<void> {
    this.deltas.push({ target, text, finish });
  }
}

export class MockInboundSource implements InboundSource {
  private handler: ImMessageHandler | undefined;
  private state = false;

  async start(): Promise<void> {
    this.state = true;
  }

  async stop(): Promise<void> {
    this.state = false;
  }

  onMessage(handler: ImMessageHandler): void {
    this.handler = handler;
  }

  get connected(): boolean {
    return this.state;
  }

  async deliver(message: import("@codearts-qqbot/core").InboundMessage): Promise<void> {
    if (!this.state || this.handler === undefined) throw new Error("mock source is not started");
    await this.handler(message);
  }
}