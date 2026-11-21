import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WeixinMedia,
  decryptMedia,
  encryptMedia,
  mediaDownloadUrl,
  parseMediaAesKey,
  type WeixinMediaItem,
} from "../src/adapters/weixin/weixin-media.js";

const AES_KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("weixin media crypto", () => {
  it("解析 32 位 hex 的 image_item.aeskey", () => {
    const key = parseMediaAesKey({ aeskey: AES_KEY.toString("hex") });
    expect(key.equals(AES_KEY)).toBe(true);
  });

  it("解析 base64 编码的 16 字节 media.aes_key", () => {
    const key = parseMediaAesKey({ media: { aes_key: AES_KEY.toString("base64") } });
    expect(key.equals(AES_KEY)).toBe(true);
  });

  it("解析 base64 编码的 hex 字符串 media.aes_key", () => {
    const key = parseMediaAesKey({
      media: { aes_key: Buffer.from(AES_KEY.toString("hex")).toString("base64") },
    });
    expect(key.equals(AES_KEY)).toBe(true);
  });

  it("拒绝非法 aeskey", () => {
    expect(() => parseMediaAesKey({ aeskey: "not-a-key" })).toThrow();
    expect(() => parseMediaAesKey({ media: { aes_key: "c2hvcnQ=" } })).toThrow();
  });

  it("AES-128-ECB 加解密可逆", () => {
    const ciphertext = encryptMedia(PNG, AES_KEY);
    expect(ciphertext.length % 16).toBe(0);
    expect(decryptMedia(ciphertext, AES_KEY).equals(PNG)).toBe(true);
  });

  it("拒绝非整块密文", () => {
    expect(() => decryptMedia(Buffer.from([1, 2, 3]), AES_KEY)).toThrow();
  });

  it("优先构造 CDN 下载地址", () => {
    const url = mediaDownloadUrl({ encrypt_query_param: "a b&c" });
    expect(url).toBe("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%20b%26c");
  });

  it("拒绝非腾讯 CDN 的 full_url", () => {
    expect(() => mediaDownloadUrl({ full_url: "https://evil.example.com/c2c/download?a=1" })).toThrow();
  });

  it("允许腾讯 CDN 的 full_url 并清除敏感片段", () => {
    const url = mediaDownloadUrl({
      full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?filekey=1#frag",
    });
    expect(url).toBe("https://novac2c.cdn.weixin.qq.com/c2c/download?filekey=1");
  });
});

describe("WeixinMedia", () => {
  it("下载并解密 CDN 密文", async () => {
    const ciphertext = encryptMedia(PNG, AES_KEY);
    const calls: string[] = [];
    const media = new WeixinMedia("https://ilinkai.weixin.qq.com/", {
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return new Response(ciphertext, { status: 200 });
      }) as typeof fetch,
    });

    const item: WeixinMediaItem = {
      media: { encrypt_query_param: "q1", aes_key: AES_KEY.toString("base64") },
    };
    const result = await media.download(item);
    expect(result.buffer.equals(PNG)).toBe(true);
    expect(result.size).toBe(PNG.length);
    expect(calls[0]).toContain("novac2c.cdn.weixin.qq.com/c2c/download");
  });

  it("下载失败抛出错误", async () => {
    const media = new WeixinMedia("https://ilinkai.weixin.qq.com/", {
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    await expect(media.download({ media: { encrypt_query_param: "q", aes_key: AES_KEY.toString("base64") } })).rejects.toThrow();
  });

  it("上传图片：申请地址 → 加密上传 → 组装 image_item", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "weixin-media-"));
    const file = path.join(dir, "chart.png");
    writeFileSync(file, PNG);

    let uploaded: { url: string; body: Buffer } | undefined;
    const media = new WeixinMedia("https://ilinkai.weixin.qq.com/", {
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url.includes("getuploadurl")) {
          const payload = JSON.parse(String(init?.body)) as { rawsize: number; filesize: number; aeskey: string };
          expect(payload.rawsize).toBe(PNG.length);
          expect(payload.filesize).toBe(16);
          expect(payload.aeskey).toMatch(/^[0-9a-f]{32}$/);
          return json({ upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?filekey=abc" });
        }
        if (url.includes("/c2c/upload")) {
          uploaded = { url, body: init?.body as Buffer };
          return new Response("", { status: 200, headers: { "x-encrypted-param": "download-param" } });
        }
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    });

    const result = await media.upload("tok", "wx-1", file, "image");
    expect(result.kind).toBe("image");
    expect(result.item).toMatchObject({ type: 2, image_item: { media: { encrypt_query_param: "download-param", encrypt_type: 1 } } });
    expect(result.size).toBe(PNG.length);
    expect(uploaded).toBeDefined();
    const key = Buffer.from((result.media.aes_key as string), "base64");
    const decodedKey = parseMediaAesKey({ media: { aes_key: result.media.aes_key } });
    expect(key.length).toBe(32);
    expect(decryptMedia(uploaded!.body, decodedKey).equals(PNG)).toBe(true);
  });

  it("上传文件：组装 file_item 并保留文件名", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "weixin-media-"));
    const file = path.join(dir, "report.pdf");
    writeFileSync(file, Buffer.from("%PDF-1.4 test"));

    const media = new WeixinMedia("https://ilinkai.weixin.qq.com/", {
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes("getuploadurl")) return json({ upload_param: "param-1" });
        if (url.includes("/c2c/upload")) {
          expect(url).toContain("encrypted_query_param=param-1");
          return new Response("", { status: 200, headers: { "x-encrypted-param": "dp-2" } });
        }
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    });

    const result = await media.upload("tok", "wx-1", file, "file");
    expect(result.item).toMatchObject({ type: 4, file_item: { file_name: "report.pdf", len: "13" } });
  });

  it("上传失败在缺少 x-encrypted-param 时抛出", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "weixin-media-"));
    const file = path.join(dir, "a.png");
    writeFileSync(file, PNG);
    const media = new WeixinMedia("https://ilinkai.weixin.qq.com/", {
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        if (String(input).includes("getuploadurl")) return json({ upload_param: "p" });
        return new Response("", { status: 200 });
      }) as typeof fetch,
    });
    await expect(media.upload("tok", "wx-1", file, "image")).rejects.toThrow("x-encrypted-param");
  });

  it("sendMedia 携带 context_token 并校验响应码", async () => {
    const bodies: any[] = [];
    const media = new WeixinMedia("https://ilinkai.weixin.qq.com/", {
      fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ ret: 0 });
      }) as typeof fetch,
    });

    await media.sendMedia("tok", "wx-1", { type: 2 }, "ctx-1");
    expect(bodies[0].msg).toMatchObject({
      to_user_id: "wx-1",
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 2 }],
      context_token: "ctx-1",
    });
    expect(bodies[0].base_info).toMatchObject({ channel_version: "2.4.6" });
  });

  it("sendMedia 在 ret 非 0 时抛出", async () => {
    const media = new WeixinMedia("https://ilinkai.weixin.qq.com/", {
      fetchImpl: (async () => json({ ret: -1 })) as typeof fetch,
    });
    await expect(media.sendMedia("tok", "wx-1", { type: 2 })).rejects.toThrow("rejected");
  });
});