import {
  AccessController,
  COMMANDS,
  ErrorCode,
  QqbotError,
  assembleAgentBody,
  createNoopLogger,
  helpText,
  parseCommand,
  suggestCommand,
  toUserText,
} from "@codearts-qqbot/core";
import type { ImChannel, InboundMessage, Logger, ReplyTarget } from "@codearts-qqbot/core";
import type { KernelPort, QuestionItem } from "@codearts-qqbot/kernel-port";
import { normalizeConfig, type RuntimeConfig } from "./config.js";
import { SessionRegistry, sessionKeyOf } from "./session/registry.js";
import { OutboundRouter } from "./transport/outbound.js";
import type { ImAdapter } from "./transport/adapter.js";
import type { InboundSource, ImTransport } from "./transport/outbound-types.js";
import { CircuitBreaker } from "./ops/health.js";
import type { MediaService } from "./media/service.js";

export interface QqbotAppOptions {
  port: KernelPort;
  /** 渠道适配器（推荐）；与 transport+source 二选一 */
  adapter?: ImAdapter;
  transport?: ImTransport;
  source?: InboundSource;
  access: AccessController;
  registry: SessionRegistry;
  config: RuntimeConfig;
  media?: MediaService;
  logger?: Logger;
}

/**
 * 装配层：把"接入 → 鉴权 → 组装 → 会话 → 投递"串成一条可测试的链路。
 *
 * 不直接依赖码道扩展 API，也不直接依赖 QQ SDK，
 * 因此可以在 mock 内核 + mock IM 下端到端验证。
 */
export class QqbotApp {
  private readonly port: KernelPort;
  private readonly transport: ImTransport;
  private readonly source: InboundSource;
  private readonly channel: ImChannel;
  private readonly access: AccessController;
  private readonly registry: SessionRegistry;
  private readonly config: RuntimeConfig;
  private readonly media: MediaService | undefined;
  private readonly logger: Logger;
  private readonly outbound: OutboundRouter;
  private readonly breaker: CircuitBreaker;
  private unsubscribe: (() => void) | undefined;
  private started = false;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private readonly idleWaiters = new Map<string, Array<() => void>>();
  private readonly pendingPermissions = new Map<string, string>();
  private readonly pendingQuestions = new Map<string, { requestId: string; questions: QuestionItem[] }>();

