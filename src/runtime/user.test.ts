import { describe, expect, it } from "vitest";

import { INTERNAL_SANDBOX_WORKER_ARGUMENT } from "../../packages/sandbox-extension/src/runtime/worker-protocol.js";
import { assertRuntimeUser } from "./user.js";

describe("runtime user admission", () => {
  it("rejects root before interactive, help, or worker execution", () => {
    for (const args of [[], ["--help"], [INTERNAL_SANDBOX_WORKER_ARGUMENT]]) {
      expect(() => assertRuntimeUser(args, 0)).toThrow(
        "refusing to run as root; run pi-sandbox as the intended unprivileged user",
      );
    }
  });

  it("admits an ordinary Unix user", () => {
    expect(() => assertRuntimeUser([], 1000)).not.toThrow();
  });

  it("admits only the root-run administrative commands used by installers", () => {
    expect(() => assertRuntimeUser(["--validate-installation"], 0)).not.toThrow();
    expect(() => assertRuntimeUser(["--print-execution-backend"], 0)).not.toThrow();
    expect(() => assertRuntimeUser(["--validate-installation-extra"], 0)).toThrow(
      "refusing to run as root",
    );
  });
});
