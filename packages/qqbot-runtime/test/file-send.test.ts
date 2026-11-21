import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QqImTransport } from "../src/qq/transport.js";
import type { QqApi } from "../src/qq/client.js";

class FakeApi {
  readonly uploads: Array<{ scope: string; id: string; file: string; type: number }> = [];
  readonly medias: Array<{ scope: string; id: string; fileInfo: string }> = [];
  readonly texts: Array<{ id: string; content: string; msgId?: string; msgSeq?: number }> = [];
  failUpload = false;

  async uploadFile(scope: "c2c" | "group", id: string, file: string, type: number): Promise<{ fileInfo: string }> {
    if (this.failUpload) throw new Error("upload failed");
    this.uploads.push({ scope, id, file, type });
    return { fileInfo: "file-info-1" };
  }

  async sendMedia(scope: "c2c" | "group", id: string, fileInfo: string): Promise<void> {
    this.medias.push({ scope, id, fileInfo });
  }

  async sendC2C(id: string, content: string, msgId?: string, msgSeq?: number): Promise<void> {
    this.texts.push({ id, content, ...(msgId === undefined ? {} : { msgId }), ...(msgSeq === undefined ? {} : { msgSeq }) });
  }

  async sendGroup(id: string, content: string): Promise<void> {
    this.texts.push({ id, content });
  }
}

function setup(): { transport: QqImTransport; api: FakeApi; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "qqbot-file-"));
  const api = new FakeApi();
  const transport = new QqImTransport(api as unknown as QqApi, {
    allowedRoots: [root],
    maxFileBytes: 1024,
  });
  return { transport, api, root };
}

describe("QqImTransport 文件回传", () => {
  it("白名单内文件会先上传再发送富媒体", async () => {
    const { transport, api, root } = setup();
    const file = path.join(root, "a.png");
    writeFileSync(file, "x".repeat(10));

    await transport.sendFile({ scope: "c2c", targetId: "u1", msgId: "m1" }, [{ path: file, name: "a.png" }]);

    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0]).toMatchObject({ scope: "c2c", id: "u1", type: 1 });
    expect(api.medias).toHaveLength(1);
    expect(api.texts).toHaveLength(0);
  });

  it("白名单外文件被拒绝", async () => {
    const { transport, api } = setup();
    const outside = path.join(os.tmpdir(), "outside.png");
    writeFileSync(outside, "x");

    await transport.sendFile({ scope: "c2c", targetId: "u1" }, [{ path: outside, name: "outside.png" }]);

    expect(api.uploads).toHaveLength(0);
    expect(api.texts[0]?.content).toContain("不在允许");
  });

  it("超过大小上限时不发上传", async () => {
    const { transport, api, root } = setup();
    const file = path.join(root, "big.bin");
    writeFileSync(file, "x".repeat(2048));

    await transport.sendFile({ scope: "c2c", targetId: "u1" }, [{ path: file, name: "big.bin" }]);

    expect(api.uploads).toHaveLength(0);
    expect(api.texts[0]?.content).toContain("文件过大");
  });

  it("上传失败时降级为路径文本", async () => {
    const { transport, api, root } = setup();
    api.failUpload = true;
    const file = path.join(root, "b.pdf");
    writeFileSync(file, "x");

    await transport.sendFile({ scope: "c2c", targetId: "u1" }, [{ path: file, name: "b.pdf" }]);

    expect(api.medias).toHaveLength(0);
    expect(api.texts[0]?.content).toContain("文件：b.pdf");
  });
});