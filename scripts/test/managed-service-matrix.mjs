import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify, parse } from "@iarna/toml";

/** Distinct fixture artifacts, built from the same patched Pi and native inventory. */
export async function verifyManagedServiceMatrix(context, environment, runCommand) {
  const {
    repositoryRoot,
    extractedRelease,
    codingAgentRoot,
    bunTarget,
    bunTsconfig,
    distribution,
    os,
  } = context;
  if (os !== "linux" && os !== "darwin")
    throw new Error("Unsupported managed service qualification platform");
  const temporary = await mkdtemp(join(tmpdir(), "pi-managed-matrix-"));
  await chmod(temporary, 0o700);
  const runId = randomBytes(16).toString("hex");
  const runtimeRoot =
    os === "linux" ? `/run/pi-sandbox-verify/${runId}` : join(temporary, "runtime");
  const port = await unusedPort();
  const password = randomBytes(32).toString("hex");
  const passwordFile = join(temporary, "password"),
    certificate = join(temporary, "certificate.pem"),
    key = join(temporary, "key.pem");
  const privateRoot = join(repositoryRoot, "dist/private"),
    backup = join(temporary, "production-private");
  await cp(privateRoot, backup, { recursive: true });
  const agentPrivate = join(codingAgentRoot, "dist/pi-sandbox/private-cli.js");
  const savedEntrypoint = await readFile(agentPrivate);
  try {
    await writeFile(passwordFile, password, { mode: 0o600 });
    await runCommand(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        certificate,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      { env: environment },
    );
    const endpoint = {
      transport: "https",
      url: `https://127.0.0.1:${port}/v1/service`,
      basic_username: "fixture",
      basic_password_file: passwordFile,
      send_machine_id: os === "darwin",
      tls_ca_file: certificate,
    };
    const fixtureNames = [
      "fixed-local",
      "audit-local",
      ...(os === "linux" ? ["service-unix"] : []),
      "service-https",
    ];
    const fixtures = [];
    for (const name of fixtureNames) {
      const installation = join(runtimeRoot, name);
      const configuration =
        name === "fixed-local"
          ? {
              source: "local",
              config_dir: join(installation, "config"),
              allow_config_override: false,
            }
          : name === "audit-local"
            ? {
                source: "local",
                config_dir: join(installation, "config"),
                allow_config_override: true,
                audit_endpoint: endpoint,
              }
            : {
                source: "service",
                endpoint:
                  name === "service-unix"
                    ? { transport: "unix", socket_path: join(runtimeRoot, "service.sock") }
                    : endpoint,
              };
      const selected = {
        libexec_dir: join(installation, "payload"),
        launcher_path: join(installation, "bin/pi-sandbox"),
        configuration,
        ...(os === "linux"
          ? {
              bubblewrap:
                distribution.bubblewrap.mode === "system"
                  ? { mode: "system", path: distribution.bubblewrap.path }
                  : {
                      mode: "bundled",
                      binary: distribution.bubblewrap.binary,
                      version: distribution.bubblewrap.version,
                      sha256: distribution.bubblewrap.sha256,
                      license_file: distribution.bubblewrap.licenseFile,
                    },
            }
          : {}),
        ...(distribution.toolBundle
          ? {
              tool_bundle: {
                directory: distribution.toolBundle.directory,
                inventory_sha256: distribution.toolBundle.inventorySha256,
                commands: distribution.toolBundle.commands,
              },
            }
          : {}),
      };
      const descriptor = join(temporary, `${name}.toml`);
      await writeFile(
        descriptor,
        stringify({
          version: 4,
          extension_manifests: distribution.extensionManifests,
          ...(distribution.skillsSource ? { skills_source: distribution.skillsSource } : {}),
          platforms: { [os]: selected },
        }),
        { mode: 0o600 },
      );
      await runCommand(
        process.execPath,
        [
          join(repositoryRoot, "scripts/build-bundles.mjs"),
          "--distribution",
          descriptor,
          "--executable-relative-tools",
        ],
        { env: environment },
      );
      await copyFile(join(privateRoot, "private-cli.js"), agentPrivate);
      const executable = join(temporary, name);
      await runCommand(
        "bun",
        [
          "build",
          "--compile",
          `--tsconfig-override=${bunTsconfig}`,
          "--no-compile-autoload-bunfig",
          "--no-compile-autoload-dotenv",
          `--target=${bunTarget}`,
          "--define",
          `PI_SANDBOX_HOST_TOOLS=${JSON.stringify(Object.fromEntries(Object.keys(distribution.layout.hostTools ?? {}).map((tool) => [tool, `tools/bin/${tool}`])))}`,
          "./dist/pi-sandbox/private-entrypoint.mjs",
          "./src/utils/image-resize-worker.ts",
          "./src/extensions/codemode/worker.ts",
          "--outfile",
          executable,
        ],
        { cwd: codingAgentRoot, env: environment },
      );
      await chmod(executable, 0o755);
      fixtures.push({
        name,
        executable,
        sha256: createHash("sha256")
          .update(await readFile(executable))
          .digest("hex"),
        installation,
      });
    }
    const policy = parse(
      await readFile(
        join(
          repositoryRoot,
          `config/default/config${os === "darwin" ? ".seatbelt" : ".direct"}.toml`,
        ),
        "utf8",
      ),
    );
    policy.workspace = {
      default: "host",
      allowed: ["host"],
      modes: { host: { description: "Offline managed-service qualification." } },
    };
    policy.sessions.retention_days = 0;
    if (distribution.skillsSource)
      policy.skills = {
        directories: fixtures.map((fixture) => join(fixture.installation, "payload/skills")),
      };
    policy.audit.enabled = true;
    for (const name of ["write", "edit", "bash"])
      policy.tools[name] = { mode: "allow", session_grant: "never" };
    policy.environment.pi = {
      FIXTURE_TOKEN: "managed-fixture-token",
      FIXTURE_USER: "{{username}}",
    };
    policy.models_file = join(runtimeRoot, "models.json");
    const policyText = stringify(policy);
    delete policy.models_file;
    // Qualify the exact production bytes offline as well as the four separately
    // compiled runtime fixtures. This command never contacts their fixed endpoint.
    const productionPolicy = globalThis.structuredClone(policy);
    if (distribution.skillsSource)
      productionPolicy.skills = {
        directories: [join(distribution.layout.libexecDir, "skills")],
      };
    const productionFixture = join(temporary, "production-bootstrap.json");
    await writeFile(
      productionFixture,
      JSON.stringify({
        version: 1,
        request_id: "b".repeat(32),
        operation: "bootstrap",
        result: {
          policy: productionPolicy,
          overrides: { tools: {} },
          environment: { pi: {}, sandbox: {}, extensions: {} },
          models: { providers: {} },
          policy_revision: "a".repeat(32),
        },
      }),
      { mode: 0o600 },
    );
    const productionPayload = join(extractedRelease, "payload/pi-sandbox");
    await runCommand(
      join(productionPayload, "pi-sandbox"),
      ["--validate-bootstrap", productionFixture, "--candidate-payload", productionPayload],
      { env: environment },
    );
    // All full HTTPS fixtures use their private CA. Separately exercise the
    // bundled-public-root branch in compiled Bun against that same live server.
    const publicRootSource = join(temporary, "public-root-probe.ts");
    const publicRootExecutable = join(temporary, "public-root-probe");
    await writeFile(
      publicRootSource,
      `import { ServiceClient } from ${JSON.stringify(join(repositoryRoot, "src/service/client.ts"))};
const client = new ServiceClient(${JSON.stringify({ transport: "https", url: endpoint.url, basicUsername: "fixture", basicPassword: password, sendMachineId: false })}, { identity: () => ({ username: "fixture-probe" }) });
try {
  await client.request("audit_check", { audit_session_id: "a".repeat(32), service_epoch: "b".repeat(32) });
  throw new Error("Untrusted private certificate was accepted");
} catch (error) {
  if (!(error instanceof Error) || error.message !== "Managed service connection failed") throw error;
  console.log("Bundled public roots rejected the private fixture CA");
}
`,
      { mode: 0o600 },
    );
    await runCommand(
      "bun",
      [
        "build",
        "--compile",
        `--tsconfig-override=${bunTsconfig}`,
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-dotenv",
        `--target=${bunTarget}`,
        publicRootSource,
        "--outfile",
        publicRootExecutable,
      ],
      { env: environment },
    );
    const plan = {
      version: 1,
      runId,
      runtimeRoot,
      port,
      passwordFile,
      certificate,
      key,
      fixtures,
      policyText,
      policyObject: policy,
      productionPayload,
      publicRootProbe: {
        executable: publicRootExecutable,
        sha256: createHash("sha256")
          .update(await readFile(publicRootExecutable))
          .digest("hex"),
      },
      serviceBinary: os === "linux" ? join(repositoryRoot, "dist/native/pi-sandbox-service") : null,
      platform: os,
      architecture: process.arch,
    };
    const planFile = join(temporary, "plan.json");
    await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
    const script = join(repositoryRoot, "scripts/test/managed-service-matrix.py");
    if (os === "linux") {
      await runCommand(
        "sudo",
        ["-n", "unshare", "--mount", "--fork", "python3", script, planFile],
        { env: environment },
      );
    } else await runCommand("python3", [script, planFile], { env: environment });
    process.stdout.write(`Managed service artifact matrix passed (${fixtureNames.join(", ")})\n`);
  } finally {
    await writeFile(agentPrivate, savedEntrypoint);
    await rm(privateRoot, { recursive: true, force: true });
    await cp(backup, privateRoot, { recursive: true });
    await rm(temporary, { recursive: true, force: true });
  }
}
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
