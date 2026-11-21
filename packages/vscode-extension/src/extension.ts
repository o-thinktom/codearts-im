import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { defaultIpcPath, type AccessMutationResult, type KernelConnection } from "@codearts-qqbot/ipc";
import { KernelBridge } from "./bridge.js";
import { discoverKernel } from "./kernel-discovery.js";
import { decryptKernelSecret } from "./kernel-secret.js";
import { SidecarSupervisor, type SidecarStatus } from "./sidecar.js";
import { showBindPanel } from "./bind-panel.js";

let supervisor: SidecarSupervisor | undefined;
let bridge: KernelBridge | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let kernelSecretSource: "stored" | "auto" | "none" = "none";

const IPC_TAG = "vscode";

function describe(status: SidecarStatus): { text: string; tooltip: string; color?: string } {
  switch (status.state) {
    case "running":
      return { text: "$(radio-tower) QQ Bot", tooltip: "QQ Bot 运行中", color: undefined };
    case "starting":
      return { text: "$(sync~spin) QQ Bot", tooltip: "QQ Bot 正在启动", color: "statusBarItem.warningBackground" };
    case "failed":
      return {
        text: "$(error) QQ Bot",
        tooltip: `QQ Bot 异常：${status.detail ?? "未知原因"}（已重启 ${status.restarts} 次）`,
        color: "statusBarItem.errorBackground",
      };
    default:
      return { text: "$(circle-slash) QQ Bot", tooltip: "QQ Bot 已停止", color: undefined };
  }
}

function publishStatus(status: SidecarStatus): void {
  if (statusItem === undefined) return;
  const view = describe(status);
  statusItem.text = view.text;
  statusItem.tooltip = view.tooltip;
  statusItem.backgroundColor = view.color === undefined ? undefined : new vscode.ThemeColor(view.color);
  statusItem.show();
}

function log(message: string): void {
  output?.appendLine(message);
  if (vscode.workspace.getConfiguration("codeartsQqbot").get<boolean>("debug", false)) {
    output?.show(true);
  }
}

/**
 * 发现内核并把连接信息下发给 sidecar（方案 A）。
 *
 * 说明：内核 Basic Auth 口令由码道扩展持有、不落盘，第三方扩展无法读取；
 * 因此这里自动下发 baseUrl，口令需来自用户录入或官方接口（见 kernel-probe-report）。
 */
