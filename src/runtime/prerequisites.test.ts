import { describe, expect, it } from "vitest";

import { assertHostPrerequisites } from "./prerequisites.js";

describe("host prerequisites", () => {
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
