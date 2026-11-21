import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WeixinState {
  version: 1;
  botId?: string;
  getUpdatesBuf: string;
  updatedAt: number;
}

const EMPTY: WeixinState = { version: 1, getUpdatesBuf: "", updatedAt: 0 };

/**
 * iLink 长轮询游标持久化：重启后从上次位置继续，避免漏消息。
 * 采用临时文件 + rename 的原子写策略。
 */
export class WeixinStateStore {
  constructor(private readonly file: string) {}

  async load(): Promise<WeixinState> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<WeixinState>;
      return {
        version: 1,
        ...(typeof parsed.botId === "string" ? { botId: parsed.botId } : {}),
        getUpdatesBuf: typeof parsed.getUpdatesBuf === "string" ? parsed.getUpdatesBuf : "",
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
      try {
        await rename(this.file, `${this.file}.corrupt.${Date.now()}`);
      } catch {
        // 备份失败不阻塞
      }
      return { ...EMPTY };
    }
  }

  async save(state: WeixinState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }

  async setCursor(getUpdatesBuf: string, botId?: string): Promise<void> {
    await this.save({
      version: 1,
      ...(botId === undefined ? {} : { botId }),
      getUpdatesBuf,
      updatedAt: Date.now(),
    });
  }
}