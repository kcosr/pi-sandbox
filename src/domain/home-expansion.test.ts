import { describe, expect, it, vi } from "vitest";

import {
  emptyManagedEnvironment,
  MAXIMUM_ENVIRONMENT_VALUE_BYTES,
  parseManagedEnvironment,
} from "./environment.js";
import { expandManagedHomePaths } from "./home-expansion.js";
import { MAXIMUM_ADMINISTRATIVE_PATH_BYTES } from "../../packages/sandbox-extension/src/runtime/paths.js";

const account = (homeDirectory: string) => ({ username: "alice", uid: 1001, homeDirectory });
describe("expandManagedHomePaths", () => {
  it("shares one lazy machine lookup across paths and configured scopes", () => {
    const machineId = "12345678-9ABC-5DEF-8123-456789ABCDEF";
    const machine = vi.fn(() => machineId);
    const identity = vi.fn(() => account("/Users/alice"));
    const result = expandManagedHomePaths(
      {
        cwdWritable: false,
        hiddenPaths: ["/private/{{machine_id}}"],
        deniedPaths: ["/denied/{{machine_id}}"],
      },
      parseManagedEnvironment({
        pi: { MACHINE: "{{machine_id}}" },
        sandbox: { MACHINE: "{{machine_id}}" },
        extensions: { service: { MACHINE: "{{machine_id}}" } },
      }),
      identity,
      machine,
    );
    expect(result.filesystem.hiddenPaths).toEqual([`/private/${machineId}`]);
    expect(result.filesystem.deniedPaths).toEqual([`/denied/${machineId}`]);
    expect(result.environment).toEqual({
      pi: { MACHINE: machineId },
      sandbox: { MACHINE: machineId },
      extensions: { service: { MACHINE: machineId } },
    });
    expect(machine).toHaveBeenCalledOnce();
    expect(identity).not.toHaveBeenCalled();
  });

  it("does not consult an unavailable machine resolver without an active macro", () => {
    const machine = vi.fn(() => {
      throw new Error("Machine ID unavailable");
    });
    const result = expandManagedHomePaths(
      { cwdWritable: true, hiddenPaths: [], deniedPaths: [] },
      parseManagedEnvironment({
        pi: { LITERAL: "{{{{machine_id}}}}" },
        sandbox: {},
        extensions: {},
      }),
      () => account("/Users/alice"),
      machine,
    );
    expect(result.environment.pi.LITERAL).toBe("{{machine_id}}");
    expect(machine).not.toHaveBeenCalled();
  });

  it("expands immutable Seatbelt denials using the invoking account and rejects collisions", () => {
    const getIdentity = vi.fn(() => account("/Users/alice"));
    const filesystem = {
      cwdWritable: false,
      hiddenPaths: [],
      deniedPaths: ["~/.ssh", "/private/{{username}}/{{uid}}"],
    };
    const result = expandManagedHomePaths(filesystem, emptyManagedEnvironment(), getIdentity);
    expect(result.filesystem.deniedPaths).toEqual(["/Users/alice/.ssh", "/private/alice/1001"]);
    expect(Object.isFrozen(result.filesystem.deniedPaths)).toBe(true);
    expect(filesystem.deniedPaths).toEqual(["~/.ssh", "/private/{{username}}/{{uid}}"]);
    expect(getIdentity).toHaveBeenCalledTimes(1);
    expect(() =>
      expandManagedHomePaths(
        { ...filesystem, deniedPaths: ["~/.ssh", "/Users/alice/.ssh"] },
        emptyManagedEnvironment(),
        getIdentity,
      ),
    ).toThrow("filesystem.denied_paths");
  });
  it("expands exclusions and every configured environment scope using one account lookup", () => {
    const filesystem = Object.freeze({
      cwdWritable: false,
      deniedPaths: [],
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
        deniedPaths: [],
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
      { cwdWritable: true, deniedPaths: [], hiddenPaths: ["/srv/private"] },
      parseManagedEnvironment({ pi, sandbox: {}, extensions: {} }),
      getHomeDirectory,
    );
    expect(result.environment.pi).toEqual(pi);
    expect(getHomeDirectory).not.toHaveBeenCalled();
  });

  it("substitutes only the environment prefix without normalizing or evaluating its suffix", () => {
    const result = expandManagedHomePaths(
      { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
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
      { cwdWritable: true, deniedPaths: [], hiddenPaths: ["~/.ssh"] },
      parseManagedEnvironment({ pi: { ROOT: "~", CHILD: "~/cache" }, sandbox: {}, extensions: {} }),
      () => account("/"),
    );
    expect(result.filesystem.hiddenPaths).toEqual(["/.ssh"]);
    expect(result.environment.pi).toEqual({ ROOT: "/", CHILD: "/cache" });
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, deniedPaths: [], hiddenPaths: ["~"] },
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
        { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
        parseManagedEnvironment({ pi: { VALUE: "~" }, sandbox: {}, extensions: {} }),
        () => account(home),
      ),
    ).toThrow("account home directory must be a normalized absolute path");
  });

  it("fails closed when account lookup fails", () => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, deniedPaths: [], hiddenPaths: ["~/.ssh"] },
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
        { cwdWritable: true, deniedPaths: [], hiddenPaths: ["~/.ssh", "/home/alice/.ssh"] },
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
          { cwdWritable: true, deniedPaths: [], hiddenPaths: ["~"] },
          emptyManagedEnvironment(),
          () => account(home),
        ),
      ).toThrow("must not overlap private system paths or hide /tmp");
    },
  );

  it("rechecks the byte limit of expanded hidden paths", () => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, deniedPaths: [], hiddenPaths: ["~/" + "é".repeat(2040)] },
        emptyManagedEnvironment(),
        () => account("/home/alice/account"),
      ),
    ).toThrow("unique normalized absolute paths");
  });

  it("rechecks the byte limit of the account home directory", () => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
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
      expandManagedHomePaths(
        { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
        environment,
        () => account("/home/alice"),
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
      expandManagedHomePaths(
        { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
        environment,
        () => account("/" + "a".repeat(512)),
      ),
    ).toThrow("managed_environment_invalid");
  });
});
