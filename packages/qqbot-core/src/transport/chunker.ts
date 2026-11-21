const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

interface Fence {
  /** 原始围栏（开围栏可能带语言标识，如 ```ts） */
  raw: string;
  /** 纯围栏符号（``` 或 ~~~），用于闭合 */
  marker: string;
}

function fenceOf(line: string): Fence | undefined {
  const m = FENCE.exec(line);
  const marker = m?.[1];
  if (marker === undefined) return undefined;
  const rest = (m?.[2] ?? "").trim();
  return { raw: rest.length > 0 ? `${marker}${rest}` : marker, marker };
}

function isClosingFence(fence: Fence): boolean {
  return fence.raw === fence.marker;
}

function closes(line: string, open: Fence): boolean {
  const fence = fenceOf(line);
  if (fence === undefined || !isClosingFence(fence)) return false;
  return fence.marker[0] === open.marker[0] && fence.marker.length >= open.marker.length;
}

/**
 * Markdown 感知切分。
 *
 * - 按行聚合，避免把段落切碎；
 * - 代码块独立成段，跨段时保留语言标识并自动补闭合围栏；
 * - 单行超过上限时按字符硬切；
 * - 每段长度不超过 limit（围栏开销计入）。
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
  const max = Math.max(1, Math.floor(limit));
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) return [];

  const lines = normalized.split("\n");
  const chunks: string[] = [];

  let buf: string[] = [];
  let len = 0;
  let open: Fence | undefined;

  const joinCost = (): number => (buf.length > 0 ? 1 : 0);
  const hasBody = (): boolean => (open === undefined ? buf.length > 0 : buf.length > 1);

  const startSegment = (): void => {
    buf = open === undefined ? [] : [open.raw];
    len = open === undefined ? 0 : open.raw.length;
  };

  const emit = (final: boolean): void => {
    if (!hasBody() && !final) {
      startSegment();
      return;
    }
    let body = buf.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
    if (body.length > 0 && open !== undefined && !body.endsWith(open.marker)) {
      body = `${body}\n${open.marker}`;
    }
    if (body.trim().length > 0) chunks.push(body);
    startSegment();
  };

  for (const line of lines) {
    const fence = fenceOf(line);
    const opening = fence !== undefined && open === undefined;
    const closing = fence !== undefined && open !== undefined && closes(line, open);

    if (opening && hasBody()) {
      emit(false);
    }

    const projected = len + joinCost() + line.length + (open !== undefined && closing ? open.marker.length + 1 : 0);
    if (projected > max && hasBody()) {
      emit(false);
    }

    if (!hasBody() && len + joinCost() > max) {
      emit(false);
    }

    const room = max - len - joinCost() - (open === undefined ? 0 : open.marker.length + 1);
    if (line.length > Math.max(1, room)) {
      const size = Math.max(1, room);
      for (let i = 0; i < line.length; i += size) {
        if (len + joinCost() + size > max && hasBody()) emit(false);
        buf.push(line.slice(i, i + size));
        len += (buf.length > 1 ? 1 : 0) + Math.min(size, line.length - i);
      }
    } else {
      buf.push(line);
      len += (buf.length > 1 ? 1 : 0) + line.length;
    }

    if (opening) open = fence;
    if (closing) open = undefined;
  }

  emit(true);
  return chunks;
}