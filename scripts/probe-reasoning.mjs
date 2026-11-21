/**
 * 思维链事件探测：确认 reasoning part 的增量是否会被误当作正文。
 *
 *   node scripts/probe-reasoning.mjs
 */
import { readFileSync } from "node:fs";

const port = Number(process.env.KERNEL_PORT ?? "55513");
const password = readFileSync(".local/kernel-password.txt", "utf8").trim();
const auth = `Basic ${Buffer.from(`codearts:${password}`).toString("base64")}`;
const directory = process.cwd();
const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (t, n = 300) => (t.length <= n ? t : `${t.slice(0, n)}…`);

async function call(method, p, body) {
  const sep = p.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 25000).unref?.();
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

const created = await call("POST", "/session", { title: "qqbot-reasoning-probe" });
const id = JSON.parse(created.text).id;
console.log(`[probe] session=${id}`);

void subscribe();
await wait(700);

void call("POST", `/session/${id}/message`, {
  parts: [{ type: "text", text: "请先推理再回答：17 * 23 等于多少？请展示简短思考过程，然后给出结果。" }],
  model: { providerID: "inferhub-provider", modelID: "deepseek-v4.1-flash-1017" },
  agent: "build",
}).catch((err) => console.log(`[probe] message pending/aborted: ${err instanceof Error ? err.message : String(err)}`));

await wait(15000);

const partTypes = new Map();
for (const e of events) {
  if (e.type === "message.part.updated" && e.properties?.part?.id !== undefined) {
    partTypes.set(e.properties.part.id, e.properties.part.type);
  }
}
console.log(`[probe] partTypes=${JSON.stringify([...partTypes.entries()].slice(0, 12))}`);

const deltas = events.filter((e) => e.type === "message.part.delta");
const byField = {};
for (const d of deltas) {
  const field = d.properties?.field ?? "?";
  byField[field] = (byField[field] ?? 0) + 1;
}
console.log(`[probe] delta fields=${JSON.stringify(byField)}`);
for (const d of deltas.slice(0, 5)) {
  const p = d.properties ?? {};
  console.log(
    `  partID=${clip(String(p.partID), 40)} field=${p.field} type=${partTypes.get(p.partID) ?? "?"} delta=${clip(String(p.delta), 60)}`,
  );
}

const messages = await call("GET", `/session/${id}/message`);
let parsed = [];
try {
  parsed = JSON.parse(messages.text);
} catch {
  parsed = [];
}
for (const m of parsed) {
  if (m.info?.role !== "assistant") continue;
  console.log(`[probe] assistant parts=${JSON.stringify((m.parts ?? []).map((p) => p.type))}`);
}

await call("DELETE", `/session/${id}`);
console.log("[probe] done");
process.exit(0);