import { access } from "node:fs/promises";
import path from "node:path";
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

/** Observe only; never detach an unrelated or uncertain host volume. */
export async function assertNoSmolvmLayerAttachments(state: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const plist = await hostQuery(["/usr/bin/hdiutil", "info", "-plist"]);
  const raw: unknown = JSON.parse(
    (
      await hostQuery(["/usr/bin/plutil", "-convert", "json", "-o", "-", "--", "-"], plist)
    ).toString(),
  );
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { images?: unknown }).images))
    throw new Error("smolvm_layer_inventory_invalid");
  for (const image of (raw as { images: unknown[] }).images) {
    if (
      !image ||
      typeof image !== "object" ||
      typeof (image as Record<string, unknown>)["image-path"] !== "string"
    )
      throw new Error("smolvm_layer_inventory_invalid");
    const file = path.normalize((image as Record<string, string>)["image-path"]!);
    if (file === state || file.startsWith(`${state}/`))
      throw new Error("smolvm_layer_attachment_remains");
  }
}
