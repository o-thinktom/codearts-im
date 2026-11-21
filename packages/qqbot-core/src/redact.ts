const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/("?(?:appSecret|app_secret|secret|password|token|accessToken|access_token|authorization)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi, "$1***"],
  [/(Bot\s+)[A-Za-z0-9._-]{8,}/g, "$1***"],
  [/(Bearer\s+)[A-Za-z0-9._-]{8,}/g, "$1***"],
];

const OPENID = /([A-Za-z0-9]{4})[A-Za-z0-9_-]{8,}([A-Za-z0-9]{4})/g;

export function redactText(input: string): string {
  let out = input;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function maskId(id: string, keep = 4): string {
  if (id.length <= keep * 2) return `${id.slice(0, 1)}***`;
  return `${id.slice(0, keep)}***${id.slice(-keep)}`;
}

export function redactId(input: string): string {
  return input.replace(OPENID, (_m, a: string, b: string) => `${a}***${b}`);
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return redactText(redactId(value));
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|credential/i.test(k)) {
        out[k] = "***";
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}