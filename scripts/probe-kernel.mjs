/**
 * 码道内核端点只读探测。
 *
 *   node scripts/probe-kernel.mjs --port 20553 --dir <workspace>
 *   node scripts/probe-kernel.mjs --port 20553 --events 3
 *
 * 只做 GET / 只读采样，不创建会话、不写入任何数据。
 */
import { argv, exit } from "node:process";

const args = argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
};

const port = Number(getArg("--port", "20553"));
const host = getArg("--host", "127.0.0.1");
const dir = getArg("--dir", process.cwd());
const eventSeconds = Number(getArg("--events", "0"));
const user = getArg("--user", "");
const pass = getArg("--pass", "");
const base = `http://${host}:${port}`;

const headers = { "x-opencode-directory": dir, accept: "application/json" };
if (user.length > 0) {
  headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

const endpoints = [
  "/api/info",
  "/api/health",
  "/api/agent",
  "/session",
  "/session/active",
  "/v1/skill",
  "/v1/skills",
  "/cag/agent",
  "/cag/rules",
  "/cag/extension/list",
  "/doc",
  "/openapi.json",
  "/config",
  "/project",
];

const clip = (text, n = 400) => (text.length <= n ? text : `${text.slice(0, n)}…`);

async function probeOne(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${base}${path}`, { method: "GET", headers, signal: ctrl.signal });
    const text = await res.text();
    return { path, status: res.status, type: res.headers.get("content-type") ?? "", body: text };
  } catch (err) {
    return { path, status: "ERR", type: "", body: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`[probe] base=${base} dir=${dir}`);
console.log(`[probe] 尝试 ${endpoints.length} 个只读端点`);

const results = [];
for (const path of endpoints) {
  const r = await probeOne(path);
  results.push(r);
  const flag = r.status === 200 ? "OK  " : "----";
  console.log(`[${flag}] ${String(r.status).padEnd(4)} ${path.padEnd(22)} ${clip(r.body.replace(/\s+/g, " ").trim(), 220)}`);
}

const readable = results.filter((r) => r.status === 200).map((r) => r.path);
console.log(`[probe] 可用端点: ${readable.length > 0 ? readable.join(", ") : "(无)"}`);

if (eventSeconds > 0) {
  console.log(`[probe] 采样事件流 ${eventSeconds}s（只读）`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), eventSeconds * 1000);
  try {
    const res = await fetch(`${base}/event`, {
      method: "GET",
      headers: { ...headers, accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    console.log(`[events] status=${res.status} type=${res.headers.get("content-type") ?? ""}`);
    if (res.body !== null) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let frames = 0;
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          frames += 1;
          console.log(`[event#${frames}] ${clip(buf.slice(0, idx).replace(/\s+/g, " "), 300)}`);
          buf = buf.slice(idx + 2);
          idx = buf.indexOf("\n\n");
          if (frames >= 20) {
            ctrl.abort();
            break;
          }
        }
        if (frames >= 20) break;
      }
      console.log(`[events] 共 ${frames} 帧`);
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    console.log(`[events] 采样结束 (${name})`);
  } finally {
    clearTimeout(timer);
  }
}

exit(0);