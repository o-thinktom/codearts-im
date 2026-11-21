import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ErrorCode, QqbotError } from "@codearts-qqbot/core";

export const CREDENTIAL_KEYS = {
  appId: "qqbot/app-id",
  appSecret: "qqbot/app-secret",
  ipcToken: "qqbot/ipc-token",
} as const;

export interface CredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

interface FileShape {
  version: 1;
  entries: Record<string, string>;
}

/**
 * 兜底实现：0600 文件。
 *
 * 生产环境必须替换为 DPAPI（Windows）/ Keychain（macOS）/ libsecret（Linux）。
 * 当前实现只用于开发与无系统密钥库的环境，并在启动时给出显式告警。
 */
export class FileCredentialStore implements CredentialStore {
  private cache: FileShape | undefined;

  constructor(
    private readonly file: string,
    private readonly onInsecureFallback?: () => void,
  ) {}

  private async load(): Promise<FileShape> {
    if (this.cache !== undefined) return this.cache;
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
        throw new Error("invalid credential file");
      }
      this.cache = { version: 1, entries: parsed.entries as Record<string, string> };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        try {
          await rename(this.file, `${this.file}.corrupt.${Date.now()}`);
        } catch {
          // ignore
        }
      }
      this.cache = { version: 1, entries: {} };
      this.onInsecureFallback?.();
    }
    return this.cache;
  }

  async get(key: string): Promise<string | undefined> {
    const data = await this.load();
    return data.entries[key];
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data.entries[key] = value;
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, this.file);
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    delete data.entries[key];
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export async function requireCredential(store: CredentialStore, key: string): Promise<string> {
  const value = await store.get(key);
  if (value === undefined || value.length === 0) {
    throw new QqbotError(ErrorCode.CREDENTIAL_INVALID, `missing credential ${key}`);
  }
  return value;
}