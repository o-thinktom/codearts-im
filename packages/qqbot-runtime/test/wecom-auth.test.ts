import { describe, expect, it } from "vitest";
import { WecomQrAuth, type WecomQrSession } from "../src/adapters/wecom/wecom-auth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(handler: (url: string) => Response): WecomQrAuth {
  return new WecomQrAuth({
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => handler(String(input))) as typeof fetch,
    clock: () => 1_000,
  });
}

const session: WecomQrSession = {
  scode: "sc-1",
  verificationUrl: "https://work.weixin.qq.com/ai/qc/verify?code=x",
  expiresAt: 301_000,
  pollIntervalMs: 3_000,
};

describe("WecomQrAuth", () => {
  it("start 返回 scode、授权地址与过期时间", async () => {
    const auth = setup(() =>
      jsonResponse({
        data: {
          scode: "sc-1",
          auth_url: "https://work.weixin.qq.com/ai/qc/verify?code=x&state=y",
        },
      }),
    );
    const result = await auth.start();
    expect(result.scode).toBe("sc-1");
    expect(result.verificationUrl).toBe("https://work.weixin.qq.com/ai/qc/verify?code=x&state=y");
    expect(result.expiresAt).toBe(1_000 + 5 * 60_000);
    expect(result.pollIntervalMs).toBe(3_000);
  });

  it("拒绝非官方授权地址", async () => {
    const auth = setup(() =>
      jsonResponse({ data: { scode: "sc-1", auth_url: "https://evil.example.com/verify" } }),
    );
    await expect(auth.start()).rejects.toThrow("无效");
  });

  it("拒绝 http 与带非标准端口的地址", async () => {
    for (const url of ["http://work.weixin.qq.com/x", "https://work.weixin.qq.com:8443/x"]) {
      const auth = setup(() => jsonResponse({ data: { scode: "s", auth_url: url } }));
      await expect(auth.start()).rejects.toThrow("无效");
    }
  });

  it("poll 的 waiting / expired / failed 状态", async () => {
    const waiting = setup(() => jsonResponse({ data: { status: "waiting" } }));
    expect(await waiting.poll(session)).toEqual({ status: "waiting" });

    const expired = setup(() => jsonResponse({ data: { status: "expired" } }));
    expect(await expired.poll(session)).toEqual({ status: "expired" });

    const failed = setup(() => jsonResponse({ data: { status: "fail" } }));
    expect(await failed.poll(session)).toEqual({ status: "failed" });
  });

  it("poll 成功返回 botId 与 secret", async () => {
    const auth = setup(() =>
      jsonResponse({ data: { status: "SUCCESS", bot_info: { botid: "bot-1", secret: "sec-1" } } }),
    );
    expect(await auth.poll(session)).toEqual({ status: "success", botId: "bot-1", secret: "sec-1" });
  });

  it("成功但缺少凭据时报错", async () => {
    const auth = setup(() => jsonResponse({ data: { status: "success", bot_info: { botid: "bot-1" } } }));
    await expect(auth.poll(session)).rejects.toThrow("缺少");
  });

  it("HTTP 错误抛出", async () => {
    const auth = setup(() => jsonResponse({}, 503));
    await expect(auth.poll(session)).rejects.toThrow("HTTP 503");
  });
});