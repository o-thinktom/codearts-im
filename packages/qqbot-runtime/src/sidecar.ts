import { homedir } from "node:os";
import path from "node:path";
import { AccessController, createConsoleLogger } from "@codearts-qqbot/core";
import type { Logger } from "@codearts-qqbot/core";
import {
  IpcServer,
  defaultIpcPath,
  type AccessAction,
  type AccessMutationResult,
  type AccessSnapshot,
  type ChannelCredentials,
  type KernelConnection,
} from "@codearts-qqbot/ipc";
import { HttpKernelPort, type KernelPort } from "@codearts-qqbot/kernel-port";
import { FileAccessStore } from "./access/store.js";
import { MediaService } from "./media/service.js";
import { acquireInstanceLock, type InstanceLock } from "./ops/single-instance.js";
import { QqApi } from "./qq/client.js";
import { QqAdapter } from "./adapters/qq/adapter.js";
import { WeixinApi } from "./adapters/weixin/weixin-api.js";
import { WeixinAdapter } from "./adapters/weixin/adapter.js";
import { WeixinMedia } from "./adapters/weixin/weixin-media.js";
import { WeixinStateStore } from "./adapters/weixin/weixin-state.js";
import type { ImAdapter } from "./transport/adapter.js";
import { QqbotApp } from "./gateway.js";
import { FilePrefsStore, SessionRegistry } from "./session/registry.js";
import { normalizeConfig } from "./config.js";

export interface SidecarOptions {
  ipcPath?: string;
  ipcToken: string;
  workspace: string;
  /** 仅用于本地调试；生产由扩展经 IPC 下发 */
  appId?: string;
  appSecret?: string;
  waitMs?: number;
  logger?: Logger;
}

export interface SidecarHandle {
  stop(): Promise<void>;
  readonly ready: Promise<void>;
}

interface Pending {
  credentials?: ChannelCredentials;
  kernel?: KernelConnection;
}

function dataDirOf(): string {
  const fromEnv = process.env.CODEARTS_QQBOT_DATA;
  return fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : path.join(homedir(), ".codeartsdoer", "qqbot");
}

/**
 * sidecar 主流程：
 *   起 IPC → 等待扩展下发 (QQ 凭据 + 内核连接) → 建 HttpKernelPort → 起 QQ 链路
 *
 * 凭据只存在于内存，不写日志、不落盘；
 * 访问名单与会话映射持久化在 CODEARTS_QQBOT_DATA，重启后可恢复。
 */
