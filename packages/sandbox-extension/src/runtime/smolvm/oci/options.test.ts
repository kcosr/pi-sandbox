import { describe, expect, it } from "vitest";
import { validateOciFamilyOptions } from "./family.js";
import { validateOciAttachment } from "./transport.js";
import type { SmolvmOciFamilyOptions } from "./types.js";

const options: SmolvmOciFamilyOptions = {
  smolvmPath: "/trusted/smolvm",
  imageArchive: "/trusted/rocky.tar",
  imageSha256: "a".repeat(64),
  stateDirectory: "/state",
  cwd: "/workspace",
  networkMode: "none",
  resources: { cpus: 1, memoryMiB: 512, storageGiB: 2, overlayGiB: 1 },
  mounts: [{ hostPath: "/inputs", guestPath: "/inputs", readOnly: true }],
};
describe("OCI trusted configuration", () => {
  it("accepts a writable workload with read-only explicit mounts", () =>
    expect(() => validateOciFamilyOptions(options)).not.toThrow());
  it.each([
    { networkMode: "filtered" },
    { cwd: "relative" },
    { cwd: "/workspace/../etc" },
    { imageSha256: "tag" },
    { other: true },
    { resources: { ...options.resources, cpus: 0 } },
    { resources: { ...options.resources, nested: true } },
    { mounts: [{ hostPath: "/inputs", guestPath: "/usr", readOnly: true }] },
    { mounts: [{ hostPath: "/inputs", guestPath: "/proc/a", readOnly: true }] },
    { mounts: [{ hostPath: "/inputs", guestPath: "/inputs", readOnly: false }] },
    {
      mounts: [
        { hostPath: "/inputs", guestPath: "/inputs", readOnly: true },
        { hostPath: "/extra", guestPath: "/inputs/sub", readOnly: true },
      ],
    },
    { limits: { maximumInputBytes: 1048577 } },
    { limits: { maximumArgumentBytes: 65537 } },
    { limits: { maximumTimeoutMs: 600001 } },
    { limits: { arbitrary: true } },
  ])("rejects unsupported authority %j", (patch) =>
    expect(() =>
      validateOciFamilyOptions({ ...options, ...patch } as SmolvmOciFamilyOptions),
    ).toThrow(),
  );
});
describe("OCI attachment", () => {
  const descriptor = {
    version: 1,
    socketPath: "/private/control.sock",
    token: "a".repeat(64),
    machineId: "candidate",
    cwd: "/workspace",
    home: "/root",
  };
  it("accepts its single format", () =>
    expect(() => validateOciAttachment(descriptor)).not.toThrow());
  it.each([
    { version: 2 },
    { token: "secret" },
    { socketPath: "relative" },
    { socketPath: "/x/../control.sock" },
    { machineId: "../../other" },
    { cwd: "/a/../b" },
    { home: "/host" },
    { extra: true },
  ])("rejects %j", (patch) =>
    expect(() => validateOciAttachment({ ...descriptor, ...patch })).toThrow(),
  );
});
