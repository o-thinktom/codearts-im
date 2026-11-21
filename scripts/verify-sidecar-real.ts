/**
 * 真实链路验证：拉起 sidecar 可执行文件，模拟扩展下发凭据与内核连接。
 *
 *   QQBOT_APPID=... QQBOT_SECRET=... npx tsx scripts/verify-sidecar-real.ts
 *
 * 不发消息、不调用模型；只验证 sidecar 能否连上内核并进入运行态。
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { IpcClient, defaultIpcPath } from "@codearts-qqbot/ipc";
import { discoverKernel } from "../packages/vscode-extension/src/kernel-discovery.js";

const exe = path.resolve("packages/vscode-extension/bin/qqbot-sidecar-win32-x64.exe");
const secretFile = path.resolve(".local/kernel-password.txt");
const discovered = discoverKernel();

if (discovered === undefined) {
  console.error("[verify] 未发现内核，请先启动码道");
  process.exit(1);
}

const password = existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : undefined;
if (password === undefined || password.length === 0) {
  console.error("[verify] 缺少 .local/kernel-password.txt");
  process.exit(1);
}

const appId = process.env.QQBOT_APPID ?? "probe-app";
const appSecret = process.env.QQBOT_SECRET ?? "probe-secret";
const token = randomUUID();
const pipe = defaultIpcPath(`verify-real-${process.pid}`);

console.log(`[verify] kernel=${discovered.baseUrl} version=${discovered.version} appId=${appId.slice(0, 4)}***`);

const child = spawn(exe, ["--ipc-token", token, "--ipc-pipe", pipe, "--workspace", process.cwd()], {
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk: string) => {
  output += chunk;
  process.stderr.write(chunk);
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
await wait(2500);

const client = new IpcClient({ path: pipe, token, timeoutMs: 8000 });
try {
  await client.connect();
  await client.authenticate();
  await client.request("credentials.set", { appId, appSecret });
  await client.request("kernel.set", {
    baseUrl: discovered.baseUrl,
    basicAuth: { username: "codearts", password },
    source: "manual",
    version: discovered.version,
  });
  await wait(9000);

  const status = await client.request("status.get").catch(() => undefined);
  console.log(`[verify] status.get=${JSON.stringify(status)}`);
} catch (err) {
  console.log(`[verify] ipc error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  client.close();
  child.kill();
}

await wait(500);

console.log(
  `[verify] summary: running=${output.includes("sidecar running")} kernelReceived=${output.includes(
    "kernel connection received",
  )} credsReceived=${output.includes("qq credentials received")} fatal=${output.includes("fatal")}`,
);
process.exit(output.includes("sidecar running") ? 0 : 1);