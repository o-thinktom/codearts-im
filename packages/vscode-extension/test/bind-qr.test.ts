import { describe, expect, it } from "vitest";
import type { QrConnectCallbacks } from "@tencent-connect/qqbot-connector";
import { startBindSession, type QrBindEvent } from "../src/bind-qr.js";

interface Call {
  callbacks: QrConnectCallbacks;
  stopped: boolean;
}

function setup(): { session: ReturnType<typeof startBindSession>; events: QrBindEvent[]; calls: Call[] } {
  const events: QrBindEvent[] = [];
  const calls: Call[] = [];
  const connectFactory = (callbacks: QrConnectCallbacks): (() => void) => {
    const call: Call = { callbacks, stopped: false };
    calls.push(call);
    return () => {
      call.stopped = true;
    };
  };

  const session = startBindSession({
    source: "test",
    onEvent: (event) => {
      events.push(event);
    },
    connectFactory,
  });
  return { session, events, calls };
}

describe("扫码绑定状态机", () => {
  it("二维码就绪时上报 URL", () => {
    const { events, calls } = setup();
    calls[0]?.callbacks.onQrDisplayed?.("https://example.com/qr");
    expect(events).toEqual([{ kind: "qr", url: "https://example.com/qr" }]);
  });

  it("扫码成功后返回凭据", () => {
    const { events, calls } = setup();
    calls[0]?.callbacks.onSuccess([{ appId: "123456", appSecret: "secret", userOpenid: "u1" }]);
    expect(events[0]).toEqual({ kind: "success", appId: "123456", appSecret: "secret", userOpenid: "u1" });
  });

  it("刷新会停止旧轮询并重建", () => {
    const { session, calls } = setup();
    session.refresh();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.stopped).toBe(true);
  });

  it("dispose 后停止轮询且不再上报", () => {
    const { session, events, calls } = setup();
    session.dispose();
    expect(calls[0]?.stopped).toBe(true);

    calls[0]?.callbacks.onSuccess([{ appId: "1", appSecret: "s" }]);
    calls[0]?.callbacks.onFailure(new Error("boom"));
    expect(events).toHaveLength(0);
  });

  it("空凭据作为失败处理", () => {
    const { events, calls } = setup();
    calls[0]?.callbacks.onSuccess([]);
    expect(events[0]).toEqual({ kind: "failed", reason: "扫码未返回有效凭据" });
  });

  it("二维码过期上报 expired", () => {
    const { events, calls } = setup();
    calls[0]?.callbacks.onQrExpired?.();
    expect(events[0]).toEqual({ kind: "expired" });
  });
});