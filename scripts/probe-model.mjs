/**
 * 显式模型验证 + 事件样本抓取。
 *
 *   node scripts/probe-model.mjs
 *
 * 创建 1 个测试会话，用 deepseek 模型请求一次，抓取 SSE 事件与最终消息内容，结束后删除会话。
 */
import { readFileSync } from "node:fs";

const port = Number(process.env.KERNEL_PORT ?? "22837");
const password = readFileSync(".local/kernel-password.txt", "utf8").trim();
const auth = `Basic ${Buffer.from(`codearts:${password}`).toString("base64")}`;
const directory = process.cwd();
const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (t, n = 700) => (t.length <= n ? t : `${t.slice(0, n)}…`);

async function call(method, p, body) {
  const res = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

const events = [];
async function subscribe() {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 60000).unref?.();
  const res = await fetch(`${base}/event?directory=${encodeURIComponent(directory)}`, {
    headers: { authorization: auth, accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") {
        try {
          events.push(JSON.parse(data));
        } catch {
          // ignore
        }
      }
      idx = buf.indexOf("\n\n");
    }
  }
}

const created = await call("POST", "/session", { title: "qqbot-model-probe" });
const id = JSON.parse(created.text).id;
console.log(`[probe] session=${id}`);

void subscribe();
await wait(800);

const payload = {
  parts: [{ type: "text", text: "只回复两个字：收到" }],
  model: { providerID: "inferhub-provider", modelID: "deepseek-v4.1-flash-1017" },
  agent: "build",
};
const sent = await call("POST", `/session/${id}/message`, payload);
console.log(`[probe] POST message -> ${sent.status} ${clip(sent.text.replace(/\s+/g, " "), 500)}`);

await wait(12000);

const msgs = await call("GET", `/session/${id}/message`);
let parsed = [];
try {
  parsed = JSON.parse(msgs.text);
} catch {
  // ignore
}
console.log(`[probe] messages=${parsed.length}`);
for (const m of parsed) {
  const role = m.info?.role;
  const texts = (m.parts ?? [])
    .map((p) => `${p.type}${p.text ? `=${JSON.stringify(p.text).slice(0, 120)}` : ""}`)
    .join(", ");
  console.log(`  ${role} tokens=${JSON.stringify(m.info?.tokens ?? null).slice(0, 80)} parts=[${texts}]`);
}

console.log(`[probe] events=${events.length} types=${[...new Set(events.map((e) => e.type))].join(",")}`);
const deltas = events.filter((e) => e.type === "message.part.delta");
console.log(`[probe] delta samples=${deltas.length}`);
for (const d of deltas.slice(0, 3)) console.log(`  ${clip(JSON.stringify(d), 600)}`);
const partTexts = events.filter((e) => e.type === "message.part.updated" && e.properties?.part?.text);
console.log(`[probe] part.text samples=${partTexts.length}`);
for (const p of partTexts.slice(0, 2)) console.log(`  ${clip(JSON.stringify(p), 600)}`);

await call("DELETE", `/session/${id}`);
console.log("[probe] done");
process.exit(0);