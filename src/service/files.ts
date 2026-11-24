import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Ordinary invoking-user file permissions and symlinks; no privileged-source policy. */
export async function readBoundedUtf8File(
  path: string,
  maximum: number,
  description: string,
): Promise<string> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximum) throw new Error();
      const bytes = Buffer.alloc(maximum + 1);
      let size = 0;
      while (size < bytes.length) {
        const r = await file.read(bytes, size, bytes.length - size, null);
        if (r.bytesRead === 0) break;
        size += r.bytesRead;
      }
      if (size > maximum) throw new Error();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, size),
      );
    } finally {
      await file.close();
    }
  } catch {
    throw new Error(`${description} must be a readable bounded regular UTF-8 file`);
  }
}
