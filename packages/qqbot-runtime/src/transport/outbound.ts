import { chunkMarkdownText, createNoopLogger } from "@codearts-qqbot/core";
import type { Logger, PresentedFile, ReplyTarget } from "@codearts-qqbot/core";
import type { KernelEvent, QuestionItem } from "@codearts-qqbot/kernel-port";
import type { ImTransport, SendKind } from "./outbound-types.js";

export interface OutboundOptions {
  transport: ImTransport;
  textChunkLimit?: number;
  showToolResults?: boolean;
  logger?: Logger;
  now?: () => number;
}

interface Segment {
  text: string;
  order: number;
}

interface TurnState {
  turn: number;
  target: ReplyTarget;
  /** 按 messageId 分段收集：一轮里可能有多条 assistant 消息（多步/工具后继续） */
  segments: Map<string, Segment>;
  nextOrder: number;
  toolCalls: Map<string, { name: string; args: unknown }>;
  presented: PresentedFile[];
  presentedCalls: Set<string>;
}

/**
 * 内核事件 → IM 消息。
 *
 * 关键语义：
 * - 回合归属：只有当前 turn 的事件才会被投递，避免并发串话；
 * - 多消息：一轮内按 messageId 分段累积，各自完成时投递，不再丢弃后续消息；
 * - 兜底：turn/end 时把未完成的剩余分段按顺序合并投递；
 * - 顺序：同一会话的发送串行化，保证"文本先于文件"；
 * - 幂等：同一 callId 的交付物只投递一次。
 */
export class OutboundRouter {
  private readonly transport: ImTransport;
  private readonly limit: number;
  private readonly showToolResults: boolean;
  private readonly logger: Logger;
  private readonly turns = new Map<string, TurnState>();
  private readonly chains = new Map<string, Promise<void>>();
  /** 每个会话最近一次的投递目标（turn 结束后保留，供提问/审批等异步通知使用） */
  private readonly targets = new Map<string, ReplyTarget>();

  constructor(opts: OutboundOptions) {
    this.transport = opts.transport;
    this.limit = opts.textChunkLimit ?? 4500;
    this.showToolResults = opts.showToolResults ?? false;
    this.logger = opts.logger ?? createNoopLogger();
  }

  /** 在新一轮 prompt 之前调用，绑定投递目标 */
  beginTurn(sessionId: string, target: ReplyTarget, turn: number): void {
    this.targets.set(sessionId, target);
    this.turns.set(sessionId, {
      turn,
      target,
      segments: new Map(),
      nextOrder: 0,
      toolCalls: new Map(),
      presented: [],
      presentedCalls: new Set(),
    });
  }

