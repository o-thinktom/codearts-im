import { EventEmitter } from "node:events";
import net from "node:net";
import { encodeFrame, isNotification, isRequest, isResponse, type RpcMessage, type RpcResponse } from "./protocol.js";

export interface IpcClientOptions {
  path: string;
  token: string;
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * NDJSON over 命名管道 / UDS 的 JSON-RPC 客户端。
 *
 * 连接后必须先完成 ipc.auth，之后才能执行业务方法；
 * 请求按 id 配对，超时统一 reject，避免悬挂。
 */
export class IpcClient extends EventEmitter {
  private socket: net.Socket | undefined;
  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;
  private closeNotified = false;

  constructor(private readonly options: IpcClientOptions) {
    super();
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.closeNotified = false;

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.options.path);
      this.socket = socket;

      let settled = false;
      const onError = (err: Error): void => {
        socket.off("error", onError);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      socket.once("error", onError);
      socket.once("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("ipc closed before connect"));
        }
      });
      socket.once("connect", () => {
        settled = true;
        socket.off("error", onError);
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("close", () => {
          if (this.socket === socket) this.socket = undefined;
          this.notifyClosed();
        });
        socket.on("error", () => {
          if (this.socket === socket) this.socket = undefined;
          this.notifyClosed();
        });
        resolve();
      });
    });
  }

  async authenticate(): Promise<void> {
    await this.request("ipc.auth", { token: this.options.token });
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) this.handleLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    if (isNotification(message)) {
      this.emit("notification", message.method, message.params);
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connected) return Promise.reject(new Error("ipc not connected"));
    const id = ++this.seq;
    const frame = encodeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ipc timeout: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.socket?.write(frame);
    });
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.on("notification", handler);
    return () => this.off("notification", handler);
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.failAll(new Error("ipc closed"));
    this.emit("close");
  }
}

export type { RpcResponse };
export { isRequest };