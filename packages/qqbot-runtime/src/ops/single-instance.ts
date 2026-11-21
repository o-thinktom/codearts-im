import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface InstanceLock {
  release(): void;
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * appId 级单实例锁。
 *
 * 用 `wx` 原子创建锁文件；若已存在则检查持有进程是否存活，
 * 持有者已死（崩溃残留）时清理并重试一次。
 */
export function acquireInstanceLock(dir: string, tag: string): InstanceLock | undefined {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tag}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", encoding: "utf8" });
      return {
        release(): void {
          try {
            unlinkSync(file);
          } catch {
            // 已被清理
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;

      let pid = 0;
      try {
        pid = Number(readFileSync(file, "utf8").trim());
      } catch {
        pid = 0;
      }
      if (isAlive(pid)) return undefined;

      try {
        unlinkSync(file);
      } catch {
        // 清理失败则退出
      }
    }
  }
  return undefined;
}