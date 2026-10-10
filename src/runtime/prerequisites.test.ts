import { describe, expect, it, vi } from "vitest";

import { assertExecutionPrerequisites, assertHostPrerequisites } from "./prerequisites.js";

describe("host prerequisites", () => {
  it("checks the selected smolvm wrapper and host tools without requiring guest tools on PATH", async () => {
    vi.stubEnv("PATH", "");
    try {
      await expect(
        assertExecutionPrerequisites(
          "smolvm",
          {
            smolvm: { path: "/bin/sh", version: "1.25.4" },
          },
          [],
        ),
      ).resolves.toBeUndefined();
      await expect(
        assertExecutionPrerequisites(
          "smolvm",
          {
            smolvm: { path: "/definitely-missing/smolvm", version: "1.25.4" },
          },
          ["/definitely-missing/git"],
        ),
      ).rejects.toThrow(
        "Missing required host executables:\n- /definitely-missing/git\n- /definitely-missing/smolvm",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("accepts fixed executables and alternative command names", async () => {
    await expect(
      assertHostPrerequisites({
        fixedExecutables: ["/bin/sh"],
        path: "/bin",
        pathCommands: [{ label: "shell", names: ["missing-shell", "sh"] }],
      }),
    ).resolves.toBeUndefined();
  });

  it("reports every missing dependency before startup", async () => {
    await expect(
      assertHostPrerequisites({
        fixedExecutables: ["/definitely-missing/pi-sandbox-tool"],
        path: "/bin",
        pathCommands: [{ label: "fd or fdfind", names: ["definitely-missing-fd"] }],
      }),
    ).rejects.toThrow(
      "Missing required host executables:\n- /definitely-missing/pi-sandbox-tool\n- fd or fdfind",
    );
  });

  it("checks build-selected extension executables in addition to core prerequisites", async () => {
    await expect(
      assertHostPrerequisites({
        fixedExecutables: ["/bin/sh"],
        additionalFixedExecutables: ["/definitely-missing/managed-extension"],
        pathCommands: [],
      }),
    ).rejects.toThrow("- /definitely-missing/managed-extension");
  });
});
