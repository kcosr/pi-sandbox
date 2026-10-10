import { describe, expect, it, vi } from "vitest";

import {
  emptyManagedEnvironment,
  MAXIMUM_ENVIRONMENT_VALUE_BYTES,
  parseManagedEnvironment,
} from "./environment.js";
import { expandManagedHomePaths } from "./home-expansion.js";
import { MAXIMUM_ADMINISTRATIVE_PATH_BYTES } from "../../packages/sandbox-extension/src/runtime/paths.js";
import type { SmolvmConfig } from "./policy.js";

const account = (homeDirectory: string) => ({ username: "alice", uid: 1001, homeDirectory });
const smolvm: SmolvmConfig = Object.freeze({
  image: "/opt/{{uid}}/tools.smolmachine",
  imageSha256: "a".repeat(64),
  stateDirectory: "/var/tmp/pi-vm-{{uid}}",
  cpus: 2,
  memoryMiB: 1024,
  storageGiB: 1,
  overlayGiB: 1,
});

describe("expandManagedHomePaths", () => {
  it("shares one trusted account lookup across smolvm state and other configured values", () => {
    const getIdentity = vi.fn(() => account("/accounts/alice"));
    const result = expandManagedHomePaths(
      { cwdWritable: true, hiddenPaths: [] },
      parseManagedEnvironment({
        pi: { HOME: "/untrusted/home", OWNER: "{{uid}}" },
        sandbox: {},
        extensions: {},
      }),
      getIdentity,
      smolvm,
    );
    expect(result.smolvm).toEqual({ ...smolvm, stateDirectory: "/var/tmp/pi-vm-1001" });
    expect(result.environment.pi.OWNER).toBe("1001");
    expect(getIdentity).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(result.smolvm)).toBe(true);
    expect(smolvm.stateDirectory).toBe("/var/tmp/pi-vm-{{uid}}");

    const second = expandManagedHomePaths(
      { cwdWritable: true, hiddenPaths: [] },
      emptyManagedEnvironment(),
      () => ({ username: "bob", uid: 1002, homeDirectory: "/accounts/bob" }),
      smolvm,
    );
    expect(second.smolvm?.stateDirectory).toBe("/var/tmp/pi-vm-1002");
    expect(second.smolvm?.image).toBe("/opt/{{uid}}/tools.smolmachine");
  });

  it.each(["..", "alice:other", "a".repeat(49), "alice\nother"])(
    "revalidates expanded smolvm state directory for account name %j",
    (username) => {
      expect(() =>
        expandManagedHomePaths(
          { cwdWritable: true, hiddenPaths: [] },
          emptyManagedEnvironment(),
          () => ({ username, uid: 1001, homeDirectory: "/accounts/alice" }),
          { ...smolvm, stateDirectory: "/var/tmp/{{username}}" },
        ),
      ).toThrow("Expanded smolvm.state_directory");
    },
  );

  it("expands exclusions and every configured environment scope using one account lookup", () => {
    const filesystem = Object.freeze({
      cwdWritable: false,
      hiddenPaths: Object.freeze(["~/.ssh", "~", "/srv/private"]),
    });
    const environment = parseManagedEnvironment({
      pi: { PI_CODING_AGENT_DIR: "~/.pi/agent", HOME: "/untrusted/home" },
      sandbox: { CACHE: "~/cache/" },
      extensions: { git: { GIT_CREDENTIALS: "~/.git-credentials", HOME: "~" } },
    });
    const getHomeDirectory = vi.fn(() => account("/accounts/alice"));

    const result = expandManagedHomePaths(filesystem, environment, getHomeDirectory);

    expect(result).toEqual({
      filesystem: {
        cwdWritable: false,
        hiddenPaths: ["/accounts/alice", "/accounts/alice/.ssh", "/srv/private"],
      },
      environment: {
        pi: { PI_CODING_AGENT_DIR: "/accounts/alice/.pi/agent", HOME: "/untrusted/home" },
        sandbox: { CACHE: "/accounts/alice/cache/" },
        extensions: {
          git: { GIT_CREDENTIALS: "/accounts/alice/.git-credentials", HOME: "/accounts/alice" },
        },
      },
    });
    expect(getHomeDirectory).toHaveBeenCalledTimes(1);
    expect(filesystem.hiddenPaths).toEqual(["~/.ssh", "~", "/srv/private"]);
    expect(environment.pi.PI_CODING_AGENT_DIR).toBe("~/.pi/agent");
    for (const value of [
      result,
      result.filesystem,
      result.filesystem.hiddenPaths,
      result.environment,
      result.environment.pi,
      result.environment.sandbox,
      result.environment.extensions,
      result.environment.extensions.git,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("keeps ordinary environment strings literal without consulting the account database", () => {
    const pi = {
      EMBEDDED: "prefix~/file",
      OTHER_ACCOUNT: "~bob/.ssh",
      TOKEN: "~token",
      VARIABLE: "$HOME/file",
      SHELL: "$(pwd)/file",
      GLOB: "/home/*/file",
      LIST: "/first:~/second",
      EMPTY: "",
    };
    const getHomeDirectory = vi.fn(() => {
      throw new Error("Account lookup should remain lazy");
    });
    const result = expandManagedHomePaths(
      { cwdWritable: true, hiddenPaths: ["/srv/private"] },
      parseManagedEnvironment({ pi, sandbox: {}, extensions: {} }),
      getHomeDirectory,
    );
    expect(result.environment.pi).toEqual(pi);
    expect(getHomeDirectory).not.toHaveBeenCalled();
  });

  it("substitutes only the environment prefix without normalizing or evaluating its suffix", () => {
    const result = expandManagedHomePaths(
      { cwdWritable: true, hiddenPaths: [] },
      parseManagedEnvironment({
        pi: { A: "~/", B: "~/a/../b//", C: "~/$VAR/*/~other", D: "~/$(command)" },
        sandbox: {},
        extensions: {},
      }),
      () => account("/home/alice"),
    );
    expect(result.environment.pi).toEqual({
      A: "/home/alice/",
      B: "/home/alice/a/../b//",
      C: "/home/alice/$VAR/*/~other",
      D: "/home/alice/$(command)",
    });
  });

  it("handles an account whose home directory is root", () => {
    const result = expandManagedHomePaths(
      { cwdWritable: true, hiddenPaths: ["~/.ssh"] },
      parseManagedEnvironment({ pi: { ROOT: "~", CHILD: "~/cache" }, sandbox: {}, extensions: {} }),
      () => account("/"),
    );
    expect(result.filesystem.hiddenPaths).toEqual(["/.ssh"]);
    expect(result.environment.pi).toEqual({ ROOT: "/", CHILD: "/cache" });
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: ["~"] },
        emptyManagedEnvironment(),
        () => account("/"),
      ),
    ).toThrow("filesystem.hidden_paths");
  });

  it.each([
    "",
    "relative",
    "~/recursive",
    "/home/alice/",
    "/home/../alice",
    "/home//alice",
    "/home/a\n",
  ])("rejects invalid account home directories: %j", (home) => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: [] },
        parseManagedEnvironment({ pi: { VALUE: "~" }, sandbox: {}, extensions: {} }),
        () => account(home),
      ),
    ).toThrow("account home directory must be a normalized absolute path");
  });

  it("fails closed when account lookup fails", () => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: ["~/.ssh"] },
        emptyManagedEnvironment(),
        () => {
          throw new Error("account unavailable");
        },
      ),
    ).toThrow("account unavailable");
  });

  it("rejects duplicate exclusions produced by expansion", () => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: ["~/.ssh", "/home/alice/.ssh"] },
        emptyManagedEnvironment(),
        () => account("/home/alice"),
      ),
    ).toThrow("unique normalized absolute paths");
  });

  it.each(["/proc", "/sys/private", "/dev", "/run/private", "/tmp"])(
    "rechecks reserved hidden paths after expansion: %s",
    (home) => {
      expect(() =>
        expandManagedHomePaths(
          { cwdWritable: true, hiddenPaths: ["~"] },
          emptyManagedEnvironment(),
          () => account(home),
        ),
      ).toThrow("must not overlap private system paths or hide /tmp");
    },
  );

  it("rechecks the byte limit of expanded hidden paths", () => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: ["~/" + "é".repeat(2040)] },
        emptyManagedEnvironment(),
        () => account("/home/alice/account"),
      ),
    ).toThrow("unique normalized absolute paths");
  });

  it("rechecks the byte limit of the account home directory", () => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: [] },
        parseManagedEnvironment({ pi: { VALUE: "~" }, sandbox: {}, extensions: {} }),
        () => account("/" + "a".repeat(MAXIMUM_ADMINISTRATIVE_PATH_BYTES)),
      ),
    ).toThrow("account home directory must be a normalized absolute path");
  });

  it("rejects individual environment values that exceed the limit after expansion", () => {
    const environment = parseManagedEnvironment({
      pi: { VALUE: "~/" + "a".repeat(MAXIMUM_ENVIRONMENT_VALUE_BYTES - 2) },
      sandbox: {},
      extensions: {},
    });
    expect(() =>
      expandManagedHomePaths({ cwdWritable: true, hiddenPaths: [] }, environment, () =>
        account("/home/alice"),
      ),
    ).toThrow("managed_environment_invalid");
  });

  it("rejects aggregate environment growth past the limit after expansion", () => {
    const environment = parseManagedEnvironment({
      pi: Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => [`VAR_${index}`, "~/cache"]),
      ),
      sandbox: {},
      extensions: {},
    });
    expect(() =>
      expandManagedHomePaths({ cwdWritable: true, hiddenPaths: [] }, environment, () =>
        account("/" + "a".repeat(512)),
      ),
    ).toThrow("managed_environment_invalid");
  });
});