  route(sessionId: string, event: KernelEvent): void {
    const state = this.turns.get(sessionId);

    if (state === undefined) {
      if (event.type === "question/request") {
        const target = this.targets.get(sessionId);
        if (target !== undefined) {
          this.enqueueTo(sessionId, target, (t) => this.sendText(t, this.questionText(event.questions), "notice"));
        }
      }
      return;
    }

    if (event.type === "turn/start") {
      if (state === undefined) return;
      state.turn = event.turn;
      state.segments.clear();
      state.nextOrder = 0;
      state.toolCalls.clear();
      state.presented = [];
      state.presentedCalls.clear();
      return;
    }

    if (state === undefined) return;
    if ("turn" in event && event.turn !== state.turn) return;

    switch (event.type) {
      case "text/delta": {
        const existing = state.segments.get(event.attemptId);
        if (existing !== undefined) {
          existing.text += event.text;
        } else {
          state.segments.set(event.attemptId, { text: event.text, order: state.nextOrder });
          state.nextOrder += 1;
        }
        return;
      }

      case "message/complete": {
        const messageId = event.messageId ?? this.lastSegmentId(state);
        const segment = messageId === undefined ? undefined : state.segments.get(messageId);
        const fallback = event.blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text ?? "")
          .join("\n");
        if (segment === undefined && fallback.trim().length > 0) {
          const key = messageId ?? `fallback-${state.nextOrder}`;
          state.segments.set(key, { text: fallback, order: state.nextOrder });
          state.nextOrder += 1;
        }
        this.logger.info("reply buffered", {
          sessionId,
          messageId: messageId ?? "n/a",
          length: (segment?.text ?? fallback).length,
        });
        return;
      }

      case "tool/call":
        state.toolCalls.set(event.callId, { name: event.name, args: event.args });
        return;

      case "tool/result": {
        const call = state.toolCalls.get(event.callId);
        state.toolCalls.delete(event.callId);
        if (call === undefined) return;
        if (event.ok && !this.showToolResults) return;
        const text = event.ok
          ? `🔧 ${call.name}\n${event.summary ?? "(已执行)"}`
          : `🔧 ${call.name} 执行失败\n${event.summary ?? ""}`.trim();
        this.enqueue(sessionId, (t) => this.sendText(t, text, "tool"));
        return;
      }

      case "permission/request":
        this.enqueue(sessionId, (t) =>
          this.sendText(t, `⚠️ 需要审批：${event.action}\n${event.detail}\n\n回复 1 允许 / 2 拒绝（或 /allow /deny）`, "notice"),
        );
        return;

      case "question/request":
        this.enqueue(sessionId, (t) => this.sendText(t, this.questionText(event.questions), "notice"));
        return;

      case "deliverable": {
        const fresh = event.files.filter((f) => !state.presentedCalls.has(f.path));
        for (const f of fresh) state.presentedCalls.add(f.path);
        state.presented.push(...fresh);
        return;
      }

      case "turn/end": {
        const pending = [...state.segments.values()]
          .sort((a, b) => a.order - b.order)
          .map((s) => s.text)
          .join("\n\n");
        state.segments.clear();
        if (pending.trim().length > 0) {
          this.logger.info("reply sending (flush)", { sessionId, length: pending.length });
          this.enqueue(sessionId, (t) => this.sendText(t, pending, "reply"));
        }

        const files = state.presented;
        state.presented = [];
        if (event.reason !== undefined) {
          this.enqueue(sessionId, (t) =>
            this.sendText(t, `⚠️ 本轮异常结束\n${event.reason?.code}: ${event.reason?.message}`, "error"),
          );
        }
        if (files.length > 0) {
          this.enqueue(sessionId, async (t) => {
            await this.transport.sendFile(t, files);
          });
        }
        this.turns.delete(sessionId);
        return;
      }
    }
  }

  private questionText(questions: QuestionItem[]): string {
    const lines = ["❓ 需要你选择"];
    questions.forEach((question, index) => {
      if (questions.length > 1) lines.push(`问题 ${index + 1}：`);
      if (question.header !== undefined && question.header.length > 0) lines.push(`【${question.header}】`);
      lines.push(question.question);
      question.options.forEach((option, optionIndex) => {
        const letter = String.fromCharCode(65 + optionIndex);
        const suffix = option.description === undefined ? "" : ` — ${option.description}`;
        lines.push(`${letter}. ${option.label}${suffix}`);
      });
    });
    lines.push(
      questions.length > 1
        ? "回复格式：A;B（每个问题用分号分隔，多选用逗号）"
        : "回复字母选择（多选用逗号，如 A,C）",
    );
    return lines.join("\n");
  }

  private lastSegmentId(state: TurnState): string | undefined {
    let last: { id: string; order: number } | undefined;
    for (const [id, segment] of state.segments) {
      if (last === undefined || segment.order > last.order) last = { id, order: segment.order };
    }
    return last?.id;
  }

  private enqueue(sessionId: string, task: (target: ReplyTarget) => Promise<void>): void {
    const state = this.turns.get(sessionId);
    if (state === undefined) return;
    const target = state.target;
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => task(target))
      .catch((err) => {
        this.logger.error("outbound send failed", { sessionId, err: String(err) });
      });
    this.chains.set(sessionId, next);
  }

  private enqueueTo(sessionId: string, target: ReplyTarget, task: (t: ReplyTarget) => Promise<void>): void {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => task(target))
      .catch((err) => {
        this.logger.error("outbound send failed", { sessionId, err: String(err) });
      });
    this.chains.set(sessionId, next);
  }

  private async sendText(target: ReplyTarget, text: string, kind: SendKind): Promise<void> {
    const chunks = chunkMarkdownText(text, this.limit);
    for (const chunk of chunks) {
      await this.transport.sendText(target, chunk, kind);
    }
  }

  async flush(sessionId: string): Promise<void> {
    await (this.chains.get(sessionId) ?? Promise.resolve());
  }

  async flushAll(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }
}