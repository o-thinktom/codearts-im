import { describe, expect, it } from "vitest";
import { QqApi } from "../src/qq/client.js";

interface Call {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(routes: Array<(call: Call) => Response | undefined>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      headers: init?.headers as Record<string, string> | undefined,
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

describe("QqApi", () => {
  it("换取 token 并缓存", async () => {
    const { fetchImpl, calls } = fakeFetch([
      (c) => (c.url.includes("getAppAccessToken") ? jsonResponse({ access_token: "tok-1", expires_in: 7200 }) : undefined),
      (c) => (c.url.endsWith("/gateway/bot") ? jsonResponse({ url: "wss://example" }) : undefined),
    ]);
    const api = new QqApi({ appId: "app", appSecret: "sec", fetchImpl, now: () => 0 });

    expect(await api.getToken()).toBe("tok-1");
    expect(await api.getToken()).toBe("tok-1");
    expect(await api.getGateway()).toBe("wss://example");

    const tokenCalls = calls.filter((c) => c.url.includes("getAppAccessToken"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toEqual({ appId: "app", clientSecret: "sec" });
    const gw = calls.find((c) => c.url.endsWith("/gateway/bot"));
    expect(gw?.headers?.authorization).toBe("QQBot tok-1");
  });

  it("token 过期后刷新", async () => {
    let now = 0;
    let n = 0;
    const { fetchImpl } = fakeFetch([
      (c) => {
        if (!c.url.includes("getAppAccessToken")) return undefined;
        n += 1;
        return jsonResponse({ access_token: `tok-${n}`, expires_in: 120 });
      },
    ]);
    const api = new QqApi({ appId: "app", appSecret: "sec", fetchImpl, now: () => now });
    expect(await api.getToken()).toBe("tok-1");
    now = 100_000;
    expect(await api.getToken()).toBe("tok-2");
  });

  it("401 时强制刷新并重试一次", async () => {
    let token = 0;
    const { fetchImpl, calls } = fakeFetch([
      (c) => {
        if (c.url.includes("getAppAccessToken")) {
          token += 1;
          return jsonResponse({ access_token: `tok-${token}`, expires_in: 7200 });
        }
        if (c.url.includes("/v2/users/")) {
          const auth = c.headers?.authorization;
          return auth === "QQBot tok-1" ? new Response("unauthorized", { status: 401 }) : new Response(null, { status: 204 });
        }
        return undefined;
      },
    ]);
    const api = new QqApi({ appId: "app", appSecret: "sec", fetchImpl });
    await expect(api.sendC2C("u1", "hi", "m1")).resolves.toBeUndefined();
    expect(calls.filter((c) => c.url.includes("getAppAccessToken"))).toHaveLength(2);
  });

  it("私聊发送带 msg_id 与 msg_type", async () => {
    const { fetchImpl, calls } = fakeFetch([
      (c) => (c.url.includes("getAppAccessToken") ? jsonResponse({ access_token: "tok", expires_in: 7200 }) : undefined),
      (c) => (c.url.includes("/v2/users/") ? new Response(null, { status: 204 }) : undefined),
    ]);
    const api = new QqApi({ appId: "app", appSecret: "sec", fetchImpl });
    await api.sendC2C("openid-1", "hello", "msg-1");

    const send = calls.find((c) => c.url.includes("/v2/users/"));
    expect(send?.url).toContain("/v2/users/openid-1/messages");
    expect(send?.body).toEqual({ content: "hello", msg_type: 0, msg_id: "msg-1" });
  });

  it("群聊发送走 groups 路径", async () => {
    const { fetchImpl, calls } = fakeFetch([
      (c) => (c.url.includes("getAppAccessToken") ? jsonResponse({ access_token: "tok", expires_in: 7200 }) : undefined),
      (c) => (c.url.includes("/v2/groups/") ? new Response(null, { status: 204 }) : undefined),
    ]);
    const api = new QqApi({ appId: "app", appSecret: "sec", fetchImpl });
    await api.sendGroup("group-1", "hi");
    expect(calls.some((c) => c.url.includes("/v2/groups/group-1/messages"))).toBe(true);
  });

  it("凭据错误抛出 QB-1001", async () => {
    const { fetchImpl } = fakeFetch([
      (c) => (c.url.includes("getAppAccessToken") ? jsonResponse({ code: 100016, message: "invalid appid" }) : undefined),
    ]);
    const api = new QqApi({ appId: "app", appSecret: "sec", fetchImpl });
    await expect(api.getToken()).rejects.toMatchObject({ code: "QB-1001" });
  });
});