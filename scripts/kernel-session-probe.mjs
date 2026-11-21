/**
 * 实测内核 session 生命周期与事件流（隔离沙盒实例）。
 *
 *   node scripts/kernel-session-probe.mjs
 *
 * 只创建一条测试会话，用于校准事件名与字段，不落业务数据。
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const EXE =
  process.env.KERNEL_EXE ??
  path.join(HOME, ".codeartsdoer/CodeArts_Agent/AgentKernel_Vscode_26_11_100_126_11_1-20261110192452.exe");

const port = Number(process.env.KERNEL_PROBE_PORT ?? "20602");
const user = "codearts";
const pass = "probe123";
const root = path.join(os.tmpdir(), `codearts-kernel-session-${port}`);
const workspace = process.cwd();

for (const d of ["data", "log", "config", "builtin", "state"]) mkdirSync(path.join(root, d), { recursive: true });

const logFile = path.join(root, "kernel.log");
const logStream = createWriteStream(logFile, { flags: "a" });

const child = spawn(EXE, [`--port=${port}`, "serve"], {
  env: {
    ...process.env,
    OPENCODE_SERVER_USERNAME: user,
    OPENCODE_SERVER_PASSWORD: pass,
    KERNEL_DATA_DIR: path.join(root, "data"),
    KERNEL_LOG_DIR: path.join(root, "log"),
    KERNEL_STATE_DIR: path.join(root, "state"),
    KERNEL_CONFIG_DIR: path.join(root, "config"),
    BUILT_IN_CONFIG_DIR: path.join(root, "builtin"),
    IDE: "vscode",
    IS_PROD: "true",
    PLUGIN_ENV: "hc",
  },
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);

const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (t, n = 300) => (t.length <= n ? t : `${t.slice(0, n)}…`);

const headers = () => ({
  authorization: auth,
  "content-type": "application/json",
  "x-opencode-directory": workspace,
  accept: "application/json",
});

async function call(method, p, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${base}${p}?directory=${encodeURIComponent(workspace)}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: "ERR", text: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const events = [];
let sseStatus = "none";

async function subscribe() {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 25000).unref?.();
  try {
    const res = await fetch(`${base}/event?directory=${encodeURIComponent(workspace)}`, {
      headers: { authorization: auth, accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    sseStatus = String(res.status);
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
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data.length > 0 && data !== "[DONE]") {
          try {
            events.push(JSON.parse(data));
          } catch {
            events.push({ type: "__raw__", raw: clip(data, 200) });
          }
        }
        idx = buf.indexOf("\n\n");
      }
      if (events.length >= 40) break;
    }
  } catch {
    // abort 正常
  }
}

try {
  await wait(7000);
  const sub = subscribe();
  await wait(500);

  const created = await call("POST", "/session", { title: "qqbot-probe" });
  console.log(`[session] POST /session -> ${created.status} ${clip(created.text.replace(/\s+/g, " "), 500)}`);

  let sessionId = "";
  try {
    const parsed = JSON.parse(created.text);
    sessionId = parsed.id ?? parsed.session?.id ?? "";
  } catch {
    // ignore
  }

  if (sessionId) {
    const detail = await call("GET", `/session/${sessionId}`);
    console.log(`[session] GET /session/{id} -> ${detail.status} ${clip(detail.text.replace(/\s+/g, " "), 300)}`);

    for (const p of [`/session/${sessionId}/prompt`, `/session/${sessionId}/message`]) {
      const r = await call("POST", p, { parts: [{ type: "text", text: "ping" }] });
      console.log(`[session] POST ${p.replace(sessionId, "{id}")} -> ${r.status} ${clip(r.text.replace(/\s+/g, " "), 300)}`);
      if (r.status === 200 || r.status === 204) break;
    }
  }

  await wait(6000);
  console.log(`[events] SSE status=${sseStatus} frames=${events.length}`);
  const kinds = new Map();
  for (const e of events) {
    const key = e.type ?? e.event ?? "__unknown__";
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)} x ${k}`);
  }
  const samples = events.filter((e) => ["session.created", "session.updated", "message.updated", "message.part.updated", "session.idle"].includes(e.type));
  for (const s of samples.slice(0, 4)) {
    console.log(`[sample] ${clip(JSON.stringify(s), 700)}`);
  }

  await sub.catch(() => undefined);
} catch (err) {
  console.log("[probe] 失败：", err instanceof Error ? err.message : String(err));
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Get-Content -Tail 20 '${logFile.replace(/'/g, "''")}'`], {
      stdio: "inherit",
    });
  } catch {
    // ignore
  }
  process.exitCode = 1;
} finally {
  try {
    execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // already exited
  }
  logStream.end();
  await wait(300);
}