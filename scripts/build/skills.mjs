import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const comparePaths = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const modeString = (mode) => ((mode & 0o111) === 0 ? "0644" : "0755");

function validateComponent(component) {
  if (
    component.length === 0 ||
    component === "." ||
    component === ".." ||
    /[^!-~]|[\\/]/u.test(component)
  ) {
    throw new Error("bundled skill paths must use printable ASCII without spaces or backslashes");
  }
}

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function inspectSkills(directory, { normalizeModes = false } = {}) {
  const root = await lstat(directory);
  if (!root.isDirectory()) throw new Error("skills_source must be a regular directory");
  const directories = [];
  const files = [];
  async function visit(path, relativePath) {
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      if (!normalizeModes && (stat.mode & 0o7777) !== 0o755) {
        throw new Error(`bundled skill directory mode must be 0755: ${relativePath}`);
      }
      directories.push(relativePath);
      for (const entry of (await readdir(path)).sort(comparePaths)) {
        validateComponent(entry);
        await visit(join(path, entry), `${relativePath}/${entry}`);
      }
    } else if (stat.isFile()) {
      const mode = modeString(stat.mode);
      if (!normalizeModes && (stat.mode & 0o7777) !== Number.parseInt(mode, 8)) {
        throw new Error(`bundled skill file mode must be 0644 or 0755: ${relativePath}`);
      }
      const contents = await readFile(path);
      files.push({ path: relativePath, size: contents.byteLength, sha256: digest(contents), mode });
    } else {
      throw new Error(`bundled skills contain an unsupported file type: ${relativePath}`);
    }
  }
  await visit(directory, "skills");
  directories.sort(comparePaths);
  files.sort((left, right) => comparePaths(left.path, right.path));
  return { directories, files };
}

/** Snapshot content and normalized modes before building; source paths stay out of releases. */
export async function loadSkillsBundle(source) {
  if (source === undefined) return undefined;
  const inventory = await inspectSkills(source, { normalizeModes: true });
  return {
    directory: source,
    release: {
      source: { kind: "prepared-directory", sha256: digest(JSON.stringify(inventory)) },
      ...inventory,
    },
  };
}

export function validateSkillsConfiguration(bundle, config, layout) {
  const installedRoot = `${layout.libexecDir}/skills`;
  const roots = config.skills?.directories ?? [];
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
    throw new Error("default configuration skills.directories must be an array of paths");
  }
  if (bundle && !roots.includes(installedRoot)) {
    throw new Error(`default configuration skills.directories must include ${installedRoot}`);
  }
  for (const root of roots) {
    if (root !== installedRoot && !root.startsWith(`${installedRoot}/`)) continue;
    const relativePath = `skills${root.slice(installedRoot.length)}`;
    if (!bundle?.release.directories.includes(relativePath)) {
      throw new Error(`configured bundled skill directory is absent from the candidate: ${root}`);
    }
  }
}

export async function copySkillsBundle(bundle, payload) {
  if (!bundle) return;
  for (const directory of bundle.release.directories) {
    await mkdir(join(payload, directory), { recursive: true, mode: 0o755 });
    await chmod(join(payload, directory), 0o755);
  }
  for (const file of bundle.release.files) {
    const sourcePath = join(bundle.directory, file.path.slice("skills/".length));
    const stat = await lstat(sourcePath);
    if (!stat.isFile() || modeString(stat.mode) !== file.mode) {
      throw new Error(`skill source changed during the build: ${file.path}`);
    }
    const contents = await readFile(sourcePath);
    if (contents.byteLength !== file.size || digest(contents) !== file.sha256) {
      throw new Error(`skill source changed during the build: ${file.path}`);
    }
    const target = join(payload, file.path);
    await writeFile(target, contents, { flag: "wx", mode: Number.parseInt(file.mode, 8) });
    await chmod(target, Number.parseInt(file.mode, 8));
  }
  // Detect additions, removals, mode changes and empty-directory changes as well.
  const current = await inspectSkills(bundle.directory, { normalizeModes: true });
  if (digest(JSON.stringify(current)) !== bundle.release.source.sha256) {
    throw new Error("skill source changed during the build");
  }
  await writeFile(
    join(payload, "skills-modes.txt"),
    bundle.release.files.map((file) => `${file.mode} ${file.path}\n`).join(""),
    { flag: "wx", mode: 0o644 },
  );
  await chmod(join(payload, "skills-modes.txt"), 0o644);
  await validatePackagedSkills(payload, bundle.release);
}

/** Validate actual archive modes and exact manifest/sidecar/file membership. */
export async function validatePackagedSkills(payload, expected = null) {
  const tree = await statIfPresent(join(payload, "skills"));
  const sidecar = await statIfPresent(join(payload, "skills-modes.txt"));
  if (!tree && !sidecar) {
    if (expected !== null) throw new Error("bundled skills are missing from the payload");
    return;
  }
  if (!tree?.isDirectory() || !sidecar?.isFile()) {
    throw new Error("bundled skills require both a regular skills directory and skills-modes.txt");
  }
  if (expected === null) throw new Error("payload contains an unselected skills bundle");
  if ((sidecar.mode & 0o7777) !== 0o644) throw new Error("skills-modes.txt must have mode 0644");
  const inventory = await inspectSkills(join(payload, "skills"));
  const modes = inventory.files.map((file) => `${file.mode} ${file.path}\n`).join("");
  if ((await readFile(join(payload, "skills-modes.txt"), "utf8")) !== modes) {
    throw new Error("skills-modes.txt does not match the complete bundled skill inventory");
  }
  const actual = {
    source: { kind: "prepared-directory", sha256: digest(JSON.stringify(inventory)) },
    ...inventory,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("bundled skills do not match their release inventory");
  }
}
