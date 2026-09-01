import { constants as osConstants } from "node:os";

import type { NetworkMode } from "../domain/index.js";

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x8000_0000;
const SECCOMP_RET_ERRNO = 0x0005_0000;
const SECCOMP_RET_ALLOW = 0x7fff_0000;
const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;

interface ArchitectureSyscalls {
  readonly auditArchitecture: number;
  readonly socketSyscall: number;
  readonly alwaysDeniedSyscalls: readonly number[];
  readonly rejectX32: boolean;
}

const ARCHITECTURES: Readonly<Partial<Record<NodeJS.Architecture, ArchitectureSyscalls>>> =
  Object.freeze({
    x64: Object.freeze({
      auditArchitecture: 0xc000_003e,
      socketSyscall: 41,
      alwaysDeniedSyscalls: Object.freeze([425, 426, 427, 86, 265]),
      rejectX32: true,
    }),
    arm64: Object.freeze({
      auditArchitecture: 0xc000_00b7,
      socketSyscall: 198,
      alwaysDeniedSyscalls: Object.freeze([425, 426, 427, 37]),
      rejectX32: false,
    }),
  });

interface BpfInstruction {
  readonly code: number;
  readonly jumpTrue: number;
  readonly jumpFalse: number;
  readonly value: number;
}

/**
 * Deny io_uring setup/control and hard-link creation. Offline mode also denies
 * connectable socket creation. Anonymous socket pairs remain available because
 * the Bun worker uses one to spawn command children; those descriptors cannot
 * connect to an external endpoint. An architecture mismatch kills the sandbox
 * process rather than evaluating syscall numbers for the wrong ABI.
 */
export function buildSandboxSeccompFilter(
  architecture: NodeJS.Architecture = process.arch,
  networkMode: NetworkMode = "none",
): Buffer {
  if (networkMode !== "none" && networkMode !== "host") {
    throw new Error("sandbox_network_mode_invalid");
  }
  const syscalls = ARCHITECTURES[architecture];
  if (!syscalls) {
    throw new Error(`sandbox_seccomp_unsupported_architecture:${architecture}`);
  }

  const deny = SECCOMP_RET_ERRNO | osConstants.errno.EACCES;
  const instructions: BpfInstruction[] = [
    instruction(BPF_LD_W_ABS, SECCOMP_DATA_ARCH_OFFSET),
    instruction(BPF_JMP_JEQ_K, syscalls.auditArchitecture, 1, 0),
    instruction(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
    instruction(BPF_LD_W_ABS, SECCOMP_DATA_NR_OFFSET),
  ];
  if (syscalls.rejectX32) {
    instructions.push(instruction(BPF_JMP_JSET_K, 0x4000_0000, 0, 1), instruction(BPF_RET_K, deny));
  }
  const deniedSyscalls =
    networkMode === "none"
      ? [syscalls.socketSyscall, ...syscalls.alwaysDeniedSyscalls]
      : syscalls.alwaysDeniedSyscalls;
  for (const syscall of deniedSyscalls) {
    instructions.push(instruction(BPF_JMP_JEQ_K, syscall, 0, 1), instruction(BPF_RET_K, deny));
  }
  instructions.push(instruction(BPF_RET_K, SECCOMP_RET_ALLOW));
  return encodeInstructions(instructions);
}

function instruction(code: number, value: number, jumpTrue = 0, jumpFalse = 0): BpfInstruction {
  return { code, jumpTrue, jumpFalse, value };
}

function encodeInstructions(instructions: readonly BpfInstruction[]): Buffer {
  const result = Buffer.allocUnsafe(instructions.length * 8);
  instructions.forEach((item, index) => {
    const offset = index * 8;
    result.writeUInt16LE(item.code, offset);
    result.writeUInt8(item.jumpTrue, offset + 2);
    result.writeUInt8(item.jumpFalse, offset + 3);
    result.writeUInt32LE(item.value >>> 0, offset + 4);
  });
  return result;
}
