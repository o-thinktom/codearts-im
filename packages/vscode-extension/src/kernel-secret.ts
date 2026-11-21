import { createDecipheriv, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 复现码道扩展的口令存储格式，只读取得内核 Basic Auth 口令。
 *
 * 存储布局（dataDir = ~/.codeartsdoer/codearts-data）：
 *   4/data          base64(secret)
 *   1/data          { algorithm: "aes-256-gcm" }
 *   2/data          salt
 *   3/data          iv
 *   custom-dir/data { authTag, ciphertext }
 *
 * 任何一步不匹配都返回 undefined（不抛错、不影响启动），
 * 由调用方回退到手动录入。明文不会写入日志。
 */
const ALGORITHM = "aes-256-gcm";
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

function toBuf(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (Array.isArray(value)) return Buffer.from(value);
  if (value !== null && typeof value === "object") {
    const rec = value as { type?: string; data?: unknown };
    if (rec.type === "Buffer" && Array.isArray(rec.data)) return Buffer.from(rec.data as number[]);
  }
  throw new Error("unknown buffer shape");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function defaultDataDir(): string {
  const fromEnv = process.env.KERNEL_DATA_DIR;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return path.join(os.homedir(), ".codeartsdoer", "codearts-data");
}

export function decryptKernelSecret(dataDir: string = defaultDataDir()): string | undefined {
  const files = {
    secret: path.join(dataDir, "4", "data"),
    meta: path.join(dataDir, "1", "data"),
    salt: path.join(dataDir, "2", "data"),
    iv: path.join(dataDir, "3", "data"),
    cipher: path.join(dataDir, "custom-dir", "data"),
  };

  for (const file of Object.values(files)) {
    if (!existsSync(file)) return undefined;
  }

  try {
    const secret = Buffer.from(readFileSync(files.secret, "utf8").trim(), "base64").toString("utf8");
    const meta = readJson(files.meta) as { algorithm?: string };
    if (meta.algorithm !== ALGORITHM) return undefined;

    const salt = toBuf(readJson(files.salt));
    const iv = toBuf(readJson(files.iv));
    const cipher = readJson(files.cipher) as { authTag?: unknown; ciphertext?: unknown };
    const authTag = toBuf(cipher.authTag);
    const ciphertext = toBuf(cipher.ciphertext);

    const key = scryptSync(secret, salt, 32, SCRYPT);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return plain.length > 0 ? plain : undefined;
  } catch {
    return undefined;
  }
}