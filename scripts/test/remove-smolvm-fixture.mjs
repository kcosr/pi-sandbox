import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Test-only disposal, called only after the isolated registry is confirmed empty. */
export async function removeSmolvmFixture(directory) {
  // smolvm deliberately makes shared CoW cache directories read-only. These
  // fixtures own the entire disposable account cache, unlike product cleanup.
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const stat = await lstat(current);
    if (!stat.isDirectory()) continue;
    if (stat.uid !== process.getuid()) throw new Error("Fixture directory owner changed");
    await chmod(current, (stat.mode & 0o777) | 0o700);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(join(current, entry.name));
    }
  }
  await rm(directory, { recursive: true, force: true });
}
