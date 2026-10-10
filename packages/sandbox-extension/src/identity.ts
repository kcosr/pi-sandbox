import { readFileSync } from "node:fs";

export interface SandboxPackageIdentity {
  readonly name: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly piVersion: string;
  readonly sourceSha256: string;
}

/** Available in the built artifact; source checkouts are not release identities. */
export function sandboxPackageIdentity(): SandboxPackageIdentity {
  return Object.freeze(
    JSON.parse(
      readFileSync(new URL("../provenance.json", import.meta.url), "utf8"),
    ) as SandboxPackageIdentity,
  );
}
