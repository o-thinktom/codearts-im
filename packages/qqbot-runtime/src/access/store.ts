import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyAccessConfig } from "@codearts-qqbot/core";
import type { AccessConfig, AccessStore } from "@codearts-qqbot/core";

/**
 * 访问控制持久化。
 *
 * 与 prefs.json 同样的原子写策略（临时文件 + rename），
 * 损坏时备份并从空配置启动，避免把机器人锁死。
 */
export class FileAccessStore implements AccessStore {
  constructor(private readonly file: string) {}

  async load(): Promise<AccessConfig> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<AccessConfig>;
      if (typeof parsed.revision !== "number" || parsed.c2c === undefined || parsed.group === undefined) {
        throw new Error("invalid access config");
      }
      return {
        revision: parsed.revision,
        c2c: { mode: parsed.c2c.mode, allow: [...parsed.c2c.allow] },
        group: { mode: parsed.group.mode, allow: [...parsed.group.allow] },
        command: parsed.command === undefined
          ? { mode: "allowlist", allow: [] }
          : { mode: parsed.command.mode, allow: [...parsed.command.allow] },
        pairing: [...(parsed.pairing ?? [])],
        revoked: [...(parsed.revoked ?? [])],
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyAccessConfig();
      try {
        await rename(this.file, `${this.file}.corrupt.${Date.now()}`);
      } catch {
        // 备份失败不阻塞
      }
      return emptyAccessConfig();
    }
  }

  async save(next: AccessConfig): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }
}