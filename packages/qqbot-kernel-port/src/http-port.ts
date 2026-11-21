import { ErrorCode, QqbotError, createNoopLogger } from "@codearts-qqbot/core";
import type { Decision, Logger } from "@codearts-qqbot/core";
import { detectCapabilities } from "./compat.js";
import { isNonTextDelta, normalizeEvent, trackPartType } from "./normalize.js";
import type {
  Capability,
  CreateSessionInput,
  KernelEventHandler,
  KernelInfo,
  KernelPort,
  KernelPortOptions,
  PromptPart,
} from "./port.js";

/**
 * 内核 HTTP 端点。
 *
 * 已由真实内核（126.11.1-20261110192452）实测校准：
 *   POST /session                    创建会话（返回 id/slug/version/directory）
 *   GET  /session/{id}               查询会话
 *   POST /session/{id}/message       发送消息（parts）
 *   GET  /event?directory=...        SSE 事件流
 *   GET  /global/health              健康检查
 *   GET  /config                     配置（agents/providers）
 *   GET  /doc                        OpenAPI（不含 session 路由）
 *
 * 目录作用域通过 `?directory=` 查询参数传递（实测有效），
 * 同时保留 `x-opencode-directory` 头以兼容旧实现。
 */
export interface KernelHttpPaths {
  info: string;
  create: string;
  session: (id: string) => string;
  prompt: (id: string) => string;
  compact: (id: string) => string;
  model: (id: string) => string;
  permission: (id: string, requestId: string) => string;
  events: string;
}

export const DEFAULT_HTTP_PATHS: KernelHttpPaths = {
  info: "/global/health",
  create: "/session",
  session: (id) => `/session/${encodeURIComponent(id)}`,
  prompt: (id) => `/session/${encodeURIComponent(id)}/message`,
  compact: (id) => `/session/${encodeURIComponent(id)}/compact`,
  model: (id) => `/session/${encodeURIComponent(id)}/model`,
  permission: (id, requestId) =>
    `/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(requestId)}`,
  events: "/event",
};

export interface KernelBasicAuth {
  username: string;
  password: string;
}

export interface HttpKernelOptions extends KernelPortOptions {
  baseUrl: string;
  directory: string;
  basicAuth?: KernelBasicAuth;
  token?: string;
  paths?: Partial<KernelHttpPaths>;
  timeoutMs?: number;
  /** 发送消息的单独超时：模型/多步可能远超普通请求 */
  promptTimeoutMs?: number;
  reconnect?: { initialMs: number; maxMs: number };
  /** 显式模型：auto-router 在部分场景会选择不可用的 speed 模型 */
  model?: { providerID: string; modelID: string };
  agent?: string;
}

interface HealthPayload {
  healthy?: boolean;
}

interface ConfigPayload {
  agent?: Record<string, unknown>;
  provider?: Record<string, unknown>;
}

interface SessionPayload {
  id?: string;
  session?: { id?: string };
  version?: string;
}

const ALL_CAPABILITIES: Capability[] = [
  "session.create",
  "session.resume",
  "session.exists",
  "prompt",
  "event.stream",
  "event.delta",
  "compact",
  "model.set",
  "permission",
  "deliverable",
];

/**
 * HTTP + SSE 实现。
 *
 * 设计约束：
 * - 只连回环地址；
 * - 目录作用域显式传递；
 * - 事件流断线自动重连，不缓存历史；
 * - 端点路径与鉴权方式可注入，便于内核升级后快速适配。
 */
export class HttpKernelPort implements KernelPort {
  private readonly logger: Logger;
  private readonly baseUrl: string;
  private readonly directory: string;
  private readonly basicAuth: KernelBasicAuth | undefined;
  private readonly token: string | undefined;
  private readonly paths: KernelHttpPaths;
  private readonly timeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly reconnectCfg: { initialMs: number; maxMs: number };
  private readonly model: { providerID: string; modelID: string } | undefined;
  private readonly agent: string | undefined;
  /** partID → part.type，用于过滤 reasoning 等非正文增量 */
  private readonly partTypes = new Map<string, string>();
  private streamReady = false;
  private streamReadyResolve: ((ok: boolean) => void) | undefined;
  private readonly handlers = new Set<KernelEventHandler>();
  private capabilities: Set<Capability> = new Set();
  private version = "unknown";
  private abort: AbortController | undefined;
  private closed = false;
  private connecting: Promise<void> | undefined;

