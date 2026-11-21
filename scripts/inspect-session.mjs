/**
 * 检查指定会话在内核中的状态、消息与相关日志。
 *
 *   node scripts/inspect-session.mjs <sessionId>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.KERNEL_PORT ?? "22837");
const session = process.argv[2];
if (session === undefined) {
  console.error("usage: node scripts/inspect-session.mjs <sessionId>");
  process.exit(1);
}

const password = readFileSync(".local/kernel-password.txt", "utf8").trim();
const auth = `Basic ${Buffer.from(`codearts:${password}`).toString("base64")}`;
const directory = process.cwd();
const base = `http://127.0.0.1:${port}`;
const clip = (t, n = 1500) => (t.length <= n ? t : `${t.slice(0, n)}…`);

const get = async (p) => {
  const sep = p.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 6000).unref?.();
  const res = await fetch(`${base}${p}${sep}directory=${encodeURIComponent(directory)}`, {
    headers: { authorization: auth },
    signal: ctrl.signal,
  });
  return { status: res.status, text: await res.text() };
};

console.log(`[inspect] kernel=${base} session=${session}`);

for (const p of [`/session/${session}`, `/session/${session}/message`, `/session/${session}/todo`]) {
  try {
    const r = await get(p);
    console.log(`\n[inspect] GET ${p} -> ${r.status}\n${clip(r.text)}`);
  } catch (err) {
    console.log(`\n[inspect] GET ${p} -> ERR ${err instanceof Error ? err.message : String(err)}`);
  }
}

const logDir = path.join(os.homedir(), ".codeartsdoer", "codearts-data", "log");
try {
  const files = readdirSync(logDir)
    .filter((f) => f.startsWith("kernel-") && f.endsWith(".log"))
    .map((f) => ({ f, mtime: statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 2);

  console.log(`\n[inspect] 最近内核日志：${files.map((x) => x.f).join(", ")}`);
  for (const { f } of files) {
    const lines = readFileSync(path.join(logDir, f), "utf8").split(/\r?\n/);
    const hits = lines.filter((l) => l.includes(session) && /error|Error|failed|provider|model|quota|abort/i.test(l));
    console.log(`[inspect] ${f} 命中 ${hits.length} 行`);
    for (const line of hits.slice(-8)) console.log(`  ${line.slice(0, 400)}`);
  }
} catch (err) {
  console.log(`[inspect] 读取日志失败：${err instanceof Error ? err.message : String(err)}`);
}