/**
 * IPC 手动验证：启动 sidecar 侧服务端，模拟扩展下发一次 kernel.set。
 *
 *   npm run ipc:probe
 */
import { randomUUID } from "node:crypto";
import { IpcClient, IpcServer, defaultIpcPath, type KernelConnection } from "@codearts-qqbot/ipc";

const tag = `probe-${process.pid}`;
const pipePath = defaultIpcPath(tag);
const token = randomUUID();

let connection: KernelConnection | undefined;
let resolveSet: ((value: KernelConnection) => void) | undefined;
const setPromise = new Promise<KernelConnection>((resolve) => {
  resolveSet = resolve;
});

const server = new IpcServer({
  path: pipePath,
  token,
  handlers: {
    kernelGet: () => connection,
    onKernelSet: (c) => {
      connection = c;
      console.log(`[ipc] kernel.set received: ${c.baseUrl} source=${c.source} auth=${c.basicAuth === undefined ? "no" : "yes"}`);
      resolveSet?.(c);
    },
    statusGet: () => ({ online: true }),
  },
});

await server.start();
console.log(`[ipc] listening ${pipePath}`);

const client = new IpcClient({ path: pipePath, token, timeoutMs: 5000 });
await client.connect();
await client.authenticate();
console.log(`[ipc] auth ok; ping=${JSON.stringify(await client.request("ipc.ping"))}`);

await client.request("kernel.set", {
  baseUrl: "http://127.0.0.1:20553",
  source: "manual",
});
await setPromise;
console.log(`[ipc] kernel.get=${JSON.stringify(await client.request("kernel.get"))}`);
console.log(`[ipc] status.get=${JSON.stringify(await client.request("status.get"))}`);

client.close();
await server.close();
console.log("[ipc] done");