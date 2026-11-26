import { join } from "node:path";

export const macosInstallDirectory = "/Applications";
export const macosBundleName = "Pi Sandbox.app";
export const macosBundleClient = "Contents/Resources/client";
export const macosBundleLauncher = "Contents/MacOS/pi-sandbox";

const installedBundle = join(macosInstallDirectory, macosBundleName);
export const macosInstalledBundleLauncher = join(installedBundle, macosBundleLauncher);
export const macosPackageLayout = Object.freeze({
  libexecDir: join(installedBundle, macosBundleClient),
  launcherPath: "/usr/local/bin/pi-sandbox",
});
