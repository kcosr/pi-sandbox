import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

/** Only application-created metadata/socket directories; never smolvm storage. */
export async function removeStoppedPrivateState(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (
    !path.isAbsolute(directory) ||
    directory === "/" ||
    (await realpath(directory)) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error("smolvm_cleanup_path_invalid");
  await rm(directory, { recursive: true, force: true });
}
