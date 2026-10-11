import { describe, expect, it, vi } from "vitest";
import { parseDarwinProcessSnapshot, queryDarwinProcess } from "./darwin-query.js";
import { hostQuery } from "./host-query.js";
vi.mock("./host-query.js", () => ({ hostQuery: vi.fn() }));
const encode = (s: string) => Buffer.from(s).toString("hex");
const sample = () => ({
  version: 1,
  state: "present",
  pid: 42,
  uid: process.geteuid?.(),
  processGroup: 41,
  startSeconds: "1791690000",
  startMicroseconds: "123456",
  executableHex: encode("/runtime/smolvm-bin"),
  argvHex: ["/runtime/smolvm-bin", "_boot-vm", "/private/state/boot.json"].map(encode),
});
const parse = (v: unknown) => parseDarwinProcessSnapshot(Buffer.from(JSON.stringify(v)), 42);
describe("Darwin process observation protocol", () => {
  it("retains exact subsecond generation and byte boundaries", () => {
    const v = sample();
    v.argvHex.push(encode(""), encode("space and π\n"));
    expect(parse(v)).toEqual({
      start: "darwin:1791690000:123456",
      executable: "/runtime/smolvm-bin",
      argv: ["/runtime/smolvm-bin", "_boot-vm", "/private/state/boot.json", "", "space and π\n"],
    });
    expect(parse({ ...v, startMicroseconds: "123457" })?.start).not.toBe(parse(v)?.start);
  });
  it("recognizes only the exact absence response", () => {
    expect(parse({ version: 1, state: "absent" })).toBeUndefined();
    expect(() => parse({ version: 1, state: "absent", error: "permission" })).toThrow();
  });
  it.each([
    { pid: 43 },
    { uid: -1 },
    { state: "unknown" },
    { version: 2 },
    { startSeconds: "1.1" },
    { startMicroseconds: "1000000" },
    { startMicroseconds: "01" },
    { executableHex: "zz" },
    { executableHex: "ff" },
    { argvHex: ["00"] },
    { environment: {} },
    { argvHex: [] },
  ])("rejects malformed or ambiguous observation %j", (patch) => {
    expect(() => parse({ ...sample(), ...patch })).toThrow();
  });
  it("does not turn query failure into process absence", async () => {
    vi.mocked(hostQuery).mockRejectedValueOnce(new Error("permission failure"));
    await expect(
      queryDarwinProcess({ path: "/trusted/query", sha256: "a".repeat(64) }, 42),
    ).rejects.toThrow("permission failure");
    expect(hostQuery).toHaveBeenCalledWith(["/trusted/query", "42"]);
  });
});
