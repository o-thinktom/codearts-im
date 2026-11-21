import { randomBytes, randomUUID } from "node:crypto";

export const WEIXIN_QR_BASE_URL = "https://ilinkai.weixin.qq.com/";
export const WEIXIN_PROTOCOL_VERSION = "2.4.6";
const ILINK_APP_ID = "bot";
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

export interface WeixinLoginStart {
  qrcode: string;
  qrUrl: string;
}

export interface WeixinLoginResult {
  status: string;
  botToken?: string;
  botId?: string;
  baseUrl?: string;
}

export interface WeixinItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: unknown; mid_size?: number };
  file_item?: { media?: unknown; file_name?: string; len?: string };
}

export interface WeixinMessage {
  seq?: number;
  msg_id?: string;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: WeixinItem[];
}

export interface WeixinUpdates {
  msgs: WeixinMessage[];
  getUpdatesBuf: string;
}

export type WeixinApiErrorCode =
  | "network"
  | "http"
  | "provider"
  | "stale-token"
  | "invalid-response"
  | "invalid-base-url";

export class WeixinApiError extends Error {
  constructor(
    readonly code: WeixinApiErrorCode,
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "WeixinApiError";
  }
}

export interface WeixinApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  botAgent?: string;
  now?: () => number;
}

interface RequestOptions {
  method: "GET" | "POST";
  endpoint: string;
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  authenticated?: boolean;
}

function isTrustedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "weixin.qq.com" || host.endsWith(".weixin.qq.com") || host === "wechat.com" || host.endsWith(".wechat.com");
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinApiError("invalid-base-url", `invalid base url: ${value}`);
  }
  if (url.protocol !== "https:" || !isTrustedHost(url.hostname) || (url.port !== "" && url.port !== "443")) {
    throw new WeixinApiError("invalid-base-url", `untrusted base url: ${value}`);
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

/**
 * 腾讯 iLink AI 机器人协议客户端（基于社区实测实现，协议版本 2.4.6）。
 *
 * 仅访问 `*.weixin.qq.com`，并对服务端返回的 baseurl 做同域校验，
 * 避免被恶意响应引导到非腾讯域名。
 */
export class WeixinApi {
  private readonly fetchImpl: typeof fetch;
  private readonly botAgent: string;
  private baseUrl: string;

  constructor(options: WeixinApiOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? WEIXIN_QR_BASE_URL);
    this.botAgent = options.botAgent ?? `CodeArtsIMS/0.3.3`;
  }

  get endpointBase(): string {
    return this.baseUrl;
  }

  setBaseUrl(value: string): void {
    this.baseUrl = normalizeBaseUrl(value);
  }

  private headers(token?: string, authenticated = false): Record<string, string> {
    const headers: Record<string, string> = {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION),
    };
    if (authenticated) {
      headers["content-type"] = "application/json";
      headers["AuthorizationType"] = "ilink_bot_token";
      headers["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
      if (token !== undefined) headers["Authorization"] = `Bearer ${token.trim()}`;
    } else {
      headers["content-type"] = "application/json";
    }
    return headers;
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: this.botAgent };
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const ctrl = new AbortController();
    const timeout = options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const onAbort = (): void => ctrl.abort();
    options.signal?.addEventListener("abort", onAbort);

    try {
      const url = new URL(options.endpoint, this.baseUrl);
      const res = await this.fetchImpl(url.toString(), {
        method: options.method,
        headers: this.headers(options.token, options.authenticated ?? options.token !== undefined),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new WeixinApiError("http", `${options.method} ${options.endpoint} -> ${res.status}`, String(res.status));
      }
      let payload: unknown;
      try {
        payload = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        throw new WeixinApiError("invalid-response", `${options.endpoint} returned non-json`);
      }
      const rec = payload as Record<string, unknown>;
      const providerCode = rec["ret"] ?? rec["errcode"];
      if (providerCode !== undefined && String(providerCode) !== "0") {
        const code = String(providerCode);
        throw new WeixinApiError(code === "-14" ? "stale-token" : "provider", `${options.endpoint} rejected`, code);
      }
      return payload as T;
    } catch (err) {
      if (err instanceof WeixinApiError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new WeixinApiError("network", `${options.endpoint} timeout after ${timeout}ms`);
      }
      throw new WeixinApiError("network", `${options.endpoint} failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async beginLogin(localTokens: string[] = []): Promise<WeixinLoginStart> {
    const response = await this.request<{ qrcode?: string; qrcode_img_content?: string }>({
      method: "POST",
      endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
      body: { local_token_list: localTokens.slice(-10) },
      timeoutMs: 10_000,
    });
    const qrcode = response.qrcode;
    const qrUrl = response.qrcode_img_content;
    if (qrcode === undefined || qrUrl === undefined) {
      throw new WeixinApiError("invalid-response", "qr response missing qrcode/qrcode_img_content");
    }
    return { qrcode, qrUrl };
  }

  async pollLogin(qrcode: string, verifyCode?: string): Promise<WeixinLoginResult> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode !== undefined && verifyCode.trim().length > 0) {
      endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`;
    }
    const response = await this.request<{
      status?: string;
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
    }>({
      method: "GET",
      endpoint,
      timeoutMs: 10_000,
      authenticated: false,
    });
    const status = response.status ?? "unknown";
    const result: WeixinLoginResult = { status };

    if (status === "confirmed") {
      if (response.bot_token === undefined || response.ilink_bot_id === undefined) {
        throw new WeixinApiError("invalid-response", "confirmed without bot_token/ilink_bot_id");
      }
      result.botToken = response.bot_token;
      result.botId = response.ilink_bot_id;
      if (response.baseurl !== undefined) {
        this.setBaseUrl(response.baseurl);
        result.baseUrl = this.baseUrl;
      }
    }
    return result;
  }

  async getUpdates(token: string, getUpdatesBuf: string, timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS): Promise<WeixinUpdates> {
    try {
      const response = await this.request<{ msgs?: WeixinMessage[]; get_updates_buf?: string }>({
        method: "POST",
        endpoint: "ilink/bot/getupdates",
        body: { get_updates_buf: getUpdatesBuf, base_info: this.baseInfo() },
        token,
        timeoutMs,
      });
      return {
        msgs: Array.isArray(response.msgs) ? response.msgs : [],
        getUpdatesBuf: typeof response.get_updates_buf === "string" ? response.get_updates_buf : getUpdatesBuf,
      };
    } catch (err) {
      // 长轮询超时视为空响应，不计入失败
      if (err instanceof WeixinApiError && err.code === "network" && err.message.includes("timeout")) {
        return { msgs: [], getUpdatesBuf };
      }
      throw err;
    }
  }

  async sendText(
    token: string,
    toUserId: string,
    text: string,
    contextToken?: string,
  ): Promise<void> {
    const clientId = `codearts-im-${randomUUID()}`;
    await this.request({
      method: "POST",
      endpoint: "ilink/bot/sendmessage",
      token,
      timeoutMs: 20_000,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          ...(contextToken === undefined ? {} : { context_token: contextToken }),
        },
        base_info: this.baseInfo(),
      },
    });
  }

  async getTypingTicket(token: string, toUserId: string, contextToken?: string): Promise<string | undefined> {
    const response = await this.request<{ typing_ticket?: string }>({
      method: "POST",
      endpoint: "ilink/bot/getconfig",
      token,
      timeoutMs: 10_000,
      body: {
        ilink_user_id: toUserId,
        ...(contextToken === undefined ? {} : { context_token: contextToken }),
        base_info: this.baseInfo(),
      },
    });
    return response.typing_ticket;
  }

  async sendTyping(token: string, toUserId: string, typingTicket: string, status: 1 | 2): Promise<void> {
    await this.request({
      method: "POST",
      endpoint: "ilink/bot/sendtyping",
      token,
      timeoutMs: 10_000,
      body: {
        ilink_user_id: toUserId,
        typing_ticket: typingTicket,
        status,
        base_info: this.baseInfo(),
      },
    });
  }

  async notifyStart(token: string): Promise<void> {
    await this.request({
      method: "POST",
      endpoint: "ilink/bot/msg/notifystart",
      token,
      timeoutMs: 10_000,
      body: { base_info: this.baseInfo() },
    });
  }

  async notifyStop(token: string): Promise<void> {
    await this.request({
      method: "POST",
      endpoint: "ilink/bot/msg/notifystop",
      token,
      timeoutMs: 10_000,
      body: { base_info: this.baseInfo() },
    });
  }
}