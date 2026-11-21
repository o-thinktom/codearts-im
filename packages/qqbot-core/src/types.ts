export type ChatScope = "c2c" | "group";

/** IM 渠道标识；缺省视为 qq（兼容既有会话数据） */
export type ImChannel = "qq" | "weixin" | "wecom" | "wecom-app";

export type AccessMode = "open" | "allowlist" | "disabled";

export type MediaKind = "image" | "video" | "file" | "voice" | "unknown";

export interface ReplyTarget {
  scope: ChatScope;
  targetId: string;
  /** 渠道；缺省 qq */
  channel?: ImChannel;
  msgId?: string;
  proactive?: boolean;
}

export interface Attachment {
  kind: MediaKind;
  filename?: string;
  contentType?: string;
  url?: string;
  localPath?: string;
  size?: number;
  asrText?: string;
  durationSec?: number;
}

export interface QuoteRef {
  text?: string;
  attachments?: Attachment[];
}

export interface HistoryEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  messageId: string;
}

export interface InboundMessage {
  scope: ChatScope;
  /** 渠道；缺省 qq */
  channel?: ImChannel;
  peerId: string;
  senderId: string;
  senderName?: string;
  text: string;
  mentioned: boolean;
  messageId: string;
  timestamp: number;
  attachments?: Attachment[];
  quote?: QuoteRef;
  history?: HistoryEntry[];
}

export interface OutboundText {
  target: ReplyTarget;
  text: string;
  kind: "reply" | "tool" | "error" | "notice";
}

export interface PresentedFile {
  path: string;
  name: string;
  size?: number;
}

export type Decision = "allow" | "deny";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  text: string;
  options: QuestionOption[];
  timeoutMs: number;
}

export interface Answer {
  questionId: string;
  optionId: string;
  answeredBy: string;
}

export interface AccessRule {
  mode: AccessMode;
  allow: string[];
}

export interface PairingCode {
  code: string;
  kind: ChatScope;
  createdAt: number;
  usedBy: string[];
}

export interface RevokedIdentity {
  kind: ChatScope;
  id: string;
  at: number;
}

export interface AccessConfig {
  revision: number;
  c2c: AccessRule;
  group: AccessRule;
  command: AccessRule;
  pairing: PairingCode[];
  revoked: RevokedIdentity[];
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createNoopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

export function createConsoleLogger(level: "debug" | "info" | "warn" | "error" = "info"): Logger {
  const rank = { debug: 10, info: 20, warn: 30, error: 40 } as const;
  const min = rank[level];
  const emit = (lvl: keyof typeof rank, message: string, fields?: Record<string, unknown>): void => {
    if (rank[lvl] < min) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: message,
      ...(fields ?? {}),
    };
    const out = JSON.stringify(line);
    if (lvl === "error") console.error(out);
    else if (lvl === "warn") console.warn(out);
    else console.log(out);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}