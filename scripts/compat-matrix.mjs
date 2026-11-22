/**
 * 码道内核兼容性矩阵。
 *
 *   npm run compat            # 只读 + 创建/删除测试会话
 *   npm run compat -- --with-prompt   # 额外触发一次真实推理（消耗额度）
 *   npm run compat -- --im qq,weixin,wecom   # 仅校验指定通道能力表（默认全部）
 *
 * 输出 compat-matrix.json；核心用例失败时退出码为 1，未发现内核时为 2。
 * 用于每次码道升级后回归，避免契约变化把链路打回原点。
 */
import { createDecipheriv, scryptSync } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const KERNEL_ROOT = path.join(HOME, ".codeartsdoer", "CodeArts_Agent");
const dataDir = process.env.KERNEL_DATA_DIR ?? path.join(HOME, ".codeartsdoer", "codearts-data");
const withPrompt = process.argv.includes("--with-prompt");
const directory = process.cwd();

const IM_CHANNELS = ["qq", "weixin", "wecom"];
const imFlag = process.argv.indexOf("--im");
const imRaw = imFlag >= 0 ? process.argv[imFlag + 1] : undefined;
const imChannels = (() => {
  if (imRaw === undefined || imRaw === "all") return [...IM_CHANNELS];
  const list = imRaw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
  const invalid = list.filter((v) => !IM_CHANNELS.includes(v));
  if (invalid.length > 0) {
    console.error(`[compat] 未知 IM 渠道：${invalid.join(",")}（可选 ${IM_CHANNELS.join("/")}）`);
    process.exit(2);
  }
  return [...new Set(list)];
})();

const toBuf = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (Array.isArray(value)) return Buffer.from(value);
  if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
  throw new Error("unknown buffer shape");
};

