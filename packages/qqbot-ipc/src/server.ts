import net from "node:net";
import {
  encodeFrame,
  isRequest,
  type AccessAction,
  type AccessMutationResult,
  type AccessSnapshot,
  type KernelConnection,
  type ChannelCredentials,
  type RpcMessage,
} from "./protocol.js";

export interface IpcServerHandlers {
  kernelGet(): KernelConnection | undefined;
  onKernelSet?(connection: KernelConnection): void | Promise<void>;
  onCredentialsSet?(credentials: ChannelCredentials): void | Promise<void>;
  accessGet?(): AccessSnapshot | Promise<AccessSnapshot>;
  accessMutate?(action: AccessAction): AccessMutationResult | Promise<AccessMutationResult>;
  statusGet?(): unknown;
  logTail?(lines: number): string[];
}

export interface IpcServerOptions {
  path: string;
  token: string;
  handlers: IpcServerHandlers;
}

interface Connection {
  socket: net.Socket;
  authenticated: boolean;
  buffer: string;
}

/**
 * sidecar 侧的 IPC 服务端。
 *
 * 安全约束：
 * - 每个连接必须先完成 ipc.auth（token 由扩展生成并随进程参数注入）；
 * - 未认证连接收到任何业务请求都返回错误；
 * - 只通过本机命名管道/UDS 通信，不开网络端口。
 */
export class IpcServer {
  private server: net.Server | undefined;
  private readonly connections = new Set<Connection>();

  constructor(private readonly options: IpcServerOptions) {}

  async start(): Promise<void> {
    if (this.server !== undefined) return;
    const server = net.createServer((socket) => this.onConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(this.options.path, () => {
        server.off("error", onError);
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    const conn: Connection = { socket, authenticated: false, buffer: "" };
    this.connections.add(conn);

    socket.on("data", (chunk) => {
      conn.buffer += chunk.toString("utf8");
      let idx = conn.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = conn.buffer.slice(0, idx).trim();
        conn.buffer = conn.buffer.slice(idx + 1);
        if (line.length > 0) void this.handleLine(conn, line);
        idx = conn.buffer.indexOf("\n");
      }
    });

    const cleanup = (): void => {
      this.connections.delete(conn);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  private async handleLine(conn: Connection, line: string): Promise<void> {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (!isRequest(message)) return;

    if (message.method === "ipc.auth") {
      const params = message.params as { token?: string } | undefined;
      if (params?.token !== this.options.token) {
        this.reply(conn, message.id, undefined, { code: 401, message: "unauthorized" });
        conn.socket.destroy();
        return;
      }
      conn.authenticated = true;
      this.reply(conn, message.id, { ok: true });
      return;
    }

    if (!conn.authenticated) {
      this.reply(conn, message.id, undefined, { code: 401, message: "not authenticated" });
      return;
    }

    try {
      switch (message.method) {
        case "ipc.ping":
          this.reply(conn, message.id, { pong: true, at: Date.now() });
          return;

        case "kernel.get":
          this.reply(conn, message.id, this.options.handlers.kernelGet() ?? null);
          return;

        case "kernel.set": {
          const conn2 = message.params as KernelConnection | undefined;
          if (conn2 === undefined || typeof conn2.baseUrl !== "string") {
            this.reply(conn, message.id, undefined, { code: 400, message: "invalid kernel connection" });
            return;
          }
          await this.options.handlers.onKernelSet?.(conn2);
          this.reply(conn, message.id, { ok: true });
          return;
        }

        case "status.get":
          this.reply(conn, message.id, this.options.handlers.statusGet?.() ?? null);
          return;

        case "access.get":
          this.reply(conn, message.id, (await this.options.handlers.accessGet?.()) ?? null);
          return;

        case "access.mutate": {
          const action = message.params as AccessAction | undefined;
          if (action === undefined || typeof action.type !== "string") {
            this.reply(conn, message.id, undefined, { code: 400, message: "invalid access action" });
            return;
          }
          const snapshot = await this.options.handlers.accessMutate?.(action);
          this.reply(conn, message.id, snapshot ?? null);
          return;
        }

        case "credentials.set": {
          const creds = message.params as ChannelCredentials | undefined;
          const valid =
            creds !== undefined &&
            (creds.channel === "weixin"
              ? typeof creds.botId === "string" &&
                typeof creds.token === "string" &&
                typeof creds.baseUrl === "string"
              : typeof creds.appId === "string" && typeof creds.appSecret === "string");
          if (!valid) {
            this.reply(conn, message.id, undefined, { code: 400, message: "invalid credentials" });
            return;
          }
          await this.options.handlers.onCredentialsSet?.(creds);
          this.reply(conn, message.id, { ok: true });
          return;
        }

        case "log.tail": {
          const params = message.params as { lines?: number } | undefined;
          this.reply(conn, message.id, this.options.handlers.logTail?.(params?.lines ?? 100) ?? []);
          return;
        }

        default:
          this.reply(conn, message.id, undefined, { code: 404, message: `unknown method ${message.method}` });
      }
    } catch (err) {
      this.reply(conn, message.id, undefined, {
        code: 500,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private reply(conn: Connection, id: number, result?: unknown, error?: { code: number; message: string }): void {
    if (conn.socket.destroyed) return;
    const payload = encodeFrame({
      jsonrpc: "2.0",
      id,
      ...(error === undefined ? { result: result ?? null } : { error }),
    });
    conn.socket.write(payload);
  }

  broadcast(method: string, params?: unknown): void {
    const frame = encodeFrame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    for (const conn of this.connections) {
      if (conn.authenticated && !conn.socket.destroyed) conn.socket.write(frame);
    }
  }

  async close(): Promise<void> {
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}