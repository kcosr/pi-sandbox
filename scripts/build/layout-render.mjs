import { dirname, join, relative } from "node:path";

export function layoutReplacements(layout, os) {
  const defaults =
    os === "linux"
      ? {
          configDir: "/etc/pi-sandbox",
          libexecDir: "/usr/libexec/pi-sandbox",
          launcherPath: "/usr/bin/pi-sandbox",
          serviceDir: "/usr/lib/systemd/system",
          identitySocketPath: "/run/pi-sandbox-identity/broker.sock",
        }
      : {
          configDir: "/etc/pi-sandbox",
          libexecDir: "/usr/local/libexec/pi-sandbox",
          launcherPath: "/usr/local/bin/pi-sandbox",
          identitySocketPath: "/run/pi-sandbox-identity/broker.sock",
        };
  const replacements = [
    [
      "../libexec/pi-sandbox/pi-sandbox",
      relative(dirname(layout.launcherPath), join(layout.libexecDir, "pi-sandbox")),
    ],
    [defaults.configDir, layout.configDir],
    [defaults.libexecDir, layout.libexecDir],
    [defaults.launcherPath, layout.launcherPath],
    [defaults.identitySocketPath, layout.identitySocketPath],
  ];
  if (os === "linux") {
    replacements.unshift(
      ["bubblewrap_mode=system", `bubblewrap_mode=${layout.bubblewrap.mode}`],
      ["/usr/bin/bwrap", layout.bubblewrap.path],
      [
        "../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker.socket",
        relative(
          layout.serviceDir,
          join(layout.libexecDir, "systemd/pi-sandbox-identity-broker.socket"),
        ),
      ],
      [
        "../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker@.service",
        relative(
          layout.serviceDir,
          join(layout.libexecDir, "systemd/pi-sandbox-identity-broker@.service"),
        ),
      ],
    );
    replacements.push([defaults.serviceDir, layout.serviceDir]);
  }
  return replacements;
}

export function renderLayoutText(contents, layout, os) {
  const replacements = new Map(layoutReplacements(layout, os));
  const pattern = new RegExp(
    [...replacements.keys()]
      .sort((left, right) => right.length - left.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("|"),
    "gu",
  );
  return contents.replace(pattern, (match) => replacements.get(match) ?? match);
}
