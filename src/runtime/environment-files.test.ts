import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  overlayManagedEnvironment,
  parseAuthoredManagedEnvironment,
  parseBrokerManagedEnvironment,
} from "../domain/index.js";
import { readEnvironmentFile, resolveEnvironmentFiles } from "./environment-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(bytes: string | Uint8Array = "token\n") {
  const root = await mkdtemp(join(tmpdir(), "pi-env-file-"));
  roots.push(root);
  const path = join(root, "{{uid}}-$NAME-secret");
  await writeFile(path, bytes);
  return { root, path };
}
const authored = (pi: Record<string, unknown>) =>
  parseAuthoredManagedEnvironment({ pi, sandbox: {}, extensions: {} });

describe("file-backed Pi environment", () => {
  it.each([
    ["token", "token"],
    ["token\n", "token"],
    ["token\r\n", "token"],
    ["token\n\n", "token\n"],
    [" token \t\r", " token \t\r"],
    ["\uFEFFtoken\n", "\uFEFFtoken"],
    ["~/{{machine_id}}/${TOKEN}/$(command)\n", "~/{{machine_id}}/${TOKEN}/$(command)"],
    ["x".repeat(8192) + "\r\n", "x".repeat(8192)],
  ])("preserves contents except one terminal line ending (%#)", async (input, expected) => {
    const { path } = await fixture(input);
    expect(await readEnvironmentFile(path)).toBe(expected);
  });

  it.each([
    "",
    "\n",
    "\r\n",
    "secret\0value",
    "x".repeat(8193),
    "x".repeat(8193) + "\n",
    "x".repeat(8195),
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xff]),
  ])(
    "rejects empty, invalid UTF-8, NUL and oversized contents without exposing data (%#)",
    async (bytes) => {
      const { path } = await fixture(bytes);
      const error = await readEnvironmentFile(path).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Pi environment file could not be read or has invalid contents",
      );
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(path);
    },
  );

  it("follows ordinary symlinks and permits ordinary file modes", async () => {
    const { root, path } = await fixture(" linked \n");
    const alias = join(root, "alias");
    await symlink(path, alias);
    await chmod(path, 0o644);
    expect(await readEnvironmentFile(alias)).toBe(" linked ");
  });

  it("rejects missing paths and directories with the same sanitized error", async () => {
    const { root } = await fixture();
    for (const path of [root, join(root, "missing")]) {
      await expect(readEnvironmentFile(path)).rejects.toThrow(
        "Pi environment file could not be read or has invalid contents",
      );
    }
  });

  it("rejects a FIFO without waiting for a writer", async () => {
    const { root } = await fixture();
    const fifo = join(root, "fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    await expect(readEnvironmentFile(fifo)).rejects.toThrow(
      "Pi environment file could not be read or has invalid contents",
    );
  }, 5000);

  it.runIf(process.geteuid?.() !== 0)("uses invoking-user permissions", async () => {
    const { path } = await fixture();
    await chmod(path, 0);
    await expect(readEnvironmentFile(path)).rejects.toThrow(
      "Pi environment file could not be read or has invalid contents",
    );
  });

  it("reads only surviving base references, once per literal path, and refreshes next startup", async () => {
    const { root, path } = await fixture();
    const missing = join(root, "missing");
    const read = vi.fn(readEnvironmentFile);
    const merged = overlayManagedEnvironment(
      authored({ FIRST: { file: path }, SECOND: { file: path }, REPLACED: { file: missing } }),
      parseBrokerManagedEnvironment({
        pi: { REPLACED: { literal: "opaque" } },
        sandbox: {},
        extensions: {},
      }),
    );
    expect(await resolveEnvironmentFiles(merged, read)).toEqual({
      pi: {
        FIRST: { literal: "token" },
        SECOND: { literal: "token" },
        REPLACED: { literal: "opaque" },
      },
      sandbox: {},
      extensions: {},
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(path);
    await writeFile(path, "rotated\n");
    expect((await resolveEnvironmentFiles(merged, read)).pi.FIRST).toEqual({ literal: "rotated" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("preserves a file-backed __proto__ variable as an own data entry", async () => {
    const { path } = await fixture();
    const resolved = await resolveEnvironmentFiles(
      authored(Object.fromEntries([["__proto__", { file: path }]])),
    );
    expect(Object.hasOwn(resolved.pi, "__proto__")).toBe(true);
    expect(resolved.pi["__proto__"]).toEqual({ literal: "token" });
    expect(Object.getPrototypeOf(resolved.pi)).toBe(Object.prototype);
  });

  it("rechecks aggregate bounds after resolving small path references", async () => {
    const { root } = await fixture();
    const pi = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `KEY_${index}`,
        { file: join(root, String(index)) },
      ]),
    );
    await expect(
      resolveEnvironmentFiles(authored(pi), () => Promise.resolve("x".repeat(8192))),
    ).rejects.toThrow("managed_environment_invalid");
  });

  it("does not accept nonregular symlink targets", async () => {
    const { root } = await fixture();
    const directory = join(root, "directory");
    const alias = join(root, "directory-link");
    await mkdir(directory);
    await symlink(directory, alias);
    await expect(readEnvironmentFile(alias)).rejects.toThrow(
      "Pi environment file could not be read or has invalid contents",
    );
  });
});
