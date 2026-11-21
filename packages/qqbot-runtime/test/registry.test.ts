import { describe, expect, it } from "vitest";
import { MemoryAccessStore, AccessController } from "@codearts-qqbot/core";
import { MockKernelPort } from "@codearts-qqbot/kernel-port";
import { MemoryPrefsStore, SessionRegistry } from "../src/session/registry.js";

describe("SessionRegistry", () => {
  it("同 peer 复用同一会话，不同 peer 隔离", async () => {
    const kernel = new MockKernelPort();
    const registry = new SessionRegistry({
      port: kernel,
      prefs: new MemoryPrefsStore("app"),
      appId: "app",
      workspace: "C:/ws",
    });

    const a1 = await registry.getOrCreate("c2c", "u1", "u1");
    const a2 = await registry.getOrCreate("c2c", "u1", "u1");
    const b = await registry.getOrCreate("c2c", "u2", "u2");

    expect(a1.kernelSessionId).toBe(a2.kernelSessionId);
    expect(b.kernelSessionId).not.toBe(a1.kernelSessionId);
    expect(kernel.sessionCount).toBe(2);
  });

  it("并发同 key 只创建一次（singleflight）", async () => {
    const kernel = new MockKernelPort();
    const registry = new SessionRegistry({
      port: kernel,
      prefs: new MemoryPrefsStore("app"),
      appId: "app",
      workspace: "C:/ws",
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => registry.getOrCreate("group", "g1", "u1")),
    );
    const ids = new Set(results.map((r) => r.kernelSessionId));
    expect(ids.size).toBe(1);
    expect(kernel.calls.filter((c) => c.method === "createSession")).toHaveLength(1);
  });

  it("持久化后可由新实例恢复", async () => {
    const prefs = new MemoryPrefsStore("app");
    const kernel = new MockKernelPort();
    const first = new SessionRegistry({ port: kernel, prefs, appId: "app", workspace: "C:/ws" });
    const record = await first.getOrCreate("c2c", "u1", "u1");

    const second = new SessionRegistry({ port: kernel, prefs, appId: "app", workspace: "C:/ws" });
    const resumed = await second.getOrCreate("c2c", "u1", "u1");
    expect(resumed.kernelSessionId).toBe(record.kernelSessionId);
    expect(kernel.calls.some((c) => c.method === "resumeSession")).toBe(true);
  });

  it("remove 后下次创建新会话", async () => {
    const kernel = new MockKernelPort();
    const registry = new SessionRegistry({
      port: kernel,
      prefs: new MemoryPrefsStore("app"),
      appId: "app",
      workspace: "C:/ws",
    });
    const before = await registry.getOrCreate("c2c", "u1", "u1");
    await registry.remove("c2c", "u1");
    const after = await registry.getOrCreate("c2c", "u1", "u1");
    expect(after.kernelSessionId).not.toBe(before.kernelSessionId);
  });

  it("闲置回收释放内核会话", async () => {
    let now = 0;
    const kernel = new MockKernelPort();
    const registry = new SessionRegistry({
      port: kernel,
      prefs: new MemoryPrefsStore("app"),
      appId: "app",
      workspace: "C:/ws",
      idleTimeoutMs: 1000,
      evictIntervalMs: 50,
      now: () => now,
    });
    await registry.getOrCreate("c2c", "u1", "u1");
    expect(registry.size).toBe(1);

    now = 5000;
    registry.startIdleEvictor();
    await new Promise((r) => setTimeout(r, 300));
    expect(registry.size).toBe(0);
    await registry.disposeAll();
  });
});

describe("AccessController 集成前置", () => {
  it("默认可用于装配", async () => {
    const access = new AccessController(new MemoryAccessStore());
    expect(await access.canAccess("c2c", "u1")).toBe(true);
  });
});