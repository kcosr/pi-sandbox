#!/usr/bin/env bun

// This file is copied beside private-cli.js under Pi's compiled dist tree. The
// hidden worker entry must avoid initializing Pi before it enters Bubblewrap.
const INTERNAL_SANDBOX_WORKER_ARGUMENT = "--pi-sandbox-internal-worker";
const workerMode =
  process.argv.length === 3 && process.argv[2] === INTERNAL_SANDBOX_WORKER_ARGUMENT;

process.title = "pi-sandbox";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = () => {};

if (!workerMode) {
  const [{ registerBunOAuthFlows }, { configureHttpDispatcher }, { restoreSandboxEnv }] =
    await Promise.all([
      import("@earendil-works/pi-ai/bun-oauth"),
      import("../core/http-dispatcher.js"),
      import("../bun/restore-sandbox-env.js"),
    ]);

  registerBunOAuthFlows();
  restoreSandboxEnv();
  configureHttpDispatcher();
  await import("../bun/register-bedrock.js");
}
await import("./private-cli.js");
