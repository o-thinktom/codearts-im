import os from "node:os";
import path from "node:path";

/** 内核连接信息：由扩展侧发现/配置后下发给 sidecar */
export interface KernelConnection {
  baseUrl: string;
  basicAuth?: { username: string; password: string };
  /** 来源标记，便于诊断：config / discovered / manual */
  source: "config" | "discovered" | "manual";
  /** 可选出厂版本，便于兼容性判断 */
  version?: string;
  /** 显式模型：auto-router 在部分场景会选择不可用的 speed 模型 */
  provider?: string;
  model?: string;
  agent?: string;
}

/** QQ 机器人凭据：只经本机 IPC 传递，不落盘、不进命令行 */
export interface QqCredentials {
  appId: string;
  appSecret: string;
}

export type AccessKind = "c2c" | "group" | "command";
export type AccessMode = "open" | "allowlist" | "disabled";

export interface AccessRuleSnapshot {
  mode: AccessMode;
  allow: string[];
}

/** 访问控制快照：供扩展 UI 展示与管理 */
export interface AccessSnapshot {
  revision: number;
  c2c: AccessRuleSnapshot;
  group: AccessRuleSnapshot;
  command: AccessRuleSnapshot;
  pairingCount: number;
  revokedCount: number;
}

export interface AccessMutationResult extends AccessSnapshot {
  pairingCode?: string;
}

export type AccessAction =
  | { type: "setMode"; kind: AccessKind; mode: AccessMode }
  | { type: "addAllow"; kind: "c2c" | "group"; id: string }
  | { type: "removeAllow"; kind: "c2c" | "group"; id: string }
  | { type: "revoke"; kind: "c2c" | "group"; id: string }
  | { type: "createPairing"; kind: "c2c" | "group" };

export const IpcMethod = {
  auth: "ipc.auth",
  ping: "ipc.ping",
  kernelGet: "kernel.get",
  kernelSet: "kernel.set",
  credentialsSet: "credentials.set",
  statusGet: "status.get",
  statusChanged: "status.changed",
  logTail: "log.tail",
} as const;

export type IpcMethodName = (typeof IpcMethod)[keyof typeof IpcMethod];

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export function encodeFrame(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * 命名管道路径：Windows 用 named pipe，其他平台用 UDS。
 * tag 建议用 appId 或用户名，避免多实例冲突。
 */
export function defaultIpcPath(tag = "default"): string {
  if (process.platform === "win32") {
    const safe = tag.replace(/[^A-Za-z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\codearts-qqbot-${safe}`;
  }
  return path.join(os.tmpdir(), `codearts-qqbot-${tag}.sock`);
}

export function isRequest(message: RpcMessage): message is RpcRequest {
  return "id" in message && "method" in message;
}

export function isResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}

export function isNotification(message: RpcMessage): message is RpcNotification {
  return !("id" in message) && "method" in message;
}