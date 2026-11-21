import { describe, expect, it } from "vitest";
import { normalizeEvent } from "../src/normalize.js";

describe("normalizeEvent", () => {
  it("识别 turn/start 并透传 turn", () => {
    expect(normalizeEvent({ type: "turn/start", sessionId: "s1", data: { turn: 2 } })).toEqual({
      type: "turn/start",
      sessionId: "s1",
      turn: 2,
    });
  });

  it("兼容嵌套 session 与别名事件名", () => {
    const ev = normalizeEvent({ type: "assistant/chunk", session: { id: "s2" }, data: { text: "hi", turn: 1 } });
    expect(ev).toMatchObject({ type: "text/delta", sessionId: "s2", text: "hi", turn: 1 });
  });

  it("缺失 sessionId 时返回 undefined", () => {
    expect(normalizeEvent({ type: "turn/start", data: { turn: 1 } })).toBeUndefined();
  });

  it("未知事件返回 undefined", () => {
    expect(normalizeEvent({ type: "unknown/event", sessionId: "s1" })).toBeUndefined();
  });

  it("工具调用要求 callId 与 name", () => {
    expect(normalizeEvent({ type: "tool/call", sessionId: "s1", data: { callId: "c1" } })).toBeUndefined();
    expect(normalizeEvent({ type: "tool/call", sessionId: "s1", data: { callId: "c1", name: "bash", args: { cmd: "ls" } } })).toMatchObject({
      type: "tool/call",
      callId: "c1",
      name: "bash",
    });
  });

  it("工具结果默认 ok=true，isError 取反", () => {
    expect(normalizeEvent({ type: "tool/result", sessionId: "s1", data: { callId: "c1" } })).toMatchObject({ ok: true });
    expect(normalizeEvent({ type: "tool/result", sessionId: "s1", data: { callId: "c1", isError: true } })).toMatchObject({
      ok: false,
    });
  });

  it("message/complete 抽取文本块", () => {
    const ev = normalizeEvent({
      type: "assistant/message",
      sessionId: "s1",
      data: { turn: 1, content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    });
    expect(ev).toMatchObject({ type: "message/complete", blocks: [{ text: "a" }, { text: "b" }] });
  });

  it("权限请求抽取 requestId 与动作", () => {
    const ev = normalizeEvent({
      type: "permission/asked",
      sessionId: "s1",
      data: { requestId: "p1", action: "shell", detail: "rm -rf" },
    });
    expect(ev).toMatchObject({ type: "permission/request", requestId: "p1", action: "shell" });
  });

  it("交付物支持字符串与对象两种形态", () => {
    const ev = normalizeEvent({
      type: "deliverables/presented",
      sessionId: "s1",
      data: { files: ["C:/a/b.ts", { path: "C:/c/d.md", name: "d.md" }] },
    });
    expect(ev).toMatchObject({
      type: "deliverable",
      files: [
        { path: "C:/a/b.ts", name: "b.ts" },
        { path: "C:/c/d.md", name: "d.md" },
      ],
    });
  });

  it("turn/end 携带错误原因", () => {
    const ev = normalizeEvent({
      type: "turn/end",
      sessionId: "s1",
      data: { turn: 1, reason: { code: "E_TIMEOUT", message: "too slow" } },
    });
    expect(ev).toMatchObject({ type: "turn/end", reason: { code: "E_TIMEOUT", message: "too slow" } });
  });
});