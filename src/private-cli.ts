#!/usr/bin/env bun

import { INTERNAL_SANDBOX_WORKER_ARGUMENT } from "../packages/sandbox-extension/src/runtime/worker-protocol.js";
import { assertRuntimeUser } from "./runtime/user.js";
import { parseSandboxArguments, type SandboxArguments } from "./runtime/config-arguments.js";

const args = process.argv.slice(2);

let launch: SandboxArguments | undefined;
try {
  const parsed = parseSandboxArguments(args);
  assertRuntimeUser(parsed.piArgs);
  launch = parsed;
} catch (error) {
  console.error(`pi-sandbox: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

if (launch !== undefined && args.length === 1 && args[0] === INTERNAL_SANDBOX_WORKER_ARGUMENT) {
  try {
    const { runSandboxWorker } =
      await import("../packages/sandbox-extension/src/runtime/worker.js");
    await runSandboxWorker();
  } catch (error) {
    console.error(`pi-sandbox-worker: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 70;
  }
} else if (launch !== undefined) {
  const { sanitizeManagedEnvironment } = await import("./runtime/environment.js");

  sanitizeManagedEnvironment();

  try {
    const { runPiSandbox } = await import("./runtime/main.js");
    await runPiSandbox(launch);
  } catch (error) {
    console.error(`pi-sandbox: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
