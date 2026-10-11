import { afterEach, describe, expect, it, vi } from "vitest";
import { hostQuery } from "./host-query.js";
import { assertNoSmolvmLayerAttachments, verifySmolvmCapability } from "./platform.js";

vi.mock("./host-query.js", () => ({ hostQuery: vi.fn() }));
const query = vi.mocked(hostQuery);
afterEach(() => {
  vi.unstubAllGlobals();
  query.mockReset();
});
function darwin() {
  vi.stubGlobal("process", { platform: "darwin", arch: "arm64" });
}
describe("Darwin prerequisites and scoped layer cleanup", () => {
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
  it("leaves unrelated attachments alone and rejects an attachment inside its state", async () => {
    darwin();
    const plist = Buffer.from("bounded plist fixture");
    query
      .mockResolvedValueOnce(plist)
      .mockResolvedValueOnce(
        Buffer.from(
          JSON.stringify({ images: [{ "image-path": "/private/tmp/family-other/layers.dmg" }] }),
        ),
      );
    await expect(assertNoSmolvmLayerAttachments("/private/tmp/family")).resolves.toBeUndefined();
    expect(query.mock.calls[1]).toEqual([
      ["/usr/bin/plutil", "-convert", "json", "-o", "-", "--", "-"],
      plist,
    ]);
    query
      .mockResolvedValueOnce(plist)
      .mockResolvedValueOnce(
        Buffer.from(
          JSON.stringify({ images: [{ "image-path": "/private/tmp/family/layers.dmg" }] }),
        ),
      );
    await expect(assertNoSmolvmLayerAttachments("/private/tmp/family")).rejects.toThrow(
      "attachment_remains",
    );
    expect(query.mock.calls.every(([argv]) => !argv.includes("detach"))).toBe(true);
  });
  it.each([{}, { images: [{}] }, { images: [null] }])(
    "rejects uncertain inventory %j",
    async (inventory) => {
      darwin();
      query
        .mockResolvedValueOnce(Buffer.from("plist"))
        .mockResolvedValueOnce(Buffer.from(JSON.stringify(inventory)));
      await expect(assertNoSmolvmLayerAttachments("/private/tmp/family")).rejects.toThrow(
        "inventory_invalid",
      );
    },
  );
  it("propagates query failure instead of declaring attachment absence", async () => {
    darwin();
    query.mockRejectedValueOnce(new Error("query failed"));
    await expect(assertNoSmolvmLayerAttachments("/private/tmp/family")).rejects.toThrow(
      "query failed",
    );
  });
  it("does not introduce Darwin queries into Linux cleanup", async () => {
    vi.stubGlobal("process", { platform: "linux", arch: "x64" });
    await expect(assertNoSmolvmLayerAttachments("/tmp/family")).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
