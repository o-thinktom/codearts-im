#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, accessSync, constants, readFileSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import path from "node:path";

const ok = (label, detail) => console.log(`[PASS] ${label.padEnd(16)} ${detail}`);
const warn = (label, detail) => console.log(`[WARN] ${label.padEnd(16)} ${detail}`);
const fail = (label, detail) => {
  console.log(`[FAIL] ${label.padEnd(16)} ${detail}`);
  process.exitCode = 1;
};

tryIt("OS", () => `${platform()} ${arch()}`);

tryIt("Node", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && (minor ?? 0) < 3)) throw new Error(`需要 >= 20.3，当前 ${process.versions.node}`);
  return process.versions.node;
});

tryIt("npm", () => {
  const cmd = platform() === "win32" ? "npm.cmd" : "npm";
  return execFileSync(cmd, ["-v"], { encoding: "utf8" }).trim();
});

tryIt("码道安装", () => {
  const candidates = [
    "D:/apps/CodeArts Agent",
    "/Applications/CodeArts Agent.app",
    path.join(process.env.LOCALAPPDATA ?? "", "Programs/CodeArts Agent"),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) throw new Error("未找到安装目录（可用 CODEARTS_HOME 指定）");
  return found;
});

tryIt("内核二进制", () => {
  const home = process.env.CODEARTS_HOME ?? "D:/apps/CodeArts Agent";
  const exe = path.join(
    home,
    "resources/app/extensions/vscode-codebot",
    `agentkernelServer-${platform()}-${arch()}${platform() === "win32" ? ".exe" : ""}`,
  );
  if (!existsSync(exe)) throw new Error(`未找到 ${exe}`);
  return path.basename(exe);
});

tryIt("数据目录", () => {
  const dir = path.join(homedir(), ".codeartsdoer", "codearts-im");
  accessSync(path.dirname(dir), constants.W_OK);
  return dir;
});

tryIt("内核配置", () => {
  const cfg = path.join(homedir(), ".codeartsdoer", "package.json");
  if (!existsSync(cfg)) throw new Error("未找到 ~/.codeartsdoer/package.json（码道尚未完成初始化）");
  const pkg = JSON.parse(readFileSync(cfg, "utf8"));
  const version = pkg?.dependencies?.["@opencode-ai/plugin"] ?? "unknown";
  return `@opencode-ai/plugin ${version}`;
});

warn("QQ 出网", "请在运行期验证 wss 握手（离线开发可忽略）");
warn("命名管道", "Windows 需允许 \\\\.\\pipe\\codearts-im-*");

function tryIt(label, fn) {
  try {
    ok(label, fn());
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}