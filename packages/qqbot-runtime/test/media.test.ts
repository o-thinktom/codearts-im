import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MediaService } from "../src/media/service.js";

function makeService(maxBytes = 1024): { service: MediaService; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "qqbot-media-"));
  const fetchImpl = (async () =>
    new Response(Buffer.from("MEDIA-DATA"), { status: 200, headers: { "content-length": "10" } })) as typeof fetch;
  return { service: new MediaService({ root, maxBytes, ttlHours: 1, fetchImpl }), root };
}

describe("MediaService", () => {
  it("下载并落盘，补全 localPath", async () => {
    const { service, root } = makeService();
    const [out] = await service.ingest("peer/../x", "msg1", [
      { kind: "image", url: "https://example.com/a.png", contentType: "image/png", filename: "a.png" },
    ]);

    expect(out?.localPath).toBeDefined();
    expect(out?.size).toBe(10);
    const relative = path.relative(root, out?.localPath ?? "");
    expect(relative).not.toContain("..");
    expect(existsSync(out?.localPath ?? "")).toBe(true);
  });

  it("超过上限时不落盘", async () => {
    const { service } = makeService(5);
    const [out] = await service.ingest("peer", "msg2", [{ kind: "image", url: "https://example.com/big.png" }]);
    expect(out?.localPath).toBeUndefined();
  });

  it("语音与其他类型原样透传", async () => {
    const { service } = makeService();
    const attachments = [{ kind: "voice" as const, asrText: "你好", url: "https://example.com/v.silk" }];
    const out = await service.ingest("peer", "msg3", attachments);
    expect(out[0]).toEqual(attachments[0]);
  });

  it("清理超过 TTL 的文件", async () => {
    const { service, root } = makeService();
    const file = path.join(root, "peer", "old.png");
    mkdirSync(path.join(root, "peer"), { recursive: true });
    writeFileSync(file, "x");
    const old = (Date.now() - 2 * 3600 * 1000) / 1000;
    utimesSync(file, old, old);

    const removed = await service.cleanup();
    expect(removed).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});