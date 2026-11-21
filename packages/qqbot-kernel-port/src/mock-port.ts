import { QqbotError, ErrorCode, createNoopLogger } from "@codearts-qqbot/core";
import type { Decision, Logger } from "@codearts-qqbot/core";
import type {
  Capability,
  CreateSessionInput,
  KernelEvent,
  KernelEventHandler,
  KernelInfo,
  KernelPort,
  KernelPortOptions,
  PromptPart,
  QuestionItem,
} from "./port.js";

export interface MockReply {
  text: string;
  toolCall?: { name: string; args?: unknown; ok?: boolean; summary?: string };
  permission?: { action: string; detail: string };
  deliverable?: { path: string; name?: string }[];
  error?: { code: string; message: string };
}

export interface MockKernelOptions extends KernelPortOptions {
  responder?: (prompt: string, sessionId: string) => MockReply | Promise<MockReply>;
  streaming?: boolean;
  deltaSize?: number;
  latencyMs?: number;
  version?: string;
  failHealth?: boolean;
}

interface MockSession {
  id: string;
  cwd: string;
  turns: number;
}

/**
 * 假内核：用于本地开发、单测与 CI 闭环。
 *
 * 行为刻意贴近设计文档的统一事件模型（turn/start → delta* → message/complete → turn/end），
 * 使上层编排可以脱离真实内核完成验证。
 */
export class MockKernelPort implements KernelPort {
  private readonly sessions = new Map<string, MockSession>();
  private readonly handlers = new Set<KernelEventHandler>();
  private readonly logger: Logger;
  private readonly responder: (prompt: string, sessionId: string) => MockReply | Promise<MockReply>;
  private readonly streaming: boolean;
  private readonly deltaSize: number;
  private readonly latencyMs: number;
  private readonly version: string;
  private failHealth: boolean;
  private seq = 0;
  private closed = false;

  public readonly calls: Array<{ method: string; args: unknown[] }> = [];
  public readonly permissions: Array<{ sessionId: string; requestId: string; decision: Decision }> = [];
  public readonly questionAnswers: Array<{ requestId: string; answers: string[][] }> = [];

