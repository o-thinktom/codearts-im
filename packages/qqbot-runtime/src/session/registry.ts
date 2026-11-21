import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ErrorCode, QqbotError, createNoopLogger } from "@codearts-qqbot/core";
import type { ChatScope, ImChannel, Logger } from "@codearts-qqbot/core";
import type { KernelPort } from "@codearts-qqbot/kernel-port";

export interface PeerRecord {
  sessionKey: string;
  kernelSessionId: string;
  scope: ChatScope;
  peerId: string;
  senderId: string;
  createdAt: number;
  lastActiveAt: number;
  agent?: string;
  provider?: string;
  model?: string;
}

export interface PrefsFile {
  version: 1;
  appId: string;
  peers: Record<string, PeerRecord>;
}

export interface PrefsStore {
  load(): Promise<PrefsFile>;
  save(prefs: PrefsFile): Promise<void>;
}

export class MemoryPrefsStore implements PrefsStore {
  private data: PrefsFile;

  constructor(appId = "test-app") {
    this.data = { version: 1, appId, peers: {} };
  }

  async load(): Promise<PrefsFile> {
    return structuredClone(this.data);
  }

  async save(prefs: PrefsFile): Promise<void> {
    this.data = structuredClone(prefs);
  }
}

export class FilePrefsStore implements PrefsStore {
  constructor(
    private readonly file: string,
    private readonly appId: string,
  ) {}

