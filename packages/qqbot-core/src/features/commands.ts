export interface CommandSpec {
  name: string;
  aliases: string[];
  usage: string;
  description: string;
  requiresAllowlist: boolean;
}

export const COMMANDS: CommandSpec[] = [
  { name: "new", aliases: ["reset", "clear"], usage: "/new", description: "新建会话", requiresAllowlist: true },
  { name: "compact", aliases: [], usage: "/compact", description: "压缩历史上下文", requiresAllowlist: true },
  { name: "model", aliases: [], usage: "/model [provider/model]", description: "查看或切换模型", requiresAllowlist: true },
  { name: "stop", aliases: [], usage: "/stop", description: "中止当前生成", requiresAllowlist: true },
  { name: "allow", aliases: ["approve", "yes"], usage: "/allow", description: "批准待处理的敏感操作", requiresAllowlist: true },
  { name: "deny", aliases: ["reject", "no"], usage: "/deny", description: "拒绝待处理的敏感操作", requiresAllowlist: true },
  { name: "bot-status", aliases: ["status"], usage: "/bot-status", description: "查看会话与内核状态", requiresAllowlist: false },
  { name: "bot-ping", aliases: ["ping"], usage: "/bot-ping", description: "查看传输与处理时延", requiresAllowlist: false },
  { name: "bot-help", aliases: ["help"], usage: "/bot-help", description: "查看命令清单", requiresAllowlist: false },
];

export interface ParsedCommand {
  name: string;
  spec?: CommandSpec;
  args: string[];
  raw: string;
}

export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1).trim();
  if (!body) return undefined;

  const [head, ...rest] = body.split(/\s+/);
  if (!head) return undefined;
  const lowered = head.toLowerCase();
  const spec = COMMANDS.find((c) => c.name === lowered || c.aliases.includes(lowered));
  return { name: spec?.name ?? lowered, ...(spec ? { spec } : {}), args: rest, raw: trimmed };
}

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cur = dp[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
      prev = cur;
    }
  }
  return dp[cols - 1] ?? Math.max(a.length, b.length);
}

export function suggestCommand(name: string): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const c of COMMANDS) {
    for (const candidate of [c.name, ...c.aliases]) {
      const score = distance(name, candidate);
      if (score <= 2 && (best === undefined || score < best.score)) {
        best = { name: c.name, score };
      }
    }
  }
  return best?.name;
}

export function helpText(): string {
  const lines = ["可用命令："];
  for (const c of COMMANDS) {
    lines.push(`${c.usage} — ${c.description}`);
  }
  return lines.join("\n");
}