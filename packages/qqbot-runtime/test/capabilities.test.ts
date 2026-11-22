import { describe, expect, it } from "vitest";
import capabilities from "../src/transport/capabilities.json" with { type: "json" };
import { QQ_CAPABILITY } from "../src/transport/adapter.js";
import { WEIXIN_CAPABILITY } from "../src/adapters/weixin/adapter.js";
import { WECOM_CAPABILITY } from "../src/adapters/wecom/adapter.js";

const MEDIA = new Set(["base64", "cdn", "sdk"]);

describe("渠道能力表（capabilities.json）", () => {
  it("三个适配器都引用同一份事实来源", () => {
    expect(QQ_CAPABILITY).toEqual(capabilities.qq);
    expect(WEIXIN_CAPABILITY).toEqual(capabilities.weixin);
    expect(WECOM_CAPABILITY).toEqual(capabilities.wecom);
  });

  it("字段取值受约束", () => {
    for (const [channel, capability] of Object.entries(capabilities)) {
      expect(channel).toMatch(/^(qq|weixin|wecom)$/);
      expect(capability.maxChars).toBeGreaterThan(0);
      expect(capability.maxFileBytes).toBeGreaterThan(0);
      expect(MEDIA.has(capability.media)).toBe(true);
    }
  });

  it("微信沿用协议上限 1800，避免超长被服务端截断", () => {
    expect(capabilities.weixin.maxChars).toBe(1800);
  });

  it("未实现 token 级流式前，三通道都不得声明 streaming", () => {
    expect(capabilities.qq.streaming).toBe(false);
    expect(capabilities.weixin.streaming).toBe(false);
    expect(capabilities.wecom.streaming).toBe(false);
  });

  it("只有企微声明按钮能力，微信保持文本交互", () => {
    expect(capabilities.wecom.buttons).toBe(true);
    expect(capabilities.qq.buttons).toBe(false);
    expect(capabilities.weixin.buttons).toBe(false);
  });
});