/**
 * 触发方式对照实验：找出 126.11.2 下真正会启动推理的消息请求。
 *
 *   node scripts/probe-prompt.mjs
 *
 * 会创建 1 个测试会话，最多触发 3 次小请求（消耗极少量额度），结束后删除会话。
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const configFile = path.join(
  os.homedir(),
  ".codeartsdoer/CodeArts_Agent/Vscode_26_11_100-126_11_1-20261110192452/server_config.properties",
);
let port = Number(process.env.KERNEL_PORT ?? "0");
if (!port) {
  try {
    const text = readFileSync(configFile, "utf8");
    const m = /port=(\d+)/.exec(text);
    if (m) port = Number(m[1]);
  } catch {
    // ignore
  }
}
port = port || 22837;

const password = readFileSync(".local/kernel-password.txt", "utf8").trim();
const auth = `Basic ${Buffer.from(`codearts:${password}`).toString("base64")}`;
const directory = process.cwd();
const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body) {
  const sep = p.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20000).unref?.();
  const res = await fetch(`${base}${p}${sep}directory=${encodeURIComponent(directory)}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: ctrl.signal,
  });
  const text = await res.text();
  return { status: res.status, text };
}

const events = [];
async function subscribe() {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 120000).unref?.();
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

const created = await call("POST", "/session", { title: "qqbot-prompt-probe" });
console.log(`[probe] create -> ${created.status} ${created.text.slice(0, 200)}`);
const id = JSON.parse(created.text).id;
const model = { providerID: "inferhub-provider", modelID: "deepseek-v4.1-flash-1017" };

void subscribe();
await wait(600);

const attempts = [
  {
    name: "A message(parts only)",
    path: `/session/${id}/message`,
    body: { parts: [{ type: "text", text: "回复两个字：收到" }] },
  },
  {
    name: "B message(parts + model + agent)",
    path: `/session/${id}/message`,
    body: { parts: [{ type: "text", text: "回复两个字：收到" }], model, agent: "build" },
  },
  {
    name: "C prompt(parts + model)",
    path: `/session/${id}/prompt`,
    body: { parts: [{ type: "text", text: "回复两个字：收到" }], model },
  },
];

for (const a of attempts) {
  events.length = 0;
  const r = await call("POST", a.path, a.body);
  console.log(`\n[probe] ${a.name} -> ${r.status} ${r.text.slice(0, 200)}`);
  await wait(6000);

  const msgs = await call("GET", `/session/${id}/message`);
  let parsed = [];
  try {
    parsed = JSON.parse(msgs.text);
  } catch {
    // ignore
  }
  const roles = parsed.map((m) => `${m.info?.role}:${JSON.stringify(m.parts?.[0]?.text ?? m.parts?.[0]?.type ?? "").slice(0, 60)}`);
  console.log(`[probe] messages(${parsed.length}) ${roles.join(" | ").slice(0, 400)}`);
  console.log(`[probe] events(${events.length}) ${[...new Set(events.map((e) => e.type))].join(", ")}`);
}

await call("DELETE", `/session/${id}`);
console.log("\n[probe] cleanup done");
process.exit(0);