import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCandidateSkillDirectories, validateSharedSkillDirectories } from "./skills.js";

const temporary: string[] = [];
async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-shared-skills-"));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("shared skill policy validation", () => {
  it("accepts empty roots, symlink aliases, overlapping roots, and does not parse individual skills", async () => {
    const root = await fixture();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "SKILL.md"), "malformed skills remain Pi diagnostics");
    await symlink(join(root, "nested"), join(root, "alias"));
    await expect(validateSharedSkillDirectories([])).resolves.toBeUndefined();
    await expect(
      validateSharedSkillDirectories([root, join(root, "nested"), join(root, "alias")]),
    ).resolves.toBeUndefined();
  });

  it("rejects missing or non-directory roots with the authored path", async () => {
    const root = await fixture();
    await writeFile(join(root, "file"), "x");
    for (const path of [join(root, "missing"), join(root, "file")]) {
      await expect(validateSharedSkillDirectories([root, path])).rejects.toThrow(path);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "requires both read and traversal permission as the invoking user",
    async () => {
      const root = await fixture();
      try {
        for (const mode of [0o400, 0o100, 0o000]) {
          await chmod(root, mode);
          await expect(validateSharedSkillDirectories([root])).rejects.toThrow(
            "readable, traversable",
          );
        }
      } finally {
        await chmod(root, 0o700);
      }
    },
  );

  it("checks only roots inside the package-owned skill tree against the candidate payload", async () => {
    const candidate = await fixture();
    const libexec = "/usr/libexec/pi-sandbox";
    const bundled = `${libexec}/skills`;
    await expect(
      validateCandidateSkillDirectories(
        ["/absent/external", `${bundled}-other`],
        libexec,
        candidate,
      ),
    ).resolves.toBeUndefined();
    await expect(validateCandidateSkillDirectories([bundled], libexec, candidate)).rejects.toThrow(
      bundled,
    );
    await mkdir(join(candidate, "skills", "team"), { recursive: true });
    await writeFile(join(candidate, "skills", "file"), "x");
    await expect(
      validateCandidateSkillDirectories([bundled, `${bundled}/team`], libexec, candidate),
    ).resolves.toBeUndefined();
    for (const suffix of ["removed", "file"]) {
      await expect(
        validateCandidateSkillDirectories([`${bundled}/${suffix}`], libexec, candidate),
      ).rejects.toThrow("candidate payload");
    }
    await expect(validateCandidateSkillDirectories([], libexec, "relative")).rejects.toThrow(
      "absolute",
    );
    await expect(
      validateCandidateSkillDirectories([], libexec, join(candidate, "skills", "file")),
    ).rejects.toThrow("directory");
  });
});