  constructor(options: QqbotAppOptions) {
    const transport = options.adapter ?? options.transport;
    const source = options.adapter ?? options.source;
    if (transport === undefined || source === undefined) {
      throw new QqbotError(ErrorCode.CONFIG_INVALID, "QqbotApp requires adapter or transport+source");
    }
    this.port = options.port;
    this.transport = transport;
    this.source = source;
    this.channel = options.adapter?.id ?? "qq";
    this.access = options.access;
    this.registry = options.registry;
    this.config = normalizeConfig(options.config);
    this.media = options.media;
    this.logger = options.logger ?? createNoopLogger();
    this.outbound = new OutboundRouter({
      transport: this.transport,
      textChunkLimit: options.adapter?.capability.maxChars ?? this.config.textChunkLimit,
      showToolResults: this.config.showToolResults,
      workspace: this.config.workspace,
      logger: this.logger,
    });
    this.breaker = new CircuitBreaker({
      logger: this.logger,
      probe: () => this.port.health(),
      threshold: 3,
      openMs: 10000,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.syncAccessConfig();
    this.unsubscribe = this.port.subscribe((event) => {
      this.outbound.route(event.sessionId, event);
      if (event.type === "permission/request") {
        this.pendingPermissions.set(event.sessionId, event.requestId);
      }
      if (event.type === "question/request") {
        this.pendingQuestions.set(event.sessionId, { requestId: event.requestId, questions: event.questions });
      }
      if (event.type === "question/closed") {
        this.pendingQuestions.delete(event.sessionId);
      }
      if (event.type === "turn/end") {
        this.resolveIdle(event.sessionId);
      }
    });
    this.source.onMessage((message) => this.handleInbound(message));
    if (this.port.waitStreamReady !== undefined) {
      const ready = await this.port.waitStreamReady(3000);
      if (!ready) this.logger.warn("kernel event stream not ready before first message");
    }
    await this.transport.start();
    await this.source.start();
    this.registry.startIdleEvictor();
    this.media?.start();
    this.started = true;
    this.logger.info("qqbot app started", { appId: this.config.appId });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.outbound.flushAll();
    await this.source.stop();
    await this.transport.stop();
    await this.registry.disposeAll();
    this.media?.stop();
    this.logger.info("qqbot app stopped");
  }

  private resolveIdle(sessionId: string): void {
    const waiters = this.idleWaiters.get(sessionId);
    if (waiters === undefined) return;
    this.idleWaiters.delete(sessionId);
    for (const w of waiters) w();
  }

  private waitIdle(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const list = this.idleWaiters.get(sessionId) ?? [];
      const done = (): void => resolve();
      list.push(done);
      this.idleWaiters.set(sessionId, list);
      const timer = setTimeout(() => {
        const current = this.idleWaiters.get(sessionId) ?? [];
        this.idleWaiters.set(
          sessionId,
          current.filter((w) => w !== done),
        );
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private targetOf(msg: InboundMessage): ReplyTarget {
    return { scope: msg.scope, channel: this.channel, targetId: msg.peerId, msgId: msg.messageId };
  }

  /** 把配置里的访问模式同步到访问控制（配置是唯一事实源） */
  private async syncAccessConfig(): Promise<void> {
    const cfg = await this.access.list();
    const desired = {
      c2c: this.config.access.c2cMode,
      group: this.config.access.groupMode,
      command: this.config.access.commandMode,
    } as const;
    for (const kind of ["c2c", "group", "command"] as const) {
      if (cfg[kind].mode !== desired[kind]) {
        await this.access.setMode(kind, desired[kind]);
      }
    }
  }

  /** 命令、配对码、审批/问答回答不进串行队列，避免被正在等待的 prompt 阻塞 */
  private isPriorityMessage(msg: InboundMessage): boolean {
    const text = msg.text.trim();
    if (msg.scope === "c2c" && /^[A-Z0-9]{6}$/.test(text)) return true;
    if (text.startsWith("/")) return true;

    const record = this.registry.find(sessionKeyOf(this.channel, this.config.appId, msg.scope, msg.peerId));
    if (record === undefined) return false;

    if ((text === "1" || text === "2") && this.pendingPermissions.has(record.kernelSessionId)) return true;
    return /^[A-H](?:[;,][A-H])*$/i.test(text) && this.pendingQuestions.has(record.kernelSessionId);
  }

  /** 供测试与 sidecar 直接调用；内部也用于 source.onMessage */
  async handleInbound(msg: InboundMessage): Promise<void> {
    if (this.isPriorityMessage(msg)) {
      await this.process(msg);
      return;
    }

    const key = sessionKeyOf(this.channel, this.config.appId, msg.scope, msg.peerId);
    const running = this.pending.get(key) ?? 0;

    if (running >= this.config.maxQueue) {
      await this.transport.sendText(this.targetOf(msg), toUserText(new QqbotError(ErrorCode.QUEUE_FULL)), "error");
      return;
    }

    this.pending.set(key, running + 1);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(msg))
      .catch((err) => {
        this.logger.error("inbound processing failed", { sessionKey: key, err: String(err) });
        return this.transport.sendText(this.targetOf(msg), toUserText(err), "error");
      })
      .finally(() => {
        const left = (this.pending.get(key) ?? 1) - 1;
        if (left <= 0) this.pending.delete(key);
        else this.pending.set(key, left);
      });
    this.chains.set(key, next);
    await next;
  }

  private async process(msg: InboundMessage): Promise<void> {
    const target = this.targetOf(msg);

    if (msg.scope === "c2c") {
      const code = msg.text.trim();
      if (/^[A-Z0-9]{6}$/.test(code)) {
        const result = await this.access.redeemPairing(code, msg.scope, msg.senderId);
        await this.transport.sendText(
          target,
          result.ok ? "配对成功，已加入白名单。" : "配对码无效、已过期或该身份已被撤销。",
          result.ok ? "notice" : "error",
        );
        return;
      }
    }

    const allowed = await this.access.canAccess(msg.scope, msg.senderId);
    if (!allowed) {
      this.logger.warn("access denied", { scope: msg.scope, senderId: msg.senderId });
      if (msg.scope === "c2c") {
        await this.transport.sendText(target, toUserText(new QqbotError(ErrorCode.ACCESS_DENIED)), "error");
      }
      return;
    }

    if (msg.scope === "group" && this.config.requireMention && !msg.mentioned) {
      return;
    }

    const decision = msg.text.trim();
    if (decision === "1" || decision === "2") {
      const record = this.registry.find(sessionKeyOf(this.channel, this.config.appId, msg.scope, msg.peerId));
      const requestId = record === undefined ? undefined : this.pendingPermissions.get(record.kernelSessionId);
      if (record !== undefined && requestId !== undefined) {
        await this.port.respondPermission(record.kernelSessionId, requestId, decision === "1" ? "allow" : "deny");
        this.pendingPermissions.delete(record.kernelSessionId);
        await this.transport.sendText(target, decision === "1" ? "已允许。" : "已拒绝。", "notice");
        return;
      }
    }

    const questionMatch = /^([A-H](?:[;,][A-H])*)$/i.exec(decision);
    if (questionMatch !== null) {
      const record = this.registry.find(sessionKeyOf(this.channel, this.config.appId, msg.scope, msg.peerId));
      const pending = record === undefined ? undefined : this.pendingQuestions.get(record.kernelSessionId);
      if (record !== undefined && pending !== undefined && this.port.respondQuestion !== undefined) {
        const groups = decision
          .toUpperCase()
          .split(";")
          .map((group) => group.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
        const answers = groups.map((letters, index) => {
          const options = pending.questions[index]?.options ?? [];
          return letters
            .map((letter) => options[letter.charCodeAt(0) - 65]?.label)
            .filter((label): label is string => label !== undefined);
        });
        const valid = groups.length === pending.questions.length && answers.every((a) => a.length > 0);
        if (valid) {
          await this.port.respondQuestion(record.kernelSessionId, pending.requestId, answers);
          this.pendingQuestions.delete(record.kernelSessionId);
          await this.transport.sendText(
            target,
            `已提交选择：${answers.map((a) => a.join("、")).join("；")}`,
            "notice",
          );
          return;
        }
      }
    }

    const command = parseCommand(msg.text);
    if (command !== undefined) {
      await this.handleCommand(command.name, command.args, msg, target);
      return;
    }

    const attachments =
      this.media === undefined || msg.attachments === undefined || !this.config.media.enabled
        ? msg.attachments
        : await this.media.ingest(msg.peerId, msg.messageId, msg.attachments);

    const body = assembleAgentBody(attachments === undefined ? msg : { ...msg, attachments });
    if (body === null) return;

    if (!this.breaker.allowed) {
      await this.transport.sendText(target, toUserText(new QqbotError(ErrorCode.KERNEL_NOT_READY)), "error");
      return;
    }

    const record = await this.registry.getOrCreate(msg.scope, msg.peerId, msg.senderId);
    this.logger.info("inbound accepted", {
      scope: msg.scope,
      peerId: msg.peerId,
      sessionId: record.kernelSessionId,
      length: body.length,
    });
    this.outbound.beginTurn(record.kernelSessionId, target, 0);

    const idle = this.waitIdle(record.kernelSessionId, this.config.processingTimeoutMs);
    this.logger.info("kernel prompt sending", { sessionId: record.kernelSessionId });
    try {
      await this.port.prompt(record.kernelSessionId, [{ kind: "text", text: body }]);
    } catch (err) {
      const retryable = err instanceof QqbotError && err.retryable;
      if (!retryable) throw err;
      this.logger.warn("prompt request interrupted, continue waiting for stream", {
        sessionId: record.kernelSessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    await idle;
  }

  private async handleCommand(name: string, args: string[], msg: InboundMessage, target: ReplyTarget): Promise<void> {
    const spec = COMMANDS.find((c) => c.name === name);
    if (spec === undefined) {
      const suggestion = suggestCommand(name);
      await this.transport.sendText(
        target,
        suggestion === undefined ? `未知命令 /${name}\n\n${helpText()}` : `未知命令 /${name}，你是否想输入 /${suggestion}？`,
        "notice",
      );
      return;
    }

    if (spec.requiresAllowlist) {
      const permitted = await this.access.canRunCommand(msg.senderId);
      if (!permitted) {
        await this.transport.sendText(target, toUserText(new QqbotError(ErrorCode.ACCESS_DENIED)), "error");
        return;
      }
    }

    switch (name) {
      case "bot-help":
        await this.transport.sendText(target, helpText(), "notice");
        return;

      case "bot-ping":
        await this.transport.sendText(target, `pong（会话 ${this.registry.size} 个，内核熔断 ${this.breaker.state}）`, "notice");
        return;

      case "bot-status": {
        const record = this.registry.find(sessionKeyOf(this.channel, this.config.appId, msg.scope, msg.peerId));
        const lines = [
          `在线：${this.source.connected ? "是" : "否"}`,
          `内核：${this.breaker.state}`,
          record === undefined ? "会话：未建立" : `会话：${record.kernelSessionId}`,
          record === undefined ? "" : `最近活跃：${new Date(record.lastActiveAt).toISOString()}`,
        ].filter((l) => l.length > 0);
        await this.transport.sendText(target, lines.join("\n"), "notice");
        return;
      }

      case "new": {
        await this.registry.remove(msg.scope, msg.peerId);
        await this.transport.sendText(target, "已新建会话。", "notice");
        return;
      }

      case "compact": {
        const record = await this.registry.getOrCreate(msg.scope, msg.peerId, msg.senderId);
        await this.port.compact(record.kernelSessionId);
        await this.transport.sendText(target, "已压缩历史上下文。", "notice");
        return;
      }

      case "model": {
        const record = await this.registry.getOrCreate(msg.scope, msg.peerId, msg.senderId);
        if (args.length === 0) {
          await this.transport.sendText(
            target,
            record.provider === undefined ? "当前使用码道默认模型。" : `当前模型：${record.provider}/${record.model ?? "default"}`,
            "notice",
          );
          return;
        }
        const [provider, model] = (args[0] ?? "").split("/");
        if (!provider || !model) {
          await this.transport.sendText(target, "格式：/model provider/model", "notice");
          return;
        }
        await this.port.setModel(record.kernelSessionId, provider, model);
        await this.transport.sendText(target, `已切换模型：${provider}/${model}（新会话生效）`, "notice");
        return;
      }

      case "stop": {
        const record = this.registry.find(sessionKeyOf(this.channel, this.config.appId, msg.scope, msg.peerId));
        if (record === undefined) {
          await this.transport.sendText(target, "当前没有运行中的任务。", "notice");
          return;
        }
        if (this.port.cancel !== undefined) await this.port.cancel(record.kernelSessionId);
        this.resolveIdle(record.kernelSessionId);
        await this.transport.sendText(target, "已请求中止当前生成。", "notice");
        return;
      }

      case "allow":
      case "deny": {
        const record = this.registry.find(sessionKeyOf(this.channel, this.config.appId, msg.scope, msg.peerId));
        if (record === undefined) return;
        const requestId = this.pendingPermissions.get(record.kernelSessionId);
        if (requestId === undefined) {
          await this.transport.sendText(target, "当前没有待处理的审批。", "notice");
          return;
        }
        await this.port.respondPermission(record.kernelSessionId, requestId, name === "allow" ? "allow" : "deny");
        this.pendingPermissions.delete(record.kernelSessionId);
        await this.transport.sendText(target, name === "allow" ? "已允许。" : "已拒绝。", "notice");
        return;
      }

      default:
        await this.transport.sendText(target, helpText(), "notice");
    }
  }
}
