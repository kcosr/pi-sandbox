import { describe, expect, it } from "vitest";

import {
  overlayManagedEnvironment,
  parseManagedEnvironment,
  parseAuthoredManagedEnvironment,
  parseBrokerManagedEnvironment,
} from "./environment.js";

describe("managed administrative environment", () => {
  it("overlays user values by scope and variable name", () => {
    const base = parseManagedEnvironment({
      pi: { SHARED: "global", GLOBAL_PI: "base" },
      sandbox: { GLOBAL_SANDBOX: "base" },
      extensions: {
        "service-api": { TOKEN: "global", URL: "https://global.example" },
      },
    });
    const user = parseManagedEnvironment({
      pi: { SHARED: "user", USER_PI: "override" },
      sandbox: { USER_SANDBOX: "override" },
      extensions: { "service-api": { TOKEN: "user" } },
    });

    expect(overlayManagedEnvironment(base, user)).toEqual({
      pi: { SHARED: "user", GLOBAL_PI: "base", USER_PI: "override" },
      sandbox: { GLOBAL_SANDBOX: "base", USER_SANDBOX: "override" },
      extensions: {
        "service-api": { TOKEN: "user", URL: "https://global.example" },
      },
    });
  });

  it.each(["BASHOPTS", "CDPATH", "GLOBIGNORE", "IFS"])(
    "rejects shell-sensitive %s only in the sandbox scope",
    (name) => {
      expect(() =>
        parseManagedEnvironment({ pi: {}, sandbox: { [name]: "x" }, extensions: {} }),
      ).toThrow("managed_environment_invalid");
      expect(
        parseManagedEnvironment({
          pi: { [name]: "x" },
          sandbox: {},
          extensions: { "service-api": { [name]: "x" } },
        }).pi,
      ).toEqual({ [name]: "x" });
    },
  );

  it("revalidates aggregate limits after overlay", () => {
    const variables = (prefix: string) =>
      Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`${prefix}_${index}`, "x"]));
    const base = parseManagedEnvironment({
      pi: variables("GLOBAL"),
      sandbox: variables("SHARED"),
      extensions: {},
    });
    const user = parseManagedEnvironment({
      pi: {},
      sandbox: {},
      extensions: { "service-api": { ONE_MORE: "x" } },
    });

    expect(() => overlayManagedEnvironment(base, user)).toThrow("managed_environment_invalid");
  });
});

describe("Pi environment value sources", () => {
  const environment = (pi: Record<string, unknown>) => ({ pi, sandbox: {}, extensions: {} });
  it("admits immutable authored file references without interpreting literal path text", () => {
    const parsed = parseAuthoredManagedEnvironment(
      environment({ TOKEN: { file: "/etc/secrets/{{uid}}-$NAME" } }),
    );
    expect(parsed.pi.TOKEN).toEqual({ file: "/etc/secrets/{{uid}}-$NAME" });
    expect(Object.isFrozen(parsed.pi.TOKEN)).toBe(true);
  });
  it.each([
    {},
    { file: "relative" },
    { file: "~/token" },
    { file: "/" },
    { file: "/a/../b" },
    { file: "/a//b" },
    { file: "/a/" },
    { file: "/" + "a".repeat(4096) },
    { file: "/etc/token", extra: true },
    { file: 1 },
    { literal: "token" },
    ["/etc/token"],
    null,
  ])("rejects invalid authored Pi references (%#)", (value) => {
    expect(() => parseAuthoredManagedEnvironment(environment({ TOKEN: value }))).toThrow(
      "managed_environment_invalid",
    );
  });
  it("preserves environment names that also name object prototype properties", () => {
    const parsed = parseAuthoredManagedEnvironment(
      environment(
        Object.fromEntries<unknown>([
          ["__proto__", { file: "/etc/secret" }],
          ["constructor", "ordinary"],
        ]),
      ),
    );
    expect(Object.hasOwn(parsed.pi, "__proto__")).toBe(true);
    expect(parsed.pi["__proto__"]).toEqual({ file: "/etc/secret" });
    expect(Object.getPrototypeOf(parsed.pi)).toBe(Object.prototype);
  });

  it("keeps authored, wire and final resolved parsers distinct", () => {
    const literal = { literal: "~/{{unknown}}" };
    expect(parseBrokerManagedEnvironment(environment({ TOKEN: literal })).pi.TOKEN).toEqual(
      literal,
    );
    for (const value of [
      { file: "/etc/token" },
      { literal: "" },
      { literal: "token", extra: true },
      { literal: "nul\0value" },
      { literal: "x".repeat(8193) },
    ]) {
      expect(() => parseBrokerManagedEnvironment(environment({ TOKEN: value }))).toThrow(
        "managed_environment_invalid",
      );
    }
    expect(() => parseManagedEnvironment(environment({ TOKEN: literal }))).toThrow(
      "managed_environment_invalid",
    );
  });
  it("rejects references and opaque values outside the Pi scope", () => {
    for (const parse of [parseAuthoredManagedEnvironment, parseBrokerManagedEnvironment]) {
      for (const value of [{ file: "/etc/token" }, { literal: "token" }]) {
        expect(() => parse({ pi: {}, sandbox: { TOKEN: value }, extensions: {} })).toThrow(
          "managed_environment_invalid",
        );
        expect(() =>
          parse({ pi: {}, sandbox: {}, extensions: { service: { TOKEN: value } } }),
        ).toThrow("managed_environment_invalid");
      }
    }
  });
});
