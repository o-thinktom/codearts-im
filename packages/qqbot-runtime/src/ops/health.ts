import { createNoopLogger } from "@codearts-qqbot/core";
import type { Logger } from "@codearts-qqbot/core";

export type HealthState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  threshold?: number;
  openMs?: number;
  probe?: () => Promise<boolean>;
  logger?: Logger;
  now?: () => number;
}

/**
 * 内核健康熔断器：
 * CLOSED（正常）→ 连续失败 threshold 次 → OPEN（拒绝新请求）
 * → 冷却 openMs → HALF_OPEN（放行一次探测）→ 成功回 CLOSED / 失败回 OPEN。
 */
export class CircuitBreaker {
  private stateValue: HealthState = "CLOSED";
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly probe: (() => Promise<boolean>) | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.openMs = options.openMs ?? 10000;
    this.logger = options.logger ?? createNoopLogger();
    this.now = options.now ?? (() => Date.now());
    this.probe = options.probe;
  }

  get state(): HealthState {
    if (this.stateValue === "OPEN" && this.now() - this.openedAt >= this.openMs) {
      this.stateValue = "HALF_OPEN";
    }
    return this.stateValue;
  }

  get allowed(): boolean {
    return this.state !== "OPEN";
  }

  recordSuccess(): void {
    this.failures = 0;
    if (this.stateValue !== "CLOSED") {
      this.logger.info("kernel circuit closed");
    }
    this.stateValue = "CLOSED";
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.stateValue = "OPEN";
      this.openedAt = this.now();
      this.logger.warn("kernel circuit opened", { failures: this.failures });
    }
  }

  async guard<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === "OPEN") {
      throw new Error("kernel circuit is open");
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  async tick(): Promise<HealthState> {
    if (this.state !== "HALF_OPEN" || this.probe === undefined) return this.state;
    const ok = await this.probe().catch(() => false);
    if (ok) this.recordSuccess();
    else this.recordFailure();
    return this.state;
  }
}

export interface WatchdogOptions {
  intervalMs?: number;
  check: () => Promise<boolean>;
  onUnhealthy: (consecutive: number) => void | Promise<void>;
  logger?: Logger;
}

export class Watchdog {
  private timer: NodeJS.Timeout | undefined;
  private consecutive = 0;

  constructor(private readonly opts: WatchdogOptions) {}

  start(): void {
    if (this.timer !== undefined) return;
    const interval = this.opts.intervalMs ?? 30000;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, interval);
    this.timer.unref?.();
  }

  async runOnce(): Promise<void> {
    const ok = await this.opts.check().catch(() => false);
    if (ok) {
      this.consecutive = 0;
      return;
    }
    this.consecutive += 1;
    this.opts.logger?.warn("health check failed", { consecutive: this.consecutive });
    await this.opts.onUnhealthy(this.consecutive);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}