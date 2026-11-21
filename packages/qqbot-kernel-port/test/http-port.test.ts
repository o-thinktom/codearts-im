import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpKernelPort } from "../src/http-port.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response): void {
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      };
      calls.push(call);
      return handler(call);
    },
  );
}

const port = (): HttpKernelPort =>
  new HttpKernelPort({
    baseUrl: "http://127.0.0.1:12345",
    directory: "E:/ws/demo",
    basicAuth: { username: "codearts", password: "secret" },
    timeoutMs: 1000,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("HttpKernelPort（真实契约）", () => {
  it("创建会话走 POST /session，并带 directory 与 Basic Auth", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ id: "ses_1", version: "126.11.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await port().createSession({ cwd: "E:/ws/demo", title: "t" });

    expect(res.id).toBe("ses_1");
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toContain("/session?directory=E%3A%2Fws%2Fdemo");
    expect(call?.headers.authorization).toBe(`Basic ${Buffer.from("codearts:secret").toString("base64")}`);
    expect(call?.headers["x-opencode-directory"]).toBe("E:/ws/demo");
  });

  it("发送消息走 POST /session/{id}/message", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await port().prompt("ses_1", [{ kind: "text", text: "hi" }]);

    const call = calls[0];
    expect(call?.url).toContain("/session/ses_1/message?directory=");
    expect(call?.body).toEqual({ parts: [{ type: "text", text: "hi" }] });
  });

  it("会话不存在时 sessionExists 返回 false", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));
    expect(await port().sessionExists("ses_missing")).toBe(false);
  });

  it("info 读取 /global/health 与 /config", async () => {
    stubFetch((call) => {
      if (call.url.includes("/global/health")) return new Response(JSON.stringify({ healthy: true }), { status: 200 });
      return new Response(JSON.stringify({ agent: { build: {} }, provider: { inferhub: {} } }), { status: 200 });
    });

    const info = await port().info();
    expect(info.capabilities.has("event.delta")).toBe(true);
    expect(info.agentIds).toEqual(["build"]);
    expect(info.providers).toEqual(["inferhub"]);
  });

  it("非回环地址被拒绝", () => {
    expect(
      () =>
        new HttpKernelPort({
          baseUrl: "http://10.0.0.8:12345",
          directory: "E:/ws",
          basicAuth: { username: "codearts", password: "x" },
        }),
    ).toThrow();
  });
});