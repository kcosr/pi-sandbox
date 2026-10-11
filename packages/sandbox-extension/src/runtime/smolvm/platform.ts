import { access } from "node:fs/promises";
import { hostQuery } from "./host-query.js";
import { smolvmReleaseForPlatform } from "./release-pin.js";

export async function verifySmolvmCapability(): Promise<void> {
  smolvmReleaseForPlatform(process.platform, process.arch);
  if (process.platform === "linux") return access("/dev/kvm", 6);
  const version = (await hostQuery(["/usr/bin/sw_vers", "-productVersion"])).toString().trim();
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(version) || Number(version.split(".")[0]) < 26)
    throw new Error("smolvm_requires_macos_26");
  if ((await hostQuery(["/usr/sbin/sysctl", "-n", "kern.hv_support"])).toString().trim() !== "1")
    throw new Error("smolvm_hypervisor_unavailable");
}
