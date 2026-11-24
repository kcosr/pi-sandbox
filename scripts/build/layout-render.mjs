import { dirname, join, relative } from "node:path";

export function layoutReplacements(layout, os) {
  const config = layout.configuration;
  const replacements = [
    ["configuration_source=local", `configuration_source=${config.source}`],
    ["expected_arch=x64", `expected_arch=${process.arch}`],
    [
      "bundled_commands=''",
      `bundled_commands='${[...Object.keys(layout.toolBundle?.commands ?? {}), ...Object.keys(layout.hostTools ?? {})].sort().join(" ")}'`,
    ],
    [
      "../libexec/pi-sandbox/pi-sandbox",
      relative(dirname(layout.launcherPath), join(layout.libexecDir, "pi-sandbox")),
    ],
    [
      os === "linux" ? "/usr/libexec/pi-sandbox" : "/usr/local/libexec/pi-sandbox",
      layout.libexecDir,
    ],
    [os === "linux" ? "/usr/bin/pi-sandbox" : "/usr/local/bin/pi-sandbox", layout.launcherPath],
  ];
  if (config.source === "local") replacements.push(["/etc/pi-sandbox", config.configDir]);
  if (os === "linux")
    replacements.push(
      ["bubblewrap_mode=system", `bubblewrap_mode=${layout.bubblewrap.mode}`],
      ["/usr/bin/bwrap", layout.bubblewrap.path],
    );
  return replacements;
}

export function renderLayoutText(contents, layout, os) {
  const shell = contents.startsWith("#!/bin/sh");
  const assignments = new Set([
    "configuration_source=local",
    "expected_arch=x64",
    "bundled_commands=''",
    "bubblewrap_mode=system",
  ]);
  const replacements = new Map(
    layoutReplacements(layout, os).map(([from, to]) => [
      from,
      shell && !assignments.has(from) ? to.replace(/[\\$`"]/gu, "\\$&") : to,
    ]),
  );
  const pattern = new RegExp(
    [...replacements.keys()]
      .sort((a, b) => b.length - a.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("|"),
    "gu",
  );
  return contents.replace(pattern, (match) => replacements.get(match) ?? match);
}
