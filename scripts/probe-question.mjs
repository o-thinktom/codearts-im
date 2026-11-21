/**
 * 提问通道探测：触发 question 工具，抓取事件结构与待答列表。
 *
 *   node scripts/probe-question.mjs
 *
 * 会创建一个测试会话并触发一次模型调用（消耗少量额度），结束后删除会话。
 */
import { readFileSync } from "node:fs";

const port = Number(process.env.KERNEL_PORT ?? "49546");
const password = readFileSync(".local/kernel-password.txt", "utf8").trim();
const auth = `Basic ${Buffer.from(`codearts:${password}`).toString("base64")}`;
const directory = process.cwd();
const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (t, n = 900) => (t.length <= n ? t : `${t.slice(0, n)}…`);

async function call(method, p, body) {
  const sep = p.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30000).unref?.();
  const res = await fetch(`${base}${p}${sep}directory=${encodeURIComponent(directory)}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: ctrl.signal,
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

const created = await call("POST", "/session", { title: "qqbot-question-probe" });
const id = JSON.parse(created.text).id;
console.log(`[probe] session=${id}`);

void subscribe();
await wait(700);

void call("POST", `/session/${id}/message`, {
  parts: [
    {
      type: "text",
      text: "请立即调用 question 工具，向我提问：'选择下一步操作'，提供两个选项：A 继续，B 停止。不要直接回答，必须先调用工具。",
    },
  ],
  model: { providerID: "inferhub-provider", modelID: "deepseek-v4.1-flash-1017" },
  agent: "build",
})
  .then((sent) => {
    console.log(`[probe] message -> ${sent.status} ${clip(sent.text.replace(/\s+/g, " "), 400)}`);
  })
  .catch((err) => {
    console.log(`[probe] message pending/aborted: ${err instanceof Error ? err.message : String(err)}`);
  });

await wait(15000);

const questionEvents = events.filter((e) => typeof e.type === "string" && e.type.includes("question"));
console.log(`[probe] question events=${questionEvents.length}`);
for (const e of questionEvents.slice(0, 6)) console.log(`  ${clip(JSON.stringify(e), 900)}`);

const messages = await call("GET", `/session/${id}/message`);
let parsed = [];
try {
  parsed = JSON.parse(messages.text);
} catch {
  // ignore
}
for (const m of parsed) {
  for (const part of m.parts ?? []) {
    if (part.tool === "question" || part.type === "question" || (part.state?.input?.questions !== undefined)) {
      console.log(`[probe] part role=${m.info?.role} tool=${part.tool ?? part.type} state=${clip(JSON.stringify(part.state ?? part), 1000)}`);
    }
  }
}

const list = await call("GET", "/question");
console.log(`[probe] GET /question -> ${list.status} ${clip(list.text, 1200)}`);

await call("DELETE", `/session/${id}`);
console.log("[probe] done");
process.exit(0);