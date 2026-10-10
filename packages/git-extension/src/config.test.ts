import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGitConfig, readGitConfig } from "./config.js";

const POLICY = { version: 1, allowed_hosts: ["github.com"], allowed_schemes: ["https"] };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-git-config-"));
  directories.push(directory);
  const file = path.join(directory, "git.json");
  await writeFile(file, JSON.stringify(POLICY), { mode: 0o600 });
  return { directory, file };
}

describe("standalone Git configuration", () => {
  it("requires explicit version and the same strict repository policy as managed Git", () => {
    const parsed = parseGitConfig(POLICY);
    expect(parsed).toEqual(POLICY);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.allowed_hosts)).toBe(true);
    for (const invalid of [
      null,
      [],
      { ...POLICY, version: 2 },
      { allowed_hosts: ["github.com"], allowed_schemes: ["https"] },
      { ...POLICY, allowed_hosts: [] },
      { ...POLICY, allowed_hosts: ["github.com:443"] },
      { ...POLICY, allowed_schemes: ["file"] },
      { ...POLICY, tools: {} },
      Object.assign(Object.create({ inherited: true }) as object, POLICY),
    ])
      expect(() => parseGitConfig(invalid)).toThrow();
  });

  it("reads only an explicit private owned regular file, with no final symlink", async () => {
    const { directory, file } = await fixture();
    await expect(readGitConfig(file)).resolves.toEqual(POLICY);
    await expect(readGitConfig("git.json")).rejects.toThrow("absolute");
    await expect(readGitConfig(`${directory}/../git.json`)).rejects.toThrow("absolute");
    const alias = path.join(directory, "alias.json");
    await symlink(file, alias);
    await expect(readGitConfig(alias)).rejects.toThrow();
    await expect(readGitConfig(directory)).rejects.toThrow("private owned regular");
    await chmod(file, 0o640);
    await expect(readGitConfig(file)).rejects.toThrow("private owned regular");
  });

  it("rejects invalid JSON and oversized configuration", async () => {
    const { file } = await fixture();
    await writeFile(file, "{");
    await expect(readGitConfig(file)).rejects.toThrow();
    await writeFile(file, " ".repeat(65537));
    await expect(readGitConfig(file)).rejects.toThrow("64 KiB");
  });
});
