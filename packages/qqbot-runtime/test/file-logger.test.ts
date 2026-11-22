import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLogger, readLogTail, teeLogger } from "../src/ops/file-logger.js";

const wait = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

function dir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "qqbot-log-"));
}

describe("createFileLogger", () => {
  it("把结构化日志写入 sidecar.log", async () => {
    const root = dir();
    const logger = createFileLogger(root);
    logger.info("hello", { sessionId: "s1" });
    logger.warn("careful");
    await wait();

    const lines = readLogTail(root, 10);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first).toMatchObject({ level: "info", msg: "hello", sessionId: "s1" });
    expect(typeof first["ts"]).toBe("string");
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ level: "warn", msg: "careful" });
  });

  it("超过上限时轮转并保留历史", async () => {
    const root = dir();
    const logger = createFileLogger(root, { maxBytes: 150, keepFiles: 3 });
    for (let i = 0; i < 6; i += 1) {
      logger.info(`line-${i}`, { pad: "x".repeat(20) });
    }
    await wait(200);

    expect(existsSync(path.join(root, "sidecar.log.1"))).toBe(true);
    const all = readLogTail(root, 200);
    expect(all[all.length - 1]).toContain("line-5");
  });

  it("按最近行数截取且不抛错", async () => {
    const root = dir();
    expect(readLogTail(root, 5)).toEqual([]);

    const logger = createFileLogger(root);
    for (let i = 0; i < 5; i += 1) logger.info(`m-${i}`);
    await wait();
    const tail = readLogTail(root, 2);
    expect(tail).toHaveLength(2);
    expect(tail[1]).toContain("m-4");
  });

  it("日志目录不可写时不抛异常", () => {
    const logger = createFileLogger(path.join(os.tmpdir(), "qqbot\0bad"));
    expect(() => logger.info("boom")).not.toThrow();
  });
});

describe("teeLogger", () => {
  it("同时转发到两个 logger", () => {
    const a: string[] = [];
    const b: string[] = [];
    const mk = (sink: string[]) => ({
      debug: (m: string) => sink.push(`d:${m}`),
      info: (m: string) => sink.push(`i:${m}`),
      warn: (m: string) => sink.push(`w:${m}`),
      error: (m: string) => sink.push(`e:${m}`),
    });
    const logger = teeLogger(mk(a), mk(b));
    logger.error("failed");
    expect(a).toEqual(["e:failed"]);
    expect(b).toEqual(["e:failed"]);
  });
});

describe("日志文件内容", () => {
  it("每行是合法 JSON 且包含时间戳", async () => {
    const root = dir();
    const logger = createFileLogger(root);
    logger.info("x");
    await wait();
    const raw = readFileSync(path.join(root, "sidecar.log"), "utf8").trim();
    expect(raw.split("\n")).toHaveLength(1);
    expect(JSON.parse(raw)).toHaveProperty("ts");
  });
});