export async function runSidecar(options: SidecarOptions): Promise<SidecarHandle> {
  const logger = options.logger ?? createConsoleLogger(process.env.QQBOT_DEBUG === "1" ? "debug" : "info");
  const ipcPath = options.ipcPath ?? defaultIpcPath("vscode");
  const waitMs = options.waitMs ?? 60000;
  const dataDir = dataDirOf();

  const access = new AccessController(new FileAccessStore(path.join(dataDir, "access.json")));

  const toSnapshot = async (): Promise<AccessSnapshot> => {
    const cfg = await access.list();
    return {
      revision: cfg.revision,
      c2c: { mode: cfg.c2c.mode, allow: [...cfg.c2c.allow] },
      group: { mode: cfg.group.mode, allow: [...cfg.group.allow] },
      command: { mode: cfg.command.mode, allow: [...cfg.command.allow] },
      pairingCount: cfg.pairing.length,
      revokedCount: cfg.revoked.length,
    };
  };

  const applyAction = async (action: AccessAction): Promise<AccessMutationResult> => {
    let pairingCode: string | undefined;
    switch (action.type) {
      case "setMode":
        await access.setMode(action.kind, action.mode);
        break;
      case "addAllow":
        await access.addAllow(action.kind, action.id);
        break;
      case "removeAllow":
        await access.removeAllow(action.kind, action.id);
        break;
      case "revoke":
        await access.revoke(action.kind, action.id);
        break;
      case "createPairing": {
        const record = await access.createPairing(action.kind);
        pairingCode = record.code;
        break;
      }
      default:
        break;
    }
    return { ...(await toSnapshot()), ...(pairingCode === undefined ? {} : { pairingCode }) };
  };

  const pending: Pending = {
    ...(options.appId === undefined || options.appSecret === undefined
      ? {}
      : { credentials: { channel: "qq", appId: options.appId, appSecret: options.appSecret } }),
  };

  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  let started = false;
  let online = false;
  let channelRef: string | undefined;
  const maybeStart = (): void => {
    if (!started && pending.credentials !== undefined && pending.kernel !== undefined) {
      started = true;
      resolveReady?.();
    }
  };

  const ipc = new IpcServer({
    path: ipcPath,
    token: options.ipcToken,
    handlers: {
      kernelGet: () => pending.kernel,
      onKernelSet: (connection) => {
        pending.kernel = connection;
        logger.info("kernel connection received", {
          baseUrl: connection.baseUrl,
          hasAuth: connection.basicAuth !== undefined,
        });
        maybeStart();
      },
      onCredentialsSet: (credentials) => {
        pending.credentials = credentials;
        const channel = credentials.channel ?? "qq";
        const label =
          credentials.channel === "weixin"
            ? `weixin bot ${credentials.botId.slice(0, 6)}***`
            : `qq app ${credentials.appId.slice(0, 4)}***`;
        logger.info("channel credentials received", { channel, target: label });
        maybeStart();
      },
      accessGet: () => toSnapshot(),
      accessMutate: (action) => applyAction(action),
      statusGet: () => ({ online, channel: channelRef, kernel: pending.kernel?.baseUrl ?? null }),
    },
  });

  await ipc.start();
  logger.info("sidecar ipc listening", { path: ipcPath, dataDir });

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for kernel/credentials")), waitMs);
    timer.unref?.();
  });

  await Promise.race([ready, timeout]).catch(async (err) => {
    logger.error("sidecar startup failed", { err: err instanceof Error ? err.message : String(err) });
    await ipc.close();
    throw err;
  });

  if (pending.credentials === undefined || pending.kernel === undefined) {
    await ipc.close();
    throw new Error("missing kernel or credentials");
  }

  const credentials = pending.credentials;
  const connection = pending.kernel;

  const kernel: KernelPort = new HttpKernelPort({
    baseUrl: connection.baseUrl,
    directory: options.workspace,
    logger,
    ...(connection.basicAuth === undefined ? {} : { basicAuth: connection.basicAuth }),
    ...(connection.provider === undefined || connection.model === undefined
      ? {}
      : { model: { providerID: connection.provider, modelID: connection.model } }),
    ...(connection.agent === undefined ? {} : { agent: connection.agent }),
  });

  const healthy = await kernel.health();
  if (!healthy) {
    await ipc.close();
    throw new Error(`kernel unhealthy at ${connection.baseUrl} (auth/endpoint)`);
  }

  const channel = credentials.channel ?? "qq";
  channelRef = channel;
  const sessionAppId = credentials.channel === "weixin" ? credentials.botId : credentials.appId;

  const lock: InstanceLock | undefined = acquireInstanceLock(
    path.join(dataDir, "locks"),
    `${channel}-${sessionAppId}`,
  );
  if (lock === undefined) {
    await ipc.close();
    throw new Error(`another sidecar instance is already running for ${channel}:${sessionAppId}`);
  }

  let adapter: ImAdapter;
  if (credentials.channel === "weixin") {
    adapter = new WeixinAdapter({
      api: new WeixinApi({ baseUrl: credentials.baseUrl }),
      botId: credentials.botId,
      token: credentials.token,
      state: new WeixinStateStore(path.join(dataDir, "weixin-state.json")),
      logger,
      media: new WeixinMedia(credentials.baseUrl),
      mediaRoot: path.join(dataDir, "media"),
      workspace: options.workspace,
      onStaleToken: (reason) => logger.error("weixin token expired, re-scan required", { reason }),
    });
  } else {
    adapter = new QqAdapter({
      api: new QqApi({ appId: credentials.appId, appSecret: credentials.appSecret, logger }),
      logger,
      allowedRoots: [options.workspace, path.join(dataDir, "media")],
      maxFileBytes: 20 * 1024 * 1024,
    });
  }

  const registry = new SessionRegistry({
    port: kernel,
    channel: adapter.id,
    prefs: new FilePrefsStore(path.join(dataDir, "prefs.json"), sessionAppId),
    appId: sessionAppId,
    workspace: options.workspace,
    logger,
  });

  const config = normalizeConfig({
    appId: sessionAppId,
    workspace: options.workspace,
    access: { c2cMode: "open", groupMode: "open", commandMode: "open" },
    media: {
      enabled: process.env.QQBOT_MEDIA_ENABLED !== "0",
      maxMB: Number(process.env.QQBOT_MEDIA_MAX_MB ?? 200),
      ttlHours: Number(process.env.QQBOT_MEDIA_TTL_HOURS ?? 24),
    },
    sendFile: { restrict: true, extraRoots: [] },
  });

  const media = new MediaService({
    root: path.join(dataDir, "media"),
    maxBytes: config.media.maxMB * 1024 * 1024,
    ttlHours: config.media.ttlHours,
    logger,
  });

  const app = new QqbotApp({
    port: kernel,
    adapter,
    access,
    registry,
    logger,
    media,
    config,
  });

  await app.start();
  logger.info("sidecar running", { c2cMode: "open", groupMode: "open", dataDir });

  let stopped = false;
  const watchOnline = async (): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (!stopped && !online && Date.now() < deadline) {
      if (adapter.connected) {
        online = true;
        ipc.broadcast("status.changed", { online: true, channel: adapter.id });
        logger.info("channel online", { channel: adapter.id });
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  void watchOnline();

  return {
    ready,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await app.stop();
      await kernel.close();
      await ipc.close();
      lock.release();
      logger.info("sidecar stopped");
    },
  };
}