export const compiledLayout = Object.freeze({
  configDir: "/etc/pi-sandbox",
  configPath: "/etc/pi-sandbox/config.toml",
  defaultModelsPath: "/etc/pi-sandbox/models.json",
  libexecDir: "/usr/libexec/pi-sandbox",
  launcherPath: "/usr/bin/pi-sandbox",
  auditSocketPath: "/run/pi-sandbox-audit/collector.sock",
  identitySocketPath: "/run/pi-sandbox-identity/broker.sock",
  serviceDir: "/usr/lib/systemd/system",
  bubblewrap: Object.freeze({ mode: "system", path: "/usr/bin/bwrap" }),
});
