import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const configured = process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE !== undefined;
const required = process.env.PI_SANDBOX_REQUIRE_SMOLVM === "1";
const suite = configured || required ? describe : describe.skip;
suite("OCI native interactive terminal", () => {
  it("qualifies real Bun PTYs, scoped close, concurrent tools, reviewer isolation and edited original retention", async () => {
    if (
      !process.env.PI_SANDBOX_SMOLVM_BIN ||
      !process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE ||
      !process.env.PI_SANDBOX_SMOLVM_OCI_SHA256
    )
      throw new Error("requires pinned smolvm binary, OCI image and digest");
    const { stdout } = await promisify(execFile)(
      process.env.PI_SANDBOX_TEST_BUN ?? "bun",
      ["tests/fixtures/oci-terminal-native.ts"],
      {
        cwd: process.cwd(),
        env: process.env,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
      },
    );
    const result = JSON.parse(stdout) as { checks: string[] };
    expect(result.checks).toHaveLength(8);
  }, 190000);
});
