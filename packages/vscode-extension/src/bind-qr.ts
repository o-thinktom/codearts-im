import { startQrConnect } from "@tencent-connect/qqbot-connector";
import type { QrConnectCallbacks, QrConnectOptions } from "@tencent-connect/qqbot-connector";

export type QrBindEvent =
  | { kind: "qr"; url: string }
  | { kind: "success"; appId: string; appSecret: string; userOpenid?: string }
  | { kind: "expired" }
  | { kind: "failed"; reason: string };

export type ConnectFactory = (callbacks: QrConnectCallbacks, options?: QrConnectOptions) => () => void;

export interface QrBindOptions {
  /** 调用来源标识，会拼进官方二维码 URL */
  source: string;
  onEvent: (event: QrBindEvent) => void;
  /** 测试注入点；默认使用官方 startQrConnect */
  connectFactory?: ConnectFactory;
}

export interface QrBindSession {
  refresh(): void;
  dispose(): void;
}

/**
 * 扫码绑定会话：
 * - 官方页面负责创建/绑定机器人，成功后回调返回 appId/appSecret；
 * - 支持刷新（重建二维码）与取消（abort 轮询）；
 * - 不落盘、不打印凭据，由调用方写入安全存储。
 */
export function startBindSession(options: QrBindOptions): QrBindSession {
  const factory: ConnectFactory = options.connectFactory ?? startQrConnect;
  let stop: (() => void) | undefined;
  let controller: AbortController | undefined;
  let disposed = false;

  const begin = (): void => {
    stop?.();
    controller?.abort();
    const ctl = new AbortController();
    controller = ctl;

    stop = factory(
      {
        onQrDisplayed: (url) => {
          if (!disposed && !ctl.signal.aborted) options.onEvent({ kind: "qr", url });
        },
        onQrExpired: () => {
          if (!disposed && !ctl.signal.aborted) options.onEvent({ kind: "expired" });
        },
        onSuccess: (credentials) => {
          if (disposed || ctl.signal.aborted) return;
          const first = credentials[0];
          if (first === undefined) {
            options.onEvent({ kind: "failed", reason: "扫码未返回有效凭据" });
            return;
          }
          options.onEvent({
            kind: "success",
            appId: first.appId,
            appSecret: first.appSecret,
            ...(first.userOpenid === undefined ? {} : { userOpenid: first.userOpenid }),
          });
        },
        onFailure: (error) => {
          if (disposed || ctl.signal.aborted) return;
          options.onEvent({ kind: "failed", reason: error.message });
        },
      },
      {
        displayQrCodeToConsole: false,
        signal: ctl.signal,
        source: options.source,
      },
    );
  };

  begin();

  return {
    refresh(): void {
      if (disposed) return;
      begin();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controller?.abort();
      stop?.();
      stop = undefined;
    },
  };
}