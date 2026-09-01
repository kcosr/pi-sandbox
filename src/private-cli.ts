#!/usr/bin/env bun

import { INTERNAL_SANDBOX_WORKER_ARGUMENT } from "./sandbox/worker-protocol.js";
import { assertRuntimeUser } from "./runtime/user.js";

const args = process.argv.slice(2);

let admitted = false;
try {
  assertRuntimeUser(args);
  admitted = true;
} catch (error) {
  console.error(`pi-sandbox: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

if (admitted && args.length === 1 && args[0] === INTERNAL_SANDBOX_WORKER_ARGUMENT) {
  try {
    const { runSandboxWorker } = await import("./sandbox/worker.js");
    await runSandboxWorker();
  } catch (error) {
    console.error(`pi-sandbox-worker: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 70;
  }
} else if (admitted) {
  const { sanitizeManagedEnvironment } = await import("./runtime/environment.js");

  sanitizeManagedEnvironment();

  try {
    const { runPiSandbox } = await import("./runtime/main.js");
    await runPiSandbox(args);
  } catch (error) {
    console.error(`pi-sandbox: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
