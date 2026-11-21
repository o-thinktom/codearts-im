import { describe, expect, it } from "vitest";
import { isNonTextDelta, normalizeEvent, trackPartType } from "../src/index.js";

describe("思维链过滤", () => {
  it("reasoning 增量应被丢弃（即使 field 是 text）", () => {
    const partTypes = new Map<string, string>();
    trackPartType(
      { type: "message.part.updated", properties: { sessionID: "s1", part: { id: "prt_1", type: "reasoning" } } },
      partTypes,
    );

    const delta = {
      type: "message.part.delta",
      properties: { sessionID: "s1", partID: "prt_1", messageID: "m1", field: "text", delta: "17 * 23 = 391" },
    };
    expect(isNonTextDelta(delta, partTypes)).toBe(true);
  });

  it("正文增量保留", () => {
    const partTypes = new Map<string, string>();
    trackPartType(
      { type: "message.part.updated", properties: { sessionID: "s1", part: { id: "prt_2", type: "text" } } },
      partTypes,
    );

    const delta = {
      type: "message.part.delta",
      properties: { sessionID: "s1", partID: "prt_2", messageID: "m1", field: "text", delta: "结果是 391" },
    };
    expect(isNonTextDelta(delta, partTypes)).toBe(false);
  });

  it("未记录类型的增量不丢弃（兼容旧内核）", () => {
    const partTypes = new Map<string, string>();
    const delta = { type: "message.part.delta", properties: { sessionID: "s1", partID: "unknown", delta: "x" } };
    expect(isNonTextDelta(delta, partTypes)).toBe(false);
  });

  it("完成消息的 blocks 排除 reasoning 与 synthetic", () => {
    const ev = normalizeEvent({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "m1",
          role: "assistant",
          time: { created: 1, completed: 2 },
          content: [
            { type: "reasoning", text: "思考过程" },
            { type: "text", text: "正文回答" },
            { type: "text", text: "系统提醒", synthetic: true },
          ],
        },
      },
    });

    expect(ev).toMatchObject({ type: "message/complete", blocks: [{ type: "text", text: "正文回答" }] });
  });
});