/**
 * 数字分身（/im/welink）参数语义验证。
 *
 * 官方扩展调用时 webserverPath = AgentKernel_*.exe（内核自身路径），
 * 本脚本用正确参数在不同 ideType 下探测错误码，判断是否存在通用扩展点。
 *
 *   node scripts/probe-welink.mjs
 *   PROBE_IDE_TYPES=qq-probe,welink,dingtalk node scripts/probe-welink.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, createWriteStream, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const EXE =
  process.env.KERNEL_EXE ??
  path.join(HOME, ".codeartsdoer/CodeArts_Agent/AgentKernel_Vscode_26_11_100_126_11_1-20261110192452.exe");

const port = Number(process.env.KERNEL_PROBE_PORT ?? "20603");
const root = path.join(os.tmpdir(), `codearts-welink-verify-${port}`);
for (const d of ["data", "log", "config", "builtin", "state"]) mkdirSync(path.join(root, d), { recursive: true });

const kernelLog = path.join(root, "kernel.log");
const logStream = createWriteStream(kernelLog, { flags: "a" });

const child = spawn(EXE, [`--port=${port}`, "serve"], {
  env: {
    ...process.env,
    OPENCODE_SERVER_USERNAME: "codearts",
    OPENCODE_SERVER_PASSWORD: "probe123",
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

const auth = `Basic ${Buffer.from("codearts:probe123").toString("base64")}`;
const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (t, n = 400) => (t.length <= n ? t : `${t.slice(0, n)}…`);

async function call(method, p, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctrl.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: "ERR", text: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const ideTypes = (process.env.PROBE_IDE_TYPES ?? "qq-probe,welink,dingtalk")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

try {
  await wait(7000);
  console.log(`[verify] sandbox ready; webserverPath=${EXE}`);

  for (const ideType of ideTypes) {
    const body = {
      appid: "probe-app",
      appsecret: "probe-secret",
      ideType,
      pluginName: "qq-probe-plugin",
      webserverPath: EXE,
      scenario: "probe",
      config: { workspace: root },
    };
    const started = await call("POST", "/im/welink/start", body);
    console.log(`\n[verify] ideType=${ideType} start -> ${started.status} ${clip(started.text.replace(/\s+/g, " "), 500)}`);

    await wait(1200);
    const status = await call("GET", `/im/welink/status/${encodeURIComponent(ideType)}?appid=probe-app`);
    console.log(`[verify] ideType=${ideType} status -> ${status.status} ${clip(status.text.replace(/\s+/g, " "), 400)}`);

    await call("POST", "/im/welink/stop", { ideType, appid: "probe-app", force: true });
  }

  const list = await call("GET", "/im/welink/list");
  console.log(`\n[verify] list -> ${list.status} ${clip(list.text.replace(/\s+/g, " "), 600)}`);

  const tail = readFileSync(kernelLog, "utf8").split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
  console.log(`\n[verify] kernel log tail:\n${tail}`);
} catch (err) {
  console.log(`[verify] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  try {
    execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // ignore
  }
  logStream.end();
  await wait(300);
}