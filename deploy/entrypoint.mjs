#!/usr/bin/env node
/**
 * Container entrypoint for the single application image.
 *
 * The deployment is two services — this container and postgres — so everything the application
 * needs happens here, in order: virtual display, schema migrations, browser binary, then the web
 * portal and the claim worker side by side under one PID 1.
 *
 * The startup steps are deliberately eager rather than lazy. A migration or a browser download
 * that fails on first use surfaces as a mysteriously broken claim hours later; failing here puts
 * it at the top of `docker logs` where an operator actually looks.
 *
 * Supervision of the long-lived children (why not `sh -c 'a & b & wait'`) lives in
 * packages/core/src/supervisor.ts.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// Imported by path, not by package name: this file sits outside every workspace package, so
// pnpm has not linked `@uc/core` into a node_modules directory above it.
import { bootstrapSecrets, supervise } from "../packages/core/dist/index.js";

const DISPLAY = process.env.DISPLAY ?? ":99";
const X_SOCKET = `/tmp/.X11-unix/X${DISPLAY.replace(":", "")}`;
const CONFIG_DIR = process.env.UC_CONFIG_DIR ?? "/var/lib/uc";
const SECRETS_FILE = join(CONFIG_DIR, "secrets.json");

const log = (message, fields) =>
  console.log(
    JSON.stringify({ level: "info", name: "entrypoint", message, ...(fields ?? {}) }),
  );

/** Spawns a process and adapts it to the supervisor's child shape. */
function start(name, command, args) {
  const proc = spawn(command, args, { stdio: "inherit" });
  const exited = new Promise((resolve) => {
    // A process killed by a signal reports code `null`; map that to the conventional 128+n so the
    // container's exit code stays a number and still says what happened.
    proc.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    proc.on("error", (err) => {
      log("failed to start", { child: name, error: String(err) });
      resolve(1);
    });
  });
  return { name, exited, stop: (signal) => proc.kill(signal) };
}

/** Runs a process to completion, aborting startup if it fails. */
async function runToCompletion(name, command, args) {
  const child = start(name, command, args);
  const code = await child.exited;
  if (code !== 0) {
    log("startup step failed", { step: name, code });
    process.exit(code);
  }
}

// Secrets first: everything downstream needs them in the environment, and getting APP_ENCRYPTION_KEY
// wrong is the one mistake an update can make that destroys data. Resolved from the environment,
// then from the config volume, and only generated when neither has them — see bootstrap-secrets.ts.
mkdirSync(CONFIG_DIR, { recursive: true });
const secrets = bootstrapSecrets(
  process.env,
  {
    read: () => (existsSync(SECRETS_FILE) ? readFileSync(SECRETS_FILE, "utf8") : null),
    // 0600: the file is the deployment's master key, and the volume may be browsable from the host.
    write: (contents) => writeFileSync(SECRETS_FILE, contents, { mode: 0o600 }),
  },
  (kind) => randomBytes(32).toString(kind === "base64-32" ? "base64" : "hex"),
);
for (const [name, value] of Object.entries(secrets.values)) process.env[name] = value;
if (secrets.generated.length > 0) {
  log("generated missing secrets and persisted them", {
    // Names only. Logging a value would put the master key in `docker logs`, where it is far
    // easier to read than the 0600 file it was just written to.
    names: secrets.generated,
    file: SECRETS_FILE,
  });
}

// Xvfb: the worker runs Chromium headed (best stealth) so it needs a display even though the
// host has none. Supervised like the others — if it dies, every later claim would fail at launch.
const xvfb = start("xvfb", "Xvfb", [DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp"]);
for (let i = 0; i < 100 && !existsSync(X_SOCKET); i++) await sleep(100);
if (!existsSync(X_SOCKET)) {
  log("Xvfb did not create its socket", { socket: X_SOCKET });
  process.exit(1);
}
log("virtual display ready", { display: DISPLAY });

// Migrations, catalog seed, and the check that this is the key the database was written with.
// A mismatch stops the boot here rather than surfacing later as a series of unreadable accounts.
await runToCompletion("preflight", "node", ["packages/db/dist/migrate.js"]);
log("database ready and encryption key verified");

// No-op once the cache volume is populated; the ~200MB download only happens on a fresh volume.
await runToCompletion("browser", "corepack", [
  "pnpm",
  "--filter",
  "@uc/connectors",
  "exec",
  "cloakbrowser",
  "install",
]);
log("browser ready");

const children = [
  xvfb,
  start("web", "node", ["apps/web/server.mjs"]),
  start("worker", "node", ["apps/worker/dist/index.js"]),
];

const code = await supervise({
  children,
  onShutdownSignal: (handler) => {
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  },
  log,
});
process.exit(code);
