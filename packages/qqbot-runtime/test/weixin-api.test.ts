import { describe, expect, it } from "vitest";
import { WeixinApi, WeixinApiError } from "../src/adapters/weixin/weixin-api.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(routes: Array<(call: Call) => Response | undefined>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    };
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res !== undefined) return res;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("WeixinApi", () => {
  it("申请二维码携带 iLink 头与 bot_type", async () => {
    const { fetchImpl, calls } = fakeFetch([
      (c) => (c.url.includes("get_bot_qrcode") ? json({ qrcode: "qr-1", qrcode_img_content: "https://weixin.qq.com/qr" }) : undefined),
    ]);
    const api = new WeixinApi({ fetchImpl });
    const start = await api.beginLogin();

    expect(start).toEqual({ qrcode: "qr-1", qrUrl: "https://weixin.qq.com/qr" });
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toContain("ilink/bot/get_bot_qrcode?bot_type=3");
    expect(call?.headers["iLink-App-Id"]).toBe("bot");
    expect(call?.body).toEqual({ local_token_list: [] });
  });

  it("扫码确认返回 botToken/botId 并校验 baseurl", async () => {
    const { fetchImpl } = fakeFetch([
      () => json({ status: "confirmed", bot_token: "tok", ilink_bot_id: "bot-1", baseurl: "https://ilinkai.weixin.qq.com/" }),
    ]);
    const api = new WeixinApi({ fetchImpl });
    const result = await api.pollLogin("qr-1");
    expect(result).toMatchObject({ status: "confirmed", botToken: "tok", botId: "bot-1" });
  });

  it("拒绝非腾讯域名的 baseurl", async () => {
    const { fetchImpl } = fakeFetch([
      () => json({ status: "confirmed", bot_token: "tok", ilink_bot_id: "bot-1", baseurl: "https://evil.example.com/" }),
    ]);
    const api = new WeixinApi({ fetchImpl });
    await expect(api.pollLogin("qr-1")).rejects.toBeInstanceOf(WeixinApiError);
  });

  it("getupdates 携带游标；超时返回空且不抛错", async () => {
    const { fetchImpl, calls } = fakeFetch([
      (c) => (c.url.includes("getupdates") ? json({ msgs: [{ msg_id: "m1" }], get_updates_buf: "buf-2" }) : undefined),
    ]);
    const api = new WeixinApi({ fetchImpl });
    const updates = await api.getUpdates("tok", "buf-1", 1000);
    expect(updates.getUpdatesBuf).toBe("buf-2");
    expect(calls[0]?.body).toMatchObject({ get_updates_buf: "buf-1" });

    const timeoutApi = new WeixinApi({
      fetchImpl: (async () => {
        throw new DOMException("aborted", "AbortError");
      }) as typeof fetch,
    });
    const empty = await timeoutApi.getUpdates("tok", "buf-1", 1000);
    expect(empty).toEqual({ msgs: [], getUpdatesBuf: "buf-1" });
  });

  it("发送文本使用 message_type=2 与 text_item", async () => {
    const { fetchImpl, calls } = fakeFetch([() => json({ ret: 0 })]);
    const api = new WeixinApi({ fetchImpl });
    await api.sendText("tok", "wx-user", "hello", "ctx-1");

    const call = calls[0];
    expect(call?.headers.Authorization).toBe("Bearer tok");
    expect(call?.headers.AuthorizationType).toBe("ilink_bot_token");
    expect(call?.body).toMatchObject({
      msg: {
        to_user_id: "wx-user",
        message_type: 2,
        item_list: [{ type: 1, text_item: { text: "hello" } }],
        context_token: "ctx-1",
      },
    });
  });

  it("-14 映射为 stale-token", async () => {
    const { fetchImpl } = fakeFetch([() => json({ ret: -14, errmsg: "stale" })]);
    const api = new WeixinApi({ fetchImpl });
    await expect(api.getUpdates("tok", "")).rejects.toMatchObject({ code: "stale-token" });
  });
});