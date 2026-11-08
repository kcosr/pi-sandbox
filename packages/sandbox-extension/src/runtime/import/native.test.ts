import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBubblewrapExecutor } from "../bubblewrap-executor.js";
import type { SandboxExecutor } from "../contracts.js";
import { IMPORT_LIMITS, type SandboxImportSession, type SandboxImportTarget } from "./contracts.js";

const bubblewrapPath = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
describe.skipIf(process.platform !== "linux" || !existsSync(bubblewrapPath))(
  "real Bubblewrap scratch import",
  () => {
    let cwd: string | undefined;
    let executor: SandboxExecutor | undefined;
    const sessions: SandboxImportSession[] = [];
    afterEach(async () => {
      await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
      await executor?.close();
      executor = undefined;
      if (cwd) await rm(cwd, { recursive: true, force: true });
    });
    async function setup(): Promise<SandboxImportTarget> {
      cwd = await mkdtemp("/tmp/pi-import-native-");
      await writeFile(path.join(cwd, "host-original"), "host unchanged");
      let target: SandboxImportTarget | undefined;
      const bun =
        process.env.PI_SANDBOX_BUN ?? execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
      executor = await createBubblewrapExecutor({
        cwd,
        cwdWritable: false,
        networkMode: "none",
        bubblewrapPath,
        workerCommand: [bun, fileURLToPath(new URL("../worker-entry.ts", import.meta.url))],
        onImportTarget: (value) => {
          target = value;
        },
      });
      expect(target).toBeDefined();
      expect(Object.hasOwn(executor, "importTarget")).toBe(false);
      return target!;
    }

    it("transfers binary chunks into private storage and anchors checkout paths while other commands run", async () => {
      const target = await setup();
      const first = await target.open();
      const second = await target.open();
      sessions.push(first, second);
      const bytes = Buffer.alloc(IMPORT_LIMITS.chunkBytes + 93);
      for (let index = 0; index < bytes.byteLength; index++) bytes[index] = index % 256;
      await Promise.all([
        (async () => {
          await first.writeChunk(bytes.subarray(0, IMPORT_LIMITS.chunkBytes));
          await first.writeChunk(bytes.subarray(IMPORT_LIMITS.chunkBytes));
        })(),
        second.writeChunk(Buffer.from("second session")),
        executor!
          .execute({ argv: ["/bin/printf", "peer runs"] })
          .then((result) => expect(result.stdout.toString()).toBe("peer runs")),
      ]);
      const input = await first.finish();
      const directory = await first.reserveDirectory("repos/demo");
      const copied = await executor!.execute({
        argv: ["/bin/sh", "-c", 'cat "$1" > "$2/data"', "probe", input, directory.path],
      });
      expect(copied.exitCode).toBe(0);
      expect(
        (await executor!.execute({ argv: ["/bin/cat", `${directory.path}/data`] })).stdout,
      ).toEqual(bytes);
      await first.verifyDirectory();
      const replaced = await executor!.execute({
        argv: [
          "/bin/sh",
          "-c",
          'mv "$1" "$1-old"; ln -s "$PWD" "$1"',
          "probe",
          directory.displayPath,
        ],
      });
      expect(replaced.exitCode).toBe(0);
      await expect(first.verifyDirectory()).rejects.toThrow("import_directory_changed");
      expect(
        (await executor!.execute({ argv: ["/bin/cat", `${directory.path}/data`] })).stdout,
      ).toEqual(bytes);
      expect(
        (await executor!.execute({ argv: ["/bin/cat", await second.finish()] })).stdout.toString(),
      ).toBe("second session");
      expect(await readFile(path.join(cwd!, "host-original"), "utf8")).toBe("host unchanged");
      await first.close();
      expect((await executor!.execute({ argv: ["/bin/cat", input] })).exitCode).not.toBe(0);
      expect(
        (await executor!.execute({ argv: ["/bin/cat", `${directory.displayPath}-old/data`] }))
          .stdout,
      ).toEqual(bytes);
    }, 20_000);

    it("rejects symlink ancestors and existing targets, scopes cancellation, and cleans up on shutdown", async () => {
      const target = await setup();
      const abort = new AbortController();
      const first = await target.open(abort.signal);
      const second = await target.open();
      sessions.push(first, second);
      await executor!.execute({
        argv: ["/bin/sh", "-c", 'ln -s "$PWD" "$HOME/link"; mkdir "$HOME/existing"'],
      });
      await expect(first.reserveDirectory("link/escape")).rejects.toThrow(
        "import_filesystem_error",
      );
      await expect(first.reserveDirectory("existing")).rejects.toThrow("import_destination_exists");
      await first.writeChunk(Buffer.from("cancel me"));
      const input = await first.finish();
      abort.abort();
      expect((await executor!.execute({ argv: ["/bin/cat", input] })).stdout.toString()).toBe(
        "cancel me",
      );
      await first.close();
      expect((await executor!.execute({ argv: ["/bin/cat", input] })).exitCode).not.toBe(0);
      await second.writeChunk(Buffer.from("survives peer cancellation"));
      expect(
        (await executor!.execute({ argv: ["/bin/cat", await second.finish()] })).stdout.toString(),
      ).toBe("survives peer cancellation");
      const denied = await executor!.execute({
        argv: ["/bin/sh", "-c", 'printf overwrite > "$PWD/host-original"'],
      });
      expect(denied.exitCode).not.toBe(0);
      await executor!.close();
      await expect(second.reserveDirectory("repos/after-close")).rejects.toThrow("import_closed");
      expect(await readFile(path.join(cwd!, "host-original"), "utf8")).toBe("host unchanged");
    }, 20_000);
  },
);
