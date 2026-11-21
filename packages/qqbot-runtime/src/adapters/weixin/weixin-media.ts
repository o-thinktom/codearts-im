import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const CDN_HOST = "novac2c.cdn.weixin.qq.com";
const PROTOCOL_VERSION = "2.4.6";

export interface WeixinMediaRef {
  encrypt_query_param?: string;
  full_url?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface WeixinMediaItem {
  media?: WeixinMediaRef;
  aeskey?: string;
  file_name?: string;
  len?: string;
}

export interface WeixinMediaOptions {
  fetchImpl?: typeof fetch;
  botAgent?: string;
  maxDownloadBytes?: number;
}

export interface UploadedMedia {
  item: Record<string, unknown>;
  media: { encrypt_query_param: string; aes_key: string; encrypt_type: 1 };
  ciphertextSize: number;
  size: number;
  name: string;
  kind: "image" | "file";
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function strictBase64(value: unknown): Buffer | undefined {
  const text = nonEmpty(value);
  if (text === undefined || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return undefined;
  return Buffer.from(text, "base64");
}

/**
 * iLink 图片使用两种 AES key 编码：
 * - `image_item.aeskey`：32 位 hex；
 * - `media.aes_key`：base64（16 字节密钥，或 32 位 hex 字符串）。
 */
export function parseMediaAesKey(item: WeixinMediaItem): Buffer {
  const direct = nonEmpty(item.aeskey);
  if (direct !== undefined) {
    if (!/^[0-9a-fA-F]{32}$/.test(direct)) throw new Error("invalid aeskey");
    return Buffer.from(direct, "hex");
  }
  const encoded = strictBase64(item.media?.aes_key);
  if (encoded?.length === 16) return encoded;
  if (encoded?.length === 32) {
    const ascii = encoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, "hex");
  }
  throw new Error("invalid media aes_key");
}

export function decryptMedia(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error("invalid aes key length");
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new Error("invalid ciphertext");
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptMedia(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function mediaDownloadUrl(media: WeixinMediaRef | undefined): string {
  const query = nonEmpty(media?.encrypt_query_param);
  if (query !== undefined) {
    return `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(query)}`;
  }
  const full = nonEmpty(media?.full_url);
  if (full === undefined) throw new Error("media has no download url");
  const url = new URL(full);
  if (url.protocol !== "https:" || url.hostname !== CDN_HOST || (url.port !== "" && url.port !== "443")) {
    throw new Error(`untrusted media url: ${full}`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

/**
 * 微信媒体：入站下载解密 + 出站 CDN 加密上传与富媒体消息。
 *
 * 仅访问 `novac2c.cdn.weixin.qq.com` 与 `*.weixin.qq.com`；
 * 上传使用 AES-128-ECB（PKCS#7），与 iLink 协议一致。
 */
export class WeixinMedia {
  private readonly fetchImpl: typeof fetch;
  private readonly botAgent: string;
  private readonly maxDownloadBytes: number;

  constructor(
    private readonly baseUrl: string,
    options: WeixinMediaOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.botAgent = options.botAgent ?? "CodeArtsIMS/0.3.2";
    this.maxDownloadBytes = options.maxDownloadBytes ?? 20 * 1024 * 1024;
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: PROTOCOL_VERSION, bot_agent: this.botAgent };
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 6),
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
      Authorization: `Bearer ${token}`,
    };
  }

  async download(item: WeixinMediaItem): Promise<{ buffer: Buffer; size: number }> {
    const key = parseMediaAesKey(item);
    const url = mediaDownloadUrl(item.media);
    const res = await this.fetchImpl(url, { method: "GET", redirect: "manual" });
    if (!res.ok) throw new Error(`media download failed: ${res.status}`);
    const ciphertext = Buffer.from(await res.arrayBuffer());
    if (ciphertext.length > this.maxDownloadBytes + 16) throw new Error("media exceeds size limit");
    const buffer = decryptMedia(ciphertext, key);
    return { buffer, size: buffer.length };
  }

  private async getUploadUrl(
    token: string,
    toUserId: string,
    fileKey: string,
    mediaType: 1 | 3,
    rawSize: number,
    rawMd5: string,
    paddedSize: number,
    aesKeyHex: string,
  ): Promise<string> {
    const res = await this.fetchImpl(new URL("ilink/bot/getuploadurl", this.baseUrl), {
      method: "POST",
      headers: this.authHeaders(token),
      body: JSON.stringify({
        filekey: fileKey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: rawSize,
        rawfilemd5: rawMd5,
        filesize: paddedSize,
        no_need_thumb: true,
        aeskey: aesKeyHex,
        base_info: this.baseInfo(),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`getuploadurl failed: ${res.status}`);
    const payload = (text.length === 0 ? {} : JSON.parse(text)) as {
      upload_full_url?: string;
      upload_param?: string;
      ret?: number | string;
    };
    if (payload.ret !== undefined && String(payload.ret) !== "0") {
      throw new Error(`getuploadurl rejected: ${payload.ret}`);
    }
    const full = nonEmpty(payload.upload_full_url);
    if (full !== undefined) {
      const url = new URL(full);
      if (url.protocol !== "https:" || url.hostname !== CDN_HOST || url.pathname !== "/c2c/upload") {
        throw new Error(`untrusted upload url: ${full}`);
      }
      return url.toString();
    }
    const param = nonEmpty(payload.upload_param);
    if (param === undefined) throw new Error("getuploadurl returned no upload url");
    const url = new URL(`${CDN_BASE}/upload`);
    url.searchParams.set("encrypted_query_param", param);
    url.searchParams.set("filekey", fileKey);
    return url.toString();
  }

  private async uploadCdn(url: string, ciphertext: Buffer): Promise<string> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(ciphertext.length),
      },
      body: ciphertext,
      redirect: "error",
    });
    if (res.status !== 200) throw new Error(`cdn upload failed: ${res.status}`);
    const downloadParam = res.headers.get("x-encrypted-param");
    if (downloadParam === null || downloadParam.length === 0) {
      throw new Error("cdn upload missing x-encrypted-param");
    }
    return downloadParam;
  }

  /**
   * 上传本地文件并构造 iLink 富媒体 item（图片 type=2，文件 type=4）。
   */
  async upload(
    token: string,
    toUserId: string,
    filePath: string,
    kind: "image" | "file",
  ): Promise<UploadedMedia> {
    const bytes = readFileSync(filePath);
    const size = statSync(filePath).size;
    const fileKey = randomBytes(16).toString("hex");
    const aesKey = randomBytes(16);
    const rawMd5 = createHash("md5").update(bytes).digest("hex");
    const ciphertext = encryptMedia(bytes, aesKey);
    const mediaType: 1 | 3 = kind === "image" ? 1 : 3;

    const uploadUrl = await this.getUploadUrl(
      token,
      toUserId,
      fileKey,
      mediaType,
      size,
      rawMd5,
      ciphertext.length,
      aesKey.toString("hex"),
    );
    const downloadParam = await this.uploadCdn(uploadUrl, ciphertext);
    const media = {
      encrypt_query_param: downloadParam,
      aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
      encrypt_type: 1,
    } as const;

    const name = path.basename(filePath);
    const item =
      kind === "image"
        ? { type: 2, image_item: { media, mid_size: ciphertext.length } }
        : { type: 4, file_item: { media, file_name: name, len: String(size) } };

    return { item, media, ciphertextSize: ciphertext.length, size, name, kind };
  }

  async sendMedia(
    token: string,
    toUserId: string,
    item: Record<string, unknown>,
    contextToken?: string,
  ): Promise<void> {
    const clientId = `codearts-im-${randomBytes(16).toString("hex")}`;
    const res = await this.fetchImpl(new URL("ilink/bot/sendmessage", this.baseUrl), {
      method: "POST",
      headers: this.authHeaders(token),
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [item],
          ...(contextToken === undefined ? {} : { context_token: contextToken }),
        },
        base_info: this.baseInfo(),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`send media failed: ${res.status}`);
    if (text.length > 0) {
      try {
        const payload = JSON.parse(text) as { ret?: number | string; errcode?: number | string };
        const code = payload.ret ?? payload.errcode;
        if (code !== undefined && String(code) !== "0") throw new Error(`send media rejected: ${code}`);
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    }
  }
}