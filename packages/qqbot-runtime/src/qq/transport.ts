import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createNoopLogger } from "@codearts-qqbot/core";
import type { Logger, PresentedFile, ReplyTarget } from "@codearts-qqbot/core";
import type { QqApi } from "./client.js";
import type { ImTransport, SendKind } from "../transport/outbound-types.js";

export interface QqImTransportOptions {
  logger?: Logger;
  /** 允许发送的根目录（workspace + 媒体目录）；为空则拒绝所有文件 */
  allowedRoots?: string[];
  maxFileBytes?: number;
}

const MAX_PASSIVE_REPLIES = 5;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

function fileTypeOf(file: string): number {
  const ext = path.extname(file).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) return 1;
  if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) return 2;
  if ([".silk", ".amr", ".mp3", ".wav", ".ogg"].includes(ext)) return 3;
  return 4;
}

/**
 * QQ 出站实现。
 *
 * - 文本：被动回复最多 5 条，第 2 条起带递增 msg_seq；超限降级主动消息；
 * - 文件：先上传富媒体（base64），再以 msg_type=7 发送；
 * - 安全：只允许白名单根目录下的真实路径（realpath 校验），限制单文件大小；
 * - 降级：上传/发送失败时回退为路径文本，避免静默丢文件。
 */
export class QqImTransport implements ImTransport {
  private readonly logger: Logger;
  private readonly allowedRoots: string[];
  private readonly maxFileBytes: number;
  private readonly seqByKey = new Map<string, number>();

  constructor(
    private readonly api: QqApi,
    options: QqImTransportOptions = {},
  ) {
    this.logger = options.logger ?? createNoopLogger();
    this.allowedRoots = options.allowedRoots ?? [];
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  private realOrResolve(target: string): string {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  }

  private isAllowed(target: string): boolean {
    if (this.allowedRoots.length === 0) return false;
    const real = this.realOrResolve(target);
    return this.allowedRoots.some((root) => {
      const base = this.realOrResolve(root);
      return real === base || real.startsWith(base + path.sep);
    });
  }

  private nextSeq(target: ReplyTarget): { msgId?: string; msgSeq?: number } {
    const msgId = target.msgId;
    if (msgId === undefined) return {};

    if (this.seqByKey.size > 200) this.seqByKey.clear();
    const key = `${target.scope}:${target.targetId}:${msgId}`;
    const next = (this.seqByKey.get(key) ?? 0) + 1;
    if (next <= MAX_PASSIVE_REPLIES) {
      this.seqByKey.set(key, next);
      return { msgId, msgSeq: next };
    }

    this.logger.warn("passive reply limit reached, fallback to active message", { key, limit: MAX_PASSIVE_REPLIES });
    return {};
  }

  async sendText(target: ReplyTarget, text: string, _kind: SendKind): Promise<void> {
    const { msgId, msgSeq } = this.nextSeq(target);
    if (target.scope === "c2c") {
      await this.api.sendC2C(target.targetId, text, msgId, msgSeq);
    } else {
      await this.api.sendGroup(target.targetId, text, msgId, msgSeq);
    }
  }

  async sendFile(target: ReplyTarget, files: PresentedFile[]): Promise<void> {
    for (const file of files) {
      if (!this.isAllowed(file.path)) {
        this.logger.warn("file path not allowed", { file: file.name });
        await this.sendText(target, `⚠️ 文件不在允许发送的范围内：${file.name}`, "error");
        continue;
      }

      let size = 0;
      try {
        size = statSync(file.path).size;
      } catch {
        await this.sendText(target, `⚠️ 文件不存在：${file.name}`, "error");
        continue;
      }
      if (size > this.maxFileBytes) {
        await this.sendText(target, `⚠️ 文件过大（${(size / 1024 / 1024).toFixed(1)}MB）：${file.name}`, "error");
        continue;
      }

      try {
        const uploaded = await this.api.uploadFile(target.scope, target.targetId, file.path, fileTypeOf(file.path));
        const { msgId, msgSeq } = this.nextSeq(target);
        await this.api.sendMedia(target.scope, target.targetId, uploaded.fileInfo, msgId, msgSeq);
        this.logger.info("file sent", { file: file.name, bytes: size });
      } catch (err) {
        this.logger.warn("file upload failed, fallback to path text", {
          file: file.name,
          err: err instanceof Error ? err.message : String(err),
        });
        await this.sendText(target, `文件：${file.name}\n${file.path}`, "file");
      }
    }
  }
}