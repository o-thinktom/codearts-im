/**
 * 打包 VS Code 扩展（esbuild → CJS），并产出 VSIX。
 *
 *   npm run build:extension
 *   npm run package:vsix
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = path.join(ROOT, "packages/vscode-extension");
const OUT = path.join(PKG, "dist");

mkdirSync(OUT, { recursive: true });
rmSync(path.join(OUT, "extension.cjs"), { force: true });

console.log("[build:extension] bundling");
await build({
  entryPoints: [path.join(PKG, "src/extension.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(OUT, "extension.cjs"),
  external: ["vscode"],
  sourcemap: false,
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});

writeFileSync(
  path.join(PKG, ".vscodeignore"),
  ["src/**", "test/**", "tsconfig*.json", "*.map", "dist/**/*.map", "node_modules/**"].join("\n"),
);

console.log("[build:extension] done: dist/extension.cjs");

if (process.argv.includes("--vsix")) {
  console.log("[build:extension] packaging VSIX");
  execFileSync("npx", ["--yes", "@vscode/vsce", "package", "--no-dependencies", "--allow-missing-repository"], {
    cwd: PKG,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}