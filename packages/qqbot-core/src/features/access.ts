import { ErrorCode, QqbotError } from "../errors.js";
import type { AccessConfig, AccessMode, AccessRule, ChatScope, PairingCode } from "../types.js";

export interface AccessStore {
  load(): Promise<AccessConfig>;
  save(next: AccessConfig): Promise<void>;
}

export function emptyAccessConfig(): AccessConfig {
  return {
    revision: 0,
    c2c: { mode: "open", allow: [] },
    group: { mode: "allowlist", allow: [] },
    command: { mode: "allowlist", allow: [] },
    pairing: [],
    revoked: [],
  };
}

export class MemoryAccessStore implements AccessStore {
  private config: AccessConfig;

  constructor(initial?: AccessConfig) {
    this.config = initial ?? emptyAccessConfig();
  }

  async load(): Promise<AccessConfig> {
    return structuredClone(this.config);
  }

  async save(next: AccessConfig): Promise<void> {
    this.config = structuredClone(next);
  }
}

export type PairingFailure = "invalid" | "revoked" | "kind_mismatch" | "exhausted";

export interface PairingResult {
  ok: boolean;
  reason?: PairingFailure;
  config?: AccessConfig;
}

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function defaultCode(): string {
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)] ?? "A";
  }
  return out;
}

/**
 * 访问控制：三模式 + 配对码 + 撤销 + revision 乐观锁。
 *
 * 安全语义：
 * - 撤销优先于放行：撤销名单中的身份即使重新配对也不生效；
 * - 命令权限独立于会话权限；
 * - 任何写操作必须携带期望 revision，冲突返回 QB-6002。
 */
export class AccessController {
  constructor(
    private readonly store: AccessStore,
    private readonly now: () => number = () => Date.now(),
    private readonly genCode: () => string = defaultCode,
    private readonly codeTtlMs: number = DEFAULT_CODE_TTL_MS,
  ) {}

  async list(): Promise<AccessConfig> {
    return this.store.load();
  }

  private isRevoked(cfg: AccessConfig, kind: ChatScope, id: string): boolean {
    return cfg.revoked.some((r) => r.kind === kind && r.id === id);
  }

  private check(rule: AccessRule, cfg: AccessConfig, kind: ChatScope, id: string): boolean {
    if (this.isRevoked(cfg, kind, id)) return false;
    switch (rule.mode) {
      case "open":
        return true;
      case "allowlist":
        return rule.allow.includes(id);
      case "disabled":
        return false;
      default:
        return false;
    }
  }

  async canAccess(kind: ChatScope, id: string): Promise<boolean> {
    const cfg = await this.store.load();
    return this.check(cfg[kind], cfg, kind, id);
  }

  async canRunCommand(id: string): Promise<boolean> {
    const cfg = await this.store.load();
    return this.check(cfg.command, cfg, "c2c", id);
  }

  private assertRevision(cfg: AccessConfig, expected: number | undefined): void {
    if (expected === undefined) return;
    if (cfg.revision !== expected) {
      throw new QqbotError(ErrorCode.REVISION_CONFLICT, `revision ${cfg.revision} != ${expected}`);
    }
  }

  private async mutate(expected: number | undefined, fn: (cfg: AccessConfig) => void): Promise<AccessConfig> {
    const cfg = await this.store.load();
    this.assertRevision(cfg, expected);
    fn(cfg);
    cfg.revision += 1;
    await this.store.save(cfg);
    return cfg;
  }

  async setMode(kind: "c2c" | "group" | "command", mode: AccessMode, expected?: number): Promise<AccessConfig> {
    return this.mutate(expected, (cfg) => {
      cfg[kind].mode = mode;
    });
  }

  async addAllow(kind: "c2c" | "group", id: string, expected?: number): Promise<AccessConfig> {
    return this.mutate(expected, (cfg) => {
      if (!cfg[kind].allow.includes(id)) cfg[kind].allow.push(id);
      cfg.revoked = cfg.revoked.filter((r) => !(r.kind === kind && r.id === id));
    });
  }

  async removeAllow(kind: "c2c" | "group", id: string, expected?: number): Promise<AccessConfig> {
    return this.mutate(expected, (cfg) => {
      cfg[kind].allow = cfg[kind].allow.filter((x) => x !== id);
    });
  }

  async revoke(kind: ChatScope, id: string, expected?: number): Promise<AccessConfig> {
    return this.mutate(expected, (cfg) => {
      cfg.c2c.allow = cfg.c2c.allow.filter((x) => x !== id);
      cfg.group.allow = cfg.group.allow.filter((x) => x !== id);
      if (!cfg.revoked.some((r) => r.kind === kind && r.id === id)) {
        cfg.revoked.push({ kind, id, at: this.now() });
      }
    });
  }

  async createPairing(kind: ChatScope, expected?: number): Promise<PairingCode> {
    const cfg = await this.store.load();
    this.assertRevision(cfg, expected);
    const code = this.genCode();
    const record: PairingCode = { code, kind, createdAt: this.now(), usedBy: [] };
    cfg.pairing = cfg.pairing.filter((p) => this.now() - p.createdAt <= this.codeTtlMs);
    cfg.pairing.push(record);
    cfg.revision += 1;
    await this.store.save(cfg);
    return record;
  }

  async redeemPairing(code: string, kind: ChatScope, id: string, expected?: number): Promise<PairingResult> {
    const cfg = await this.store.load();
    const record = cfg.pairing.find((p) => p.code === code.toUpperCase());
    if (!record) return { ok: false, reason: "invalid" };
    if (record.kind !== kind) return { ok: false, reason: "kind_mismatch" };
    if (this.now() - record.createdAt > this.codeTtlMs) return { ok: false, reason: "invalid" };
    if (this.isRevoked(cfg, kind, id)) return { ok: false, reason: "revoked" };

    this.assertRevision(cfg, expected);
    if (!cfg[kind].allow.includes(id)) cfg[kind].allow.push(id);
    if (!record.usedBy.includes(id)) record.usedBy.push(id);
    cfg.revision += 1;
    await this.store.save(cfg);
    return { ok: true, config: cfg };
  }
}