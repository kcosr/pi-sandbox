/** Strict JSON shared by local catalogs and service wire messages. */
export function parseStrictJson(source: string, maximumBytes = 4 * 1024 * 1024): unknown {
  const invalid = (): never => {
    throw new Error("Invalid JSON input");
  };
  if (Buffer.byteLength(source) > maximumBytes) return invalid();
  let offset = 0;
  const numericToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(source[offset] ?? "")) offset++;
  };
  const string = (): string => {
    const start = offset;
    if (source[offset++] !== '"') return invalid();
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') {
        let result: string;
        try {
          result = JSON.parse(source.slice(start, offset)) as string;
        } catch {
          return invalid();
        }
        if (/[\uD800-\uDFFF]/u.test(result)) return invalid();
        return result;
      }
      if (char === "\\") offset++;
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) return invalid();
    whitespace();
    const char = source[offset];
    if (char === '"') return string();
    if (char === "{") {
      offset++;
      whitespace();
      const result = Object.create(null) as Record<string, unknown>;
      if (source[offset] === "}") {
        offset++;
        return result;
      }
      while (offset < source.length) {
        whitespace();
        const key = string();
        whitespace();
        if (Object.hasOwn(result, key) || source[offset++] !== ":") return invalid();
        result[key] = value(depth + 1);
        whitespace();
        if (source[offset] === "}") {
          offset++;
          return result;
        }
        if (source[offset++] !== ",") return invalid();
      }
      return invalid();
    }
    if (char === "[") {
      offset++;
      whitespace();
      const result: unknown[] = [];
      if (source[offset] === "]") {
        offset++;
        return result;
      }
      while (offset < source.length) {
        result.push(value(depth + 1));
        whitespace();
        if (source[offset] === "]") {
          offset++;
          return result;
        }
        if (source[offset++] !== ",") return invalid();
      }
      return invalid();
    }
    for (const [token, literal] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(token, offset)) {
        offset += token.length;
        return literal;
      }
    }
    numericToken.lastIndex = offset;
    const match = numericToken.exec(source);
    if (!match) return invalid();
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)))
      return invalid();
    return number;
  };
  const result = value(0);
  whitespace();
  if (offset !== source.length) return invalid();
  return result;
}

/** Reject TOML values that cannot be represented faithfully by the service protocol. */
export function assertJsonValue(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("JSON nesting exceeds 32");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)) return;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return;
  if (Array.isArray(value)) {
    for (const child of value) assertJsonValue(child, depth + 1);
    return;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    for (const [key, child] of Object.entries(value)) {
      if (/[\uD800-\uDFFF]/u.test(key)) throw new Error("Invalid JSON key");
      assertJsonValue(child, depth + 1);
    }
    return;
  }
  throw new Error("Unsupported JSON value");
}

export function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
