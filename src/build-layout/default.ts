export const compiledLayout = Object.freeze({
  configuration: Object.freeze({
    source: "local" as const,
    allowConfigOverride: false,
    configDir: "/etc/pi-sandbox",
    configPath: "/etc/pi-sandbox/config.toml",
    defaultModelsPath: "/etc/pi-sandbox/models.json",
  }),
  libexecDir: "/usr/libexec/pi-sandbox",
  launcherPath: "/usr/bin/pi-sandbox",
  bubblewrap: Object.freeze({ mode: "system", path: "/usr/bin/bwrap" }),
});
