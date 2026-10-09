/** Validate a literal endpoint without normalizing its path, query, or percent escapes. */
export function validateMcpUrl(value: string): void {
  if (
    Buffer.byteLength(value) > 4096 ||
    /[\s\p{Cc}\\{}]/u.test(value) ||
    /%(?![0-9a-f]{2})/iu.test(value)
  )
    throw new Error("Invalid literal MCP URL");
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/iu.exec(value);
  if (match === null) throw new Error("Invalid literal MCP URL");
  const [, protocol, authority, path] = match;
  if (authority!.includes("@")) throw new Error("Invalid MCP URL authority");
  const url = new URL(value);
  if (
    url.username !== "" ||
    url.password !== "" ||
    (protocol!.toLowerCase() === "http" &&
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/iu.test(authority!))
  )
    throw new Error("MCP HTTP requires a literal loopback host");
  for (const component of path!.split("/")) {
    const decoded = decodeURIComponent(component);
    if (decoded === "." || decoded === "..") throw new Error("MCP URL dot segments are forbidden");
  }
}
