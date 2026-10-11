import { describe, expect, it } from "vitest";
import { validateSmolvmSocketPaths } from "./registry.js";

describe("ordinary registry socket paths", () => {
  it("accepts ordinary short shared cache paths", () => {
    expect(() =>
      validateSmolvmSocketPaths({ HOME: "/home/user", XDG_CACHE_HOME: "/cache" }),
    ).not.toThrow();
  });
  it("rejects an upstream socket that would exceed the platform limit before native creation", () => {
    const long = "/" + "x".repeat(100);
    expect(() => validateSmolvmSocketPaths({ HOME: long, XDG_CACHE_HOME: long })).toThrow(
      "smolvm_native_socket_path_too_long",
    );
  });
});
