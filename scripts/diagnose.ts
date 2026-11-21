/**
 * 端到端诊断：内核发现 → 健康检查 → 口令状态。
 *
 *   npx tsx scripts/diagnose.ts
 *   npx tsx scripts/diagnose.ts --password <kernel-password>
 */
import { createConsoleLogger } from "@codearts-qqbot/core";
import { HttpKernelPort } from "@codearts-qqbot/kernel-port";
import { discoverKernel } from "../packages/vscode-extension/src/kernel-discovery.js";

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const logger = createConsoleLogger("info");
const discovered = discoverKernel();

if (discovered === undefined) {
  console.log("[diagnose] 未发现内核：~/.codeartsdoer/CodeArts_Agent/*/server_config.properties 不存在");
  console.log("[diagnose] 请先启动码道并完成一次对话，让内核被拉起");
  process.exit(1);
}

console.log(`[diagnose] kernel baseUrl=${discovered.baseUrl} version=${discovered.version} pid=${discovered.pid}`);

const password = argOf("--password") ?? process.env.QQBOT_KERNEL_PASSWORD;
const port = new HttpKernelPort({
  baseUrl: discovered.baseUrl,
  directory: process.cwd(),
  logger,
  ...(password === undefined ? {} : { basicAuth: { username: "codearts", password } }),
});

try {
  const healthy = await port.health();
  console.log(`[diagnose] health=${healthy ? "OK" : "FAIL"}`);

  if (healthy) {
    const info = await port.info();
    console.log(`[diagnose] version=${info.version} agents=${info.agentIds.length} providers=${info.providers.length}`);
    console.log("[diagnose] 内核连接可用，可以直接启动 sidecar");
  } else if (password === undefined) {
    console.log("[diagnose] 结论：缺少内核口令（401）。方案 A 需要官方接口或手动录入口令。");
    console.log("[diagnose] 手动验证：npx tsx scripts/diagnose.ts --password <口令>");
    process.exitCode = 2;
  } else {
    console.log("[diagnose] 结论：口令不正确或内核拒绝访问");
    process.exitCode = 3;
  }
} catch (err) {
  const code = (err as { code?: string }).code ?? "unknown";
  const message = err instanceof Error ? err.message : String(err);
  console.log(`[diagnose] error code=${code} message=${message}`);
  if (code === "QB-1001") {
    console.log("[diagnose] 结论：内核返回 401，需要 Basic Auth 口令");
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
} finally {
  await port.close();
}