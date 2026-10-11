import { createHostCommandExecutor } from "../host-command/index.js";

/** Internal fixed read-only host probes; no ambient environment or shell. */
export async function hostQuery(
  argv: readonly [string, ...string[]],
  stdin?: Buffer,
): Promise<Buffer> {
  const host = createHostCommandExecutor({
    cwd: "/",
    environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
  });
  try {
    const result = await host.execute({
      argv,
      ...(stdin ? { stdin } : {}),
      timeoutMs: 5000,
      maxOutputBytes: 4 * 1048576,
    });
    if (result.exitCode !== 0 || result.signal !== null)
      throw new Error("smolvm_host_query_failed");
    return result.stdout;
  } finally {
    await host.close();
  }
}
