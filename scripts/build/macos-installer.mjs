import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  macosBundleClient,
  macosBundleFinderLauncher,
  macosBundleLauncher,
  macosBundleName,
  macosBundleTerminalCommand,
  macosInstallDirectory,
  macosInstalledBundleLauncher,
  macosPackageLayout,
} from "./macos-layout.mjs";

const bundleIdentifier = "io.github.kcosr.pi-sandbox";
const launcherSource = fileURLToPath(new URL("./macos-launcher.c", import.meta.url));
const terminalCommandSource = new URL("./macos-terminal.command", import.meta.url);
const launcherHook = new URL("../install/macos-app-launcher.sh", import.meta.url);
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const osVersionPattern = /^\d+\.\d+(?:\.\d+)?$/u;

function plist(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${body}
</plist>
`;
}

function newerOS(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? left : right;
  }
  return left;
}

async function nativeMinimumOS(executable, architecture, capture) {
  if ((await capture("/usr/bin/lipo", ["-archs", executable])).trim() !== architecture)
    throw new Error("macOS package executable architecture does not match the release target");
  const headers = await capture("/usr/bin/vtool", ["-show-build", executable]);
  const version = /^\s*minos\s+(\d+\.\d+(?:\.\d+)?)\s*$/mu.exec(headers)?.[1];
  if (version !== undefined && /^\s*platform\s+MACOS\s*$/mu.test(headers)) return version;
  const legacyVersion =
    /cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+\.\d+(?:\.\d+)?)/u.exec(headers)?.[1];
  if (legacyVersion !== undefined) return legacyVersion;
  throw new Error("macOS package executable has no macOS deployment version");
}

async function bundleModes(root, normalize = false) {
  const modes = new Map();
  async function visit(name) {
    const path = join(root, name);
    const stats = await lstat(path);
    const directory = stats.isDirectory();
    if (!directory && !stats.isFile())
      throw new Error(`macOS package contains an unsupported file type: ${name}`);
    const mode = directory || (stats.mode & 0o111) !== 0 ? 0o755 : 0o644;
    if ((stats.mode & 0o7777) !== mode) {
      if (!normalize) throw new Error(`macOS package has an unexpected mode: ${name}`);
      await chmod(path, mode);
    }
    modes.set(name, mode | (directory ? 0o040000 : 0o100000));
    if (directory) {
      for (const entry of (await readdir(path)).sort())
        await visit(name === "." ? entry : join(name, entry));
    }
  }
  await visit(".");
  return modes;
}

function verifyBom(listing, expectedModes) {
  const remaining = new Map(expectedModes);
  for (const row of listing.trimEnd().split("\n")) {
    const [raw, mode, uid, gid, ...extra] = row.split("\t");
    const name = raw.replace(/^\.\//u, "");
    const actualMode = Number.parseInt(mode, 8);
    if (uid !== "0" || gid !== "0" || extra.length !== 0)
      throw new Error(`macOS package has unexpected payload ownership: ${name}`);
    if (remaining.get(name) === actualMode) {
      remaining.delete(name);
      continue;
    }
    // Apple's package format may encode xattrs as companion AppleDouble records.
    const leaf = name.split("/").at(-1);
    const companion = name.slice(0, name.length - leaf.length) + leaf.slice(2);
    if (leaf.startsWith("._") && expectedModes.get(companion) === actualMode) continue;
    throw new Error(`macOS package contains an unexpected bill of materials entry: ${name}`);
  }
  if (remaining.size !== 0)
    throw new Error("macOS package bill of materials omits payload entries");
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex");
}

async function makeDiskImage({ product, filename, sha256, directory, output, run }) {
  const contents = join(directory, "image-contents");
  const mountpoint = join(directory, "image-mount");
  await mkdir(contents);
  await mkdir(mountpoint);
  await copyFile(product, join(contents, filename));
  await run("/usr/bin/hdiutil", [
    "create",
    "-quiet",
    "-format",
    "UDZO",
    "-volname",
    "Pi Sandbox",
    "-srcfolder",
    contents,
    output,
  ]);
  await run("/usr/bin/hdiutil", ["verify", "-quiet", output]);
  await run("/usr/bin/hdiutil", [
    "attach",
    "-quiet",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    mountpoint,
    output,
  ]);
  try {
    const packaged = join(mountpoint, filename);
    if (!(await lstat(packaged)).isFile() || (await digest(packaged)) !== sha256)
      throw new Error("macOS disk image does not contain the verified installer package");
  } finally {
    await run("/usr/bin/hdiutil", ["detach", "-quiet", mountpoint]);
  }
}

/** Assemble a native installer around the already validated, executable-relative client payload. */
export async function buildMacosInstaller({
  payload,
  temporaryDirectory,
  out,
  version,
  architecture,
  minimumOS,
  displayVersion,
  diskImage,
  run,
  capture,
  fileInventory,
}) {
  const nativeArch = { arm64: "arm64", x64: "x86_64" }[architecture];
  if (process.platform !== "darwin" || nativeArch === undefined || architecture !== process.arch)
    throw new Error("macOS installer assembly requires the macOS host architecture");
  if (
    !versionPattern.test(version) ||
    (minimumOS !== undefined && !osVersionPattern.test(minimumOS))
  )
    throw new Error("macOS installer version metadata is invalid");

  const directory = await mkdtemp(join(temporaryDirectory, "macos-installer-"));
  const root = join(directory, "root");
  const app = join(root, macosBundleName);
  const client = join(app, macosBundleClient);
  const launcher = join(app, macosBundleLauncher);
  const finderLauncher = join(app, macosBundleFinderLauncher);
  const terminalCommand = join(app, macosBundleTerminalCommand);
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(dirname(client), { recursive: true });
  await cp(payload, client, { recursive: true, force: false, errorOnExist: true });

  const appMinimumOS = await nativeMinimumOS(join(client, "pi-sandbox"), nativeArch, capture);
  let requiredOS = minimumOS === undefined ? appMinimumOS : newerOS(appMinimumOS, minimumOS);
  for (const native of (await fileInventory(client)).filter(
    (entry) => entry.path.startsWith("native/") && entry.path.endsWith(".node"),
  )) {
    const nativeOS = await nativeMinimumOS(join(client, native.path), nativeArch, capture);
    requiredOS = newerOS(requiredOS, nativeOS);
  }

  await copyFile(terminalCommandSource, terminalCommand);
  await chmod(terminalCommand, 0o755);
  for (const [executable, target, flags] of [
    [launcher, join(client, "pi-sandbox"), []],
    [finderLauncher, terminalCommand, ["-DPI_SANDBOX_OPEN_TERMINAL"]],
  ]) {
    await run("/usr/bin/clang", [
      "-arch",
      nativeArch,
      `-mmacosx-version-min=${requiredOS}`,
      "-Wall",
      "-Wextra",
      "-Werror",
      `-DPI_SANDBOX_TARGET_PATH=${JSON.stringify(relative(dirname(executable), target))}`,
      ...flags,
      launcherSource,
      "-o",
      executable,
    ]);
    await nativeMinimumOS(executable, nativeArch, capture);
  }
  await writeFile(
    join(app, "Contents/Info.plist"),
    plist(`<dict>
  <key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
  <key>CFBundleExecutable</key><string>${basename(finderLauncher)}</string>
  <key>CFBundleName</key><string>Pi Sandbox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>${requiredOS}</string>
</dict>`),
  );
  await run("/usr/bin/codesign", ["--force", "--sign", "-", launcher]);
  await run("/usr/bin/codesign", ["--force", "--sign", "-", app]);
  const expectedModes = await bundleModes(root, true);
  const expectedPayload = await fileInventory(root);
  if (JSON.stringify(await fileInventory(client)) !== JSON.stringify(await fileInventory(payload)))
    throw new Error("macOS bundle assembly changed the validated client payload");

  const componentPlist = join(directory, "component.plist");
  await writeFile(
    componentPlist,
    plist(`<array><dict>
  <key>RootRelativeBundlePath</key><string>${macosBundleName}</string>
  <key>BundleIsRelocatable</key><false/>
  <key>BundleHasStrictIdentifier</key><true/>
  <key>BundleIsVersionChecked</key><true/>
  <key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array>`),
  );
  const requirementsPlist = join(directory, "requirements.plist");
  await writeFile(
    requirementsPlist,
    plist(`<dict>
  <key>arch</key><array><string>${nativeArch}</string></array>
  <key>os</key><array><string>${requiredOS}</string></array>
  <key>home</key><false/>
</dict>`),
  );
  const component = join(directory, "component.pkg");
  const scripts = join(directory, "scripts");
  await mkdir(scripts);
  const hook = (await readFile(launcherHook, "utf8"))
    .replace("@BUNDLE_LAUNCHER@", macosInstalledBundleLauncher)
    .replace("@COMMAND_PATH@", macosPackageLayout.launcherPath);
  for (const name of ["preinstall", "postinstall"])
    await writeFile(join(scripts, name), hook, { mode: 0o755 });
  await run("/usr/bin/pkgbuild", [
    "--root",
    root,
    "--component-plist",
    componentPlist,
    "--scripts",
    scripts,
    "--install-location",
    macosInstallDirectory,
    "--ownership",
    "recommended",
    "--identifier",
    bundleIdentifier,
    "--version",
    version,
    component,
  ]);

  await mkdir(out, { recursive: true });
  // Staging is private and on the destination filesystem. Link complete files into place.
  const outputStage = await mkdtemp(join(out, ".pi-sandbox-macos-"));
  const published = [];
  try {
    const stem = `pi-sandbox-${version}-darwin-${architecture}`;
    const filename = `${stem}.pkg`;
    const product = join(outputStage, filename);
    await run("/usr/bin/productbuild", [
      "--product",
      requirementsPlist,
      "--package",
      component,
      product,
    ]);
    await chmod(product, 0o600);

    const expanded = join(directory, "expanded");
    await run("/usr/sbin/pkgutil", ["--expand-full", product, expanded]);
    const packageDirectory = join(expanded, "component.pkg");
    const expandedPayload = join(packageDirectory, "Payload");
    const info = await readFile(join(packageDirectory, "PackageInfo"), "utf8");
    const distribution = await readFile(join(expanded, "Distribution"), "utf8");
    if (
      !info.includes(`install-location="${macosInstallDirectory}"`) ||
      !info.includes('auth="root"') ||
      !info.includes('relocatable="false"') ||
      !info.includes(`identifier="${bundleIdentifier}"`) ||
      !info.includes("<upgrade-bundle>") ||
      !info.includes("<strict-identifier>") ||
      !info.includes("<preinstall ") ||
      !info.includes("<postinstall ") ||
      !distribution.includes(`hostArchitectures="${nativeArch}"`) ||
      !distribution.includes(`min="${requiredOS}"`)
    )
      throw new Error("macOS package installer metadata does not match the requested release");
    for (const name of ["preinstall", "postinstall"]) {
      const script = join(packageDirectory, "Scripts", name);
      if ((await readFile(script, "utf8")) !== hook || ((await lstat(script)).mode & 0o111) === 0)
        throw new Error(`macOS package ${name} hook differs after extraction`);
    }
    verifyBom(
      await capture("/usr/bin/lsbom", ["-p", "fmug", join(packageDirectory, "Bom")]),
      expectedModes,
    );
    const actualModes = await bundleModes(expandedPayload);
    if (
      JSON.stringify([...actualModes]) !== JSON.stringify([...expectedModes]) ||
      JSON.stringify(await fileInventory(expandedPayload)) !== JSON.stringify(expectedPayload)
    )
      throw new Error("macOS installer payload inventory differs after extraction");

    const extractedApp = join(expandedPayload, macosBundleName);
    const extractedPayload = join(extractedApp, macosBundleClient);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", extractedApp]);
    await run("/usr/bin/codesign", ["--verify", "--strict", join(extractedPayload, "pi-sandbox")]);
    if (
      (await capture(join(extractedApp, macosBundleLauncher), ["--version"])).trim() !==
      displayVersion
    )
      throw new Error("macOS installer launcher did not start the packaged release");

    const pkgHash = await digest(product);
    const staging = [{ filename, sha256: pkgHash }];
    if (diskImage) {
      const name = `${stem}.dmg`;
      const image = join(outputStage, name);
      await makeDiskImage({
        product,
        filename,
        sha256: pkgHash,
        directory,
        output: image,
        run,
      });
      await chmod(image, 0o600);
      staging.push({ filename: name, sha256: await digest(image) });
    }
    for (const { filename: name, sha256 } of staging) {
      const checksum = join(outputStage, `${name}.sha256`);
      await writeFile(checksum, `${sha256}  ${name}\n`, { flag: "wx", mode: 0o600 });
      await chmod(checksum, 0o600);
    }
    for (const { filename: name } of staging) {
      for (const entry of [name, `${name}.sha256`]) {
        await link(join(outputStage, entry), join(out, entry));
        published.push(entry);
      }
    }
    const artifacts = staging.map(({ filename: name, sha256 }) => ({
      path: join(out, name),
      sha256,
    }));
    return { artifacts, extractedApp, extractedPayload };
  } catch (error) {
    for (const entry of published) {
      const path = join(out, entry);
      const actual = await lstat(path).catch((cause) => {
        if (cause.code !== "ENOENT") throw cause;
      });
      const staged = await lstat(join(outputStage, entry));
      if (actual?.dev === staged.dev && actual.ino === staged.ino) await rm(path, { force: true });
    }
    throw error;
  } finally {
    await rm(outputStage, { recursive: true, force: true });
  }
}
