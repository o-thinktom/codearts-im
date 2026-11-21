/**
 * 抓取码道内核的 OpenAPI 契约并输出与 QQ Bot 相关的端点清单。
 *
 *   node scripts/kernel-contract.mjs
 *
 * 产出：
 *   docs/kernel-openapi.json   完整契约（可提交，不含凭据）
 *   docs/kernel-endpoints.md   端点清单（人工阅读）
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, createWriteStream, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const EXE =
  process.env.KERNEL_EXE ??
  path.join(HOME, ".codeartsdoer/CodeArts_Agent/AgentKernel_Vscode_26_11_100_126_11_1-20261110192452.exe");

const port = Number(process.env.KERNEL_PROBE_PORT ?? "20601");
const user = "codearts";
const pass = "probe123";
const root = path.join(os.tmpdir(), `codearts-kernel-contract-${port}`);
const workspace = process.cwd();

for (const d of ["data", "log", "config", "builtin", "state"]) {
  mkdirSync(path.join(root, d), { recursive: true });
}

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

async function get(path, accept = "application/json") {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: auth, "x-opencode-directory": workspace, accept },
      signal: ctrl.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

try {
  await wait(7000);
  const doc = await get("/doc", "application/json");
  console.log(`[contract] /doc -> ${doc.status} (${doc.text.length} bytes)`);
  if (doc.status !== 200) throw new Error(`/doc ${doc.status}`);

  const openapi = JSON.parse(doc.text);
  mkdirSync(path.join(workspace, "docs"), { recursive: true });
  writeFileSync(path.join(workspace, "docs/kernel-openapi.json"), JSON.stringify(openapi, null, 2));

  const paths = Object.keys(openapi.paths ?? {});
  console.log(`[contract] paths=${paths.length} openapi=${openapi.openapi} title=${openapi.info?.title} version=${openapi.info?.version}`);

  const interesting = paths.filter((p) =>
    /session|event|permission|agent|model|message|im\/|skill|command|file/i.test(p),
  );

  const lines = [
    "# 码道内核端点清单（由 OpenAPI 生成）",
    "",
    `- openapi: ${openapi.openapi}`,
    `- title: ${openapi.info?.title}`,
    `- version: ${openapi.info?.version}`,
    `- paths: ${paths.length}`,
    "",
    "| 方法 | 路径 | operationId | 摘要 |",
    "|---|---|---|---|",
  ];

  for (const p of interesting.sort()) {
    const item = openapi.paths[p];
    for (const method of Object.keys(item)) {
      const op = item[method];
      if (typeof op !== "object" || op === null) continue;
      lines.push(`| ${method.toUpperCase()} | \`${p}\` | ${op.operationId ?? ""} | ${(op.summary ?? "").replace(/\|/g, "\\|")} |`);
    }
  }

  writeFileSync(path.join(workspace, "docs/kernel-endpoints.md"), lines.join("\n"));

  console.log("[contract] 相关端点：");
  for (const p of interesting.sort()) {
    const methods = Object.keys(openapi.paths[p])
      .map((m) => m.toUpperCase())
      .filter((m) => ["GET", "POST", "PATCH", "DELETE", "PUT"].includes(m));
    if (methods.length === 0) continue;
    const ids = methods
      .map((m) => openapi.paths[p][m.toLowerCase()]?.operationId)
      .filter(Boolean);
    console.log(`  ${methods.join(",").padEnd(12)} ${p}  ${ids.join(", ")}`);
  }
} catch (err) {
  console.log("[contract] 失败：", err instanceof Error ? err.message : String(err));
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Get-Content -Tail 15 '${logFile.replace(/'/g, "''")}'`], {
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