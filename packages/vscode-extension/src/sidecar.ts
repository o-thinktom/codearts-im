import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export type SidecarState = "stopped" | "starting" | "running" | "failed";

export interface SidecarStatus {
  state: SidecarState;
  detail?: string;
  restarts: number;
}

const MAX_RESTARTS = 5;
const INITIAL_BACKOFF_MS = 5000;

/**
 * sidecar 守护：拉起、心跳、退避重启、清理。
 *
 * 生产形态：VSIX 内置 `bin/codearts-im-sidecar-<platform>-<arch>[.exe]`；
 * 开发形态：可用 `codeartsIm.sidecarPath` 指向本地脚本。
 */
export class SidecarSupervisor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private restarts = 0;
  private backoff = INITIAL_BACKOFF_MS;
  private stopping = false;
  private lastStatus: SidecarStatus = { state: "stopped", restarts: 0 };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
    private readonly onStatus: (status: SidecarStatus) => void,
    private readonly launchArgs: () => string[] = () => [],
  ) {}

  private publishStatus(status: SidecarStatus): void {
    this.lastStatus = status;
    this.onStatus(status);
  }

  get status(): SidecarStatus {
    return this.lastStatus;
  }

  get binaryPath(): string | undefined {
    return this.resolveBinary();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private resolveBinary(): string | undefined {
    const configured = vscode.workspace.getConfiguration("codeartsIm").get<string>("sidecarPath");
    if (typeof configured === "string" && configured.length > 0) return configured;

    const exe = process.platform === "win32" ? ".exe" : "";
    const candidate = path.join(
      this.context.asAbsolutePath("bin"),
      `codearts-im-sidecar-${process.platform}-${process.arch}${exe}`,
    );
    return fs.existsSync(candidate) ? candidate : undefined;
  }

  start(): void {
    if (this.child !== undefined && this.child.exitCode === null) return;
    this.stopping = false;
    const bin = this.resolveBinary();
    if (bin === undefined) {
      this.publishStatus({ state: "failed", detail: "未找到 sidecar 可执行文件", restarts: this.restarts });
      this.log.appendLine("[codearts-im] sidecar binary not found; set codeartsIm.sidecarPath for development");
      return;
    }

    this.publishStatus({ state: "starting", restarts: this.restarts });
    const child = spawn(bin, this.launchArgs(), {
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, CODEARTS_IM_DATA: path.join(this.context.globalStorageUri.fsPath, "codearts-im") },
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.log.append(chunk));
    child.stderr.on("data", (chunk: string) => this.log.append(chunk));

    child.on("spawn", () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.publishStatus({ state: "running", restarts: this.restarts });
      this.log.appendLine(`[codearts-im] sidecar started: ${bin}`);
      const stable = setTimeout(() => {
        this.restarts = 0;
        this.publishStatus({ state: "running", restarts: 0 });
      }, 60000);
      stable.unref?.();
    });

    child.on("error", (err) => {
      if (child !== this.child) return;
      this.log.appendLine(`[codearts-im] sidecar error: ${err.message}`);
      this.publishStatus({ state: "failed", detail: err.message, restarts: this.restarts });
    });

    child.on("exit", (code, signal) => {
      // restart()/stop() 会先清空 this.child；旧进程的退出不得触发新一轮重启
      if (child !== this.child) {
        this.log.appendLine(`[codearts-im] stale sidecar exited code=${code ?? "null"} signal=${signal ?? "null"} (ignored)`);
        return;
      }
      this.stopHeartbeat();
      this.child = undefined;
      if (this.stopping) {
        this.publishStatus({ state: "stopped", restarts: this.restarts });
        return;
      }
      this.log.appendLine(`[codearts-im] sidecar exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.publishStatus({ state: "failed", detail: `退出码 ${code ?? signal ?? "unknown"}`, restarts: this.restarts });
      this.scheduleRestart();
    });

    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.child === undefined || this.child.exitCode !== null) {
        this.log.appendLine("[codearts-im] heartbeat lost");
        this.scheduleRestart();
      }
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer !== undefined) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.log.appendLine("[codearts-im] restart budget exhausted");
      this.publishStatus({ state: "failed", detail: "重启次数已达上限", restarts: this.restarts });
      return;
    }
    const delay = this.backoff;
    this.restarts += 1;
    this.backoff = Math.min(this.backoff * 2, 60000);
    this.log.appendLine(`[codearts-im] restarting in ${delay}ms (attempt ${this.restarts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.stopHeartbeat();
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null) {
      child.kill();
    }
    this.publishStatus({ state: "stopped", restarts: this.restarts });
  }

  restart(): void {
    this.stop();
    this.stopping = false;
    this.restarts = 0;
    this.backoff = INITIAL_BACKOFF_MS;
    // 等旧进程释放命名管道后再拉起，避免新进程撞上 EADDRINUSE
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.start();
    }, 300);
  }
}