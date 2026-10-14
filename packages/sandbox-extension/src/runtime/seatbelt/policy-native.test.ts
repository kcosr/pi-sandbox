import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSeatbeltProfile, type SeatbeltPolicy } from "./policy.js";
import { canonicalizeSeatbeltDirectory, isSeatbeltPathWithin } from "./paths.js";
import { startSeatbeltProcess } from "./process.js";
import { SEATBELT_LAUNCHER } from "./options.js";

// These native profile controls use genuine system executables directly. They
// do not bypass or substitute the factory's separate GNU utility prerequisites.
describe.skipIf(process.platform !== "darwin")("native Seatbelt policy controls", () => {
  let root: string;
  let policy: SeatbeltPolicy;
  beforeAll(async () => {
    root = await realpath(await mkdtemp("/private/tmp/pi-seatbelt-policy-"));
    policy = {
      workspace: await canonicalizeSeatbeltDirectory(root),
      workspaceWritable: true,
      temporaryDirectories: [],
      deniedDirectories: [],
      networkMode: "none",
    };
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  function run(argv: readonly string[], selected = policy) {
    const profile = buildSeatbeltProfile(selected);
    return startSeatbeltProcess(
      SEATBELT_LAUNCHER,
      [
        "-p",
        profile.profile,
        ...Object.entries(profile.parameters).flatMap(([key, value]) => ["-D", `${key}=${value}`]),
        ...argv,
      ],
      { PATH: "/usr/bin:/bin", LANG: "C" },
      Buffer.alloc(0),
      4000,
      8192,
    ).result;
  }

  it.each(["none", "host"] as const)(
    "allows a shell to signal its own child with %s networking",
    async (networkMode) => {
      const result = await run(
        ["/bin/sh", "-c", '/bin/sleep 1 & p=$!; kill "$p"; code=$?; wait "$p"; exit "$code"'],
        { ...policy, networkMode },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    },
  );

  it.each(["none", "host"] as const)(
    "keeps signalling an unrelated host process denied with %s networking",
    async (networkMode) => {
      const host = spawn("/bin/sleep", ["10"], { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" });
      const closed = new Promise<void>((resolve) => host.once("close", () => resolve()));
      try {
        await once(host, "spawn");
        expect(() => process.kill(host.pid!, 0)).not.toThrow();
        const result = await run(
          ["/bin/sh", "-c", 'kill -0 "$1"', "signal-probe", String(host.pid)],
          { ...policy, networkMode },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain("Operation not permitted");
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
        await closed;
      }
    },
  );

  it.each(["/Users", "/Volumes", "/Library"])(
    "denies the canonical directory %s without weakening workspace writes",
    async (directory) => {
      const denied = await canonicalizeSeatbeltDirectory(directory);
      const marker = path.join(root, "allowed");
      const result = await run(
        [
          "/bin/sh",
          "-c",
          'if /bin/ls "$1" >/dev/null 2>&1; then exit 90; fi; printf allowed > "$2"',
          "denial-probe",
          denied,
          marker,
        ],
        { ...policy, deniedDirectories: [denied] },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(await readFile(marker, "utf8")).toBe("allowed");
    },
  );

  it("restores only the selected workspace beneath a denied non-system root", async () => {
    const cwd = await realpath(process.cwd());
    const ancestor = ["/Users", "/Volumes", "/Library"].find((candidate) =>
      isSeatbeltPathWithin(candidate, cwd),
    );
    if (ancestor === undefined) return; // Native CI can choose another checkout root.
    const fixture = await mkdtemp(path.join(cwd, ".seatbelt-policy-fixture-"));
    try {
      const workspace = path.join(fixture, "workspace"),
        peer = path.join(fixture, "peer"),
        descendant = path.join(workspace, "private");
      await mkdir(descendant, { recursive: true });
      await mkdir(peer);
      await writeFile(path.join(peer, "marker"), "peer");
      await writeFile(path.join(descendant, "marker"), "private");
      const selected: SeatbeltPolicy = {
        ...policy,
        workspace: await canonicalizeSeatbeltDirectory(workspace),
        deniedDirectories: [
          await canonicalizeSeatbeltDirectory(ancestor),
          await canonicalizeSeatbeltDirectory(descendant),
        ],
      };
      const result = await run(
        [
          "/bin/sh",
          "-c",
          'cd -P -- "$1" || exit 91; printf restored > allowed; if /bin/cat "$2/marker" >/dev/null 2>&1; then exit 92; fi; if /bin/cat private/marker >/dev/null 2>&1; then exit 93; fi',
          "ancestor-probe",
          workspace,
          peer,
        ],
        selected,
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(await readFile(path.join(workspace, "allowed"), "utf8")).toBe("restored");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
