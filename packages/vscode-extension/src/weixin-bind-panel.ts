import * as vscode from "vscode";
import QRCode from "qrcode";
import { startWeixinBindSession, type WeixinBindSession } from "./weixin-bind.js";

export interface WeixinBindPanelOptions {
  onBound: (credentials: { botId: string; token: string; baseUrl: string }) => Promise<void> | void;
  onManual: () => void;
  /** 等待 sidecar 侧 IM 通道上线；超时返回 false */
  waitForOnline?: (timeoutMs: number) => Promise<boolean>;
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
  #verify { display: none; margin-top: 14px; }
  #verify input { padding: 5px 8px; width: 140px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
</style>
</head>
<body>
  <h3>使用手机微信扫码绑定机器人</h3>
  <div id="qr" class="qr">正在获取二维码…</div>
  <div id="status" class="status">等待扫码…</div>
  <div id="verify"><input id="code" placeholder="请输入验证码" /><button id="submit">提交</button></div>
  <div class="hint">扫码后由腾讯 iLink 页面完成授权，无需手动填写凭据。<br/>绑定成功后会自动启动连接。</div>
  <div>
    <button id="refresh">刷新二维码</button>
    <button id="manual" class="secondary">手动填写</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const qr = document.getElementById('qr');
  const status = document.getElementById('status');
  const verify = document.getElementById('verify');
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'starting') {
      qr.textContent = '正在获取二维码…';
      status.textContent = '';
      status.className = 'status';
      verify.style.display = 'none';
    } else if (message.type === 'qr') {
      qr.innerHTML = message.svg;
      status.textContent = '请使用手机微信扫码';
      status.className = 'status';
    } else if (message.type === 'verify') {
      verify.style.display = 'block';
      status.textContent = message.message || '请输入验证码';
    } else if (message.type === 'success') {
      qr.innerHTML = '';
      status.textContent = '绑定成功：' + message.botId + '，正在启动连接…';
      status.className = 'status success';
      verify.style.display = 'none';
    } else if (message.type === 'ready') {
      status.textContent = message.ok
        ? '连接已建立，可以在微信中给机器人发消息了'
        : '已启动，但暂未确认在线；可先发送消息测试，或查看「CodeArts QQ Bot」输出日志';
      status.className = message.ok ? 'status success' : 'status';
      document.getElementById('refresh').textContent = '重新扫码';
    } else if (message.type === 'expired') {
      status.textContent = '二维码已过期，正在刷新…';
    } else if (message.type === 'failed') {
      status.textContent = '绑定失败：' + message.reason;
      status.className = 'status error';
    }
  });
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('manual').addEventListener('click', () => vscode.postMessage({ type: 'manual' }));
  document.getElementById('submit').addEventListener('click', () => {
    const code = document.getElementById('code').value;
    if (code) vscode.postMessage({ type: 'verify', code });
  });
</script>
</body>
</html>`;

/**
 * 微信绑定向导面板：展示 iLink 二维码，支持验证码与刷新，成功后回调凭据。
 */
export function showWeixinBindPanel(options: WeixinBindPanelOptions): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "codeartsQqbotBindWeixin",
    "扫码绑定微信机器人",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  let session: WeixinBindSession | undefined;
  let disposed = false;
  const post = (message: unknown): void => {
    void panel.webview.postMessage(message);
  };

  const start = (): void => {
    session?.dispose();
    post({ type: "starting" });
    session = startWeixinBindSession({
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
          post({ type: "success", botId: `${event.botId.slice(0, 6)}***` });
          void (async () => {
            try {
              await options.onBound({ botId: event.botId, token: event.token, baseUrl: event.baseUrl });
            } catch (err) {
              post({ type: "failed", reason: err instanceof Error ? err.message : String(err) });
              return;
            }
            const ok = await options.waitForOnline?.(20_000).catch(() => false);
            post({ type: "ready", ok: ok === true });
          })();
          return;
        }
        if (event.kind === "expired") {
          post({ type: "expired" });
          if (!disposed) session?.refresh();
          return;
        }
        if (event.kind === "verify") {
          post({ type: "verify", message: event.message });
          return;
        }
        post({ type: "failed", reason: event.reason });
      },
    });
  };

  panel.webview.html = HTML;
  panel.webview.onDidReceiveMessage((message: { type?: string; code?: string }) => {
    if (message.type === "refresh") start();
    if (message.type === "manual") options.onManual();
    if (message.type === "verify" && message.code !== undefined) session?.submitVerify(message.code);
  });
  panel.onDidDispose(() => {
    disposed = true;
    session?.dispose();
    session = undefined;
  });

  start();
  return panel;
}