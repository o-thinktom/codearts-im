import { pathToFileURL } from "node:url";
import { AccessController, MemoryAccessStore, createConsoleLogger } from "@codearts-qqbot/core";
import { MockKernelPort } from "@codearts-qqbot/kernel-port";
import { QqbotApp } from "./gateway.js";
import { MemoryPrefsStore, SessionRegistry } from "./session/registry.js";
import { MockImTransport, MockInboundSource } from "./transport/outbound-types.js";
import { normalizeConfig } from "./config.js";

/**
 * 本地演示：mock 内核 + mock QQ，用于验证装配链路是否闭环。
 * 真实 QQ 与真实内核在 P1 接入，装配代码不变。
 */
export async function runDemo(): Promise<{ replies: string[] }> {
  const logger = createConsoleLogger("info");
  const kernel = new MockKernelPort({
    responder: (prompt) => ({ text: `收到：${prompt}` }),
    logger,
  });
  const transport = new MockImTransport();
  const source = new MockInboundSource();
  const access = new AccessController(new MemoryAccessStore());
  const registry = new SessionRegistry({
    port: kernel,
    prefs: new MemoryPrefsStore("demo-app"),
    appId: "demo-app",
    workspace: process.cwd(),
    logger,
  });

  const app = new QqbotApp({
    port: kernel,
    transport,
    source,
    access,
    registry,
    logger,
    config: normalizeConfig({ appId: "demo-app", workspace: process.cwd() }),
  });

  await app.start();
  await app.handleInbound({
    scope: "c2c",
    peerId: "demo-user",
    senderId: "demo-user",
    text: "你好，介绍一下你自己",
    mentioned: false,
    messageId: "m-1",
    timestamp: Date.now(),
  });
  await app.stop();

  return { replies: transport.sent.map((s) => s.text) };
}

const entry = process.argv[1];
const isEntry = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isEntry) {
  runDemo()
    .then(({ replies }) => {
      console.log("--- demo replies ---");
      for (const r of replies) console.log(r);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}