import { describe, expect, it } from "vitest";

import { applyManagedEnvironment, sanitizeManagedEnvironment } from "./environment.js";

describe("managed environment", () => {
  it("removes injection channels while preserving Pi's user home override", () => {
    const environment: NodeJS.ProcessEnv = {
      HOME: "/home/alice",
      LD_PRELOAD: "/tmp/inject.so",
      NODE_OPTIONS: "--require=/tmp/inject.js",
      PI_CODING_AGENT_DIR: "/srv/alice/pi",
      PI_CODING_AGENT_SESSION_DIR: "/srv/alice/sessions",
      PI_SANDBOX_INTERNAL_CONFIG: "/tmp/config.toml",
    };

    sanitizeManagedEnvironment(environment);

    expect(environment).toEqual({
      HOME: "/home/alice",
      PI_CODING_AGENT_DIR: "/srv/alice/pi",
      PI_CODING_AGENT_SESSION_DIR: "/srv/alice/sessions",
    });
  });

  it("temporarily applies managed variables and restores overwritten and absent values exactly", () => {
    const environment: NodeJS.ProcessEnv = {
      EXISTING: "ambient",
      UNRELATED: "preserved",
    };

    const lease = applyManagedEnvironment(
      { EXISTING: "managed", ADDED_BY_BROKER: "temporary" },
      environment,
    );

    expect(environment).toEqual({
      EXISTING: "managed",
      UNRELATED: "preserved",
      ADDED_BY_BROKER: "temporary",
    });

    lease.restore();

    expect(environment).toEqual({ EXISTING: "ambient", UNRELATED: "preserved" });
  });

  it("restores a managed environment lease only once", () => {
    const environment: NodeJS.ProcessEnv = { EXISTING: "ambient" };
    const lease = applyManagedEnvironment({ EXISTING: "managed" }, environment);

    lease.restore();
    environment.EXISTING = "later";
    lease.restore();

    expect(environment).toEqual({ EXISTING: "later" });
  });
});
