import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { createNoopLogger } from "@codearts-qqbot/core";
import type { Logger } from "@codearts-qqbot/core";

export interface FileLoggerOptions {
  /** 单文件上限，默认 4MB */
  maxBytes?: number;
  /** 保留的历史文件数量（含当前文件），默认 5 */
  keepFiles?: number;
  now?: () => Date;
}

const FILE_NAME = "sidecar.log";

/**
 * 把 sidecar 日志镜像到 `dataDir/logs/sidecar.log`，便于问题现场取证。
 *
 * 采用同步追加：日志量小，但能保证崩溃现场已落盘；写失败一律静默，
 * 不因日志影响主流程。调用方传入的字段已脱敏。
 */
export function createFileLogger(dir: string, options: FileLoggerOptions = {}): Logger {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const keepFiles = Math.max(1, options.keepFiles ?? 5);
  const now = options.now ?? (() => new Date());
  const file = path.join(dir, FILE_NAME);

  const rotate = (): void => {
    try {
      for (let i = keepFiles - 1; i >= 1; i -= 1) {
        const from = `${file}.${i}`;
        if (!existsSync(from)) continue;
        if (i === keepFiles - 1) {
          rmSync(from, { force: true });
        } else {
          renameSync(from, `${file}.${i + 1}`);
        }
      }
      if (existsSync(file)) renameSync(file, `${file}.1`);
    } catch {
      // 轮转失败时继续追加当前文件
    }
  };

  const write = (level: string, message: string, fields?: Record<string, unknown>): void => {
    try {
      mkdirSync(dir, { recursive: true });
      const line = `${JSON.stringify({ ts: now().toISOString(), level, msg: message, ...fields })}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (existsSync(file) && statSync(file).size + bytes > maxBytes) rotate();
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // 日志失败不影响主流程
    }
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

/** 同时写控制台与文件 */
export function teeLogger(primary: Logger, secondary: Logger): Logger {
  return {
    debug: (message, fields) => {
      primary.debug(message, fields);
      secondary.debug(message, fields);
    },
    info: (message, fields) => {
      primary.info(message, fields);
      secondary.info(message, fields);
    },
    warn: (message, fields) => {
      primary.warn(message, fields);
      secondary.warn(message, fields);
    },
    error: (message, fields) => {
      primary.error(message, fields);
      secondary.error(message, fields);
    },
  };
}

/** 读取日志尾部（含轮转文件），按时间顺序返回 */
export function readLogTail(dir: string, lines = 200): string[] {
  const limit = Math.max(1, Math.min(lines, 2000));
  const file = path.join(dir, FILE_NAME);
  const ordered: string[] = [];
  for (let i = 9; i >= 1; i -= 1) {
    const candidate = `${file}.${i}`;
    if (existsSync(candidate)) ordered.push(candidate);
  }
  if (existsSync(file)) ordered.push(file);

  const collected: string[] = [];
  for (const candidate of ordered) {
    try {
      const content = readFileSync(candidate, "utf8");
      const parts = content.split(/\r?\n/).filter((line) => line.length > 0);
      collected.push(...parts);
    } catch {
      // 单个文件读取失败时跳过
    }
  }
  return collected.slice(-limit);
}

/** 不带字段的静默 logger，供测试或无日志场景复用 */
export const silentLogger: Logger = createNoopLogger();