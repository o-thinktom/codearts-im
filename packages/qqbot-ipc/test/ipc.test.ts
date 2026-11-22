import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { IpcClient, IpcServer, defaultIpcPath, type KernelConnection } from "../src/index.js";

const tag = `test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let server: IpcServer | undefined;
const clients: IpcClient[] = [];

function pipePath(): string {
  return process.platform === "win32" ? defaultIpcPath(tag) : path.join(os.tmpdir(), `qqbot-ipc-${tag}.sock`);
}

async function startServer(overrides?: {
  token?: string;
  onKernelSet?: (c: KernelConnection) => void;
  wecom?: {
    start: () => import("../src/index.js").WecomQrTicket;
    poll: (scode: string) => import("../src/index.js").WecomQrPollResult;
  };
}): Promise<{ server: IpcServer; token: string; received: KernelConnection[] }> {
  const token = overrides?.token ?? "token-123";
  const received: KernelConnection[] = [];
  let current: KernelConnection | undefined;
  const s = new IpcServer({
    path: pipePath(),
    token,
    handlers: {
      kernelGet: () => current,
      onKernelSet: (c) => {
        current = c;
        received.push(c);
        overrides?.onKernelSet?.(c);
      },
      statusGet: () => ({ online: true }),
      ...(overrides?.wecom === undefined
        ? {}
        : { wecomQrStart: overrides.wecom.start, wecomQrPoll: overrides.wecom.poll }),
    },
  });
  await s.start();
  server = s;
  return { server: s, token, received };
}

async function connect(token: string): Promise<IpcClient> {
  const client = new IpcClient({ path: pipePath(), token, timeoutMs: 3000 });
  await client.connect();
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await server?.close();
  server = undefined;
});

describe("IPC 传输", () => {
  it("认证后可下发内核连接并可回读", async () => {
    const { received } = await startServer();
    const client = await connect("token-123");
    await client.authenticate();

    const ping = await client.request<{ pong: boolean }>("ipc.ping");
    expect(ping.pong).toBe(true);

    const conn: KernelConnection = {
      baseUrl: "http://127.0.0.1:20553",
      basicAuth: { username: "codearts", password: "secret" },
      source: "discovered",
    };
    await client.request("kernel.set", conn);

    expect(received).toHaveLength(1);
    expect(received[0]?.baseUrl).toBe("http://127.0.0.1:20553");
    expect(await client.request("kernel.get")).toMatchObject({ baseUrl: "http://127.0.0.1:20553" });
  });

  it("错误 token 被拒绝", async () => {
    await startServer();
    const client = await connect("wrong");
    await expect(client.authenticate()).rejects.toThrow(/unauthorized/);
  });

  it("未认证的业务请求被拒绝", async () => {
    await startServer();
    const client = await connect("token-123");
    await expect(client.request("kernel.get")).rejects.toThrow(/not authenticated/);
  });

  it("未知方法返回错误", async () => {
    await startServer();
    const client = await connect("token-123");
    await client.authenticate();
    await expect(client.request("nope")).rejects.toThrow(/unknown method/);
  });

  it("转发企业微信扫码票据与轮询结果", async () => {
    const ticket = {
      scode: "sc-1",
      verificationUrl: "https://work.weixin.qq.com/ai/qc/verify?code=x",
      expiresAt: 1_000,
      pollIntervalMs: 3_000,
    };
    const polled: string[] = [];
    await startServer({
      wecom: {
        start: () => ticket,
        poll: (scode) => {
          polled.push(scode);
          return scode === "sc-1" ? { status: "waiting" } : { status: "failed" };
        },
      },
    });
    const client = await connect("token-123");
    await client.authenticate();

    expect(await client.request("wecom.qr.start")).toEqual(ticket);
    expect(await client.request("wecom.qr.poll", { scode: "sc-1" })).toEqual({ status: "waiting" });
    expect(polled).toEqual(["sc-1"]);
  });

  it("未配置企微扫码时返回 501", async () => {
    await startServer();
    const client = await connect("token-123");
    await client.authenticate();
    await expect(client.request("wecom.qr.start")).rejects.toThrow(/not supported/);
    await expect(client.request("wecom.qr.poll", { scode: "s" })).rejects.toThrow(/invalid scode/);
  });

  it("服务端断开时客户端触发 close 事件", async () => {
    const { server: s } = await startServer();
    const client = await connect("token-123");
    await client.authenticate();

    const closed = new Promise<void>((resolve) => {
      client.once("close", () => resolve());
    });
    await s.close();
    await expect(closed).resolves.toBeUndefined();
    expect(client.connected).toBe(false);
  });

  it("服务端可广播通知", async () => {
    const { server: s } = await startServer();
    const client = await connect("token-123");
    await client.authenticate();

    const got = new Promise<{ method: string; params: unknown }>((resolve) => {
      client.onNotification((method, params) => resolve({ method, params }));
    });
    s.broadcast("status.changed", { state: "running" });
    await expect(got).resolves.toEqual({ method: "status.changed", params: { state: "running" } });
  });
});