import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/diagnostics.js";

describe("redactSecrets", () => {
  it("抹掉 JSON 中的凭据值并保留键名", () => {
    const result = redactSecrets('{"appSecret":"abc123def456","secret":"zzz"}');
    expect(result.redactions).toBe(2);
    expect(result.text).toBe('{"appSecret":"[REDACTED]","secret":"[REDACTED]"}');
  });

  it("抹掉 key=value 形式的凭据", () => {
    const result = redactSecrets("token=abc123\nbotToken=xyz789");
    expect(result.redactions).toBe(2);
    expect(result.text).toBe("token=[REDACTED]\nbotToken=[REDACTED]");
  });

  it("保留状态值，便于判断是否已配置", () => {
    const result = redactSecrets('{"password":"set"}\nkernel.password=empty');
    expect(result.redactions).toBe(0);
    expect(result.text).toBe('{"password":"set"}\nkernel.password=empty');
  });

  it("普通日志不受影响", () => {
    const text = '{"msg":"channel online","channel":"wecom"}';
    expect(redactSecrets(text)).toEqual({ text, redactions: 0 });
  });

  it("不会因为大小写漏掉字段", () => {
    const result = redactSecrets('{"AppSecret":"abc"} TOKEN=xyz');
    expect(result.redactions).toBe(2);
  });
});