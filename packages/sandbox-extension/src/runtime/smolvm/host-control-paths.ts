import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Host credentials and Pi state must not become a guest mount, including aliases. */
export async function hostControlPaths(): Promise<readonly string[]> {
  const controls = [
    path.join(homedir(), ".pi"),
    path.join(homedir(), ".ssh"),
    process.env.PI_CODING_AGENT_DIR,
  ].filter((value): value is string => !!value);
  return Promise.all(
    controls.map(async (control) => {
      try {
        return await realpath(control);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(control);
        throw error;
      }
    }),
  );
}
