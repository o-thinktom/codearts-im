/**
 * 只读解密：复现码道扩展的口令存储格式，取出内核 Basic Auth 口令。
 *
 * 存储布局（KERNEL_DATA_DIR = ~/.codeartsdoer/codearts-data）：
 *   4/data               -> base64 的 scrypt secret
 *   1/data               -> { algorithm: "aes-256-gcm" }
 *   2/data               -> salt（Buffer JSON）
 *   3/data               -> iv（Buffer JSON）
 *   custom-dir/data      -> { authTag, ciphertext }
 *
 * 明文只写入 .local/kernel-password.txt（0600），不打印到 stdout。
 *
 *   node scripts/read-kernel-secret.mjs
 */
import { createDecipheriv, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const base = process.env.KERNEL_DATA_DIR ?? path.join(os.homedir(), ".codeartsdoer", "codearts-data");

const toBuf = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (Array.isArray(value)) return Buffer.from(value);
  if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
  throw new Error(`unknown buffer shape: ${String(value).slice(0, 40)}`);
};

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const files = {
  secret: path.join(base, "4", "data"),
  meta: path.join(base, "1", "data"),
  salt: path.join(base, "2", "data"),
  iv: path.join(base, "3", "data"),
  cipher: path.join(base, "custom-dir", "data"),
};

for (const [name, p] of Object.entries(files)) {
  if (!existsSync(p)) {
    console.error(`[secret] missing ${name}: ${p}`);
    process.exit(1);
  }
}

const secret = Buffer.from(readFileSync(files.secret, "utf8").trim(), "base64").toString("utf8");
const meta = readJson(files.meta);
const salt = toBuf(readJson(files.salt));
const iv = toBuf(readJson(files.iv));
const cipher = readJson(files.cipher);
const authTag = toBuf(cipher.authTag);
const ciphertext = toBuf(cipher.ciphertext);

console.log(
  `[secret] base=${base} algorithm=${meta.algorithm} salt=${salt.length}B iv=${iv.length}B tag=${authTag.length}B cipher=${ciphertext.length}B`,
);

if (meta.algorithm !== "aes-256-gcm") {
  console.error(`[secret] unexpected algorithm: ${meta.algorithm}`);
  process.exit(2);
}

const key = scryptSync(secret, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(authTag);

let plain;
try {
  plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
} catch (err) {
  console.error(`[secret] decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(3);
}

const masked = plain.length <= 6 ? "******" : `${plain.slice(0, 4)}***${plain.slice(-2)}`;
console.log(`[secret] decrypt ok length=${plain.length} masked=${masked}`);

const outDir = path.join(ROOT, ".local");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "kernel-password.txt");
writeFileSync(outFile, plain, { encoding: "utf8", mode: 0o600 });
console.log(`[secret] written: ${outFile} (0600)`);
console.log("[secret] 用法：在「QQ Bot: 设置内核连接」中填入该口令；用完请删除该文件");