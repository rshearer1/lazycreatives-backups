const { spawn } = require("child_process");
const crypto = require("crypto");
const net = require("net");
const http = require("http");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 1000 },
        (res) => { res.resume(); resolve(); }
      );
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("sidecar health timeout"));
        else setTimeout(tick, 250);
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

async function startSidecar({ backendDir, dbPath, pythonCmd = "python" }) {
  const token = crypto.randomBytes(24).toString("hex");
  const port = await freePort();
  const env = {
    ...process.env,
    ABLEBACKUP_TOKEN: token,
    ABLEBACKUP_PORT: String(port),
    ABLEBACKUP_DB: dbPath,
  };
  const proc = spawn(pythonCmd, ["-m", "ablebackup.server"], {
    cwd: backendDir, env, stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => console.log("[sidecar]", d.toString().trim()));
  proc.stderr.on("data", (d) => console.error("[sidecar]", d.toString().trim()));
  await waitForHealth(port);
  return { proc, token, port };
}

module.exports = { startSidecar, freePort, waitForHealth };
