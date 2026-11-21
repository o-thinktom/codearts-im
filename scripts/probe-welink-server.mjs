import { appendFileSync } from "node:fs";
import http from "node:http";

const logFile = process.env.PROBE_LOG ?? "probe-welink.log";
const log = (obj) => {
  try {
    appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...obj })}\n`);
  } catch {
    // ignore
  }
};

log({
  event: "boot",
  argv: process.argv,
  cwd: process.cwd(),
  execPath: process.execPath,
  probeMark: process.env.PROBE_MARK ?? null,
  port: process.env.PROBE_PORT ?? null,
  envKeys: Object.keys(process.env),
  selectedEnv: {
    IDE: process.env.IDE ?? null,
    IS_PROD: process.env.IS_PROD ?? null,
    PLUGIN_ENV: process.env.PLUGIN_ENV ?? null,
    KERNEL_DATA_DIR: process.env.KERNEL_DATA_DIR ?? null,
    KERNEL_CONFIG_DIR: process.env.KERNEL_CONFIG_DIR ?? null,
  },
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  log({ event: "stdin", data: String(chunk).slice(0, 4000) });
});
process.stdin.on("end", () => log({ event: "stdin-end" }));
process.stdin.on("error", (err) => log({ event: "stdin-error", message: String(err) }));

const port = Number(process.env.PROBE_PORT ?? 20700);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += String(chunk);
    if (body.length > 20000) req.destroy();
  });
  req.on("end", () => {
    log({
      event: "http",
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body.slice(0, 8000),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, probe: true }));
  });
});

server.on("error", (err) => log({ event: "http-error", message: String(err) }));
server.listen(port, "127.0.0.1", () => log({ event: "listening", port }));

setInterval(() => {}, 60000);