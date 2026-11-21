import { readFileSync, statSync } from "node:fs";
import { ErrorCode, QqbotError, createNoopLogger } from "@codearts-qqbot/core";
import type { Logger } from "@codearts-qqbot/core";

export interface QqApiOptions {
  appId: string;
  appSecret: string;
  apiBase?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  code?: number;
  message?: string;
}

const DEFAULT_API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const TOKEN_SAFETY_MS = 60_000;

/**
 * QQ 开放平台 HTTP 客户端：token 管理 + 消息发送。
 *
 * 安全约定：
 * - appSecret 只存在于内存，不落盘、不写日志；
 * - 401 时强制刷新一次 token 后重试，避免频繁重建连接。
 */
export class QqApi {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(options: QqApiOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? createNoopLogger();
    this.now = options.now ?? (() => Date.now());
  }

  async getToken(force = false): Promise<string> {
    const current = this.token;
    if (!force && current !== undefined && current.expiresAt - TOKEN_SAFETY_MS > this.now()) {
      return current.value;
    }
    if (this.inflight !== undefined) return this.inflight;

    this.inflight = this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
      });
    } catch (err) {
      throw new QqbotError(ErrorCode.WS_CONNECT_FAILED, "token request failed", { retryable: true, cause: err });
    }

    const text = await res.text();
    if (!res.ok) {
      throw new QqbotError(ErrorCode.CREDENTIAL_INVALID, `token http ${res.status}`, { cause: text });
    }

    let body: TokenResponse;
    try {
      body = JSON.parse(text) as TokenResponse;
    } catch {
      throw new QqbotError(ErrorCode.CREDENTIAL_INVALID, "token response is not json");
    }

    if (body.access_token === undefined || body.access_token.length === 0) {
      throw new QqbotError(ErrorCode.CREDENTIAL_INVALID, body.message ?? "no access_token");
    }

    const ttl = Number(body.expires_in ?? 7200);
    const seconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 7200;
    this.token = { value: body.access_token, expiresAt: this.now() + seconds * 1000 };
    this.logger.info("qq token refreshed", { expiresInSec: seconds });
    return this.token.value;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.getToken();
    return this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res = await this.send(method, path, body);
    if (res.status === 401) {
      this.token = undefined;
      res = await this.send(method, path, body);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new QqbotError(ErrorCode.INTERNAL, `${method} ${path} -> ${res.status}: ${detail.slice(0, 300)}`, {
        cause: detail,
      });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  async getGateway(): Promise<string> {
    const res = await this.request<{ url?: string }>("GET", "/gateway/bot");
    if (res.url === undefined || res.url.length === 0) {
      throw new QqbotError(ErrorCode.WS_CONNECT_FAILED, "gateway response has no url");
    }
    return res.url;
  }

  async sendC2C(openid: string, content: string, msgId?: string, msgSeq?: number): Promise<void> {
    await this.request("POST", `/v2/users/${encodeURIComponent(openid)}/messages`, {
      content,
      msg_type: 0,
      ...(msgId === undefined ? {} : { msg_id: msgId }),
      ...(msgId === undefined || msgSeq === undefined ? {} : { msg_seq: msgSeq }),
    });
  }

  async sendGroup(groupOpenid: string, content: string, msgId?: string, msgSeq?: number): Promise<void> {
    await this.request("POST", `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
      content,
      msg_type: 0,
      ...(msgId === undefined ? {} : { msg_id: msgId }),
      ...(msgId === undefined || msgSeq === undefined ? {} : { msg_seq: msgSeq }),
    });
  }

  /** 上传富媒体（图片/视频/语音/文件），返回 file_info */
  async uploadFile(
    scope: "c2c" | "group",
    targetId: string,
    filePath: string,
    fileType: number,
  ): Promise<{ fileInfo: string; ttl?: number }> {
    const size = statSync(filePath).size;
    const data = readFileSync(filePath);
    const requestPath =
      scope === "c2c"
        ? `/v2/users/${encodeURIComponent(targetId)}/files`
        : `/v2/groups/${encodeURIComponent(targetId)}/files`;

    const res = await this.request<{ file_info?: string; ttl?: number }>("POST", requestPath, {
      file_type: fileType,
      file_data: data.toString("base64"),
      srv_send_msg: false,
    });

    const fileInfo = res?.file_info;
    if (fileInfo === undefined || fileInfo.length === 0) {
      throw new QqbotError(ErrorCode.INTERNAL, `file upload returned no file_info (size=${size})`);
    }
    return { fileInfo, ...(res?.ttl === undefined ? {} : { ttl: res.ttl }) };
  }

  /** 发送富媒体消息（msg_type=7） */
  async sendMedia(
    scope: "c2c" | "group",
    targetId: string,
    fileInfo: string,
    msgId?: string,
    msgSeq?: number,
  ): Promise<void> {
    const requestPath =
      scope === "c2c"
        ? `/v2/users/${encodeURIComponent(targetId)}/messages`
        : `/v2/groups/${encodeURIComponent(targetId)}/messages`;

    await this.request("POST", requestPath, {
      msg_type: 7,
      media: { file_info: fileInfo },
      ...(msgId === undefined ? {} : { msg_id: msgId }),
      ...(msgId === undefined || msgSeq === undefined ? {} : { msg_seq: msgSeq }),
    });
  }

  /** 仅用于连通性自检，不打印任何凭据 */
  async probe(): Promise<{ tokenOk: boolean; gatewayOk: boolean }> {
    try {
      await this.getToken(true);
    } catch {
      return { tokenOk: false, gatewayOk: false };
    }
    try {
      await this.getGateway();
      return { tokenOk: true, gatewayOk: true };
    } catch {
      return { tokenOk: true, gatewayOk: false };
    }
  }
}