  async load(): Promise<PrefsFile> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<PrefsFile>;
      if (parsed.version !== 1 || typeof parsed.peers !== "object" || parsed.peers === null) {
        throw new Error("invalid prefs shape");
      }
      return { version: 1, appId: this.appId, peers: parsed.peers as Record<string, PeerRecord> };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { version: 1, appId: this.appId, peers: {} };
      try {
        await rename(this.file, `${this.file}.corrupt.${Date.now()}`);
      } catch {
        // 备份失败不阻塞启动
      }
      return { version: 1, appId: this.appId, peers: {} };
    }
  }

  async save(prefs: PrefsFile): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(prefs, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export interface SessionRegistryOptions {
  port: KernelPort;
  /** 渠道；缺省 qq。QQ 保持 `qqbot:` 前缀以兼容既有 prefs */
  channel?: ImChannel;
  prefs: PrefsStore;
  appId: string;
  workspace: string;
  agent?: string;
  provider?: string;
  model?: string;
  idleTimeoutMs?: number;
  evictIntervalMs?: number;
  logger?: Logger;
  now?: () => number;
}

export function sessionKeyOf(appId: string, scope: ChatScope, peerId: string): string;
export function sessionKeyOf(channel: ImChannel, appId: string, scope: ChatScope, peerId: string): string;
export function sessionKeyOf(a: string, b: string, c?: string, d?: string): string {
  if (d !== undefined && c !== undefined) {
    const channel = a as ImChannel;
    // QQ 保持历史前缀 qqbot:，避免升级后已有会话失效
    return channel === "qq" ? `qqbot:${b}:${c}:${d}` : `${channel}:${b}:${c}:${d}`;
  }
  return `qqbot:${a}:${b}:${c ?? ""}`;
}

/**
 * peer → 内核会话 的映射与生命周期。
 *
 * 恢复策略（与 dsh-qqbot 对齐）：
 *   进程内命中 → prefs 恢复 → 新建
 * 恢复失败时只有"确认不存在"才允许新建，否则 fail-loud，
 * 防止同一 sessionId 被写入多个 project 目录。
 */
export class SessionRegistry {
  private readonly records = new Map<string, PeerRecord>();
  private readonly inflight = new Map<string, Promise<PeerRecord>>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly channel: ImChannel;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: SessionRegistryOptions) {
    this.logger = opts.logger ?? createNoopLogger();
    this.now = opts.now ?? (() => Date.now());
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    this.channel = opts.channel ?? "qq";
  }

  get size(): number {
    return this.records.size;
  }

  find(sessionKey: string): PeerRecord | undefined {
    return this.records.get(sessionKey);
  }

  findByKernelId(kernelSessionId: string): PeerRecord | undefined {
    for (const r of this.records.values()) {
      if (r.kernelSessionId === kernelSessionId) return r;
    }
    return undefined;
  }

  list(): PeerRecord[] {
    return [...this.records.values()];
  }

  async getOrCreate(scope: ChatScope, peerId: string, senderId: string): Promise<PeerRecord> {
    const key = sessionKeyOf(this.channel, this.opts.appId, scope, peerId);
    const existing = this.records.get(key);
    if (existing) {
      existing.lastActiveAt = this.now();
      return existing;
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = this.open(key, scope, peerId, senderId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async open(key: string, scope: ChatScope, peerId: string, senderId: string): Promise<PeerRecord> {
    const prefs = await this.opts.prefs.load();
    const persisted = prefs.peers[key];
    const base = {
      sessionKey: key,
      scope,
      peerId,
      senderId,
      createdAt: this.now(),
      lastActiveAt: this.now(),
      ...(this.opts.agent === undefined ? {} : { agent: this.opts.agent }),
      ...(this.opts.provider === undefined ? {} : { provider: this.opts.provider }),
      ...(this.opts.model === undefined ? {} : { model: this.opts.model }),
    };

    let kernelSessionId: string;

    if (persisted) {
      try {
        const resumed = await this.opts.port.resumeSession(persisted.kernelSessionId);
        kernelSessionId = resumed.id;
        this.logger.info("session resumed", { sessionKey: key, sessionId: kernelSessionId });
      } catch (err) {
        const exists = await this.opts.port.sessionExists(persisted.kernelSessionId);
        if (exists === true) {
          throw new QqbotError(ErrorCode.SESSION_RESUME_FAILED, `session ${persisted.kernelSessionId} exists but resume failed`, {
            cause: err,
          });
        }
        if (exists === undefined) {
          this.logger.warn("session existence unknown, creating new session", { sessionKey: key });
        }
        const created = await this.opts.port.createSession({
          cwd: this.opts.workspace,
          ...(this.opts.agent === undefined ? {} : { agent: this.opts.agent }),
        });
        kernelSessionId = created.id;
        this.logger.info("session created after resume failure", { sessionKey: key, sessionId: kernelSessionId });
      }
    } else {
      const created = await this.opts.port.createSession({
        cwd: this.opts.workspace,
        ...(this.opts.agent === undefined ? {} : { agent: this.opts.agent }),
      });
      kernelSessionId = created.id;
      this.logger.info("session created", { sessionKey: key, sessionId: kernelSessionId });
    }

    const record: PeerRecord = { ...base, kernelSessionId };
    this.records.set(key, record);

    prefs.peers[key] = record;
    await this.opts.prefs.save(prefs);
    return record;
  }

  async remove(scope: ChatScope, peerId: string): Promise<void> {
    const key = sessionKeyOf(this.channel, this.opts.appId, scope, peerId);
    const record = this.records.get(key);
    this.records.delete(key);
    const prefs = await this.opts.prefs.load();
    delete prefs.peers[key];
    await this.opts.prefs.save(prefs);
    if (record) await this.opts.port.disposeSession(record.kernelSessionId).catch(() => undefined);
  }

  startIdleEvictor(): void {
    if (this.timer !== undefined) return;
    const interval =
      this.opts.evictIntervalMs ?? Math.min(Math.max(Math.floor(this.idleTimeoutMs / 4), 5000), 60000);
    this.timer = setInterval(() => {
      void this.evictIdle();
    }, interval);
    this.timer.unref?.();
  }

  private async evictIdle(): Promise<void> {
    const deadline = this.now() - this.idleTimeoutMs;
    for (const [key, record] of [...this.records.entries()]) {
      if (record.lastActiveAt > deadline) continue;
      this.records.delete(key);
      this.logger.info("session evicted", { sessionKey: key, sessionId: record.kernelSessionId });
      await this.opts.port.disposeSession(record.kernelSessionId).catch(() => undefined);
    }
  }

  async disposeAll(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const records = [...this.records.values()];
    this.records.clear();
    await Promise.allSettled(records.map((r) => this.opts.port.disposeSession(r.kernelSessionId)));
  }
}