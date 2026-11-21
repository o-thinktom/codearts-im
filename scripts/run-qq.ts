/**
 * 真实 QQ + 真实内核联调入口（方案 A）。
 *
 * 模式：
 *   auto（默认）：等待扩展通过 IPC 下发内核连接，然后使用 HttpKernelPort
 *   mock        ：使用 MockKernelPort，仅验证 QQ 链路
 *
 *   QQBOT_APPID=xxx QQBOT_SECRET=yyy npm run run:qq
 *   QQBOT_KERNEL_MODE=mock QQBOT_APPID=xxx QQBOT_SECRET=yyy npm run run:qq
 *
 * 由扩展拉起时会注入：
 *   QQBOT_IPC_PIPE / --ipc-pipe
 *   QQBOT_IPC_TOKEN / --ipc-token
 */
import { randomUUID } from "node:crypto";
import { AccessController, MemoryAccessStore, createConsoleLogger } from "@codearts-qqbot/core";
import { IpcServer, defaultIpcPath, type KernelConnection } from "@codearts-qqbot/ipc";
import { HttpKernelPort, MockKernelPort, type KernelPort } from "@codearts-qqbot/kernel-port";
import {
  MemoryPrefsStore,
  QqApi,
  QqImTransport,
  QqInboundSource,
  QqbotApp,
  SessionRegistry,
  normalizeConfig,
} from "@codearts-qqbot/runtime";

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const appId = process.env.QQBOT_APPID;
const appSecret = process.env.QQBOT_SECRET;
if (appId === undefined || appSecret === undefined) {
  console.error("缺少 QQBOT_APPID / QQBOT_SECRET 环境变量");
  process.exit(2);
}

const mode = process.env.QQBOT_KERNEL_MODE ?? "auto";
const logger = createConsoleLogger(process.env.QQBOT_DEBUG === "1" ? "debug" : "info");
const workspace = process.cwd();

let ipc: IpcServer | undefined;
let kernel: KernelPort;

if (mode === "mock") {
  kernel = new MockKernelPort({
    logger,
    responder: (prompt) => ({ text: `【mock 内核】收到 ${prompt.length} 字：\n${prompt.slice(0, 500)}` }),
  });
  console.log("[run:qq] kernel=mock");
} else {
  const pipePath = argOf("--ipc-pipe") ?? process.env.QQBOT_IPC_PIPE ?? defaultIpcPath("vscode");
  const token = argOf("--ipc-token") ?? process.env.QQBOT_IPC_TOKEN ?? randomUUID();

  let connection: KernelConnection | undefined;
  let resolveConnection: ((c: KernelConnection) => void) | undefined;
  const connectionReady = new Promise<KernelConnection>((resolve) => {
    resolveConnection = resolve;
  });

  ipc = new IpcServer({
    path: pipePath,
    token,
    handlers: {
      kernelGet: () => connection,
      onKernelSet: (c) => {
        connection = c;
        logger.info("kernel connection received", { baseUrl: c.baseUrl, hasAuth: c.basicAuth !== undefined });
        resolveConnection?.(c);
      },
      statusGet: () => ({
        online: kernel !== undefined,
        kernel: connection?.baseUrl ?? null,
      }),
    },
  });

  await ipc.start();
  console.log(`[run:qq] 等待扩展下发内核连接（pipe=${pipePath}）`);

  const timeout = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 15000);
    timer.unref?.();
  });

  const conn = await Promise.race([connectionReady, timeout]);
  if (conn === undefined) {
    console.error("[run:qq] 15s 内未收到 kernel.set，请先启动扩展或改用 QQBOT_KERNEL_MODE=mock");
    await ipc.close();
    process.exit(3);
  }

  kernel = new HttpKernelPort({
    baseUrl: conn.baseUrl,
    directory: workspace,
    logger,
    ...(conn.basicAuth === undefined ? {} : { basicAuth: conn.basicAuth }),
  });

  const healthy = await kernel.health();
  console.log(`[run:qq] kernel=${conn.baseUrl} health=${healthy ? "ok" : "fail"}`);
  if (!healthy) {
    console.error("[run:qq] 内核不可用（可能是缺少 Basic Auth 口令）");
    await ipc.close();
    process.exit(4);
  }
}

const api = new QqApi({ appId, appSecret, logger });
const transport = new QqImTransport(api);
const source = new QqInboundSource({ api, logger });
const access = new AccessController(new MemoryAccessStore());
const registry = new SessionRegistry({
  port: kernel,
  prefs: new MemoryPrefsStore(appId),
  appId,
  workspace,
  logger,
});

const app = new QqbotApp({
  port: kernel,
  transport,
  source,
  access,
  registry,
  logger,
  config: normalizeConfig({
    appId,
    workspace,
    access: { c2cMode: "open", groupMode: "open", commandMode: "open" },
  }),
});

await app.start();
console.log("[run:qq] 已启动：私聊或在群里 @ 机器人即可；Ctrl+C 退出");

const shutdown = async (): Promise<void> => {
  console.log("\n[run:qq] 正在退出…");
  await app.stop();
  await ipc?.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const exitIdx = process.argv.indexOf("--exit-after");
if (exitIdx >= 0) {
  const seconds = Number(process.argv[exitIdx + 1] ?? 0);
  if (Number.isFinite(seconds) && seconds > 0) {
    setTimeout(() => void shutdown(), seconds * 1000).unref();
  }
}