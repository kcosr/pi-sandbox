import { constants as fsConstants } from "node:fs";
import { accessSync, realpathSync } from "node:fs";
import path from "node:path";

import { INTERNAL_SANDBOX_WORKER_ARGUMENT } from "../../packages/sandbox-extension/src/runtime/worker-protocol.js";

export function testSandboxWorkerCommand(): readonly [string, ...string[]] {
  const configured = process.env.PI_SANDBOX_BUN_PATH;
  const bunPath = configured === undefined ? findExecutable("bun") : realpathSync(configured);
  return [
    bunPath,
    path.resolve(process.cwd(), "src/private-cli.ts"),
    INTERNAL_SANDBOX_WORKER_ARGUMENT,
  ];
}

function findExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`Required test executable is unavailable: ${name}`);
}
