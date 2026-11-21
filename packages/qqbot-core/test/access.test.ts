import { describe, expect, it } from "vitest";
import { AccessController, ErrorCode, MemoryAccessStore, QqbotError } from "../src/index.js";

async function make(): Promise<AccessController> {
  return new AccessController(new MemoryAccessStore(), () => 0);
}

describe("AccessController", () => {
  it("私聊默认 open，群聊默认 allowlist", async () => {
    const access = await make();
    expect(await access.canAccess("c2c", "u1")).toBe(true);
    expect(await access.canAccess("group", "g1")).toBe(false);
  });

  it("allowlist 模式只放行名单内身份", async () => {
    const access = await make();
    await access.setMode("group", "allowlist");
    await access.addAllow("group", "g1");
    expect(await access.canAccess("group", "g1")).toBe(true);
    expect(await access.canAccess("group", "g2")).toBe(false);
  });

  it("disabled 模式拒绝所有身份", async () => {
    const access = await make();
    await access.setMode("c2c", "disabled");
    expect(await access.canAccess("c2c", "u1")).toBe(false);
  });

  it("配对码兑换后加入名单", async () => {
    const access = await make();
    const code = await access.createPairing("group");
    const result = await access.redeemPairing(code.code, "group", "g9");
    expect(result.ok).toBe(true);
    expect(await access.canAccess("group", "g9")).toBe(true);
  });

  it("配对码类型不匹配时拒绝", async () => {
    const access = await make();
    const code = await access.createPairing("group");
    const result = await access.redeemPairing(code.code, "c2c", "u9");
    expect(result).toEqual({ ok: false, reason: "kind_mismatch" });
  });

  it("撤销后即使重新配对也拒绝（撤销优先）", async () => {
    const access = await make();
    const code = await access.createPairing("group");
    await access.redeemPairing(code.code, "group", "g9");
    await access.revoke("group", "g9");
    expect(await access.canAccess("group", "g9")).toBe(false);

    const again = await access.redeemPairing(code.code, "group", "g9");
    expect(again).toEqual({ ok: false, reason: "revoked" });
    expect(await access.canAccess("group", "g9")).toBe(false);
  });

  it("revision 冲突抛出 QB-6002", async () => {
    const access = await make();
    await access.addAllow("group", "g1", 0);
    await expect(access.addAllow("group", "g2", 0)).rejects.toMatchObject({ code: ErrorCode.REVISION_CONFLICT });
  });

  it("命令权限独立于会话权限", async () => {
    const access = await make();
    expect(await access.canAccess("c2c", "u1")).toBe(true);
    expect(await access.canRunCommand("u1")).toBe(false);
    await access.setMode("command", "open");
    expect(await access.canRunCommand("u1")).toBe(true);
  });

  it("错误自带用户文案", () => {
    const err = new QqbotError(ErrorCode.ACCESS_DENIED);
    expect(err.toUserText()).toContain("使用名单");
  });
});