import * as vscode from "vscode";
import QRCode from "qrcode";
import type { WecomQrPollResult, WecomQrTicket } from "@codearts-qqbot/ipc";

export interface WecomBindPanelOptions {
  startQr: () => Promise<WecomQrTicket | undefined>;
  pollQr: (scode: string) => Promise<WecomQrPollResult | undefined>;
  onBound: (credentials: { botId: string; secret: string }) => Promise<void> | void;
  /** 等待 sidecar 侧 IM 通道上线；超时返回 false */
  waitForOnline?: (timeoutMs: number) => Promise<boolean>;
  onManual?: () => void;
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; text-align: center; }
  h3 { font-weight: 600; }
  .qr { background: #fff; padding: 12px; display: inline-flex; align-items: center; justify-content: center; min-width: 240px; min-height: 240px; border-radius: 8px; }
  .qr img { width: 240px; height: 240px; }
  .hint { opacity: .75; font-size: 12px; margin-top: 14px; line-height: 1.6; }
  .status { margin-top: 14px; font-size: 13px; }
  .error { color: var(--vscode-errorForeground); }
  .success { color: var(--vscode-testing-iconPassed, #3fb950); }
  button { margin-top: 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; }
</style>
</head>
<body>
  <h3>使用企业微信扫码绑定智能机器人</h3>
  <div id="qr" class="qr">正在获取二维码…</div>
  <div id="status" class="status">等待扫码…</div>
  <div class="hint">扫码后在企业微信中确认授权，凭据只保存在本机系统凭据库。<br/>需要企业管理员创建或授权智能机器人。</div>
  <div><button id="refresh">刷新二维码</button></div>
<script>
  const vscode = acquireVsCodeApi();
  const qr = document.getElementById('qr');
  const status = document.getElementById('status');
  const refresh = document.getElementById('refresh');
  refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'starting') {
      qr.textContent = '正在获取二维码…';
      status.textContent = '';
      status.className = 'status';
    } else if (message.type === 'qr') {
      qr.innerHTML = '';
      const img = document.createElement('img');
      img.src = message.url;
      qr.appendChild(img);
      status.textContent = '请使用企业微信扫码';
      status.className = 'status';
    } else if (message.type === 'success') {
      qr.innerHTML = '';
      status.textContent = '绑定成功：' + message.botId + '，正在启动连接…';
      status.className = 'status success';
    } else if (message.type === 'ready') {
      status.textContent = message.ok
        ? '连接已建立，可以在企业微信中给机器人发消息了'
        : '已启动，但暂未确认在线；可先发送消息测试，或查看「CodeArts QQ Bot」输出日志';
      status.className = message.ok ? 'status success' : 'status';
      refresh.textContent = '重新扫码';
    } else if (message.type === 'expired') {
      qr.innerHTML = '';
      status.textContent = '二维码已过期，请点击「刷新二维码」重新获取';
      status.className = 'status error';
    } else if (message.type === 'failed') {
      status.textContent = message.reason || '绑定失败';
      status.className = 'status error';
    }
  });
</script>
</body>
</html>`;

/**
 * 企业微信智能机器人扫码绑定面板。
 *
 * 扫码与轮询都由 sidecar 完成（复用 runtime 的 WecomQrAuth），
 * 面板只渲染二维码与状态，凭据不经过 webview。
 */
export function showWecomBindPanel(options: WecomBindPanelOptions): vscode.Disposable {
  const panel = vscode.window.createWebviewPanel(
    "codeartsQqbotWecomBind",
    "绑定企业微信智能机器人",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = HTML;

  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  let scode: string | undefined;
  let pollMs = 3_000;

  const post = (message: unknown): void => {
    if (!disposed) void panel.webview.postMessage(message);
  };
  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = (): void => {
    stop();
    if (disposed) return;
    timer = setTimeout(() => void pollOnce(), pollMs);
  };

  const pollOnce = async (): Promise<void> => {
    if (disposed || scode === undefined) return;
    const current = scode;
    try {
      const result = await options.pollQr(current);
      if (disposed || scode !== current) return;
      if (result === undefined || result.status === "waiting") {
        schedule();
        return;
      }
      if (result.status === "expired") {
        post({ type: "expired" });
        return;
      }
      if (result.status === "failed") {
        post({ type: "failed", reason: "企业微信拒绝了本次扫码授权" });
        return;
      }
      post({ type: "success", botId: `${result.botId.slice(0, 6)}***` });
      try {
        await options.onBound({ botId: result.botId, secret: result.secret });
      } catch (err) {
        post({ type: "failed", reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      const ok = await options.waitForOnline?.(20_000).catch(() => false);
      post({ type: "ready", ok: ok === true });
    } catch (err) {
      post({ type: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  };

  const start = async (): Promise<void> => {
    stop();
    scode = undefined;
    post({ type: "starting" });
    try {
      const ticket = await options.startQr();
      if (ticket === undefined) throw new Error("无法获取二维码：sidecar 未就绪或接口不可用");
      if (disposed) return;
      scode = ticket.scode;
      pollMs = ticket.pollIntervalMs;
      const dataUrl = await QRCode.toDataURL(ticket.verificationUrl, { width: 240, margin: 1 });
      post({ type: "qr", url: dataUrl });
      schedule();
    } catch (err) {
      post({ type: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  };

  const subscription = panel.webview.onDidReceiveMessage((message: unknown) => {
    if (message !== null && typeof message === "object" && (message as { type?: unknown }).type === "refresh") {
      void start();
    }
  });

  void start();

  return {
    dispose(): void {
      disposed = true;
      stop();
      subscription.dispose();
      panel.dispose();
    },
  };
}