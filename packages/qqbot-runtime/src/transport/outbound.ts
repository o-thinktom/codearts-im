import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkMarkdownText, createNoopLogger } from "@codearts-qqbot/core";
import type { Logger, PresentedFile, ReplyTarget } from "@codearts-qqbot/core";
import type { KernelEvent, QuestionItem } from "@codearts-qqbot/kernel-port";
import type { ImTransport, SendKind } from "./outbound-types.js";

/** 通过内置浏览器预览的本地文件，视为交付物 */
const PREVIEW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"]);

/** 工具名可能带命名空间前缀（如 builtin:browser、mcp__browser），按尾段判定 */
function isBrowserToolName(name: string): boolean {
  return (name.split(/[^A-Za-z0-9]+/).pop() ?? name) === "browser";
}

/** 正文里的本地图片标记：![alt](path) 与 [[file:path]] */
const LOCAL_FILE_MARKER = /!\[[^\]]*\]\(([^)\s]+)\)|\[\[file:([^\]\s]+)\]\]/g;

/** 发送前剥离本地图片标记，避免把内部约定暴露给用户 */
function stripLocalFileMarkers(text: string): string {
  return text
    .replace(LOCAL_FILE_MARKER, (whole, md: string | undefined) => (/^(?:https?:|data:)/i.test(md ?? "") ? whole : ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface OutboundOptions {
  transport: ImTransport;
  textChunkLimit?: number;
  showToolResults?: boolean;
  logger?: Logger;
  now?: () => number;
  /** 工作区根目录：交付物相对路径以此为基准解析 */
  workspace?: string;
  /** 是否启用 token 级流式（需 transport.sendDelta 与平台支持） */
  streaming?: boolean;
  /** 流式增量节流间隔，默认 600ms */
  deltaIntervalMs?: number;
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
  /** 已收到 turn/end：内核迟到的事件仍允许投递 */
  closed: boolean;
  /** 已通过流式发送的全文 */
  streamed: string;
  deltaTimer?: NodeJS.Timeout;
  /** 流式失败后本轮回退为整段发送 */
  streamDisabled: boolean;
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
  private readonly workspace: string | undefined;
  private readonly streaming: boolean;
  private readonly deltaIntervalMs: number;
  private readonly turns = new Map<string, TurnState>();
  private readonly chains = new Map<string, Promise<void>>();
  /** 每个会话最近一次的投递目标（turn 结束后保留，供提问/审批等异步通知使用） */
  private readonly targets = new Map<string, ReplyTarget>();

  constructor(opts: OutboundOptions) {
    this.transport = opts.transport;
    this.limit = opts.textChunkLimit ?? 4500;
    this.showToolResults = opts.showToolResults ?? false;
    this.logger = opts.logger ?? createNoopLogger();
    this.workspace = opts.workspace;
    this.streaming = opts.streaming === true && opts.transport.sendDelta !== undefined;
    this.deltaIntervalMs = Math.max(200, opts.deltaIntervalMs ?? 600);
  }

  private resolveDeliverable(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return this.workspace === undefined ? path.resolve(filePath) : path.join(this.workspace, filePath);
  }

  /**
   * 内核不推送交付物事件时，从 `browser` 预览调用推断产物：
   * 只接受工作区内的本地 file:// 图片/PDF，避免把任意文件发给用户。
   */
  private collectPreviewFile(state: TurnState, toolName: string, args: unknown): void {
    if (!isBrowserToolName(toolName) || this.workspace === undefined) return;
    if (args === null || typeof args !== "object") return;
    const url = (args as Record<string, unknown>)["url"];
    if (typeof url !== "string" || !url.startsWith("file:")) return;

    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return;
    }
    if (!PREVIEW_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
    if (!this.insideWorkspace(filePath)) return;
    if (state.presentedCalls.has(filePath)) return;

    state.presentedCalls.add(filePath);
    state.presented.push({ path: filePath, name: path.basename(filePath) });
  }

  /**
   * 兜底：正文里显式声明的本地图片。内核不推送交付物事件时，
   * 仍能按工作区 + 扩展名白名单把产物发给用户。
   */
  private collectDeclaredFiles(state: TurnState, text: string): void {
    if (this.workspace === undefined) return;
    const pattern = new RegExp(LOCAL_FILE_MARKER.source, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1] ?? match[2];
      if (raw === undefined || /^(?:https?:|data:|file:|\/\/)/i.test(raw)) continue;
      const filePath = this.resolveDeliverable(raw.replace(/^\.\//, ""));
      if (!PREVIEW_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
      if (!this.insideWorkspace(filePath)) continue;
      if (state.presentedCalls.has(filePath)) continue;
      state.presentedCalls.add(filePath);
      state.presented.push({ path: filePath, name: path.basename(filePath) });
    }
  }

  private insideWorkspace(filePath: string): boolean {
    if (this.workspace === undefined) return false;
    const rel = path.relative(path.resolve(this.workspace), path.resolve(filePath));
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /** 在新一轮 prompt 之前调用，绑定投递目标 */
  beginTurn(sessionId: string, target: ReplyTarget, turn: number): void {
    const previous = this.turns.get(sessionId);
    if (previous?.deltaTimer !== undefined) clearTimeout(previous.deltaTimer);
    this.targets.set(sessionId, target);
    this.turns.set(sessionId, {
      turn,
      target,
      segments: new Map(),
      nextOrder: 0,
      toolCalls: new Map(),
      presented: [],
      presentedCalls: new Set(),
      closed: false,
      streamed: "",
      streamDisabled: false,
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
      if (state.deltaTimer !== undefined) clearTimeout(state.deltaTimer);
      state.deltaTimer = undefined;
      state.streamed = "";
      state.streamDisabled = false;
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
        this.scheduleDelta(sessionId, state);
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
        this.collectPreviewFile(state, event.name, event.args);
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
        const files = event.files.map((f) => ({ ...f, path: this.resolveDeliverable(f.path) }));
        const fresh = files.filter((f) => !state.presentedCalls.has(f.path));
        for (const f of fresh) state.presentedCalls.add(f.path);
        if (state.closed) {
          // 本轮已结束：内核迟到的交付物直接补发
          if (fresh.length > 0) this.enqueue(sessionId, (t) => this.transport.sendFile(t, fresh));
          return;
        }
        state.presented.push(...fresh);
        return;
      }

      case "turn/end": {
        if (state.deltaTimer !== undefined) {
          clearTimeout(state.deltaTimer);
          state.deltaTimer = undefined;
        }
        const merged = [...state.segments.values()]
          .sort((a, b) => a.order - b.order)
          .map((s) => s.text)
          .join("\n\n");
        state.segments.clear();
        this.collectDeclaredFiles(state, merged);
        const pending = stripLocalFileMarkers(merged);

        if (state.streamed.length > 0 && this.streaming && !state.streamDisabled) {
          // 已流式输出：用 finish 帧收尾（顺带覆盖最终文本，处理候选重写）
          this.logger.info("reply sending (stream finish)", { sessionId, length: pending.length });
          this.enqueue(sessionId, async (t) => {
            try {
              await this.transport.sendDelta?.(t, pending, true);
            } catch (err) {
              this.logger.warn("stream finish failed, falling back", { err: String(err) });
              await this.sendText(t, pending, "reply");
            }
          });
        } else if (pending.trim().length > 0) {
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
        // 内核可能在本轮结束后才补发交付物事件，保留状态一小段时间
        state.closed = true;
        const cleanup = setTimeout(() => {
          if (this.turns.get(sessionId) === state) this.turns.delete(sessionId);
        }, 5000);
        cleanup.unref?.();
        return;
      }
    }
  }

  /** 合并所有分段文本，规则与 turn/end 一致 */
  private mergedText(state: TurnState): string {
    return [...state.segments.values()]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.text)
      .join("\n\n");
  }

  /** 节流推送流式增量：平台 ack 慢时避免中间帧堆积 */
  private scheduleDelta(sessionId: string, state: TurnState): void {
    if (!this.streaming || state.streamDisabled || state.deltaTimer !== undefined) return;
    const timer = setTimeout(() => {
      state.deltaTimer = undefined;
      if (this.turns.get(sessionId) !== state) return;
      void this.pushDelta(sessionId, state);
    }, this.deltaIntervalMs);
    timer.unref?.();
    state.deltaTimer = timer;
  }

  private async pushDelta(sessionId: string, state: TurnState): Promise<void> {
    if (state.streamDisabled || this.transport.sendDelta === undefined) return;
    const text = stripLocalFileMarkers(this.mergedText(state));
    if (text.length === 0 || text === state.streamed) return;
    try {
      await this.transport.sendDelta(state.target, text, false);
      state.streamed = text;
    } catch (err) {
      state.streamDisabled = true;
      this.logger.warn("stream delta failed, falling back to flush", { sessionId, err: String(err) });
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