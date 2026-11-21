/**
 * 启动一个隔离的码道内核沙盒实例并探测端点。
 *
 * 目的：不干扰正在运行的码道（不同端口 + 独立数据目录），
 * 用一个已知的 Basic Auth 口令验证端点契约。
 *
 *   node scripts/kernel-sandbox.mjs
 *   node scripts/kernel-sandbox.mjs --port 20601 --events 5
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { argv } from "node:process";

const HOME = os.homedir();
const EXE =
  process.env.KERNEL_EXE ??
  path.join(
    HOME,
    ".codeartsdoer/CodeArts_Agent/AgentKernel_Vscode_26_11_100_126_11_1-20261110192452.exe",
  );

const getArg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : (argv[i + 1] ?? fallback);
};

const port = Number(getArg("--port", "20600"));
const eventSeconds = Number(getArg("--events", "0"));
const user = getArg("--user", "codearts");
const pass = getArg("--pass", "probe123");
const workspace = getArg("--dir", process.cwd());
const root = path.join(os.tmpdir(), `codearts-kernel-probe-${port}`);

mkdirSync(path.join(root, "data"), { recursive: true });
mkdirSync(path.join(root, "log"), { recursive: true });
mkdirSync(path.join(root, "config"), { recursive: true });
mkdirSync(path.join(root, "builtin"), { recursive: true });

const logFile = path.join(root, "kernel.log");
const logStream = createWriteStream(logFile, { flags: "a" });

const env = {
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
};

mkdirSync(path.join(root, "state"), { recursive: true });

console.log(`[sandbox] exe=${EXE}`);
console.log(`[sandbox] port=${port} data=${root} log=${logFile}`);

const child = spawn(EXE, [`--port=${port}`, "serve"], {
  env,
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

child.stdout.pipe(logStream);
child.stderr.pipe(logStream);

let exited = false;
child.on("exit", (code, signal) => {
  exited = true;
  console.log(`[sandbox] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
});

const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const base = `http://127.0.0.1:${port}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(path, accept = "application/json") {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: auth, "x-opencode-directory": workspace, accept },
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: text };
  } catch (err) {
    return { status: "ERR", type: "", body: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const clip = (t, n = 260) => (t.length <= n ? t : `${t.slice(0, n)}…`);

try {
  await wait(7000);
  if (exited) {
    console.log("[sandbox] 内核提前退出，日志尾部：");
    execFileSync("powershell", ["-NoProfile", "-Command", `Get-Content -Tail 20 '${logFile.replace(/'/g, "''")}'`], {
      stdio: "inherit",
    });
    process.exit(1);
  }

  const info = await probe("/api/info");
  console.log(`[sandbox] /api/info ${info.status} ${clip(info.body.replace(/\s+/g, " "))}`);

  if (info.status === 200) {
    const endpoints = ["/api/agent", "/session", "/session/active", "/v1/skill", "/cag/agent", "/cag/rules", "/doc", "/openapi.json", "/config"];
    for (const p of endpoints) {
      const r = await probe(p);
      console.log(`[sandbox] ${String(r.status).padEnd(4)} ${p.padEnd(18)} ${clip(r.body.replace(/\s+/g, " ").trim(), 180)}`);
    }

    if (eventSeconds > 0) {
      console.log(`[sandbox] 采样 /event ${eventSeconds}s`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), eventSeconds * 1000);
      try {
        const res = await fetch(`${base}/event`, {
          headers: { authorization: auth, "x-opencode-directory": workspace, accept: "text/event-stream" },
          signal: ctrl.signal,
        });
        console.log(`[sandbox] /event ${res.status} ${res.headers.get("content-type") ?? ""}`);
        if (res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let frames = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx = buf.indexOf("\n\n");
            while (idx >= 0) {
              frames += 1;
              console.log(`[event#${frames}] ${clip(buf.slice(0, idx).replace(/\s+/g, " "), 260)}`);
              buf = buf.slice(idx + 2);
              idx = buf.indexOf("\n\n");
              if (frames >= 10) break;
            }
            if (frames >= 10) break;
          }
          console.log(`[sandbox] 事件帧数 ${frames}`);
        }
      } catch (err) {
        console.log(`[sandbox] 事件采样结束 ${err instanceof Error ? err.name : ""}`);
      } finally {
        clearTimeout(timer);
      }
    }
  } else {
    console.log("[sandbox] 认证未通过，日志尾部：");
    execFileSync("powershell", ["-NoProfile", "-Command", `Get-Content -Tail 25 '${logFile.replace(/'/g, "''")}'`], {
      stdio: "inherit",
    });
  }
} finally {
  try {
    execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // 已退出
  }
  logStream.end();
  await wait(500);
}