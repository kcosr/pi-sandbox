import assert from "node:assert/strict";
import { test } from "node:test";

import {
  preflightSmolvmRelease,
  releaseArguments,
  validateSmolvmReleaseInputs,
} from "../build/release-preflight.mjs";

const environment = {
  PI_SANDBOX_SMOLVM_BIN: "/opt/smolvm/smolvm",
  PI_SANDBOX_SMOLVM_IMAGE: "/opt/images/tools.smolmachine",
  PI_SANDBOX_SMOLVM_IMAGE_SHA256: "a".repeat(64),
  PI_SANDBOX_SMOLVM_OCI_IMAGE: "/opt/images/tools.tar",
  PI_SANDBOX_SMOLVM_OCI_SHA256: "b".repeat(64),
};
const distribution = {
  layout: { allowConfigOverride: true },
  smolvm: { path: environment.PI_SANDBOX_SMOLVM_BIN },
};
const extensions = [{ metadata: { kind: "managed", id: "git", tools: ["git_clone"] } }];
const validate = (env = environment, selected = distribution, tools = extensions) =>
  validateSmolvmReleaseInputs(env, selected, tools, "linux", "x64");

test("release lane selection preserves ordinary build arguments", () => {
  const args = ["--distribution", "/review.toml", "--out", "/artifacts"];
  assert.deepEqual(releaseArguments(args, {}), { requireSmolvm: false, buildArguments: args });
  assert.deepEqual(releaseArguments(["--require-smolvm", ...args], {}), {
    requireSmolvm: true,
    buildArguments: args,
  });
  assert.equal(releaseArguments(args, { PI_SANDBOX_REQUIRE_SMOLVM: "1" }).requireSmolvm, true);
});

test("release lane requires an explicit review manifest before reading files", async () => {
  for (const args of [[], ["--distribution"], ["--distribution", "--out", "/artifacts"]])
    await assert.rejects(preflightSmolvmRelease(args, {}), /needs --distribution/);
});

test("native release inputs cannot omit an image, digest or runtime", () => {
  assert.doesNotThrow(() => validate());
  for (const name of Object.keys(environment)) {
    const missing = { ...environment };
    delete missing[name];
    assert.throws(() => validate(missing), new RegExp(name));
  }
  assert.throws(
    () => validate({ ...environment, PI_SANDBOX_SMOLVM_IMAGE: "relative/image" }),
    /PI_SANDBOX_SMOLVM_IMAGE/,
  );
  assert.throws(
    () => validate({ ...environment, PI_SANDBOX_SMOLVM_OCI_SHA256: "invalid" }),
    /PI_SANDBOX_SMOLVM_OCI_SHA256/,
  );
});

test("a native release must exercise the compiled managed VM path", () => {
  assert.throws(
    () => validate(environment, { ...distribution, layout: { allowConfigOverride: false } }),
    /review distribution/,
  );
  assert.throws(
    () => validate(environment, { ...distribution, smolvm: undefined }),
    /review distribution/,
  );
  assert.throws(
    () => validate(environment, { ...distribution, smolvm: { path: "/other/smolvm" } }),
    /review distribution/,
  );
  assert.throws(() => validate(environment, distribution, []), /managed Git extension/);
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["linux", "arm64"],
  ])
    assert.throws(
      () => validateSmolvmReleaseInputs(environment, distribution, extensions, platform, arch),
      /Linux x86-64/,
    );
});
