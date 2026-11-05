import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBubblewrapExecutor } from "../bubblewrap-executor.js";
import type { SandboxExecutor } from "../contracts.js";
import type { SandboxExportReader, SandboxExportSource } from "./contracts.js";

const bubblewrapPath = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
describe.skipIf(process.platform !== "linux" || !existsSync(bubblewrapPath))(
  "real Bubblewrap private-file export",
  () => {
    let cwd: string | undefined;
    let executor: SandboxExecutor | undefined;
    let reader: SandboxExportReader | undefined;
    afterEach(async () => {
      await reader?.close();
      reader = undefined;
      await executor?.close();
      executor = undefined;
      if (cwd) await rm(cwd, { recursive: true, force: true });
    });

    it("exports private binary data while excluding a RO host CWD below /tmp, retains startup root identity, and cancels independently", async () => {
      cwd = await mkdtemp("/tmp/pi-export-native-");
      await writeFile(path.join(cwd, "host-input"), "host-original");
      let captured: SandboxExportSource | undefined;
      const bun =
        process.env.PI_SANDBOX_BUN ?? execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
      executor = await createBubblewrapExecutor({
        cwd,
        cwdWritable: false,
        bubblewrapPath,
        workerCommand: [bun, fileURLToPath(new URL("../worker-entry.ts", import.meta.url))],
        onExportSource: (source) => {
          captured = source;
        },
      });
      expect(captured).toBeDefined();
      expect(captured!.writableHostPaths).toEqual([]);
      expect(Object.hasOwn(executor, "exportSource")).toBe(false);
      const created = await executor.execute({
        argv: [
          "/bin/bash",
          "-c",
          'printf private > "$HOME/report"; printf temp > /tmp/private-report; ln -s "$PWD/host-input" "$HOME/host-link"; if printf changed > host-input 2>/dev/null; then exit 99; fi',
        ],
      });
      expect(created.exitCode).toBe(0);
      const invalidName = await executor.execute({
        argv: ["/bin/bash", "-c", "name=$(printf '\\377%.0s' {1..255}); touch \"$HOME/$name\""],
      });
      expect(invalidName.exitCode).toBe(0);
      reader = await captured!.open();
      const inventory = await reader.list("home", "");
      expect(inventory.entries.find((entry) => entry.name === "host-link")).toMatchObject({
        kind: "unsupported",
        problem: "export_symlink",
      });
      const unsupportedName = inventory.entries.find(
        (entry) => entry.problem === "export_invalid_utf8_name",
      );
      expect(unsupportedName).toMatchObject({ kind: "unsupported" });
      expect(Buffer.byteLength(unsupportedName!.name)).toBeGreaterThan(255);
      const temporary = await reader.list("tmp", "");
      expect(temporary.entries.map((entry) => entry.name)).toContain("private-report");
      expect(temporary.entries.map((entry) => entry.name)).not.toContain(path.basename(cwd));
      await executor.execute({
        argv: ["/bin/bash", "-c", 'mv "$HOME" "${HOME}-original"; ln -s "$PWD" "$HOME"'],
      });
      const renamedInventory = (await reader.list("home", "")).entries;
      expect(renamedInventory.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["host-link", "report"]),
      );
      expect(renamedInventory).toHaveLength(3);
      const report = inventory.entries.find((entry) => entry.name === "report")!;
      await reader.openFile(report);
      expect(Buffer.from(await reader.readChunk()).toString()).toBe("private");
      expect(await reader.readChunk()).toHaveLength(0);
      await reader.closeFile();
      await reader.close();
      reader = undefined;
      const cancellation = new AbortController();
      reader = await captured!.open(cancellation.signal);
      cancellation.abort();
      await expect(reader.list("home", "")).rejects.toThrow("export_aborted");
      await reader.close();
      reader = undefined;
      expect(
        (await executor.execute({ argv: ["/bin/printf", "peer-alive"] })).stdout.toString(),
      ).toBe("peer-alive");
      expect(await readFile(path.join(cwd, "host-input"), "utf8")).toBe("host-original");
    }, 20_000);
  },
);
