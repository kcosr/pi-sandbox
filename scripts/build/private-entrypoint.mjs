#!/usr/bin/env bun

// This file is copied beside private-cli.js under Pi's compiled dist tree. The
// hidden worker entry must avoid initializing Pi before it enters Bubblewrap.
const INTERNAL_SANDBOX_WORKER_ARGUMENT = "--pi-sandbox-internal-worker";
const workerMode =
  process.argv.length === 3 && process.argv[2] === INTERNAL_SANDBOX_WORKER_ARGUMENT;

process.title = "pi-sandbox";
process.emitWarning = () => {};

if (!workerMode) {
  // Restore the environment before Pi 1.0's runtime setup evaluates modules
  // that capture it, then register Bun OAuth, Bedrock, and the embedded WASM.
  await import("../bun/sandbox-env-setup.js");
  await import("../bun/runtime-setup.js");
  const { configureHttpDispatcher } = await import("../core/http-dispatcher.js");
  configureHttpDispatcher();
  process.title = "pi-sandbox";
}
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
await import("./private-cli.js");
