import { describe, expect, it } from "vitest";
import { buildSandboxSeccompFilter } from "./seccomp-boundary-filter.js";

describe("sandbox seccomp boundary filter", () => {
  it("denies sockets, io_uring, links, and the x32 syscall ABI on x64", () => {
    const filter = buildSandboxSeccompFilter("x64");
    expect(filter.byteLength).toBe(19 * 8);
    expect(instructionValue(filter, 1)).toBe(0xc000_003e);
    expect(instructionCode(filter, 4)).toBe(0x45);
    expect(instructionValue(filter, 4)).toBe(0x4000_0000);
    expect(comparisonValues(filter, [6, 8, 10, 12, 14, 16])).toEqual([41, 425, 426, 427, 86, 265]);
  });

  it("denies sockets, io_uring, and linkat on arm64", () => {
    const filter = buildSandboxSeccompFilter("arm64");
    expect(filter.byteLength).toBe(15 * 8);
    expect(instructionValue(filter, 1)).toBe(0xc000_00b7);
    expect(comparisonValues(filter, [4, 6, 8, 10, 12])).toEqual([198, 425, 426, 427, 37]);
  });

  it("allows socket creation in host mode while retaining other syscall denials", () => {
    const x64 = buildSandboxSeccompFilter("x64", "host");
    expect(x64.byteLength).toBe(17 * 8);
    expect(comparisonValues(x64, [6, 8, 10, 12, 14])).toEqual([425, 426, 427, 86, 265]);

    const arm64 = buildSandboxSeccompFilter("arm64", "host");
    expect(arm64.byteLength).toBe(13 * 8);
    expect(comparisonValues(arm64, [4, 6, 8, 10])).toEqual([425, 426, 427, 37]);
  });

  it("fails closed on an unsupported architecture", () => {
    expect(() => buildSandboxSeccompFilter("ia32")).toThrow(
      "sandbox_seccomp_unsupported_architecture:ia32",
    );
  });

  it("fails closed on an invalid runtime network mode", () => {
    expect(() => buildSandboxSeccompFilter("x64", "filtered" as "none")).toThrow(
      "sandbox_network_mode_invalid",
    );
  });
});

function instructionValue(filter: Buffer, index: number): number {
  return filter.readUInt32LE(index * 8 + 4);
}

function instructionCode(filter: Buffer, index: number): number {
  return filter.readUInt16LE(index * 8);
}

function comparisonValues(filter: Buffer, indices: readonly number[]): number[] {
  return indices.map((index) => instructionValue(filter, index));
}
