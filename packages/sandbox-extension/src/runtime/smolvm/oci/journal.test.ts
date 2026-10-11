import { describe, expect, it } from "vitest";
import { compactOwnedMachines, type OwnedMachine } from "./journal.js";

describe("owned inventory compaction", () => {
  it("retains referenced ancestors and uncertain leaves while discarding acknowledged deleted chains", () => {
    const records: OwnedMachine[] = [
      { name: "source", parent: null, status: "deleted", identity: null },
      { name: "referenced", parent: "source", status: "deleted", identity: null },
      { name: "uncertain", parent: "referenced", status: "uncertain", identity: null },
      { name: "old-parent", parent: "source", status: "deleted", identity: null },
      { name: "old-child", parent: "old-parent", status: "deleted", identity: null },
    ];
    expect(compactOwnedMachines(records, "source").map((r) => r.name)).toEqual([
      "source",
      "referenced",
      "uncertain",
    ]);
    records[2]!.status = "deleted";
    expect(compactOwnedMachines(records, "source").map((r) => r.name)).toEqual(["source"]);
  });
});
