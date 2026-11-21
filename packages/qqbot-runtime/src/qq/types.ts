import type { Attachment, ChatScope, InboundMessage, MediaKind } from "@codearts-qqbot/core";

export interface QqAuthor {
  user_openid?: string;
  member_openid?: string;
  union_openid?: string;
  username?: string;
}

export interface QqAttachment {
  content_type?: string;
  filename?: string;
  url?: string;
  size?: number;
  width?: number;
  height?: number;
  asr_refer_text?: string;
}

export interface QqMessageData {
  id?: string;
  content?: string;
  timestamp?: string;
  group_openid?: string;
  author?: QqAuthor;
  attachments?: QqAttachment[];
}

export interface QqPayload {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
}

export const INTENTS_GROUP_AND_C2C = 1 << 25;

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (ctor === undefined) {
    throw new Error("global WebSocket is unavailable; Node >= 22 is required");
  }
  return new ctor(url) as WebSocketLike;
}

export function classify(contentType: string | undefined): MediaKind {
  if (contentType === undefined) return "unknown";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/") || contentType.includes("voice") || contentType.includes("silk")) return "voice";
  if (contentType.includes("file") || contentType.includes("application")) return "file";
  return "unknown";
}

export function toAttachment(raw: QqAttachment): Attachment {
  const kind = classify(raw.content_type);
  return {
    kind,
    ...(raw.filename === undefined ? {} : { filename: raw.filename }),
    ...(raw.content_type === undefined ? {} : { contentType: raw.content_type }),
    ...(raw.url === undefined ? {} : { url: raw.url }),
    ...(raw.size === undefined ? {} : { size: raw.size }),
    ...(raw.asr_refer_text === undefined ? {} : { asrText: raw.asr_refer_text }),
  };
}

function timestampOf(value: string | undefined): number {
  if (value === undefined) return Date.now();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * QQ 事件 → 统一入站消息。
 * 只处理 C2C（私聊）与群 @，其余事件由上层忽略。
 */
export function parseQqMessage(eventType: string, data: QqMessageData): InboundMessage | undefined {
  const messageId = data.id;
  if (messageId === undefined) return undefined;

  let scope: ChatScope;
  let peerId: string | undefined;
  let senderId: string | undefined;
  let mentioned = false;

  if (eventType === "C2C_MESSAGE_CREATE") {
    scope = "c2c";
    senderId = data.author?.user_openid ?? data.author?.union_openid;
    peerId = senderId;
  } else if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    scope = "group";
    peerId = data.group_openid;
    senderId = data.author?.member_openid ?? data.author?.union_openid;
    mentioned = true;
  } else {
    return undefined;
  }

  if (peerId === undefined || senderId === undefined) return undefined;

  const attachments = (data.attachments ?? []).map(toAttachment);

  return {
    scope,
    peerId,
    senderId,
    ...(data.author?.username === undefined ? {} : { senderName: data.author.username }),
    text: data.content ?? "",
    mentioned,
    messageId,
    timestamp: timestampOf(data.timestamp),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}