  constructor(options: MockKernelOptions = {}) {
    this.logger = options.logger ?? createNoopLogger();
    this.responder = options.responder ?? (() => ({ text: "收到。" }));
    this.streaming = options.streaming ?? true;
    this.deltaSize = options.deltaSize ?? 8;
    this.latencyMs = options.latencyMs ?? 0;
    this.version = options.version ?? "mock-0.1.0";
    this.failHealth = options.failHealth ?? false;
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private emit(event: KernelEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        this.logger.error("mock kernel handler failed", { err: String(err) });
      }
    }
  }

  async info(): Promise<KernelInfo> {
    this.record("info");
    const capabilities = new Set<Capability>();
    for (const c of [
      "session.create",
      "session.resume",
      "session.exists",
      "prompt",
      "event.stream",
      "compact",
      "model.set",
      "permission",
      "deliverable",
    ] as const) {
      capabilities.add(c);
    }
    if (this.streaming) capabilities.add("event.delta");
    return {
      version: this.version,
      endpoint: "mock://kernel",
      capabilities,
      agentIds: ["standard"],
      providers: ["mock-provider"],
    };
  }

  async health(): Promise<boolean> {
    this.record("health");
    return !this.failHealth && !this.closed;
  }

  setHealth(value: boolean): void {
    this.failHealth = !value;
  }

  async createSession(input: CreateSessionInput): Promise<{ id: string }> {
    this.record("createSession", input);
    this.seq += 1;
    const id = `session-${this.seq.toString().padStart(4, "0")}`;
    this.sessions.set(id, { id, cwd: input.cwd, turns: 0 });
    return { id };
  }

  async resumeSession(id: string): Promise<{ id: string }> {
    this.record("resumeSession", id);
    if (!this.sessions.has(id)) throw new QqbotError(ErrorCode.SESSION_RESUME_FAILED, `unknown session ${id}`);
    return { id };
  }

  async sessionExists(id: string): Promise<boolean | undefined> {
    this.record("sessionExists", id);
    return this.sessions.has(id);
  }

  async prompt(id: string, parts: PromptPart[]): Promise<void> {
    this.record("prompt", id, parts);
    const session = this.sessions.get(id);
    if (!session) throw new QqbotError(ErrorCode.SESSION_CREATE_FAILED, `unknown session ${id}`);
    if (this.closed) throw new QqbotError(ErrorCode.KERNEL_NOT_READY, "kernel closed");

    const text = parts
      .map((p) => (p.kind === "text" ? p.text : `[${p.kind}:${p.path}]`))
      .join("\n");
    const reply = await this.responder(text, id);

    session.turns += 1;
    const turn = session.turns;
    const attemptId = `${id}:${turn}`;

    void this.runTurn(id, turn, attemptId, reply);
  }

  private async runTurn(id: string, turn: number, attemptId: string, reply: MockReply): Promise<void> {
    const wait = (): Promise<void> =>
      this.latencyMs > 0 ? new Promise((r) => setTimeout(r, this.latencyMs)) : Promise.resolve();

    this.emit({ type: "turn/start", sessionId: id, turn });

    if (reply.toolCall) {
      const callId = `call-${turn}-1`;
      this.emit({ type: "tool/call", sessionId: id, callId, name: reply.toolCall.name, args: reply.toolCall.args ?? {} });
      await wait();
      this.emit({
        type: "tool/result",
        sessionId: id,
        callId,
        ok: reply.toolCall.ok ?? true,
        ...(reply.toolCall.summary === undefined ? {} : { summary: reply.toolCall.summary }),
      });
    }

    if (reply.permission) {
      this.emit({
        type: "permission/request",
        sessionId: id,
        requestId: `perm-${turn}-1`,
        action: reply.permission.action,
        detail: reply.permission.detail,
      });
    }

    if (this.streaming && reply.text.length > 0) {
      const size = Math.max(1, this.deltaSize);
      for (let i = 0; i < reply.text.length; i += size) {
        this.emit({ type: "text/delta", sessionId: id, turn, attemptId, text: reply.text.slice(i, i + size) });
        await wait();
      }
    }

    this.emit({ type: "message/complete", sessionId: id, turn, blocks: [{ type: "text", text: reply.text }] });

    if (reply.deliverable && reply.deliverable.length > 0) {
      this.emit({
        type: "deliverable",
        sessionId: id,
        files: reply.deliverable.map((f) => ({ path: f.path, name: f.name ?? f.path.split(/[\\/]/).pop() ?? f.path })),
      });
    }

    this.emit({
      type: "turn/end",
      sessionId: id,
      turn,
      ...(reply.error === undefined ? {} : { reason: reply.error }),
    });
  }

  subscribe(handler: KernelEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async waitStreamReady(): Promise<boolean> {
    return true;
  }

  async compact(id: string): Promise<void> {
    this.record("compact", id);
    if (!this.sessions.has(id)) throw new QqbotError(ErrorCode.SESSION_CREATE_FAILED, "unknown session");
  }

  async setModel(id: string, provider: string, model: string): Promise<void> {
    this.record("setModel", id, provider, model);
    if (!this.sessions.has(id)) throw new QqbotError(ErrorCode.SESSION_CREATE_FAILED, "unknown session");
  }

  async respondPermission(id: string, requestId: string, decision: Decision): Promise<void> {
    this.record("respondPermission", id, requestId, decision);
    this.permissions.push({ sessionId: id, requestId, decision });
  }

  async respondQuestion(_sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    this.record("respondQuestion", requestId, answers);
    this.questionAnswers.push({ requestId, answers });
  }

  /** 测试辅助：触发一次提问事件 */
  emitQuestion(sessionId: string, requestId: string, questions: QuestionItem[]): void {
    this.emit({ type: "question/request", sessionId, requestId, questions });
  }

  async cancel(id: string): Promise<void> {
    this.record("cancel", id);
    const session = this.sessions.get(id);
    if (session === undefined) return;
    this.emit({ type: "turn/end", sessionId: id, turn: session.turns, reason: { code: "CANCELLED", message: "user cancelled" } });
  }

  async disposeSession(id: string): Promise<void> {
    this.record("disposeSession", id);
    this.sessions.delete(id);
  }

  async close(): Promise<void> {
    this.record("close");
    this.closed = true;
    this.handlers.clear();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
