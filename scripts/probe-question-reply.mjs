/**
 * 确认 question 应答格式：复用已挂起的问题，依次尝试不同 answers 结构。
 *
 *   KERNEL_PORT=55513 node scripts/probe-question-reply.mjs
 */
import { readFileSync } from "node:fs";

const port = Number(process.env.KERNEL_PORT ?? "55513");
const password = readFileSync(".local/kernel-password.txt", "utf8").trim();
const auth = `Basic ${Buffer.from(`codearts:${password}`).toString("base64")}`;
const directory = process.cwd();
const base = `http://127.0.0.1:${port}`;
const clip = (t, n = 400) => (t.length <= n ? t : `${t.slice(0, n)}…`);

async function call(method, p, body) {
  const sep = p.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20000).unref?.();
  const res = await fetch(`${base}${p}${sep}directory=${encodeURIComponent(directory)}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: ctrl.signal,
  });
  return { status: res.status, text: await res.text() };
}

const list = await call("GET", "/question");
console.log(`[reply] pending=${list.status} ${clip(list.text.replace(/\s+/g, " "), 300)}`);

let items = [];
try {
  items = JSON.parse(list.text);
} catch {
  items = [];
}
if (items.length === 0) {
  console.log("[reply] 没有待答问题");
  process.exit(0);
}

const target = items[0];
const label = target.questions?.[0]?.options?.[0]?.label ?? "A";
const candidates = [
  { answers: [label] },
  { answers: [{ value: label }] },
  { answers: [[label]] },
  { answer: label },
];
console.log(`[reply] target=${target.id} label=${JSON.stringify(label)}`);

for (const body of candidates) {
  const r = await call("POST", `/question/${target.id}/reply`, body);
  console.log(`[reply] ${JSON.stringify(body)} -> ${r.status} ${clip(r.text.replace(/\s+/g, " "), 300)}`);
  if (r.status === 200 || r.status === 204) break;
}

const after = await call("GET", "/question");
let remaining = [];
try {
  remaining = JSON.parse(after.text);
} catch {
  remaining = [];
}
console.log(`[reply] 剩余待答=${Array.isArray(remaining) ? remaining.length : "?"}`);
process.exit(0);