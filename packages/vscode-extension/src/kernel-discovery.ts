import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DiscoveredKernel {
  baseUrl: string;
  version: string;
  pid: number;
  configPath: string;
}

interface ServerConfig {
  pid?: number;
  port?: number;
  version?: string;
}

function parseProperties(text: string): ServerConfig {
  const out: ServerConfig = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key === "pid") out.pid = Number(value);
    else if (key === "port") out.port = Number(value);
    else if (key === "version") out.version = value;
  }
  return out;
}

/**
 * 发现码道内核的本地端口。
 *
 * 码道把 pid/port/version 写在：
 *   ~/.codeartsdoer/CodeArts_Agent/<Vscode_版本>-<内核版本>/server_config.properties
 *
 * 这里只读取端口与版本，不涉及任何凭据；
 * 是否可连接仍需 Basic Auth（口令由官方接口提供，见方案 A 文档）。
 */
export function discoverKernel(rootOverride?: string): DiscoveredKernel | undefined {
  const root = rootOverride ?? path.join(os.homedir(), ".codeartsdoer", "CodeArts_Agent");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const candidates = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("Vscode_"))
    .map((e) => {
      const dir = path.join(root, e.name);
      const file = path.join(dir, "server_config.properties");
      try {
        const stat = fs.statSync(file);
        return { dir, file, mtime: stat.mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is { dir: string; file: string; mtime: number } => x !== undefined)
    .sort((a, b) => b.mtime - a.mtime);

  for (const candidate of candidates) {
    try {
      const cfg = parseProperties(fs.readFileSync(candidate.file, "utf8"));
      if (cfg.port === undefined || !Number.isFinite(cfg.port) || cfg.port <= 0) continue;
      return {
        baseUrl: `http://127.0.0.1:${cfg.port}`,
        version: cfg.version ?? "unknown",
        pid: cfg.pid ?? 0,
        configPath: candidate.file,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}