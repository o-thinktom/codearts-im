/**
 * 构建 sidecar 单文件可执行程序（Node SEA）。
 *
 *   npm run build:sidecar
 *
 * 步骤：
 *   1) esbuild 打成 CJS 单文件（避免 SEA 对 ESM 的限制）
 *   2) 生成 SEA blob（node --experimental-sea-config）
 *   3) 复制 node 可执行文件 → 注入 blob（postject）
 *   4) 输出到 packages/vscode-extension/bin/
 *
 * 注意：Windows 正式分发需对产物做代码签名（signtool），否则可能被 SmartScreen/杀软拦截。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = path.join(ROOT, "packages/qqbot-runtime/dist");
const BIN_DIR = path.join(ROOT, "packages/vscode-extension/bin");
const platform = process.platform;
const arch = process.arch;
const exeExt = platform === "win32" ? ".exe" : "";
const target = path.join(BIN_DIR, `qqbot-sidecar-${platform}-${arch}${exeExt}`);

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(BIN_DIR, { recursive: true });

rmSync(path.join(OUT_DIR, "sidecar.cjs"), { force: true });

console.log("[build:sidecar] bundling with esbuild");
await build({
  entryPoints: [path.join(ROOT, "packages/qqbot-runtime/src/bin/sidecar-entry.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(OUT_DIR, "sidecar.cjs"),
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  banner: {
    js: "/* CodeArts QQ Bot sidecar (generated) */",
  },
});

const seaConfigPath = path.join(OUT_DIR, "sea-config.json");
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: path.join(OUT_DIR, "sidecar.cjs"),
      output: path.join(OUT_DIR, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

console.log("[build:sidecar] generating SEA blob");
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit", cwd: OUT_DIR });

console.log("[build:sidecar] copying node runtime");
rmSync(target, { force: true });
copyFileSync(process.execPath, target);

console.log("[build:sidecar] injecting blob");
const postjectArgs = [
  target,
  "NODE_SEA_BLOB",
  path.join(OUT_DIR, "sea-prep.blob"),
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
execFileSync("npx", ["--yes", "postject", ...postjectArgs], { stdio: "inherit", shell: platform === "win32" });

if (!existsSync(target)) {
  console.error("[build:sidecar] output missing:", target);
  process.exit(1);
}
const size = (statSync(target).size / (1024 * 1024)).toFixed(1);
console.log(`[build:sidecar] done: ${target} (${size} MB)`);
console.log("[build:sidecar] hint: run it with `--ipc-token <token>` (extension does this automatically)");