async function syncKernelConnection(context: vscode.ExtensionContext): Promise<void> {
  if (bridge === undefined) return;
  const ok = await bridge.connect();
  if (!ok) {
    log("[qqbot] sidecar IPC 未就绪，稍后重试");
    return;
  }

  const discovered = discoverKernel();
  if (discovered === undefined) {
    log("[qqbot] 未发现码道内核（server_config.properties 缺失）");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("codeartsQqbot");
  const username = cfg.get<string>("kernel.username", "codearts");
  const provider = cfg.get<string>("provider", "").trim() || "inferhub-provider";
  const model = cfg.get<string>("model", "").trim() || "deepseek-v4.1-flash-1017";
  const agent = cfg.get<string>("agent", "").trim() || "build";
  const saved = await context.secrets.get("qqbot/kernel-password");
  const auto = decryptKernelSecret();
  const stored = auto === undefined ? saved : undefined;
  const password = auto ?? stored;
  if (auto !== undefined) {
    kernelSecretSource = "auto";
    log(`[qqbot] 已从码道加密存储获取内核口令（length=${auto.length}）`);
    if (saved !== undefined) log("[qqbot] 自动解密优先，已忽略 SecretStorage 中的旧口令");
  } else if (stored !== undefined) {
    kernelSecretSource = "stored";
    log("[qqbot] 自动解密失败，使用已保存的内核口令");
  } else {
    kernelSecretSource = "none";
    log("[qqbot] 未取得内核口令：可执行「QQ Bot: 设置内核连接」手动录入");
  }

  const connection: KernelConnection = {
    baseUrl: discovered.baseUrl,
    source: "discovered",
    version: discovered.version,
    provider,
    model,
    agent,
    ...(password === undefined ? {} : { basicAuth: { username, password } }),
  };

  const appId = await context.secrets.get("qqbot/app-id");
  const appSecret = await context.secrets.get("qqbot/app-secret");
  if (appId !== undefined && appSecret !== undefined) {
    const okCreds = await bridge.pushCredentials({ appId, appSecret });
    if (!okCreds) log("[qqbot] QQ 凭据下发失败");
  } else {
    log("[qqbot] 尚未绑定 QQ 凭据，sidecar 会等待（执行「QQ Bot: 绑定账号」）");
  }

  const pushed = await bridge.pushKernel(connection);
  if (!pushed) {
    log("[qqbot] 内核连接信息下发失败");
    return;
  }
  if (password === undefined) {
    log("[qqbot] 已下发内核端口，但缺少口令：请执行「QQ Bot: 设置内核连接」录入，或等待官方接口");
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("CodeArts QQ Bot");
  context.subscriptions.push(output);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "codeartsQqbot.showStatus";
  context.subscriptions.push(statusItem);

  const ipcToken = randomUUID();
  const pipePath = defaultIpcPath(IPC_TAG);
  bridge = new KernelBridge({ pipePath, token: ipcToken, log });
  bridge.onReady(() => {
    void syncKernelConnection(context);
  });
  context.subscriptions.push({ dispose: () => bridge?.dispose() });

  supervisor = new SidecarSupervisor(context, output, publishStatus, () => {
    const configured = vscode.workspace.getConfiguration("codeartsQqbot").get<string>("workspace", "");
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const workspace = configured.trim().length > 0 ? configured.trim() : folder;
    return [
      "--ipc-pipe",
      pipePath,
      "--ipc-token",
      ipcToken,
      ...(workspace.length > 0 ? ["--workspace", workspace] : []),
    ];
  });
  const sup = supervisor;

  context.subscriptions.push(
    vscode.commands.registerCommand("codeartsQqbot.start", () => {
      sup.start();
      vscode.window.showInformationMessage("QQ Bot 正在启动");
      void syncKernelConnection(context);
    }),
    vscode.commands.registerCommand("codeartsQqbot.stop", () => {
      sup.stop();
      vscode.window.showInformationMessage("QQ Bot 已停止");
    }),
    vscode.commands.registerCommand("codeartsQqbot.restart", () => {
      sup.restart();
      vscode.window.showInformationMessage("QQ Bot 正在重启");
      void syncKernelConnection(context);
    }),
    vscode.commands.registerCommand("codeartsQqbot.bind", () => {
      const panel = showBindPanel({
        source: "codearts-agent-qqbot",
        onBound: async ({ appId, appSecret }) => {
          await context.secrets.store("qqbot/app-id", appId);
          await context.secrets.store("qqbot/app-secret", appSecret);
          log(`[qqbot] 扫码绑定成功 app=${appId.slice(0, 4)}***`);
          vscode.window.showInformationMessage("扫码绑定成功，正在启动 QQ Bot");
          sup.restart();
          await syncKernelConnection(context);
        },
        onManual: () => {
          void vscode.commands.executeCommand("codeartsQqbot.bindManual");
        },
      });
      context.subscriptions.push(panel);
    }),
    vscode.commands.registerCommand("codeartsQqbot.bindManual", async () => {
      const appId = await vscode.window.showInputBox({
        title: "手动绑定 QQ 机器人（1/2）",
        prompt: "输入 QQ 开放平台的 AppID",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length === 0 ? "AppID 不能为空" : undefined),
      });
      if (appId === undefined) return;

      const secret = await vscode.window.showInputBox({
        title: "手动绑定 QQ 机器人（2/2）",
        prompt: "输入 AppSecret（将存入系统凭据库，不会写入配置）",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length < 8 ? "AppSecret 长度不正确" : undefined),
      });
      if (secret === undefined) return;

      await context.secrets.store("qqbot/app-id", appId.trim());
      await context.secrets.store("qqbot/app-secret", secret.trim());
      log(`[qqbot] credentials stored for app ${appId.trim().slice(0, 4)}***`);
      vscode.window.showInformationMessage("凭据已保存，正在启动 QQ Bot");
      sup.restart();
      void syncKernelConnection(context);
    }),
    vscode.commands.registerCommand("codeartsQqbot.manageAccess", async () => {
      const snapshot = await bridge?.accessGet();
      if (snapshot === undefined) {
        vscode.window.showWarningMessage("无法读取访问名单：sidecar 未连接，请先启动 QQ Bot");
        return;
      }

      const pick = await vscode.window.showQuickPick(
        [
          { label: "查看当前配置", description: `revision ${snapshot.revision}` },
          { label: "添加私聊白名单", description: `已 ${snapshot.c2c.allow.length} 个` },
          { label: "添加群白名单", description: `已 ${snapshot.group.allow.length} 个` },
          { label: "移除私聊白名单" },
          { label: "移除群白名单" },
          { label: "撤销身份（黑名单）" },
          { label: "切换访问模式", description: `c2c=${snapshot.c2c.mode} group=${snapshot.group.mode}` },
          { label: "生成配对码" },
        ],
        { title: "QQ Bot 访问名单", ignoreFocusOut: true },
      );
      if (pick === undefined) return;

      const askId = async (title: string): Promise<string | undefined> => {
        const value = await vscode.window.showInputBox({
          title,
          prompt: "openid / group_openid（可从输出面板日志获取）",
          ignoreFocusOut: true,
        });
        const id = value?.trim();
        return id === undefined || id.length === 0 ? undefined : id;
      };

      let result: AccessMutationResult | undefined;

      switch (pick.label) {
        case "查看当前配置": {
          const lines = [
            "=== QQ Bot 访问控制 ===",
            `revision: ${snapshot.revision}`,
            `私聊: ${snapshot.c2c.mode}（${snapshot.c2c.allow.length} 个）`,
            `群聊: ${snapshot.group.mode}（${snapshot.group.allow.length} 个）`,
            `命令: ${snapshot.command.mode}（${snapshot.command.allow.length} 个）`,
            `配对码: ${snapshot.pairingCount}，黑名单: ${snapshot.revokedCount}`,
          ];
          output?.appendLine(lines.join("\n"));
          output?.show(true);
          await vscode.window.showInformationMessage(
            `私聊 ${snapshot.c2c.mode} / 群聊 ${snapshot.group.mode}（详情见输出面板）`,
          );
          return;
        }

        case "添加私聊白名单": {
          const id = await askId("添加私聊白名单");
          if (id !== undefined) result = await bridge?.accessMutate({ type: "addAllow", kind: "c2c", id });
          break;
        }

        case "添加群白名单": {
          const id = await askId("添加群白名单");
          if (id !== undefined) result = await bridge?.accessMutate({ type: "addAllow", kind: "group", id });
          break;
        }

        case "移除私聊白名单": {
          const id = await askId("移除私聊白名单");
          if (id !== undefined) result = await bridge?.accessMutate({ type: "removeAllow", kind: "c2c", id });
          break;
        }

        case "移除群白名单": {
          const id = await askId("移除群白名单");
          if (id !== undefined) result = await bridge?.accessMutate({ type: "removeAllow", kind: "group", id });
          break;
        }

        case "撤销身份（黑名单）": {
          const kindPick = await vscode.window.showQuickPick(["c2c", "group"], { title: "撤销哪类身份" });
          if (kindPick === undefined) return;
          const id = await askId(`撤销 ${kindPick} 身份`);
          if (id !== undefined) {
            result = await bridge?.accessMutate({ type: "revoke", kind: kindPick as "c2c" | "group", id });
          }
          break;
        }

        case "切换访问模式": {
          const kindPick = await vscode.window.showQuickPick(["c2c", "group", "command"], { title: "选择类别" });
          if (kindPick === undefined) return;
          const modePick = await vscode.window.showQuickPick(["open", "allowlist", "disabled"], {
            title: "选择模式",
          });
          if (modePick === undefined) return;
          result = await bridge?.accessMutate({
            type: "setMode",
            kind: kindPick as "c2c" | "group" | "command",
            mode: modePick as "open" | "allowlist" | "disabled",
          });
          break;
        }

        case "生成配对码": {
          const kindPick = await vscode.window.showQuickPick(["c2c", "group"], { title: "配对码用途" });
          if (kindPick === undefined) return;
          result = await bridge?.accessMutate({ type: "createPairing", kind: kindPick as "c2c" | "group" });
          if (result?.pairingCode !== undefined) {
            await vscode.env.clipboard.writeText(result.pairingCode);
            await vscode.window.showInformationMessage(
              `配对码 ${result.pairingCode}（已复制，10 分钟内有效）：让对方私聊机器人发送该码即可加入白名单`,
            );
          }
          break;
        }

        default:
          return;
      }

      if (result === undefined) {
        vscode.window.showWarningMessage("操作失败：sidecar 未连接或执行出错（见输出面板）");
        return;
      }
      await vscode.window.showInformationMessage(
        `已更新：私聊 ${result.c2c.mode}（${result.c2c.allow.length}）/ 群聊 ${result.group.mode}（${result.group.allow.length}）`,
      );
    }),
    vscode.commands.registerCommand("codeartsQqbot.setKernelConnection", async () => {
      const discovered = discoverKernel();
      const baseUrl = await vscode.window.showInputBox({
        title: "设置内核连接（1/2）",
        prompt: "内核地址，例如 http://127.0.0.1:20553",
        value: discovered?.baseUrl ?? "http://127.0.0.1:20553",
        ignoreFocusOut: true,
      });
      if (baseUrl === undefined) return;

      const password = await vscode.window.showInputBox({
        title: "设置内核连接（2/2）",
        prompt: "内核 Basic Auth 口令（由码道扩展注入，仅存于系统凭据库）",
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) return;

      const username = vscode.workspace
        .getConfiguration("codeartsQqbot")
        .get<string>("kernel.username", "codearts");
      await context.secrets.store("qqbot/kernel-password", password.trim());
      const ok = await bridge?.pushKernel({
        baseUrl: baseUrl.trim(),
        basicAuth: { username, password: password.trim() },
        source: "manual",
        ...(discovered === undefined ? {} : { version: discovered.version }),
      });
      vscode.window.showInformationMessage(ok === true ? "内核连接已下发" : "下发失败，请查看输出面板");
    }),
    vscode.commands.registerCommand("codeartsQqbot.showStatus", async () => {
      const status = sup.status;
      const appId = await context.secrets.get("qqbot/app-id");
      const ipc = bridge?.connected === true ? "已连接" : "未连接";
      const discovered = discoverKernel();
      const bin = sup.binaryPath;
      const secretText =
        kernelSecretSource === "auto" ? "自动解密成功" : kernelSecretSource === "stored" ? "已保存" : "未取得";

      const lines = [
        "=== CodeArts QQ Bot 状态 ===",
        `sidecar：${status.state}${status.detail === undefined ? "" : `（${status.detail}）`}`,
        `重启次数：${status.restarts}`,
        `IPC：${ipc}`,
        `管道：${pipePath}`,
        `sidecar 路径：${bin ?? "(未找到)"}${bin === undefined ? "" : ` exists=${fs.existsSync(bin)}`}`,
        `内核：${discovered === undefined ? "未发现" : `${discovered.baseUrl} (${discovered.version})`}`,
        `内核口令：${secretText}`,
        `AppID：${appId === undefined ? "未绑定" : `${appId.slice(0, 4)}***`}`,
      ];

      output?.appendLine(lines.join("\n"));
      output?.show(true);
      await vscode.window.showInformationMessage(
        `sidecar=${status.state} | IPC=${ipc} | 重启=${status.restarts}（详情见输出面板）`,
      );
    }),
    vscode.commands.registerCommand("codeartsQqbot.exportDiagnostics", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        defaultUri:
          folder === undefined
            ? vscode.Uri.file("qqbot-diagnostics.txt")
            : vscode.Uri.joinPath(folder, "qqbot-diagnostics.txt"),
        filters: { Text: ["txt"] },
      });
      if (target === undefined) return;

      const status = sup.status;
      const discovered = discoverKernel();
      const content = [
        "# CodeArts QQ Bot 诊断",
        `generatedAt=${new Date().toISOString()}`,
        `sidecar=${status.state}`,
        `restarts=${status.restarts}`,
        `ipc=${bridge?.connected === true ? "connected" : "disconnected"}`,
        `kernelBaseUrl=${discovered?.baseUrl ?? "unknown"}`,
        `kernelVersion=${discovered?.version ?? "unknown"}`,
        `vscode=${vscode.version}`,
        `platform=${process.platform}-${process.arch}`,
      ].join("\n");
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      vscode.window.showInformationMessage("诊断包已导出（不含凭据）");
    }),
  );

  publishStatus({ state: "stopped", restarts: 0 });

  const enabled = vscode.workspace.getConfiguration("codeartsQqbot").get<boolean>("enabled", false);
  if (enabled) {
    sup.start();
    void syncKernelConnection(context);
  }
}

export function deactivate(): void {
  supervisor?.stop();
  supervisor = undefined;
  bridge?.dispose();
  bridge = undefined;
  statusItem?.dispose();
  statusItem = undefined;
  output?.dispose();
  output = undefined;
}