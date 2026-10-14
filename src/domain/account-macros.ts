import { isNormalizedAbsoluteFilePath } from "../../packages/sandbox-extension/src/runtime/paths.js";

export interface AccountIdentity {
  readonly username: string;
  readonly uid: number;
  readonly homeDirectory: string;
}
type AccountMacro = "username" | "uid" | "machine_id";
type AccountPart = { readonly literal: string } | { readonly macro: AccountMacro };

function parts(value: string): AccountPart[] {
  const result: AccountPart[] = [];
  let literal = "";
  for (let i = 0; i < value.length;) {
    if (value.startsWith("{{{{", i) || value.startsWith("}}}}", i)) {
      literal += value.slice(i, i + 2);
      i += 4;
    } else if (value.startsWith("{{", i)) {
      const match = /^\{\{(username|uid|machine_id)\}\}/u.exec(value.slice(i));
      if (match === null) throw new Error("Invalid account macro syntax");
      if (literal !== "") result.push({ literal });
      literal = "";
      result.push({ macro: match[1] as AccountMacro });
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
  getMachineId?: () => string,
): string {
  const parsed = parts(value);
  let identity: AccountIdentity | undefined;
  const account = (): AccountIdentity => (identity ??= getIdentity());
  let machineId: string | undefined;
  const machine = (): string => {
    if (getMachineId === undefined) {
      throw new Error("The machine_id macro requires an operating-system machine ID resolver");
    }
    return (machineId ??= getMachineId());
  };
  let result = parsed
    .map((part) => {
      if ("literal" in part) return part.literal;
      return part.macro === "machine_id" ? machine() : String(account()[part.macro]);
    })
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
