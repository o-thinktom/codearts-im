import { describe, expect, it } from "vitest";
import { MockKernelPort } from "../src/mock-port.js";
import type { KernelEvent } from "../src/port.js";

describe("MockKernelPort", () => {
  it("创建、恢复、删除会话", async () => {
    const kernel = new MockKernelPort();
    const { id } = await kernel.createSession({ cwd: "C:/ws" });
    expect(await kernel.sessionExists(id)).toBe(true);
    expect((await kernel.resumeSession(id)).id).toBe(id);
    await kernel.disposeSession(id);
    expect(await kernel.sessionExists(id)).toBe(false);
  });

  it("prompt 产生完整事件序列", async () => {
    const kernel = new MockKernelPort({ responder: () => ({ text: "abcdefghij" }), deltaSize: 3 });
    const events: KernelEvent[] = [];
    kernel.subscribe((e) => events.push(e));
    const { id } = await kernel.createSession({ cwd: "C:/ws" });

    await kernel.prompt(id, [{ kind: "text", text: "hi" }]);
    await new Promise((r) => setTimeout(r, 20));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn/start");
    expect(types).toContain("text/delta");
    expect(types).toContain("message/complete");
    expect(types.at(-1)).toBe("turn/end");
  });

  it("关闭流式后不产生 delta", async () => {
    const kernel = new MockKernelPort({ streaming: false, responder: () => ({ text: "abc" }) });
    const events: KernelEvent[] = [];
    kernel.subscribe((e) => events.push(e));
    const { id } = await kernel.createSession({ cwd: "C:/ws" });
    await kernel.prompt(id, [{ kind: "text", text: "hi" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.type === "text/delta")).toBe(false);
    expect(events.some((e) => e.type === "message/complete")).toBe(true);
  });

  it("工具调用与权限请求按序产生", async () => {
    const kernel = new MockKernelPort({
      responder: () => ({
        text: "done",
        toolCall: { name: "bash", ok: false, summary: "exit 1" },
        permission: { action: "shell", detail: "npm test" },
      }),
    });
    const events: KernelEvent[] = [];
    kernel.subscribe((e) => events.push(e));
    const { id } = await kernel.createSession({ cwd: "C:/ws" });
    await kernel.prompt(id, [{ kind: "text", text: "run" }]);
    await new Promise((r) => setTimeout(r, 20));

    const types = events.map((e) => e.type);
    expect(types.indexOf("tool/call")).toBeLessThan(types.indexOf("tool/result"));
    expect(types).toContain("permission/request");
  });

  it("可模拟健康状态与取消", async () => {
    const kernel = new MockKernelPort();
    expect(await kernel.health()).toBe(true);
    kernel.setHealth(false);
    expect(await kernel.health()).toBe(false);

    const events: KernelEvent[] = [];
    kernel.subscribe((e) => events.push(e));
    const { id } = await kernel.createSession({ cwd: "C:/ws" });
    await kernel.cancel(id);
    expect(events.at(-1)).toMatchObject({ type: "turn/end", reason: { code: "CANCELLED" } });
  });
});