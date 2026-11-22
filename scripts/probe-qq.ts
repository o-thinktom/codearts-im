/**
 * 真实 QQ 连通性探针。
 *
 * 用法（不要把密钥写进文件）：
 *   QQBOT_APPID=xxx QQBOT_SECRET=yyy npm run probe:qq
 *   QQBOT_APPID=xxx QQBOT_SECRET=yyy npm run probe:qq -- --listen 30
 *
 * 只打印事件类型与掩码后的标识，不打印消息正文与凭据。
 */
import { createConsoleLogger } from "@codearts-qqbot/core";
import { QqApi, QqInboundSource } from "@codearts-qqbot/runtime";

const appId = process.env.QQBOT_APPID;
const appSecret = process.env.QQBOT_SECRET;

if (appId === undefined || appSecret === undefined) {
  console.error("缺少 QQBOT_APPID / QQBOT_SECRET 环境变量");
  process.exit(2);
}

const listenIndex = process.argv.indexOf("--listen");
const listenSec = listenIndex >= 0 ? Number(process.argv[listenIndex + 1] ?? 20) : 0;

const mask = (id: string): string => (id.length <= 8 ? id : `${id.slice(0, 4)}***${id.slice(-2)}`);

const logger = createConsoleLogger(process.env.CODEARTS_IM_DEBUG === "1" ? "debug" : "info");
const api = new QqApi({ appId, appSecret, logger });

const probe = await api.probe();
console.log(`[probe] token=${probe.tokenOk ? "ok" : "fail"} gateway=${probe.gatewayOk ? "ok" : "fail"}`);

if (listenSec > 0 && probe.gatewayOk) {
  const source = new QqInboundSource({ api, logger });
  source.onMessage((m) => {
    console.log(
      `[message] scope=${m.scope} peer=${mask(m.peerId)} sender=${mask(m.senderId)} ` +
        `attachments=${m.attachments?.length ?? 0} len=${m.text.length}`,
    );
  });
  await source.start();
  console.log(`[listen] ${listenSec}s，请在 QQ 中给机器人发消息（沙箱白名单内）`);
  await new Promise((r) => setTimeout(r, listenSec * 1000));
  console.log(`[listen] connected=${source.connected}`);
  await source.stop();
}

process.exit(probe.tokenOk && probe.gatewayOk ? 0 : 1);