function decryptPassword() {
  const files = {
    secret: path.join(dataDir, "4", "data"),
    meta: path.join(dataDir, "1", "data"),
    salt: path.join(dataDir, "2", "data"),
    iv: path.join(dataDir, "3", "data"),
    cipher: path.join(dataDir, "custom-dir", "data"),
  };
  for (const file of Object.values(files)) if (!existsSync(file)) return undefined;
  const secret = Buffer.from(readFileSync(files.secret, "utf8").trim(), "base64").toString("utf8");
  const meta = JSON.parse(readFileSync(files.meta, "utf8"));
  if (meta.algorithm !== "aes-256-gcm") return undefined;
  const key = scryptSync(secret, toBuf(JSON.parse(readFileSync(files.salt, "utf8"))), 32, {
    N: 65536,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, toBuf(JSON.parse(readFileSync(files.iv, "utf8"))));
  const cipher = JSON.parse(readFileSync(files.cipher, "utf8"));
  decipher.setAuthTag(toBuf(cipher.authTag));
  const plain = Buffer.concat([decipher.update(toBuf(cipher.ciphertext)), decipher.final()]).toString("utf8");
  return plain.length > 0 ? plain : undefined;
}

function candidates() {
  const out = [];
  let dirs;
  try {
    dirs = readdirSync(KERNEL_ROOT)
      .filter((d) => d.startsWith("Vscode_"))
      .map((d) => ({ d, t: statSync(path.join(KERNEL_ROOT, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return out;
  }
  for (const { d } of dirs) {
    try {
      const text = readFileSync(path.join(KERNEL_ROOT, d, "server_config.properties"), "utf8");
      const port = Number(/port=(\d+)/.exec(text)?.[1] ?? 0);
      const version = /version=([^\r\n]+)/.exec(text)?.[1]?.trim() ?? "unknown";
      if (port > 0) out.push({ port, version, dir: d });
    } catch {
      // 跳过
    }
  }
  return out;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const password = decryptPassword();
if (password === undefined) {
  console.error("[compat] 无法解密内核口令（KERNEL_DATA_DIR 或加密格式变化）");
  process.exit(2);
}

let target;
for (const c of candidates()) {
  if (await canConnect(c.port)) {
    target = c;
    break;
  }
}
if (target === undefined) {
  console.error("[compat] 未发现运行中的内核；请先启动码道并完成一次对话");
  process.exit(2);
}

const auth = `Basic ${Buffer.from(`codearts:${password}`).toString("base64")}`;
const base = `http://127.0.0.1:${target.port}`;
const headers = { authorization: auth, "content-type": "application/json", accept: "application/json" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const events = [];

async function call(method, p, body) {
  const sep = p.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${base}${p}${sep}directory=${encodeURIComponent(directory)}`, {
      method,
      headers,
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

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
}

async function subscribe(seconds) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), seconds * 1000).unref?.();
  try {
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
            // 忽略非 JSON 帧
          }
        }
        idx = buf.indexOf("\n\n");
      }
    }
  } catch {
    // abort 正常
  }
}

console.log(`[compat] kernel=${base} version=${target.version} withPrompt=${withPrompt}`);

const health = await call("GET", "/global/health");
record("health", health.status === 200, `${health.status}`);

const config = await call("GET", "/config");
record("config", config.status === 200, `${config.status}`);

const created = await call("POST", "/session", { title: "qqbot-compat" });
let sessionId = "";
try {
  sessionId = JSON.parse(created.text).id ?? "";
} catch {
  sessionId = "";
}
record("session.create", created.status === 200 && sessionId.length > 0, sessionId);

void subscribe(3);

if (withPrompt && sessionId) {
  const sent = await call("POST", `/session/${sessionId}/message`, {
    parts: [{ type: "text", text: "只回复两个字：收到" }],
    model: { providerID: "inferhub-provider", modelID: "deepseek-v4.1-flash-1017" },
    agent: "build",
  });
  record("message.send", sent.status === 200, `${sent.status}`);
  await wait(8000);
  const messages = await call("GET", `/session/${sessionId}/message`);
  let assistant = 0;
  try {
    assistant = JSON.parse(messages.text).filter((m) => m.info?.role === "assistant").length;
  } catch {
    assistant = 0;
  }
  record("message.assistant", assistant > 0, `assistant=${assistant}`);
} else {
  await wait(2000);
}

await wait(1500);
const types = [...new Set(events.map((e) => e.type))];
record("event.stream", types.length > 0, types.join(",") || "(none)");

const deleted = await call("DELETE", `/session/${sessionId}`);
record("session.delete", deleted.status === 200 || deleted.status === 204, `${deleted.status}`);

const capabilityPath = path.join(process.cwd(), "packages/qqbot-runtime/src/transport/capabilities.json");
let capabilityTable = {};
try {
  capabilityTable = JSON.parse(readFileSync(capabilityPath, "utf8"));
  record("capabilities.file", true, Object.keys(capabilityTable).join(","));
} catch (err) {
  record("capabilities.file", false, err instanceof Error ? err.message : String(err));
}

const channels = {};
for (const name of imChannels) {
  const c = capabilityTable?.[name];
  const valid =
    c !== undefined &&
    Number.isFinite(c.maxChars) &&
    c.maxChars > 0 &&
    Number.isFinite(c.maxFileBytes) &&
    c.maxFileBytes > 0 &&
    typeof c.streaming === "boolean" &&
    typeof c.typing === "boolean" &&
    typeof c.buttons === "boolean" &&
    ["base64", "cdn", "sdk"].includes(c.media);
  if (valid) channels[name] = c;
  record(`channel.${name}`, valid, valid ? `${c.media}/${c.maxChars}` : "invalid");
}

const report = {
  generatedAt: new Date().toISOString(),
  kernel: { baseUrl: base, version: target.version, dir: target.dir },
  withPrompt,
  im: imChannels,
  channels,
  results,
  events: types,
  ok: results.every((r) => r.ok),
};
writeFileSync(path.join(process.cwd(), "compat-matrix.json"), JSON.stringify(report, null, 2));

console.log(`[compat] 结果: ${report.ok ? "OK" : "FAILED"}（compat-matrix.json）`);
process.exit(report.ok ? 0 : 1);