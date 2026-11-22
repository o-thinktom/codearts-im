import * as vscode from "vscode";
import QRCode from "qrcode";
import { startBindSession, type QrBindSession } from "./bind-qr.js";

export interface BindPanelOptions {
  source: string;
  onBound: (credentials: { appId: string; appSecret: string }) => Promise<void> | void;
  onManual: () => void;
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; text-align: center; }
  h3 { font-weight: 600; }
  .qr { background: #fff; padding: 12px; display: inline-flex; align-items: center; justify-content: center; min-width: 240px; min-height: 240px; border-radius: 8px; }
  .qr svg { width: 240px; height: 240px; }
  .hint { opacity: .75; font-size: 12px; margin-top: 14px; line-height: 1.6; }
  .status { margin-top: 14px; font-size: 13px; }
  .error { color: var(--vscode-errorForeground); }
  .success { color: var(--vscode-testing-iconPassed, #3fb950); }
  button { margin-top: 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-left: 8px; }
</style>
</head>
<body>
  <h3>使用手机 QQ 扫码绑定机器人</h3>
  <div id="qr" class="qr">正在获取二维码…</div>
  <div id="status" class="status">等待扫码…</div>
  <div class="hint">扫码后由腾讯官方页面完成创建/绑定，无需手动填写 AppID 或 AppSecret。<br/>绑定成功后会自动启动连接。</div>
  <div>
    <button id="refresh">刷新二维码</button>
    <button id="manual" class="secondary">手动填写</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const qr = document.getElementById('qr');
  const status = document.getElementById('status');
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'starting') {
      qr.textContent = '正在获取二维码…';
      status.textContent = '';
      status.className = 'status';
    } else if (message.type === 'qr') {
      qr.innerHTML = message.svg;
      status.textContent = '请使用手机 QQ 扫码';
      status.className = 'status';
    } else if (message.type === 'success') {
      qr.innerHTML = '';
      status.textContent = '绑定成功：' + message.appId + '，正在启动连接…';
      status.className = 'status success';
    } else if (message.type === 'expired') {
      status.textContent = '二维码已过期，正在刷新…';
    } else if (message.type === 'failed') {
      status.textContent = '绑定失败：' + message.reason;
      status.className = 'status error';
    }
  });
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('manual').addEventListener('click', () => vscode.postMessage({ type: 'manual' }));
</script>
</body>
</html>`;

/**
 * 扫码绑定向导面板：展示官方二维码，成功后回调凭据（由调用方写入安全存储并启动）。
 */
export function showBindPanel(options: BindPanelOptions): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "codeartsImBind",
    "扫码绑定 QQ 机器人",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  let session: QrBindSession | undefined;
  let disposed = false;
  const post = (message: unknown): void => {
    void panel.webview.postMessage(message);
  };

  const start = (): void => {
    session?.dispose();
    post({ type: "starting" });
    session = startBindSession({
      source: options.source,
      onEvent: (event) => {
        if (event.kind === "qr") {
          void QRCode.toString(event.url, { type: "svg", margin: 1, width: 240 })
            .then((svg) => post({ type: "qr", svg }))
            .catch(() => post({ type: "failed", reason: "二维码渲染失败" }));
          return;
        }
        if (event.kind === "success") {
          session?.dispose();
          session = undefined;
          post({ type: "success", appId: `${event.appId.slice(0, 4)}***` });
          void options.onBound({ appId: event.appId, appSecret: event.appSecret });
          return;
        }
        if (event.kind === "expired") {
          post({ type: "expired" });
          if (!disposed) session?.refresh();
          return;
        }
        post({ type: "failed", reason: event.reason });
      },
    });
  };

  panel.webview.html = HTML;
  panel.webview.onDidReceiveMessage((message: { type?: string }) => {
    if (message.type === "refresh") start();
    if (message.type === "manual") options.onManual();
  });
  panel.onDidDispose(() => {
    disposed = true;
    session?.dispose();
    session = undefined;
  });

  start();
  return panel;
}