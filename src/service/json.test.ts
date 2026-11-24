import { describe, expect, it } from "vitest";
import { assertJsonValue, parseStrictJson } from "./json.js";
import { parseServiceResponse, ServiceError } from "./protocol.js";
const id = "a".repeat(32);
describe("strict managed JSON", () => {
  it.each([
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    "\ufeff{}",
    "/*a*/{}",
    '{"a":Infinity}',
    '{"a":NaN}',
    '{"a":9007199254740992}',
    '{"a":1e309}',
    '{"a":1,}',
    "[1,]",
    '{"a":"\\ud800"}',
    '{"a":undefined}',
    "{} trailing",
    "\v{}",
    '{"a":01}',
  ])("rejects ambiguous or unsupported JSON %s", (text) =>
    expect(() => parseStrictJson(text)).toThrow(),
  );
  it("preserves escaped strings, Unicode, fractional numbers and untrusted object keys", () => {
    const value = parseStrictJson(
      String.raw`{"__proto__":{"x":1},"emoji":"😀","escape":"a\\b\"c","number":0.25}`,
    );
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value).toEqual({ ["__proto__"]: { x: 1 }, emoji: "😀", escape: 'a\\b"c', number: 0.25 });
  });
  it("bounds encoded UTF-8 bytes and nesting independently of source shape", () => {
    expect(() => parseStrictJson('"😀"', 5)).toThrow();
    expect(parseStrictJson('"😀"', 6)).toBe("😀");
    expect(() => parseStrictJson("[".repeat(33) + "0" + "]".repeat(33))).toThrow();
    expect(() => parseStrictJson("[".repeat(32) + "0" + "]".repeat(32))).not.toThrow();
    expect(() => assertJsonValue(JSON.parse("[".repeat(33) + "0" + "]".repeat(33)))).toThrow();
    expect(() => assertJsonValue(JSON.parse("[".repeat(32) + "0" + "]".repeat(32)))).not.toThrow();
  });
  it("parses a large numeric catalog without copying the remaining input for each token", () => {
    const input = "[" + Array.from({ length: 150000 }, (_, index) => index + 0.25).join(",") + "]";
    const result = parseStrictJson(input) as number[];
    expect(result).toHaveLength(150000);
    expect(result.at(-1)).toBe(149999.25);
  });
  it.each([new Date(), NaN, Infinity, 9007199254740992, BigInt(1), { key: undefined }, () => {}])(
    "rejects TOML values without a faithful JSON representation",
    (value) => expect(() => assertJsonValue(value)).toThrow(),
  );
});
describe("service response correlation", () => {
  const result = { audit_session_id: id, service_epoch: id, audit_generation: 1, next_sequence: 1 };
  const envelope = { version: 1, request_id: id, operation: "audit_open", result };
  it("admits an exact matching result and rejects mismatched or extra fields", () => {
    expect(parseServiceResponse(envelope, "audit_open", id, 200)).toEqual(result);
    for (const invalid of [
      { ...envelope, request_id: "b".repeat(32) },
      { ...envelope, version: 2 },
      { ...envelope, operation: "audit_event" },
      { ...envelope, unknown: true },
      { ...envelope, result: { ...result, extra: true } },
      { ...envelope, result: { ...result, audit_generation: 0 } },
      { ...envelope, result: { ...result, service_epoch: "bad" } },
    ])
      expect(() => parseServiceResponse(invalid, "audit_open", id, 200)).toThrow();
  });
  it("returns typed errors only for known matching status codes and safe envelopes", () => {
    const error = {
      version: 1,
      request_id: id,
      error: { code: "unknown_audit_session", message: "expired" },
    };
    expect(() => parseServiceResponse(error, "audit_check", id, 410)).toThrow(ServiceError);
    expect(() => parseServiceResponse(error, "audit_check", id, 503)).toThrow("invalid response");
    expect(() =>
      parseServiceResponse({ ...error, request_id: "other" }, "audit_check", id, 410),
    ).toThrow("invalid response");
  });
  it("preserves bounded compatibility guidance while sanitizing other server diagnostics", () => {
    const message = "Expected policy 16; supplied policy 15; contact the administrator";
    expect(() =>
      parseServiceResponse(
        {
          version: 1,
          request_id: id,
          error: { code: "incompatible_client", message },
        },
        "bootstrap",
        id,
        403,
      ),
    ).toThrow(message);
    expect(() =>
      parseServiceResponse(
        {
          version: 1,
          request_id: id,
          error: { code: "configuration_unavailable", message: "private file contents" },
        },
        "bootstrap",
        id,
        503,
      ),
    ).toThrow("Service configuration is unavailable or invalid");
    expect(() =>
      parseServiceResponse(
        {
          version: 1,
          request_id: id,
          error: { code: "incompatible_client", message: "bad\nterminal output" },
        },
        "bootstrap",
        id,
        403,
      ),
    ).toThrow("invalid response");
  });
});
