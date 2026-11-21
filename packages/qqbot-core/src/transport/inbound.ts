import type { Attachment, HistoryEntry, InboundMessage, MediaKind } from "../types.js";

const SENDER_SHORT_ID_LEN = 8;

const ATTACHMENT_LABELS: Record<Exclude<MediaKind, "voice" | "unknown">, string> = {
  image: "[图片]",
  video: "[视频]",
  file: "[文件]",
};

function shortId(id: string): string {
  return id.slice(0, SENDER_SHORT_ID_LEN);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function buildAttachmentTags(attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return "";
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const att of attachments) {
    if (att.kind === "voice" || att.kind === "unknown") continue;
    if (seen.has(att.kind)) continue;
    seen.add(att.kind);
    const label = ATTACHMENT_LABELS[att.kind];
    if (label) tags.push(label);
  }
  return tags.join(" ");
}

function buildUserContent(msg: InboundMessage): string {
  const parts: string[] = [];
  const text = msg.text.trim();
  if (text) parts.push(text);

  for (const att of msg.attachments ?? []) {
    if (att.kind !== "voice") continue;
    const asr = att.asrText?.trim();
    if (!asr) continue;
    const duration = att.durationSec ? ` (${att.durationSec}s)` : "";
    parts.push(`[语音消息${duration}] ${asr}`);
  }

  const tags = buildAttachmentTags(msg.attachments);
  if (tags) parts.push(tags);
  return parts.join("\n");
}

function buildQuotePart(msg: InboundMessage): string {
  const q = msg.quote;
  if (!q) return "";
  const quoteText = q.text?.trim() || "";
  const quoteFiles = (q.attachments ?? [])
    .filter((a) => a.kind !== "voice")
    .map((a) => a.filename ?? a.url ?? a.kind);
  if (!quoteText && quoteFiles.length === 0) return "";

  const lines = ["[引用消息开始]"];
  if (quoteText) lines.push(quoteText);
  for (const name of quoteFiles) lines.push(`附件: ${name}`);
  lines.push("[引用消息结束]", "[当前消息]");
  return `${lines.join("\n")}\n`;
}

function buildUserMessage(msg: InboundMessage, content: string): string {
  const quote = buildQuotePart(msg);
  if (msg.scope === "c2c") return `${quote}${content}`;
  const mention = msg.mentioned ? " (@你)" : "";
  const name = msg.senderName ?? shortId(msg.senderId);
  return `${quote}[${name} (${msg.senderId})] ${content}${mention}`;
}

function renderMediaLine(att: Attachment): string {
  switch (att.kind) {
    case "image":
      return att.localPath ? `- 图片: ${att.localPath}` : `- 图片: ${att.url ?? att.filename ?? "image"}`;
    case "video":
      return att.localPath ? `- 视频: ${att.localPath}` : `- 视频: ${att.filename ?? "video"}（下载失败）`;
    case "file":
      return att.localPath
        ? `- 文件: ${att.localPath}`
        : `- 文件: ${att.filename ?? "file"} (${formatSize(att.size ?? 0)})`;
    default:
      return "";
  }
}

function buildDynamicContext(msg: InboundMessage): string {
  const lines: string[] = [];
  for (const att of msg.attachments ?? []) {
    if (att.kind === "voice" || att.kind === "unknown") continue;
    const line = renderMediaLine(att);
    if (line) lines.push(line);
  }
  const quoteFiles = msg.quote?.attachments ?? [];
  if (quoteFiles.length > 0) {
    const rendered = quoteFiles
      .filter((a) => a.kind !== "voice")
      .map((a) => renderMediaLine(a))
      .filter((l) => l.length > 0);
    if (rendered.length > 0) {
      lines.push("[引用附件]");
      for (const l of rendered) lines.push(`  ${l}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}

function buildHistory(history: HistoryEntry[] | undefined, msg: InboundMessage): string {
  if (msg.scope !== "group" || !msg.mentioned) return "";
  if (!history || history.length === 0) return "";
  const lines = ["[群聊历史开始]"];
  for (const h of history) {
    const name = h.senderName ?? shortId(h.senderId);
    lines.push(`[${name} (${h.senderId})] ${h.content}`);
  }
  lines.push("[群聊历史结束]", "[当前消息]");
  return `${lines.join("\n")}\n`;
}

function isEmptyMessage(msg: InboundMessage, content: string): boolean {
  if (content.length > 0) return false;
  if ((msg.attachments?.length ?? 0) > 0) return false;
  return !(msg.scope === "group" && msg.mentioned);
}

/**
 * 按 5 层组装 agent 实际看到的上下文：
 * 用户内容 → 引用 → 发送者标签 → 媒体元数据 → 群历史。
 * 返回 null 表示该消息不需要响应（空消息且未被 @）。
 */
export function assembleAgentBody(msg: InboundMessage): string | null {
  const content = buildUserContent(msg);
  if (isEmptyMessage(msg, content)) return null;

  const userMessage = buildUserMessage(msg, content);
  const dynamic = buildDynamicContext(msg);
  const base = dynamic.length > 0 ? `${dynamic}${userMessage}` : userMessage;
  const history = buildHistory(msg.history, msg);
  return history.length > 0 ? `${history}${base}` : base;
}