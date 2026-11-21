import { describe, expect, it } from "vitest";
import { QQ_CAPABILITY } from "../src/transport/adapter.js";
import { QqAdapter } from "../src/adapters/qq/adapter.js";
import { sessionKeyOf } from "../src/session/registry.js";
import type { QqApi } from "../src/qq/client.js";

describe("渠道抽象层", () => {
  it("QQ 会话键保持历史前缀（升级不丢会话）", () => {
    expect(sessionKeyOf("app", "c2c", "u1")).toBe("qqbot:app:c2c:u1");
    expect(sessionKeyOf("qq", "app", "c2c", "u1")).toBe("qqbot:app:c2c:u1");
  });

  it("其他渠道使用渠道前缀", () => {
    expect(sessionKeyOf("weixin", "bot", "c2c", "wx1")).toBe("weixin:bot:c2c:wx1");
    expect(sessionKeyOf("wecom", "corp", "group", "g1")).toBe("wecom:corp:group:g1");
    expect(sessionKeyOf("wecom-app", "corp", "c2c", "u1")).toBe("wecom-app:corp:c2c:u1");
  });

  it("QQ 能力基线与现有实现一致", () => {
    expect(QQ_CAPABILITY.maxChars).toBe(4500);
    expect(QQ_CAPABILITY.media).toBe("base64");
    expect(QQ_CAPABILITY.maxFileBytes).toBe(20 * 1024 * 1024);
  });

  it("QqAdapter 透传出站到现有实现", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendC2C: async (...args: unknown[]) => {
        calls.push(args);
      },
    } as unknown as QqApi;

    const adapter = new QqAdapter({ api });
    expect(adapter.id).toBe("qq");
    await adapter.sendText({ scope: "c2c", channel: "qq", targetId: "u1" }, "hi", "reply");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("u1");
    expect(calls[0]?.[1]).toBe("hi");
  });
});