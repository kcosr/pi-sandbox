import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  prepareSandboxToolRequest,
  snapshotJsonObject,
  type JsonObject,
} from "./invocation.js";

describe("tool invocation snapshots", () => {
  it("preserves own prototype keys and normalizes JSON values before freezing", () => {
    const input = JSON.parse(
      '{"z":-0,"__proto__":{"nested":[-0,{"value":"before"}]},"constructor":"data"}',
    ) as JsonObject;
    const request = prepareSandboxToolRequest("write", input);
    expect(Object.getPrototypeOf(request.arguments)).toBe(Object.prototype);
    expect(Object.hasOwn(request.arguments, "__proto__")).toBe(true);
    expect(request.arguments.__proto__).toEqual({ nested: [0, { value: "before" }] });
    expect(Object.is(request.arguments.z, -0)).toBe(false);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.arguments)).toBe(true);
    expect(Object.isFrozen(request.arguments.__proto__)).toBe(true);
    expect(canonicalizeJson(request.arguments)).toBe(
      '{"__proto__":{"nested":[0,{"value":"before"}]},"constructor":"data","z":0}',
    );
    // A managed policy copy must not change any value after sandbox authorization.
    expect(snapshotJsonObject(request.arguments)).toStrictEqual(request.arguments);
    expect(Object.hasOwn({}, "nested")).toBe(false);
  });

  it("accepts null prototypes without invoking toJSON or retaining caller objects", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      nested: { value: "before" },
      toJSON: "ordinary data",
    });
    const snapshot = snapshotJsonObject(input as JsonObject);
    input.nested.value = "after";
    expect(snapshot).toEqual({ nested: { value: "before" }, toJSON: "ordinary data" });
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    () => 1,
    Symbol("value"),
    1n,
    new Date(0),
    new Map(),
    Object.create({ inherited: true }) as unknown,
    new Array<unknown>(2),
  ])("rejects non-JSON argument values (%s)", (value) => {
    expect(() => snapshotJsonObject({ value } as JsonObject)).toThrow();
  });

  it("rejects cycles but accepts repeated values that are not cyclic", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => snapshotJsonObject(cycle as JsonObject)).toThrow("cycle");
    const shared = { value: true };
    expect(snapshotJsonObject({ first: shared, second: shared })).toEqual({
      first: { value: true },
      second: { value: true },
    });
  });
});
