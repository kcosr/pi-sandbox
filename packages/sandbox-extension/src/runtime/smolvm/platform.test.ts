import { afterEach, describe, expect, it, vi } from "vitest";
import { hostQuery } from "./host-query.js";
import { verifySmolvmCapability } from "./platform.js";

vi.mock("./host-query.js", () => ({ hostQuery: vi.fn() }));
const query = vi.mocked(hostQuery);
afterEach(() => {
  vi.unstubAllGlobals();
  query.mockReset();
});
function darwin() {
  vi.stubGlobal("process", { platform: "darwin", arch: "arm64" });
}
describe("Darwin prerequisites", () => {
  it("requires the firmware's macOS minimum and actual hypervisor support", async () => {
    darwin();
    query.mockResolvedValueOnce(Buffer.from("26.7.1\n")).mockResolvedValueOnce(Buffer.from("1\n"));
    await expect(verifySmolvmCapability()).resolves.toBeUndefined();
    expect(query.mock.calls.map(([argv]) => argv)).toEqual([
      ["/usr/bin/sw_vers", "-productVersion"],
      ["/usr/sbin/sysctl", "-n", "kern.hv_support"],
    ]);
  });
  it.each(["25.9", "invalid"])(
    "rejects unsupported OS result %s before HV query",
    async (version) => {
      darwin();
      query.mockResolvedValueOnce(Buffer.from(version));
      await expect(verifySmolvmCapability()).rejects.toThrow("requires_macos_26");
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses unavailable nested virtualization", async () => {
    darwin();
    query.mockResolvedValueOnce(Buffer.from("26.0")).mockResolvedValueOnce(Buffer.from("0"));
    await expect(verifySmolvmCapability()).rejects.toThrow("hypervisor_unavailable");
  });
});
