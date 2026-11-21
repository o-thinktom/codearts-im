const QR_BASE_URL = "https://ilinkai.weixin.qq.com/";
const APP_ID = "bot";
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);

export type WeixinBindEvent =
  | { kind: "qr"; url: string }
  | { kind: "success"; botId: string; token: string; baseUrl: string }
  | { kind: "expired" }
  | { kind: "verify"; message: string }
  | { kind: "failed"; reason: string };

export interface WeixinBindSession {
  refresh(): void;
  submitVerify(code: string): void;
  dispose(): void;
}

export interface WeixinBindOptions {
  onEvent: (event: WeixinBindEvent) => void;
  fetchImpl?: typeof fetch;
}

interface LoginStart {
  qrcode: string;
  url: string;
}

interface LoginStatus {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
}

function isTrustedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "weixin.qq.com" || host.endsWith(".weixin.qq.com") || host === "wechat.com" || host.endsWith(".wechat.com");
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !isTrustedHost(url.hostname)) {
    throw new Error(`untrusted base url: ${value}`);
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

/**
 * 个人微信扫码绑定（腾讯 iLink AI）。
 *
 * 仅负责“拿二维码 → 轮询状态 → 返回 botId/token”，不接触其它凭据；
 * 成功后由调用方写入系统凭据库并通知 sidecar 重启。
 */
export function startWeixinBindSession(options: WeixinBindOptions): WeixinBindSession {
  const fetchImpl = options.fetchImpl ?? fetch;
  let abort: AbortController | undefined;
  let qrcode: string | undefined;
  let baseUrl = QR_BASE_URL;
  let verifyCode: string | undefined;
  let disposed = false;

  const headers = (): Record<string, string> => ({
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
    "content-type": "application/json",
  });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const requestJson = async <T>(url: string, init: RequestInit, timeoutMs = 15_000): Promise<T> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = (): void => ctrl.abort();
    abort?.signal.addEventListener("abort", onAbort);
    try {
      const res = await fetchImpl(url, { ...init, headers: headers(), signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status}`);
      return (text.length === 0 ? {} : JSON.parse(text)) as T;
    } finally {
      clearTimeout(timer);
      abort?.signal.removeEventListener("abort", onAbort);
    }
  };

  const begin = async (): Promise<LoginStart> => {
    const response = await requestJson<{ qrcode?: string; qrcode_img_content?: string }>(
      `${QR_BASE_URL}ilink/bot/get_bot_qrcode?bot_type=3`,
      { method: "POST", body: JSON.stringify({ local_token_list: [] }) },
      10_000,
    );
    if (response.qrcode === undefined || response.qrcode_img_content === undefined) {
      throw new Error("微信服务未返回二维码");
    }
    const url = new URL(response.qrcode_img_content);
    if (url.protocol !== "https:" || !isTrustedHost(url.hostname)) {
      throw new Error("微信服务返回了不受信任的二维码地址");
    }
    barcode = response.qrcode;
    return { qrcode: response.qrcode, url: url.toString() };
  };

  let barcode = qrcode;

  const poll = async (signal: AbortSignal): Promise<void> => {
    while (!disposed && !signal.aborted) {
      try {
        let endpoint = `${baseUrl}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(barcode ?? "")}`;
        if (verifyCode !== undefined && verifyCode.length > 0) {
          endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
        }
        const response = await requestJson<LoginStatus>(endpoint, { method: "GET" }, 15_000);
        const status = response.status ?? "wait";

        if (status === "confirmed") {
          if (response.bot_token === undefined || response.ilink_bot_id === undefined) {
            options.onEvent({ kind: "failed", reason: "扫码成功但未返回机器人凭据" });
            return;
          }
          if (response.baseurl !== undefined) {
            try {
              baseUrl = normalizeBaseUrl(response.baseurl);
            } catch (err) {
              options.onEvent({ kind: "failed", reason: err instanceof Error ? err.message : String(err) });
              return;
            }
          }
          options.onEvent({
            kind: "success",
            botId: response.ilink_bot_id,
            token: response.bot_token,
            baseUrl,
          });
          return;
        }

        if (status === "expired") {
          options.onEvent({ kind: "expired" });
          return;
        }
        if (status === "need_verifycode") {
          options.onEvent({ kind: "verify", message: "该微信需要输入验证码后继续" });
        } else if (status === "verify_code_blocked") {
          options.onEvent({ kind: "failed", reason: "验证码错误次数过多，请稍后重试" });
          return;
        } else if (status === "binded_redirect") {
          options.onEvent({ kind: "failed", reason: "该微信已绑定其他机器人" });
          return;
        }

        await sleep(1500);
      } catch (err) {
        if (disposed || signal.aborted) return;
        options.onEvent({ kind: "failed", reason: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
  };

  const start = async (): Promise<void> => {
    abort?.abort();
    const ctrl = new AbortController();
    abort = ctrl;
    try {
      const login = await begin();
      if (disposed) return;
      options.onEvent({ kind: "qr", url: login.url });
      qrcode = login.qrcode;
      void poll(ctrl.signal);
    } catch (err) {
      if (!disposed) options.onEvent({ kind: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  };

  void start();

  return {
    refresh(): void {
      if (disposed) return;
      verifyCode = undefined;
      qrcode = undefined;
      void start();
    },
    submitVerify(code: string): void {
      verifyCode = code.trim();
      qrcode = qrcode ?? barcode;
    },
    dispose(): void {
      disposed = true;
      abort?.abort();
      abort = undefined;
    },
  };
}