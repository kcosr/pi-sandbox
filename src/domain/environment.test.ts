import { describe, expect, it } from "vitest";

import { overlayManagedEnvironment, parseManagedEnvironment } from "./environment.js";

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
