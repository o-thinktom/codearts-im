/**
 * sidecar 启动状态机验证：模拟扩展下发凭据与内核连接。
 *
 *   npx tsx scripts/verify-sidecar.ts
 *
 * 预期：能看到 credentials/kernel 接收日志，并因内核不可达而退出，
 * 而不是报 "missing kernel or credentials"。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { IpcClient, defaultIpcPath } from "@codearts-qqbot/ipc";

const exe = path.resolve("packages/vscode-extension/bin/qqbot-sidecar-win32-x64.exe");
const token = randomUUID();
const pipe = defaultIpcPath(`verify-${process.pid}`);

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

const client = new IpcClient({ path: pipe, token, timeoutMs: 5000 });
try {
  await client.connect();
  await client.authenticate();
  await client.request("credentials.set", { appId: "test-app", appSecret: "test-secret" });
  await client.request("kernel.set", { baseUrl: "http://127.0.0.1:1", source: "manual" });
  await wait(4000);
} catch (err) {
  console.log(`[verify] ipc error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  client.close();
  child.kill();
}

await wait(500);

const receivedCreds = output.includes("qq credentials received");
const receivedKernel = output.includes("kernel connection received");
const missing = output.includes("missing kernel or credentials");

console.log(
  `[verify] creds=${receivedCreds} kernel=${receivedKernel} missingState=${missing} → ${
    receivedCreds && receivedKernel && !missing ? "PASS" : "FAIL"
  }`,
);
process.exit(receivedCreds && receivedKernel && !missing ? 0 : 1);