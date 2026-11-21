import { describe, expect, it } from "vitest";
import { normalizeEvent } from "../src/normalize.js";

/**
 * 样本取自真实内核（126.11.1-20261110192452）的 /event 流结构。
 * 这些用例锁定"事件映射表"，内核升级导致结构变化时会先在这里报警。
 */
describe("真实内核事件（OpenCode 风格）", () => {
  it("session.created / session.updated 不产生业务事件", () => {
    const created = {
      type: "session.created",
      properties: { sessionID: "ses_1", info: { id: "ses_1", directory: "E:\\ws" } },
    };
    expect(normalizeEvent(created)).toBeUndefined();
    expect(normalizeEvent({ ...created, type: "session.updated" })).toBeUndefined();
  });

  it("用户消息完成视作 turn/start", () => {
    const ev = normalizeEvent({
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_1", role: "user", time: { created: 1 } } },
    });
    expect(ev).toEqual({ type: "turn/start", sessionId: "ses_1", turn: 0 });
  });

  it("助手消息完成（time.completed）视作 message/complete", () => {
    const ev = normalizeEvent({
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "msg_2",
          role: "assistant",
          time: { created: 1, completed: 2 },
          content: [{ type: "text", text: "done" }],
        },
      },
    });
    expect(ev).toMatchObject({ type: "message/complete", sessionId: "ses_1" });
  });

  it("文本增量（message.part.delta）映射为 text/delta", () => {
    const ev = normalizeEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_2",
        partID: "prt_1",
        field: "text",
        delta: "你好",
      },
    });
    expect(ev).toMatchObject({ type: "text/delta", sessionId: "ses_1", attemptId: "msg_2", text: "你好" });
  });

  it("part.updated 的文本快照不再重复计入增量", () => {
    const ev = normalizeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_1", messageID: "msg_2", sessionID: "ses_1", type: "text", text: "你好" },
      },
    });
    expect(ev).toBeUndefined();
  });

  it("工具 running 映射为 tool/call", () => {
    const ev = normalizeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: {
          id: "prt_2",
          callID: "call_1",
          type: "tool",
          tool: "bash",
          state: { status: "running", input: { command: "ls" } },
        },
      },
    });
    expect(ev).toMatchObject({ type: "tool/call", callId: "call_1", name: "bash" });
  });

  it("工具 completed 映射为 tool/result，error 映射为失败", () => {
    const base = {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_2", callID: "call_1", type: "tool", tool: "bash", state: { status: "completed", output: "ok" } },
      },
    };
    expect(normalizeEvent(base)).toMatchObject({ type: "tool/result", ok: true, summary: "ok" });

    const failed = {
      ...base,
      properties: { ...base.properties, part: { ...base.properties.part, state: { status: "error", output: "boom" } } },
    };
    expect(normalizeEvent(failed)).toMatchObject({ type: "tool/result", ok: false, summary: "boom" });
  });

  it("session.idle 映射为 turn/end", () => {
    expect(normalizeEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })).toMatchObject({
      type: "turn/end",
      sessionId: "ses_1",
    });
  });

  it("session.error 携带错误码与原因", () => {
    const ev = normalizeEvent({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "ProviderAuthError", message: "no key" } },
    });
    expect(ev).toMatchObject({ type: "turn/end", reason: { code: "ProviderAuthError", message: "no key" } });
  });

  it("permission.asked 映射为审批请求", () => {
    const ev = normalizeEvent({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["npm test"] },
    });
    expect(ev).toMatchObject({ type: "permission/request", requestId: "per_1", action: "bash" });
  });
});