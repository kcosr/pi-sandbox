import type { SandboxConfig } from "../domain/index.js";

export function assertExecutionPlatform(
  config: Pick<SandboxConfig, "execution" | "network" | "filesystem">,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`Unsupported operating system: ${platform}`);
  }
  if (config.execution.backend === "bubblewrap" && platform !== "linux") {
    throw new Error("Bubblewrap execution is supported only on Linux");
  }
  if (config.execution.backend === "seatbelt") {
    if (platform !== "darwin") throw new Error("Seatbelt execution is supported only on macOS");
    if (config.network.mode === "local")
      throw new Error("Seatbelt execution requires network.mode = none or host");
    if (config.filesystem.hiddenPaths.length > 0)
      throw new Error("Seatbelt execution requires filesystem.hidden_paths = []");
  } else if (config.filesystem.deniedPaths.length > 0) {
    throw new Error("filesystem.denied_paths requires Seatbelt execution");
  }
  if (config.execution.backend === "direct" && config.network.mode !== "host") {
    throw new Error("Direct execution requires network.mode = host");
  }
  if (config.execution.backend === "direct" && !config.filesystem.cwdWritable) {
    throw new Error("Direct execution requires filesystem.cwd_writable = true");
  }
  if (config.execution.backend === "direct" && config.filesystem.hiddenPaths.length > 0) {
    throw new Error("Direct execution requires filesystem.hidden_paths = []");
  }
}