  constructor(options: HttpKernelOptions) {
    this.logger = options.logger ?? createNoopLogger();
    const url = new URL(options.baseUrl);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
      throw new QqbotError(ErrorCode.CONFIG_INVALID, "kernel endpoint must be loopback");
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.directory = options.directory;
    this.basicAuth = options.basicAuth;
    this.token = options.token;
    this.paths = { ...DEFAULT_HTTP_PATHS, ...(options.paths ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 300000;
    this.reconnectCfg = options.reconnect ?? { initialMs: 1000, maxMs: 30000 };
    this.model = options.model;
    this.agent = options.agent;
  }

  private authorization(): string | undefined {
    if (this.basicAuth !== undefined) {
      const raw = `${this.basicAuth.username}:${this.basicAuth.password}`;
      return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
    }
    return this.token === undefined ? undefined : `Bearer ${this.token}`;
  }

  private headers(accept = "application/json"): Record<string, string> {
    const auth = this.authorization();
    return {
      "content-type": "application/json",
      accept,
      "x-opencode-directory": this.directory,
      ...(auth === undefined ? {} : { authorization: auth }),
    };
  }

  private url(path: string): string {
    const sep = path.includes("?") ? "&" : "?";
    return `${this.baseUrl}${path}${sep}directory=${encodeURIComponent(this.directory)}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url(path), {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const trimmed = detail.slice(0, 300);
        if (res.status === 404) throw new QqbotError(ErrorCode.SESSION_RESUME_FAILED, `${method} ${path} -> 404`, { cause: trimmed });
        if (res.status === 401) throw new QqbotError(ErrorCode.CREDENTIAL_INVALID, `${method} ${path} -> 401`);
        throw new QqbotError(ErrorCode.KERNEL_NOT_READY, `${method} ${path} -> ${res.status}`, {
          retryable: res.status >= 500,
          cause: trimmed,
        });
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text.length === 0 ? undefined : JSON.parse(text)) as T;
    } catch (err) {
      if (err instanceof QqbotError) throw err;
      throw new QqbotError(ErrorCode.KERNEL_NOT_READY, `${method} ${path} failed`, { retryable: true, cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async info(): Promise<KernelInfo> {
    const health = await this.request<HealthPayload>("GET", this.paths.info);
    if (health?.healthy === false) {
      throw new QqbotError(ErrorCode.KERNEL_NOT_READY, "kernel reports unhealthy");
    }

    let agentIds: string[] = [];
    let providers: string[] = [];
    try {
      const config = await this.request<ConfigPayload>("GET", "/config");
      agentIds = Object.keys(config?.agent ?? {});
      providers = Object.keys(config?.provider ?? {});
    } catch (err) {
      this.logger.warn("read kernel config failed", { err: String(err) });
    }

    this.capabilities = new Set(ALL_CAPABILITIES);
    return {
      version: this.version,
      endpoint: this.baseUrl,
      capabilities: this.capabilities,
      agentIds,
      providers,
    };
  }

  async health(): Promise<boolean> {
    try {
      const health = await this.request<HealthPayload>("GET", this.paths.info);
      return health?.healthy !== false;
    } catch {
      return false;
    }
  }

  async createSession(input: CreateSessionInput): Promise<{ id: string }> {
    const res = await this.request<SessionPayload>("POST", this.paths.create, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    });
    const id = res?.id ?? res?.session?.id;
    if (id === undefined) throw new QqbotError(ErrorCode.SESSION_CREATE_FAILED, "response has no session id");
    if (typeof res?.version === "string" && res.version.length > 0) this.version = res.version;
    return { id };
  }

  async resumeSession(id: string): Promise<{ id: string }> {
    const res = await this.request<SessionPayload>("GET", this.paths.session(id));
    return { id: res?.id ?? id };
  }

  async sessionExists(id: string): Promise<boolean | undefined> {
    try {
      await this.request("GET", this.paths.session(id));
      return true;
    } catch (err) {
      if (err instanceof QqbotError && err.code === ErrorCode.SESSION_RESUME_FAILED) return false;
      return undefined;
    }
  }

  async prompt(id: string, parts: PromptPart[]): Promise<void> {
    const payload = parts.map((p) =>
      p.kind === "text"
        ? { type: "text", text: p.text }
        : { type: "file", url: p.path, ...(p.mime === undefined ? {} : { mime: p.mime }) },
    );
    await this.request(
      "POST",
      this.paths.prompt(id),
      {
        parts: payload,
        ...(this.model === undefined ? {} : { model: this.model }),
        ...(this.agent === undefined ? {} : { agent: this.agent }),
      },
      this.promptTimeoutMs,
    );
  }

  subscribe(handler: KernelEventHandler): () => void {
    this.handlers.add(handler);
    if (this.connecting === undefined) {
      this.abort = new AbortController();
      this.connecting = this.consume(this.abort.signal).finally(() => {
        this.connecting = undefined;
      });
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  async waitStreamReady(timeoutMs = 3000): Promise<boolean> {
    if (this.streamReady) return true;
    return new Promise<boolean>((resolve) => {
      this.streamReadyResolve = resolve;
      const timer = setTimeout(() => {
        if (this.streamReadyResolve === resolve) this.streamReadyResolve = undefined;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private markStreamReady(): void {
    if (this.streamReady) return;
    this.streamReady = true;
    const resolve = this.streamReadyResolve;
    this.streamReadyResolve = undefined;
    resolve?.(true);
  }

  private async consume(signal: AbortSignal): Promise<void> {
    let backoff = this.reconnectCfg.initialMs;
    while (!this.closed && !signal.aborted) {
      try {
        await this.consumeOnce(signal);
        backoff = this.reconnectCfg.initialMs;
      } catch (err) {
        if (this.closed || signal.aborted) return;
        this.logger.warn("kernel event stream disconnected", { err: String(err), backoff });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, this.reconnectCfg.maxMs);
      }
    }
  }

  private async consumeOnce(signal: AbortSignal): Promise<void> {
    const res = await fetch(this.url(this.paths.events), {
      headers: this.headers("text/event-stream"),
      signal,
    });
    if (!res.ok || res.body === null) throw new Error(`event stream ${res.status}`);
    this.markStreamReady();


    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        this.handleFrame(frame);
        idx = buffer.indexOf("\n\n");
      }
    }
  }

  private handleFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    trackPartType(payload, this.partTypes);
    if (isNonTextDelta(payload, this.partTypes)) return;
    const event = normalizeEvent(payload, { sessionId: this.guessSessionId(payload) });
    if (event === undefined) return;
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        this.logger.error("kernel event handler failed", { err: String(err) });
      }
    }
  }

  private guessSessionId(payload: unknown): string | undefined {
    if (payload === null || typeof payload !== "object") return undefined;
    const rec = payload as Record<string, unknown>;
    const props = rec["properties"];
    if (props !== null && typeof props === "object") {
      const p = props as Record<string, unknown>;
      if (typeof p["sessionID"] === "string") return p["sessionID"];
    }
    return typeof rec["sessionID"] === "string" ? rec["sessionID"] : undefined;
  }

  async compact(id: string): Promise<void> {
    await this.request("POST", this.paths.compact(id), {});
  }

  async setModel(id: string, provider: string, model: string): Promise<void> {
    await this.request("POST", this.paths.model(id), { provider, model });
  }

  async respondPermission(id: string, requestId: string, decision: Decision): Promise<void> {
    await this.request("POST", this.paths.permission(id, requestId), { decision });
  }

  async respondQuestion(_sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    await this.request("POST", `/question/${encodeURIComponent(requestId)}/reply`, { answers });
  }

  async cancel(id: string): Promise<void> {
    await this.request("POST", "/session/" + encodeURIComponent(id) + "/abort", {});
  }

  async disposeSession(id: string): Promise<void> {
    try {
      await this.request("DELETE", this.paths.session(id));
    } catch (err) {
      this.logger.warn("dispose session failed", { id, err: String(err) });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
    this.handlers.clear();
  }
}