import { describe, expect, it } from "vitest";
import { chunkMarkdownText } from "../src/transport/chunker.js";

describe("chunkMarkdownText", () => {
  it("短文本保持单段", () => {
    const chunks = chunkMarkdownText("hello\nworld", 100);
    expect(chunks).toEqual(["hello\nworld"]);
  });

  it("空文本返回空数组", () => {
    expect(chunkMarkdownText("   \n\n ", 100)).toEqual([]);
  });

  it("长文本按上限切分且不超限", () => {
    const text = Array.from({ length: 40 }, (_, i) => `第 ${i} 行内容`).join("\n");
    const chunks = chunkMarkdownText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80);
  });

  it("跨段的代码块自动补围栏", () => {
    const code = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const text = `说明\n\`\`\`ts\n${code}\n\`\`\`\n结束`;
    const chunks = chunkMarkdownText(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      if (c.includes("const v")) {
        expect(c.startsWith("```ts")).toBe(true);
        expect(c.includes("```")).toBe(true);
      }
      expect(c.length).toBeLessThanOrEqual(120);
    }

    const codeChunks = chunks.filter((c) => c.includes("const v"));
    for (const c of codeChunks.slice(0, -1)) {
      expect(c.trimEnd().endsWith("```")).toBe(true);
    }
  });

  it("单行超长时硬切且不超限", () => {
    const line = "x".repeat(500);
    const chunks = chunkMarkdownText(line, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("")).toBe(line);
  });
});