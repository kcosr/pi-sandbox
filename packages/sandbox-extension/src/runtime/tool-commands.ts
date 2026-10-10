import type { ToolCommandPaths } from "./contracts.js";

export const LINUX_TOOL_COMMANDS: ToolCommandPaths = Object.freeze({
  bash: "/bin/bash",
  sh: "/bin/sh",
  cat: "/bin/cat",
  chmod: "/bin/chmod",
  mkdir: "/bin/mkdir",
  mv: "/bin/mv",
  rm: "/bin/rm",
  grep: "/bin/grep",
  file: "/usr/bin/file",
  find: "/usr/bin/find",
  awk: "/usr/bin/awk",
  head: "/usr/bin/head",
  sha256sum: "/usr/bin/sha256sum",
  sort: "/usr/bin/sort",
  tail: "/usr/bin/tail",
  test: "/usr/bin/test",
  wc: "/usr/bin/wc",
});

export const REQUIRED_SANDBOX_EXECUTABLES = Object.freeze(Object.values(LINUX_TOOL_COMMANDS));
