import { constants as osConstants } from "node:os";
import { describe, expect, it } from "vitest";
import { buildSandboxSeccompFilter } from "./seccomp-boundary-filter.js";

const ALLOW = 0x7fff0000;
const DENY = 0x50000 | osConstants.errno.EACCES;
const KILL = 0x80000000;
const ARCHITECTURES = [
  { name: "x64", audit: 0xc000003e, socket: 41, pair: 53, links: [86, 265] },
  { name: "arm64", audit: 0xc00000b7, socket: 198, pair: 199, links: [37] },
] as const;
const FLAGS = [0, 0x800, 0x80000, 0x80800];

describe.each(ARCHITECTURES)("sandbox seccomp boundary filter: $name", (architecture) => {
  it.each(["none", "local", "host"] as const)(
    "%s retains architecture, io_uring and hard-link protections",
    (mode) => {
      const filter = buildSandboxSeccompFilter(architecture.name, mode);
      for (const syscall of [425, 426, 427, ...architecture.links]) {
        expect(evaluate(filter, architecture.audit, syscall)).toBe(DENY);
      }
      expect(evaluate(filter, 0, architecture.socket)).toBe(KILL);
      expect(evaluate(filter, architecture.audit, 0)).toBe(ALLOW);
      if (architecture.name === "x64") {
        expect(evaluate(filter, architecture.audit, 0x40000000 | architecture.socket)).toBe(DENY);
      }
    },
  );

  it("none rejects socket creation for every supported and foreign family", () => {
    const filter = buildSandboxSeccompFilter(architecture.name, "none");
    for (const family of [1, 2, 10, 16, 17, 40]) {
      expect(evaluate(filter, architecture.audit, architecture.socket, [family, 1, 0])).toBe(DENY);
    }
  });

  it("local permits IPv4/IPv6 TCP and UDP, including standard descriptor flags", () => {
    const filter = buildSandboxSeccompFilter(architecture.name, "local");
    for (const family of [2, 10]) {
      for (const [type, protocol] of [
        [1, 0],
        [1, 6],
        [2, 0],
        [2, 17],
      ] as const) {
        for (const flags of FLAGS) {
          expect(
            evaluate(filter, architecture.audit, architecture.socket, [
              family,
              type | flags,
              protocol,
            ]),
          ).toBe(ALLOW);
        }
      }
    }
  });

  it("local rejects Unix/raw/netlink/packet sockets and unapproved types or protocols", () => {
    const filter = buildSandboxSeccompFilter(architecture.name, "local");
    for (const args of [
      [1, 1, 0],
      [1, 2, 0],
      [16, 3, 0],
      [17, 3, 0],
      [40, 1, 0],
      [2, 3, 0],
      [10, 3, 0],
      [2, 5, 0],
      [2, 1, 17],
      [10, 2, 6],
      [2, 1, 132],
      [2, 1 | 0x1000, 0],
    ]) {
      expect(evaluate(filter, architecture.audit, architecture.socket, args)).toBe(DENY);
    }
  });

  it.each(["none", "local"] as const)(
    "%s permits Bun's connected stream pairs but rejects reconnectable datagram pairs",
    (mode) => {
      const filter = buildSandboxSeccompFilter(architecture.name, mode);
      for (const flags of FLAGS) {
        expect(evaluate(filter, architecture.audit, architecture.pair, [1, 1 | flags, 0])).toBe(
          ALLOW,
        );
        expect(evaluate(filter, architecture.audit, architecture.pair, [1, 2 | flags, 0])).toBe(
          DENY,
        );
      }
      for (const args of [
        [2, 1, 0],
        [1, 5, 0],
        [1, 1, 6],
        [1, 1 | 0x1000, 0],
      ]) {
        expect(evaluate(filter, architecture.audit, architecture.pair, args)).toBe(DENY);
      }
    },
  );

  it("host preserves unrestricted socket and socketpair arguments", () => {
    const filter = buildSandboxSeccompFilter(architecture.name, "host");
    for (const syscall of [architecture.socket, architecture.pair]) {
      for (const args of [
        [1, 2, 0],
        [2, 3, 0],
        [16, 3, 0],
        [17, 3, 0],
      ]) {
        expect(evaluate(filter, architecture.audit, syscall, args)).toBe(ALLOW);
      }
    }
  });
});

describe("sandbox seccomp validation", () => {
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

/** Execute the encoded classic BPF against seccomp_data, checking actual decisions. */
function evaluate(
  filter: Buffer,
  architecture: number,
  syscall: number,
  args: readonly number[] = [],
): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(syscall, 0);
  data.writeUInt32LE(architecture, 4);
  args.forEach((value, index) => data.writeBigUInt64LE(BigInt(value), 16 + index * 8));
  let accumulator = 0;
  for (let index = 0; index < filter.length / 8; index++) {
    const offset = index * 8;
    const value = filter.readUInt32LE(offset + 4);
    switch (filter.readUInt16LE(offset)) {
      case 0x20:
        accumulator = data.readUInt32LE(value);
        break;
      case 0x15:
        index += filter.readUInt8(offset + (accumulator === value ? 2 : 3));
        break;
      case 0x45:
        index += filter.readUInt8(offset + ((accumulator & value) !== 0 ? 2 : 3));
        break;
      case 0x54:
        accumulator = (accumulator & value) >>> 0;
        break;
      case 0x06:
        return value;
      default:
        throw new Error("unsupported_test_bpf_opcode");
    }
  }
  throw new Error("bpf_did_not_return");
}
