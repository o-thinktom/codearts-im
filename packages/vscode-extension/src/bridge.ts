import * as vscode from "vscode";
import {
  IpcClient,
  type AccessAction,
  type AccessMutationResult,
  type AccessSnapshot,
  type KernelConnection,
  type QqCredentials,
} from "@codearts-qqbot/ipc";

export interface BridgeOptions {
  pipePath: string;
  token: string;
  log: (message: string) => void;
}

/**
 * 扩展侧 ↔ sidecar 的 IPC 桥。
 *
 * 职责：
 * - 连接 sidecar（命名管道/UDS）并完成 token 认证；
 * - 下发内核连接信息（端口来自自动发现，凭据来自配置/SecretStorage/官方接口）；
 * - 断线重连，避免 sidecar 重启后扩展必须重启。
 */
export class KernelBridge implements vscode.Disposable {
  private client: IpcClient | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private attempts = 0;
  private readyHandler: (() => void) | undefined;

  constructor(private readonly options: BridgeOptions) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** 注册"连接就绪"回调：每次新建 IPC 连接成功后触发（重连也会触发） */
  onReady(handler: () => void): void {
    this.readyHandler = handler;
    if (this.connected) handler();
  }

  async connect(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.client?.connected === true) return true;
    const client = new IpcClient({ path: this.options.pipePath, token: this.options.token, timeoutMs: 8000 });
    try {
      await client.connect();
      await client.authenticate();
      this.client = client;
      client.on("close", () => {
        if (this.client === client) {
          this.client = undefined;
          this.options.log("[qqbot] ipc bridge disconnected");
          this.scheduleReconnect();
        }
      });
      this.attempts = 0;
      this.options.log("[qqbot] ipc bridge connected");
      this.readyHandler?.();
      return true;
    } catch (err) {
      client.close();
      this.options.log(`[qqbot] ipc bridge connect failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.attempts += 1;
    const delay = Math.min(2000 * this.attempts, 20000);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }

  async pushKernel(connection: KernelConnection): Promise<boolean> {
    if (this.client === undefined || !this.client.connected) {
      const ok = await this.connect();
      if (!ok || this.client === undefined) return false;
    }
    try {
      await this.client.request("kernel.set", connection);
      this.options.log(`[qqbot] kernel pushed: ${connection.baseUrl} (${connection.source})`);
      return true;
    } catch (err) {
      this.options.log(`[qqbot] kernel push failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async pushCredentials(credentials: QqCredentials): Promise<boolean> {
    if (this.client === undefined || !this.client.connected) {
      const ok = await this.connect();
      if (!ok || this.client === undefined) return false;
    }
    try {
      await this.client.request("credentials.set", credentials);
      this.options.log(`[qqbot] QQ credentials pushed for app ${credentials.appId.slice(0, 4)}***`);
      return true;
    } catch (err) {
      this.options.log(`[qqbot] credentials push failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async accessGet(): Promise<AccessSnapshot | undefined> {
    return this.call<AccessSnapshot>("access.get");
  }

  async accessMutate(action: AccessAction): Promise<AccessMutationResult | undefined> {
    return this.call<AccessMutationResult>("access.mutate", action);
  }

  private async call<T>(method: string, params?: unknown): Promise<T | undefined> {
    if (this.client === undefined || !this.client.connected) {
      const ok = await this.connect();
      if (!ok || this.client === undefined) return undefined;
    }
    try {
      return await this.client.request<T>(method, params);
    } catch (err) {
      this.options.log(`[qqbot] ipc ${method} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async status(): Promise<unknown> {
    if (this.client === undefined || !this.client.connected) return undefined;
    try {
      return await this.client.request("status.get");
    } catch {
      return undefined;
    }
  }

  onStatusChanged(handler: (params: unknown) => void): void {
    this.client?.onNotification((method, params) => {
      if (method === "status.changed") handler(params);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.client?.close();
    this.client = undefined;
  }
}