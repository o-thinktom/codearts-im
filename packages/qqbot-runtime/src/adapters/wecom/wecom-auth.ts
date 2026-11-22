const GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const POLL_URL = "https://work.weixin.qq.com/ai/qc/query_result";
const QR_TTL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface WecomQrSession {
  scode: string;
  /** 需在浏览器/微信中打开并确认授权的地址 */
  verificationUrl: string;
  expiresAt: number;
  pollIntervalMs: number;
}

export type WecomQrPollResult =
  | { status: "waiting" }
  | { status: "expired" }
  | { status: "failed" }
  | { status: "success"; botId: string; secret: string };

export interface WecomQrAuthOptions {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  source?: string;
  platform?: 1 | 2 | 3;
}

function defaultPlatform(): 1 | 2 | 3 {
  if (process.platform === "win32") return 2;
  if (process.platform === "linux") return 3;
  return 1;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeVerificationUrl(value: unknown): string | undefined {
  const raw = cleanString(value);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    if (url.hostname !== "work.weixin.qq.com") return undefined;
    if (url.port.length > 0 && url.port !== "443") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function asRec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 企业微信智能机器人扫码授权。
 *
 * 只读流程：generate 取 scode + 授权地址，轮询 query_result 取 botid/secret；
 * 地址必须落在 work.weixin.qq.com，避免被服务端返回的任意链接带偏。
 */
export class WecomQrAuth {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly source: string;
  private readonly platform: 1 | 2 | 3;

  constructor(options: WecomQrAuthOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.clock = options.clock ?? (() => Date.now());
    this.source = options.source ?? "codearts-agent";
    this.platform = options.platform ?? defaultPlatform();
  }

  async start(): Promise<WecomQrSession> {
    const url = new URL(GENERATE_URL);
    url.searchParams.set("source", this.source);
    url.searchParams.set("plat", String(this.platform));

    const body = await this.request(url);
    const data = asRec(body["data"]);
    const scode = cleanString(data?.["scode"]);
    const verificationUrl = safeVerificationUrl(data?.["auth_url"]);
    if (scode === undefined || verificationUrl === undefined) {
      throw new Error("企业微信扫码服务返回的数据无效");
    }
    return { scode, verificationUrl, expiresAt: this.clock() + QR_TTL_MS, pollIntervalMs: POLL_INTERVAL_MS };
  }

  async poll(session: Pick<WecomQrSession, "scode">): Promise<WecomQrPollResult> {
    const url = new URL(POLL_URL);
    url.searchParams.set("scode", session.scode);

    const body = await this.request(url);
    const data = asRec(body["data"]);
    const state = cleanString(data?.["status"])?.toLowerCase();

    if (state === "success") {
      const info = asRec(data?.["bot_info"]);
      const botId = cleanString(info?.["botid"]);
      const secret = cleanString(info?.["secret"]);
      if (botId === undefined || secret === undefined) {
        throw new Error("企业微信扫码结果缺少机器人凭据");
      }
      return { status: "success", botId, secret };
    }
    if (state === "expired" || state === "timeout") return { status: "expired" };
    if (state === "fail" || state === "failed" || state === "error") return { status: "failed" };
    return { status: "waiting" };
  }

  private async request(url: URL): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url.href, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`企业微信扫码服务返回 HTTP ${res.status}`);
      const parsed: unknown = await res.json();
      const rec = asRec(parsed);
      if (rec === undefined) throw new Error("企业微信扫码服务返回非 JSON 对象");
      return rec;
    } finally {
      clearTimeout(timer);
    }
  }
}