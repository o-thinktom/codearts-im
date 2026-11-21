import { defaultIpcPath } from "@codearts-qqbot/ipc";
import { runSidecar } from "../sidecar.js";

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const ipcToken = argOf("--ipc-token") ?? process.env.QQBOT_IPC_TOKEN;
if (ipcToken === undefined || ipcToken.length === 0) {
  console.error("[sidecar] missing --ipc-token");
  process.exit(2);
}

const ipcPath = argOf("--ipc-pipe") ?? process.env.QQBOT_IPC_PIPE ?? defaultIpcPath("vscode");
const workspace = argOf("--workspace") ?? process.env.CODEARTS_QQBOT_WORKSPACE ?? process.cwd();

console.log(`[sidecar] starting ipc=${ipcPath} workspace=${workspace}`);

runSidecar({ ipcToken, ipcPath, workspace })
  .then((handle) => {
    console.log("[sidecar] ready");
    const shutdown = async (): Promise<void> => {
      await handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  })
  .catch((err: unknown) => {
    console.error("[sidecar] fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });