import { createCipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decryptKernelSecret } from "../src/kernel-secret.js";

const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

/** 按码道相同格式生成一份临时密文，用于验证解密逻辑 */
function writeEncryptedFixture(plain: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qqbot-secret-"));
  const secret = randomUUID();
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = scryptSync(secret, salt, 32, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  for (const sub of ["1", "2", "3", "4", "custom-dir"]) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  writeFileSync(path.join(dir, "4", "data"), Buffer.from(secret, "utf8").toString("base64"));
  writeFileSync(path.join(dir, "1", "data"), JSON.stringify({ algorithm: "aes-256-gcm" }));
  writeFileSync(path.join(dir, "2", "data"), JSON.stringify(salt));
  writeFileSync(path.join(dir, "3", "data"), JSON.stringify(iv));
  writeFileSync(path.join(dir, "custom-dir", "data"), JSON.stringify({ authTag, ciphertext }));
  return dir;
}

describe("kernel-secret", () => {
  it("能解密同一格式的密文", () => {
    const plain = randomUUID();
    const dir = writeEncryptedFixture(plain);
    expect(decryptKernelSecret(dir)).toBe(plain);
  });

  it("缺少文件时返回 undefined", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qqbot-secret-empty-"));
    expect(decryptKernelSecret(dir)).toBeUndefined();
  });

  it("算法不匹配时返回 undefined", () => {
    const dir = writeEncryptedFixture("abc");
    writeFileSync(path.join(dir, "1", "data"), JSON.stringify({ algorithm: "aes-256-cbc" }));
    expect(decryptKernelSecret(dir)).toBeUndefined();
  });

  it("密钥被替换时解密失败但不会抛错", () => {
    const dir = writeEncryptedFixture("abc");
    writeFileSync(path.join(dir, "4", "data"), Buffer.from(randomUUID(), "utf8").toString("base64"));
    expect(decryptKernelSecret(dir)).toBeUndefined();
  });
});