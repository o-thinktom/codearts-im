import type { Decision, Logger, PresentedFile } from "@codearts-qqbot/core";

export type Capability =
  | "session.create"
  | "session.resume"
  | "session.exists"
  | "prompt"
  | "event.stream"
  | "event.delta"
  | "compact"
  | "model.set"
  | "permission"
  | "deliverable";

export interface KernelInfo {
  version: string;
  endpoint: string;
  capabilities: Set<Capability>;
  agentIds: string[];
  providers: string[];
}

export interface PromptPartText {
  kind: "text";
  text: string;
}

export interface PromptPartFile {
  kind: "file" | "image";
  path: string;
  mime?: string;
}

export type PromptPart = PromptPartText | PromptPartFile;

export interface Block {
  type: "text" | "tool" | "image" | "file" | "unknown";
  text?: string;
  raw?: unknown;
}

export interface TurnError {
  code: string;
  message: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  header?: string;
  question: string;
  options: QuestionOption[];
}

export type KernelEvent =
  | { type: "turn/start"; sessionId: string; turn: number }
  | { type: "text/delta"; sessionId: string; turn: number; attemptId: string; text: string }
  | { type: "message/complete"; sessionId: string; turn: number; messageId?: string; blocks: Block[] }
  | { type: "tool/call"; sessionId: string; callId: string; name: string; args: unknown }
  | { type: "tool/result"; sessionId: string; callId: string; ok: boolean; summary?: string }
  | { type: "permission/request"; sessionId: string; requestId: string; action: string; detail: string }
  | { type: "question/request"; sessionId: string; requestId: string; questions: QuestionItem[] }
  | { type: "question/closed"; sessionId: string; requestId: string }
  | { type: "deliverable"; sessionId: string; files: PresentedFile[] }
  | { type: "turn/end"; sessionId: string; turn: number; reason?: TurnError };

export type KernelEventHandler = (event: KernelEvent) => void;

export interface CreateSessionInput {
  cwd: string;
  agent?: string;
  title?: string;
}

export interface KernelPort {
  info(): Promise<KernelInfo>;
  health(): Promise<boolean>;
  createSession(input: CreateSessionInput): Promise<{ id: string }>;
  resumeSession(id: string): Promise<{ id: string }>;
  sessionExists(id: string): Promise<boolean | undefined>;
  prompt(id: string, parts: PromptPart[]): Promise<void>;
  /** 中止当前 turn（可选能力；缺失时上层只能等待超时） */
  cancel?(id: string): Promise<void>;
  subscribe(handler: KernelEventHandler): () => void;
  /** 等待事件流就绪（可选能力；用于避免首条消息早于订阅建立） */
  waitStreamReady?(timeoutMs?: number): Promise<boolean>;
  compact(id: string): Promise<void>;
  setModel(id: string, provider: string, model: string): Promise<void>;
  respondPermission(id: string, requestId: string, decision: Decision): Promise<void>;
  /** 回答内核的提问（answers 为二维数组：每个问题一组选中项） */
  respondQuestion?(sessionId: string, requestId: string, answers: string[][]): Promise<void>;
  disposeSession(id: string): Promise<void>;
  close(): Promise<void>;
}

export interface KernelPortOptions {
  logger?: Logger;
}