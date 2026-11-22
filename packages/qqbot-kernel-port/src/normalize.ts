import type { Block, KernelEvent, TurnError } from "./port.js";

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

function str(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function num(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function bool(...values: unknown[]): boolean | undefined {
  for (const v of values) {
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

const ALIASES: Record<KernelEvent["type"], string[]> = {
  "turn/start": ["turn/start", "turn.start", "step/start", "session.turn.start", "session/start"],
  "text/delta": ["text/delta", "assistant/chunk", "assistant.delta", "message.delta", "part/delta", "chunk"],
  "message/complete": ["message/complete", "assistant/message", "message.completed", "message/end", "message"],
  "tool/call": ["tool/call", "tool.call", "tool/started", "tool/stated"],
  "tool/result": ["tool/result", "tool.result", "tool/completed", "tool/end"],
  "permission/request": ["permission/request", "permission/asked", "approval/request", "permission"],
  "question/request": [],
  "question/closed": [],
  deliverable: ["deliverable", "deliverables/presented", "file/presented", "deliverable/presented"],
  "turn/end": ["turn/end", "turn.end", "step/end", "session.idle", "session/idle"],
};

function canonicalType(rawType: string): KernelEvent["type"] | undefined {
  for (const [key, list] of Object.entries(ALIASES) as Array<[KernelEvent["type"], string[]]>) {
    if (list.includes(rawType)) return key;
  }
  return undefined;
}

function extractBlocks(raw: Rec): Block[] {
  const content = raw["content"] ?? raw["blocks"] ?? raw["parts"] ?? raw["message"];
  const source = Array.isArray(content) ? content : [];

  const blocks: Block[] = [];
  for (const item of source) {
    if (typeof item === "string") {
      blocks.push({ type: "text", text: item });
      continue;
    }
    const rec = asRec(item);
    if (!rec) continue;
    const type = str(rec["type"]);
    if (type === "reasoning" || rec["synthetic"] === true) continue;
    if (type === "text" || (type === undefined && rec["text"] !== undefined)) {
      const text = str(rec["text"], rec["content"]);
      if (text !== undefined) blocks.push({ type: "text", text, raw: item });
      continue;
    }
    if (type === "tool" || type === "tool-call" || type === "tool_use") {
      blocks.push({ type: "tool", raw: item });
      continue;
    }
    if (type === "image" || type === "file") {
      blocks.push({ type, raw: item });
      continue;
    }
    blocks.push({ type: "unknown", raw: item });
  }

  if (blocks.length === 0) {
    const text = str(raw["text"], raw["content"]);
    if (text !== undefined) blocks.push({ type: "text", text });
  }
  return blocks;
}

function extractReason(raw: Rec): TurnError | undefined {
  const reason = asRec(raw["reason"]);
  const code = str(raw["code"], reason?.["code"]);
  const message = str(raw["message"], reason?.["message"], raw["error"]);
  if (code === undefined && message === undefined) return undefined;
  return { code: code ?? "TURN_ERROR", message: message ?? "unknown" };
}

export interface NormalizeContext {
  sessionId?: string;
  turn?: number;
  attemptId?: string;
}

/**
 * 内核原始事件 → 统一事件。
 *
 * 该函数是"事件映射表"的代码化：只做字段容错与别名匹配，
 * 不做业务判断。未知事件返回 undefined（上层忽略）。
 *
 * 注意：别名表在 P0 阶段按真实内核校准，禁止在业务层猜测事件名。
 */
/**
 * 码道内核真实事件（OpenCode 风格，点号命名 + properties 包装）：
 *   server.connected / session.created / session.updated / session.idle / session.error
 *   message.updated / message.part.updated
 *   permission.asked / permission.updated
 *
 * 一个原始事件可能承载多种语义（如 message.part.updated 既可能是文本增量，
 * 也可能是工具调用），因此统一在此做一次判定。
 */
function dotEvent(rec: Rec, ctx: NormalizeContext): KernelEvent | undefined {
  const rawType = str(rec["type"]);
  if (rawType === undefined || !rawType.includes(".")) return undefined;

  const props = asRec(rec["properties"]) ?? asRec(rec["data"]) ?? rec;
  const info = asRec(props["info"]);
  const part = asRec(props["part"]);
  const sessionId = str(
    props["sessionID"],
    props["sessionId"],
    info?.["id"],
    part?.["sessionID"],
    ctx.sessionId,
  );
  if (sessionId === undefined) return undefined;
  const turn = ctx.turn ?? 0;

  switch (rawType) {
    case "session.idle":
      return { type: "turn/end", sessionId, turn };

    case "session.error": {
      const err = asRec(props["error"]);
      const code = str(err?.["name"], err?.["code"]) ?? "SESSION_ERROR";
      const message = str(err?.["message"], asRec(err?.["data"])?.["message"]) ?? "session error";
      return { type: "turn/end", sessionId, turn, reason: { code, message } };
    }

    case "permission.asked":
    case "permission.updated": {
      const requestId = str(props["id"], props["requestID"], props["permissionID"]);
      if (requestId === undefined) return undefined;
      const action = str(props["permission"], props["type"], props["title"]) ?? "unknown";
      const patterns = Array.isArray(props["patterns"])
        ? props["patterns"].filter((p): p is string => typeof p === "string").join(", ")
        : "";
      const detail = str(props["detail"], props["description"], patterns) ?? "";
      return { type: "permission/request", sessionId, requestId, action, detail };
    }

    case "question.asked": {
      const requestId = str(props["id"], props["requestID"]);
      if (requestId === undefined) return undefined;

      const rawQuestions = Array.isArray(props["questions"]) ? props["questions"] : [];
      const questions = [];
      for (const raw of rawQuestions) {
        const rec = asRec(raw);
        if (rec === undefined) continue;
        const question = str(rec["question"], rec["header"]);
        if (question === undefined) continue;

        const options = [];
        const rawOptions = Array.isArray(rec["options"]) ? rec["options"] : [];
        for (const rawOption of rawOptions) {
          const opt = asRec(rawOption);
          const label = str(opt?.["label"], rawOption);
          if (label === undefined) continue;
          const description = str(opt?.["description"]);
          options.push({ label, ...(description === undefined ? {} : { description }) });
        }

        const header = str(rec["header"]);
        questions.push({ ...(header === undefined ? {} : { header }), question, options });
      }
      if (questions.length === 0) return undefined;
      return { type: "question/request", sessionId, requestId, questions };
    }

    case "question.replied":
    case "question.rejected": {
      const requestId = str(props["id"], props["requestID"]);
      if (requestId === undefined) return undefined;
      return { type: "question/closed", sessionId, requestId };
    }

    case "message.updated": {
      const role = str(info?.["role"]) ?? "assistant";
      if (role === "user") return { type: "turn/start", sessionId, turn };
      const completed = asRec(info?.["time"])?.["completed"];
      if (completed === undefined) return undefined;
      const messageId = str(info?.["id"]);
      return {
        type: "message/complete",
        sessionId,
        turn,
        ...(messageId === undefined ? {} : { messageId }),
        blocks: info === undefined ? [] : extractBlocks(info),
      };
    }

    case "message.part.delta": {
      const field = str(props["field"]);
      if (field !== undefined && field !== "text") return undefined;
      const delta = str(props["delta"], part?.["delta"]);
      const messageID = str(props["messageID"], part?.["messageID"]);
      if (delta === undefined || messageID === undefined) return undefined;
      return { type: "text/delta", sessionId, turn, attemptId: messageID, text: delta };
    }

    case "message.part.updated": {
      if (part === undefined) return undefined;
      const partType = str(part["type"]);

      if (partType === "tool") {
        const callId = str(part["callID"], part["id"]);
        if (callId === undefined) return undefined;
        const state = asRec(part["state"]);
        const status = str(state?.["status"]) ?? "";
        if (status === "running" || status === "pending" || status === "") {
          const name = str(part["tool"], state?.["name"]);
          if (name === undefined) return undefined;
          return { type: "tool/call", sessionId, callId, name, args: state?.["input"] ?? {} };
        }
        const ok = status !== "error";
        const summary = str(state?.["output"], asRec(state?.["metadata"])?.["output"]);
        return { type: "tool/result", sessionId, callId, ok, ...(summary === undefined ? {} : { summary }) };
      }
      return undefined;
    }

    case "round.artifacts.updated": {
      // 内核交付物事件：artifacts[].role 区分 deliverable / generator / intermediate
      const artifacts = Array.isArray(props["artifacts"]) ? props["artifacts"] : [];
      const files = artifacts.flatMap((raw) => {
        const item = asRec(raw);
        if (item === undefined) return [];
        const role = str(item["role"]) ?? "deliverable";
        if (role !== "deliverable") return [];
        const status = str(item["status"]);
        if (status === "deleted" || status === "removed") return [];
        const filePath = str(item["file_path"], item["path"]);
        if (filePath === undefined) return [];
        const name = str(item["file_name"], item["name"]) ?? filePath.split(/[\\/]/).pop() ?? filePath;
        const size = num(item["file_size"], item["size"]);
        return [{ path: filePath, name, ...(size === undefined ? {} : { size }) }];
      });
      if (files.length === 0) return undefined;
      return { type: "deliverable", sessionId, files };
    }

    default:
      return undefined;
  }
}

export function normalizeEvent(raw: unknown, ctx: NormalizeContext = {}): KernelEvent | undefined {
  const rec = asRec(raw);
  if (!rec) return undefined;

  const dot = dotEvent(rec, ctx);
  if (dot !== undefined) return dot;

  const rawType = str(rec["type"], rec["event"], rec["kind"]);
  if (rawType === undefined) return undefined;
  const type = canonicalType(rawType);
  if (type === undefined) return undefined;

  const data = asRec(rec["data"]) ?? rec;
  const session = asRec(rec["session"]) ?? asRec(data["session"]);
  const sessionId =
    ctx.sessionId ??
    str(rec["sessionId"], rec["sessionId"], data["sessionId"], session?.["id"], data["sessionID"]);
  if (sessionId === undefined) return undefined;

  const turn =
    ctx.turn ??
    num(data["turn"], rec["turn"], data["turnIndex"], data["step"]) ?? 0;

  switch (type) {
    case "turn/start":
      return { type, sessionId, turn };

    case "text/delta": {
      const text = str(data["text"], data["delta"], data["chunk"], asRec(data["part"])?.["text"]);
      if (text === undefined) return undefined;
      const attemptId =
        ctx.attemptId ?? str(data["attemptId"], data["attempt"], rec["attemptId"]) ?? `${sessionId}:${turn}`;
      return { type, sessionId, turn, attemptId, text };
    }

    case "message/complete":
      return { type, sessionId, turn, blocks: extractBlocks(data) };

    case "tool/call": {
      const callId = str(data["callId"], data["callID"], data["id"], asRec(data["tool"])?.["callId"]);
      const name = str(data["name"], data["tool"], asRec(data["tool"])?.["name"]);
      if (callId === undefined || name === undefined) return undefined;
      return { type, sessionId, callId, name, args: data["args"] ?? data["input"] ?? data["arguments"] ?? {} };
    }

    case "tool/result": {
      const callId = str(data["callId"], data["callID"], data["id"]);
      if (callId === undefined) return undefined;
      const ok = bool(data["ok"], data["success"], data["isError"] === undefined ? undefined : !data["isError"]) ?? true;
      const summary = str(data["summary"], data["output"], data["result"]);
      return { type, sessionId, callId, ok, ...(summary === undefined ? {} : { summary }) };
    }

    case "permission/request": {
      const requestId = str(data["requestId"], data["requestID"], data["id"]);
      const action = str(data["action"], data["permission"], data["kind"]) ?? "unknown";
      const detail = str(data["detail"], data["title"], data["pattern"], data["description"]) ?? "";
      if (requestId === undefined) return undefined;
      return { type, sessionId, requestId, action, detail };
    }

    case "deliverable": {
      const list = data["files"];
      const files = Array.isArray(list)
        ? list.flatMap((f) => {
            const r = asRec(f);
            const path = str(r?.["path"], f);
            if (path === undefined) return [];
            return [{ path, name: str(r?.["name"]) ?? path.split(/[\\/]/).pop() ?? path }];
          })
        : [];
      if (files.length === 0) return undefined;
      return { type, sessionId, files };
    }

    case "turn/end": {
      const reason = extractReason(data);
      return { type, sessionId, turn, ...(reason === undefined ? {} : { reason }) };
    }
  }
}
/**
 * 记录 part 类型：reasoning 增量同样带 `field: "text"`，
 * 只有 partID → type 映射能区分正文与思维链。
 */
export function trackPartType(payload: unknown, partTypes: Map<string, string>): void {
  const rec = asRec(payload);
  if (rec === undefined || rec["type"] !== "message.part.updated") return;
  const part = asRec(asRec(rec["properties"])?.["part"]);
  if (part === undefined) return;
  const id = str(part["id"]);
  const type = str(part["type"]);
  if (id === undefined || type === undefined) return;
  if (partTypes.size > 5000) partTypes.clear();
  partTypes.set(id, type);
}

/** 非正文（reasoning 等）的增量应丢弃 */
export function isNonTextDelta(payload: unknown, partTypes: Map<string, string>): boolean {
  const rec = asRec(payload);
  if (rec === undefined || rec["type"] !== "message.part.delta") return false;
  const partID = str(asRec(rec["properties"])?.["partID"]);
  if (partID === undefined) return false;
  const type = partTypes.get(partID);
  return type !== undefined && type !== "text";
}