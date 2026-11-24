import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderLayoutText } from "../build/layout-render.mjs";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
async function files(root) {
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result.sort();
}
async function checksums(root) {
  await writeFile(
    join(root, "SHA256SUMS"),
    (await files(join(root, "payload")))
      .map(
        (path) =>
          `${createHash("sha256")
            .update(execFileSync("cat", [path]))
            .digest("hex")}  ${relative(root, path)}\n`,
      )
      .join(""),
  );
}
function run(script, args, root) {
  return spawnSync(script, args, { encoding: "utf8", env: { ...process.env, DESTDIR: root } });
}
for (const platform of ["linux", "darwin"])
  test(`${platform} service-source client installs offline without local policy and preserves credentials outside its payload`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-service-client-install-"));
    try {
      const release = join(root, "release"),
        payload = join(release, "payload/pi-sandbox"),
        dest = join(root, "dest");
      await mkdir(payload, { recursive: true });
      const libexecDir =
        platform === "linux" ? "/usr/libexec/pi-sandbox" : "/usr/local/libexec/pi-sandbox";
      const layout = {
        configuration: {
          source: "service",
          endpoint: { transport: "https", url: "https://fixture.invalid/v1/service" },
        },
        libexecDir,
        launcherPath: platform === "linux" ? "/usr/bin/pi-sandbox" : "/usr/local/bin/pi-sandbox",
        ...(platform === "linux" ? { bubblewrap: { mode: "system", path: "/usr/bin/bwrap" } } : {}),
      };
      for (const name of ["install", "uninstall"]) {
        await writeFile(
          join(release, `${name}.sh`),
          renderLayoutText(
            await readFile(
              join(
                repositoryRoot,
                `scripts/install/${platform === "darwin" ? "macos-" : ""}${name}.sh`,
              ),
              "utf8",
            ),
            layout,
            platform,
          ),
          { mode: 0o755 },
        );
      }
      await writeFile(
        join(payload, "pi-sandbox"),
        `#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = --print-build-capabilities ] || exit 91\necho '{"configuration_source":"service","architecture":"${process.arch}","platform":"${platform}"}'\n`,
        { mode: 0o755 },
      );
      await writeFile(join(payload, "release-manifest.json"), "{}\n");
      await writeFile(join(payload, "sbom.cdx.json"), "{}\n");
      // Offline skills packages require complete modes, but must not contact the endpoint.
      await mkdir(join(payload, "skills/review"), { recursive: true });
      await writeFile(join(payload, "skills/review/SKILL.md"), "# Review\n");
      await writeFile(join(payload, "skills-modes.txt"), "0644 skills/review/SKILL.md\n");
      await checksums(release);
      const installer = join(release, "install.sh"),
        uninstaller = join(release, "uninstall.sh");
      assert.notEqual(run(installer, ["--replace-config"], dest).status, 0);
      assert.notEqual(run(installer, ["--validation-user", "nobody"], dest).status, 0);
      assert.match(run(installer, ["--validation-user", "--help"], dest).stderr, /usage:/u);
      const result = run(installer, [], dest);
      assert.equal(result.status, 0, result.stderr);
      assert.ok((await readdir(join(dest, libexecDir))).includes("pi-sandbox"));
      await assert.rejects(readdir(join(dest, "etc/pi-sandbox")), { code: "ENOENT" });
      assert.notEqual(run(uninstaller, ["--remove-config"], dest).status, 0);
      assert.equal(run(uninstaller, [], dest).status, 0);
      await assert.rejects(readFile(join(dest, libexecDir, "pi-sandbox")), { code: "ENOENT" });
      await mkdir(join(payload, "defaults"));
      await writeFile(join(payload, "defaults/config.toml"), "unwanted local policy");
      await checksums(release);
      assert.notEqual(run(installer, [], dest).status, 0, "service packages reject defaults");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("independent service installer inventories artifacts and leaves deployment configuration intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-service-install-"));
  try {
    const release = join(root, "release"),
      payload = join(release, "payload/pi-sandbox-service"),
      dest = join(root, "dest");
    await mkdir(join(payload, "examples"), { recursive: true });
    for (const name of ["install", "uninstall"]) {
      await copyFile(
        join(repositoryRoot, `scripts/install/service-${name}.sh`),
        join(release, `${name}.sh`),
      );
      await chmod(join(release, `${name}.sh`), 0o755);
    }
    await writeFile(join(payload, "pi-sandbox-service"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const file of [
      "pi-sandbox-service.service",
      "sbom.cdx.json",
      "release-manifest.json",
      "examples/service.toml",
    ])
      await writeFile(join(payload, file), "fixture\n");
    await checksums(release);
    await mkdir(join(dest, "etc/pi-sandbox-service"), { recursive: true });
    await writeFile(join(dest, "etc/pi-sandbox-service/service.toml"), "deployment-owned\n");
    const install = run(join(release, "install.sh"), [], dest);
    assert.equal(install.status, 0, install.stderr);
    assert.equal(
      await readFile(join(dest, "usr/lib/systemd/system/pi-sandbox-service.service"), "utf8"),
      "fixture\n",
    );
    assert.equal(
      await readFile(join(dest, "usr/share/pi-sandbox-service/examples/service.toml"), "utf8"),
      "fixture\n",
    );
    await writeFile(join(payload, "pi-sandbox-service.service"), "tampered\n");
    assert.notEqual(run(join(release, "install.sh"), [], dest).status, 0);
    assert.equal(run(join(release, "uninstall.sh"), [], dest).status, 0);
    assert.equal(
      await readFile(join(dest, "etc/pi-sandbox-service/service.toml"), "utf8"),
      "deployment-owned\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
