import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createNoopLogger } from "@codearts-qqbot/core";
import type { Attachment, Logger } from "@codearts-qqbot/core";

export interface MediaServiceOptions {
  root: string;
  maxBytes: number;
  ttlHours: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/silk": ".silk",
  "audio/mpeg": ".mp3",
  "application/pdf": ".pdf",
};

/**
 * 入站媒体落盘：
 * - 只下载 image / video / file（语音用 QQ 的 ASR 文本）；
 * - 单文件超过上限直接跳过，不落盘；
 * - 文件名由 messageId + 序号生成，避免路径注入；
 * - 定期清理超过 TTL 的文件。
 */
export class MediaService {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly ttlHours: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: MediaServiceOptions) {
    this.root = options.root;
    this.maxBytes = Math.max(1, options.maxBytes);
    this.ttlHours = Math.max(1, options.ttlHours);
    this.logger = options.logger ?? createNoopLogger();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private extOf(attachment: Attachment): string {
    if (attachment.contentType !== undefined) {
      const mapped = EXT_BY_MIME[attachment.contentType.split(";")[0]?.trim() ?? ""];
      if (mapped !== undefined) return mapped;
    }
    const name = attachment.filename ?? "";
    const ext = path.extname(name);
    if (/^\.[A-Za-z0-9]{1,8}$/.test(ext)) return ext.toLowerCase();
    return ".bin";
  }

  private safeDir(peerId: string): string {
    const safe = peerId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    return path.join(this.root, safe);
  }

  async ingest(peerId: string, messageId: string, attachments: Attachment[]): Promise<Attachment[]> {
    if (attachments.length === 0) return attachments;
    const dir = this.safeDir(peerId);
    const messageKey = messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
    const out: Attachment[] = [];

    for (const [index, attachment] of attachments.entries()) {
      if (attachment.kind === "voice" || attachment.kind === "unknown") {
        out.push(attachment);
        continue;
      }
      const url = attachment.url;
      if (url === undefined || url.startsWith("file:")) {
        out.push(attachment);
        continue;
      }

      try {
        const res = await this.fetchImpl(url);
        if (!res.ok) {
          this.logger.warn("media download failed", { kind: attachment.kind, status: res.status });
          out.push(attachment);
          continue;
        }

        const declared = Number(res.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > this.maxBytes) {
          this.logger.warn("media exceeds limit", { kind: attachment.kind, bytes: declared, max: this.maxBytes });
          out.push(attachment);
          continue;
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > this.maxBytes) {
          this.logger.warn("media exceeds limit after download", { kind: attachment.kind, bytes: buffer.length });
          out.push(attachment);
          continue;
        }

        await mkdir(dir, { recursive: true });
        const file = path.join(dir, `${messageKey}-${index}${this.extOf(attachment)}`);
        await writeFile(file, buffer, { mode: 0o600 });
        out.push({ ...attachment, localPath: file, size: buffer.length });
        this.logger.info("media saved", { kind: attachment.kind, bytes: buffer.length, file });
      } catch (err) {
        this.logger.warn("media download error", { kind: attachment.kind, err: String(err) });
        out.push(attachment);
      }
    }
    return out;
  }

  async cleanup(): Promise<number> {
    const cutoff = Date.now() - this.ttlHours * 3600 * 1000;
    let removed = 0;
    let peers: string[];
    try {
      peers = await readdir(this.root);
    } catch {
      return 0;
    }

    for (const peer of peers) {
      const dir = path.join(this.root, peer);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dir, file);
        try {
          const info = await stat(full);
          if (info.mtimeMs < cutoff) {
            await rm(full, { force: true });
            removed += 1;
          }
        } catch {
          // 忽略单个文件错误
        }
      }
    }
    if (removed > 0) this.logger.info("media cleaned", { removed, ttlHours: this.ttlHours });
    return removed;
  }

  start(intervalMs = 3600 * 1000): void {
    if (this.timer !== undefined) return;
    void this.cleanup();
    this.timer = setInterval(() => {
      void this.cleanup();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}