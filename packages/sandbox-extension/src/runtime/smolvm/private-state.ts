import { chmod, lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

/** Only call after every VM using this private state has been confirmed stopped. */
export async function removeStoppedPrivateState(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || directory === "/" || (await realpath(directory)) !== directory)
    throw new Error("smolvm_cleanup_path_invalid");
  async function writableDirectories(current: string): Promise<void> {
    const stat = await lstat(current);
    if (!stat.isDirectory()) return; // Never traverse a symlink.
    if (stat.uid !== process.getuid?.()) throw new Error("smolvm_cleanup_owner_changed");
    // Upstream marks immutable extracted CoW bases read-only. They can only be
    // removed after the final dependent VM stops, which the caller establishes.
    await chmod(current, stat.mode | 0o700);
    for (const entry of await readdir(current, { withFileTypes: true }))
      if (entry.isDirectory()) await writableDirectories(path.join(current, entry.name));
  }
  await writableDirectories(directory);
  await rm(directory, { recursive: true, force: true });
}
