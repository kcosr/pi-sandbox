import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { copyToolBundle, loadToolBundle, validateNativeToolBundle } from "../build/tool-bundle.mjs";
import { createCompiledLayoutModule } from "../build/distribution.mjs";
import { renderLayoutText } from "../build/layout-render.mjs";

test("installer rendering keeps spaces and shell metacharacters literal", () => {
  const layout = {
    libexecDir: '/opt/quoted "tools" $(exit 19)/libexec',
    launcherPath: "/opt/launchers/bin/pi-sandbox",
    configDir: "/etc/pi-sandbox",
    identitySocketPath: "/run/pi-sandbox-identity/broker.sock",
    auditSocketPath: "/run/pi-sandbox-audit/collector.sock",
  };
  const script = renderLayoutText(
    `#!/bin/sh\nset -eu\nroot_prefix=\ninstall_base="$root_prefix/usr/local/libexec/pi-sandbox"\nexpected_link="../libexec/pi-sandbox/pi-sandbox"\nprintf '%s\\n%s\\n' "$install_base" "$expected_link"\n`,
    layout,
    "darwin",
  );
  assert.equal(
    execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" }),
    `${layout.libexecDir}\n${relative(dirname(layout.launcherPath), join(layout.libexecDir, "pi-sandbox"))}\n`,
  );
});

const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(run) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tool-bundle-test-")));
  const directory = join(temporary, "bundle with spaces");
  await mkdir(join(directory, "bin"), { recursive: true });
  await mkdir(join(directory, "licenses"));
  const files = [
    {
      path: "bin/grep",
      contents: "fixture executable\n",
      mode: "0755",
      originalSha256: "0".repeat(64),
    },
    {
      path: "bin/rg",
      contents: "fixture host executable\n",
      mode: "0755",
      originalSha256: "1".repeat(64),
    },
    { path: "licenses/COPYING", contents: "fixture license\n", mode: "0644" },
  ];
  for (const file of files) {
    await writeFile(join(directory, file.path), file.contents);
    await chmod(join(directory, file.path), Number.parseInt(file.mode, 8));
  }
  const inventory = {
    version: 1,
    platform: "darwin",
    architecture: "arm64",
    minimumOS: "26.0",
    sources: [
      {
        name: "fixture",
        version: "1.0",
        license: "MIT",
        sourceUrl: "https://example.invalid/source.tar.gz",
        sourceSha256: "a".repeat(64),
        binaryUrl: "https://example.invalid/binary.tar.gz",
        binarySha256: "b".repeat(64),
        licenseFiles: ["licenses/COPYING"],
      },
    ],
    files: files.map(({ contents, ...file }) => ({
      ...file,
      source: "fixture",
      size: Buffer.byteLength(contents),
      sha256: digest(contents),
    })),
  };
  const selection = { directory, inventory_sha256: "", commands: ["grep", "rg"] };
  const pin = async () => {
    const json = JSON.stringify(inventory);
    await writeFile(join(directory, "inventory.json"), json);
    selection.inventory_sha256 = digest(json);
  };
  await pin();
  const load = () => loadToolBundle(selection, temporary, "darwin", "/opt/example/libexec");
  try {
    await run({ directory, temporary, selection, inventory, pin, load });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("pinned bundles preserve copies and separate executor/host command metadata", () =>
  fixture(async ({ temporary, load }) => {
    const bundle = await load();
    assert.deepEqual(bundle.layout.toolBundle.commands, {
      grep: "/opt/example/libexec/tools/bin/grep",
    });
    assert.deepEqual(bundle.layout.hostTools, { rg: "/opt/example/libexec/tools/bin/rg" });
    const output = join(temporary, "relocated copy");
    await copyToolBundle(bundle, output);
    await assert.rejects(copyToolBundle(bundle, output), { code: "EEXIST" });
    assert.equal((await stat(join(output, "bin/grep"))).mode & 0o777, 0o755);
    assert.equal((await stat(join(output, "licenses/COPYING"))).mode & 0o777, 0o644);
    assert.equal(await readFile(join(output, "bin/grep"), "utf8"), "fixture executable\n");
    const module = createCompiledLayoutModule(bundle.layout, { executableRelative: true });
    assert.match(module, /dirname\(realpathSync\(process.execPath\)\)/u);
    assert.doesNotMatch(module, /bundle with spaces/u);
    const layout = {
      ...bundle.layout,
      configDir: "/etc/pi-sandbox",
      libexecDir: "/usr/local/libexec/pi-sandbox",
      launcherPath: "/usr/local/bin/pi-sandbox",
      identitySocketPath: "/run/pi-sandbox-identity/broker.sock",
      auditSocketPath: "/run/pi-sandbox-audit/collector.sock",
    };
    assert.equal(
      renderLayoutText("bundled_commands=''", layout, "darwin"),
      "bundled_commands='grep rg'",
    );
    assert.throws(() => validateNativeToolBundle(bundle, "linux", "arm64"), /native build/u);
  }));

test("bundle admission fails closed for changed inputs, unlisted files, symlinks, and modes", () =>
  fixture(async ({ directory, selection, load }) => {
    const pin = selection.inventory_sha256;
    selection.inventory_sha256 = "f".repeat(64);
    await assert.rejects(load(), /inventory SHA-256 mismatch/u);
    selection.inventory_sha256 = pin;
    await writeFile(join(directory, "extra"), "extra");
    await assert.rejects(load(), /unlisted/u);
    await rm(join(directory, "extra"));
    await symlink("bin/grep", join(directory, "link"));
    await assert.rejects(load(), /unsupported/u);
    await rm(join(directory, "link"));
    await chmod(join(directory, "bin/grep"), 0o777);
    await assert.rejects(load(), /mode mismatch/u);
    await chmod(join(directory, "bin/grep"), 0o755);
    await writeFile(join(directory, "bin/grep"), "tampered");
    await assert.rejects(load(), /mismatch/u);
  }));

test("strict inventory rejects traversal, omitted selection, unknown keys, and missing licenses", () =>
  fixture(async ({ inventory, selection, pin, load }) => {
    selection.commands = ["grep"];
    await assert.rejects(load(), /exactly select/u);
    selection.commands = ["grep", "rg"];
    inventory.files[0].path = "bin/../escape";
    await pin();
    await assert.rejects(load(), /file path/u);
    inventory.files[0].path = "bin/grep";
    inventory.sources[0].licenseFiles = ["licenses/missing"];
    await pin();
    await assert.rejects(load(), /license file is missing/u);
    inventory.sources[0].licenseFiles = ["licenses/COPYING"];
    inventory.lookup = "PATH";
    await pin();
    await assert.rejects(load(), /not recognized/u);
  }));
