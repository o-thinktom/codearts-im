import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const RULES = {
  "@codearts-qqbot/core": [],
  "@codearts-qqbot/ipc": [],
  "@codearts-qqbot/kernel-port": ["@codearts-qqbot/core"],
  "@codearts-qqbot/runtime": ["@codearts-qqbot/core", "@codearts-qqbot/ipc", "@codearts-qqbot/kernel-port"],
  "codearts-qqbot-cn": ["@codearts-qqbot/ipc"],
};

const DIRS = {
  "@codearts-qqbot/core": "qqbot-core",
  "@codearts-qqbot/ipc": "qqbot-ipc",
  "@codearts-qqbot/kernel-port": "qqbot-kernel-port",
  "@codearts-qqbot/runtime": "qqbot-runtime",
  "codearts-qqbot-cn": "vscode-extension",
};

const FORBIDDEN_IN_CORE = [
  "vscode",
  "@cloud/",
  "@codearts-qqbot/ipc",
  "@codearts-qqbot/kernel-port",
  "@codearts-qqbot/runtime",
];

function depsOf(pkg) {
  return {
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
}

const errors = [];

const packages = Object.keys(RULES);
for (const name of packages) {
  const dir = DIRS[name];
  const pkgPath = path.join(ROOT, "packages", dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch (err) {
    errors.push(`${name}: cannot read ${pkgPath} (${err.message})`);
    continue;
  }

  const allowed = RULES[name];
  for (const dep of Object.keys(depsOf(pkg))) {
    if (!dep.startsWith("@codearts-qqbot/")) continue;
    if (!allowed.includes(dep)) {
      errors.push(`${name}: forbidden internal dependency "${dep}" (allowed: ${allowed.join(", ") || "none"})`);
    }
  }

  if (allowed.length === 0) {
    for (const dep of Object.keys(depsOf(pkg))) {
      if (FORBIDDEN_IN_CORE.some((bad) => dep === bad || dep.startsWith(bad))) {
        errors.push(`${name}: "${dep}" is forbidden in a host-independent package`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("[layers] FAILED");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`[layers] ok (${packages.length} packages checked)`);