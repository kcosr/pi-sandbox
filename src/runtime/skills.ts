import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/** Validate policy even when skill selection is disabled. Keep authored paths intact. */
export async function validateSharedSkillDirectories(
  directories: readonly string[],
): Promise<void> {
  for (const directory of directories) {
    try {
      if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
      await access(directory, constants.R_OK | constants.X_OK);
    } catch (cause) {
      throw new Error(
        `config.skills.directories: shared skill root must be a readable, traversable directory: ${directory}`,
        { cause },
      );
    }
  }
}

/** Installation checks package-owned roots against the replacement, never the old payload. */
export async function validateCandidateSkillDirectories(
  directories: readonly string[],
  libexecDirectory: string,
  candidatePayload: string,
): Promise<void> {
  if (!isAbsolute(candidatePayload) || candidatePayload.includes("\0")) {
    throw new Error("candidate payload must be an absolute directory path");
  }
  if (!(await stat(candidatePayload)).isDirectory())
    throw new Error("candidate payload must be a directory");
  const installedSkills = join(libexecDirectory, "skills");
  for (const directory of directories) {
    if (directory !== installedSkills && !directory.startsWith(`${installedSkills}/`)) continue;
    const candidate = join(candidatePayload, "skills", relative(installedSkills, directory));
    try {
      if (!(await stat(candidate)).isDirectory()) throw new Error("not a directory");
    } catch (cause) {
      throw new Error(
        `config.skills.directories: candidate payload does not provide configured skill root: ${directory}`,
        { cause },
      );
    }
  }
}
