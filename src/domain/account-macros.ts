import { isNormalizedAbsoluteFilePath } from "./paths.js";

export interface AccountIdentity {
  readonly username: string;
  readonly uid: number;
  readonly homeDirectory: string;
}
type AccountPart = { readonly literal: string } | { readonly macro: "username" | "uid" };

function parts(value: string): AccountPart[] {
  const result: AccountPart[] = [];
  let literal = "";
  for (let i = 0; i < value.length;) {
    if (value.startsWith("{{{{", i) || value.startsWith("}}}}", i)) {
      literal += value.slice(i, i + 2);
      i += 4;
    } else if (value.startsWith("{{", i)) {
      const match = /^\{\{(username|uid)\}\}/u.exec(value.slice(i));
      if (match === null) throw new Error("Invalid account macro syntax");
      if (literal !== "") result.push({ literal });
      literal = "";
      result.push({ macro: match[1] as "username" | "uid" });
      i += match[0].length;
    } else if (value.startsWith("}}", i)) {
      throw new Error("Invalid account macro syntax");
    } else {
      literal += value[i]!;
      i++;
    }
  }
  if (literal !== "") result.push({ literal });
  return result;
}

export function validateAccountTemplate(value: string): void {
  parts(value);
}

/** Single-pass expansion: account data and escaped braces are never templates. */
export function expandAccountValue(
  value: string,
  getIdentity: () => AccountIdentity,
  expandHome = true,
): string {
  const parsed = parts(value);
  let identity: AccountIdentity | undefined;
  const account = (): AccountIdentity => (identity ??= getIdentity());
  let result = parsed
    .map((part) => ("literal" in part ? part.literal : String(account()[part.macro])))
    .join("");
  if (expandHome && (value === "~" || value.startsWith("~/"))) {
    const home = account().homeDirectory;
    if (home !== "/" && !isNormalizedAbsoluteFilePath(home)) {
      throw new Error("The invoking account home directory must be a normalized absolute path");
    }
    result = result === "~" ? home : `${home === "/" ? "" : home}${result.slice(1)}`;
  }
  return result;
}

function urlParts(template: string): { prefix: string; path: string; query: string | undefined } {
  if (
    Buffer.byteLength(template) > 4096 ||
    /[\s\p{Cc}\\]/u.test(template) ||
    /%(?![0-9a-f]{2})/iu.test(template)
  )
    throw new Error("Invalid MCP URL template");
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/iu.exec(template);
  if (match === null) throw new Error("Invalid MCP URL template");
  const [, protocol, authority, path, query] = match;
  if (/[{}@]/u.test(authority!)) throw new Error("Invalid MCP URL authority");
  const base = new URL(`${protocol}://${authority}`);
  if (
    base.username !== "" ||
    base.password !== "" ||
    (protocol!.toLowerCase() === "http" &&
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/iu.test(authority!))
  )
    throw new Error("MCP HTTP requires a literal loopback host");
  parts(path!);
  if (query !== undefined) {
    for (const parameter of query.split("&")) {
      const equal = parameter.indexOf("=");
      const key = equal < 0 ? parameter : parameter.slice(0, equal);
      if (/[{}]/u.test(key)) throw new Error("MCP URL query keys must be literal");
      if (equal >= 0) parts(parameter.slice(equal + 1));
    }
  }
  return { prefix: `${protocol}://${authority}`, path: path!, query };
}

function renderUrl(template: string, getIdentity: () => AccountIdentity): string {
  const { prefix, path, query } = urlParts(template);
  let identity: AccountIdentity | undefined;
  const render = (value: string): string =>
    parts(value)
      .map((part) => {
        if ("literal" in part) return part.literal;
        identity ??= getIdentity();
        return encodeURIComponent(String(identity[part.macro])).replace(
          /[!'()*]/gu,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
      })
      .join("");
  const expandedPath = render(path);
  for (const component of expandedPath.split("/")) {
    const decoded = decodeURIComponent(component);
    if (decoded === "." || decoded === "..") throw new Error("MCP URL dot segments are forbidden");
  }
  const expandedQuery = query
    ?.split("&")
    .map((parameter) => {
      const equal = parameter.indexOf("=");
      return equal < 0
        ? parameter
        : `${parameter.slice(0, equal + 1)}${render(parameter.slice(equal + 1))}`;
    })
    .join("&");
  const result = `${prefix}${expandedPath}${expandedQuery === undefined ? "" : `?${expandedQuery}`}`;
  if (Buffer.byteLength(result) > 4096) throw new Error("Expanded MCP URL is too long");
  new URL(result);
  return result;
}

export function validateMcpUrlTemplate(value: string): void {
  renderUrl(value, () => ({ username: "account", uid: 1, homeDirectory: "/home/account" }));
}
export function expandMcpUrl(value: string, getIdentity: () => AccountIdentity): string {
  return renderUrl(value, getIdentity);
}
