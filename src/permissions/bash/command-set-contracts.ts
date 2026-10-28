/** Administrator-approved invocation shapes, separate from the reviewed read-only registry. */
export interface BashCommandSet {
  readonly command: string;
  readonly mode: "allow";
  readonly sessionGrant: "never";
  readonly requiredFlags: readonly string[];
  readonly optionalFlags: readonly string[];
  readonly options: Readonly<Record<string, readonly string[]>>;
  readonly operands: { readonly min: number; readonly max: number };
}

export type BashCommandSets = Readonly<Record<string, BashCommandSet>>;

export const MAXIMUM_COMMAND_SETS = 64;
export const MAXIMUM_COMMAND_SET_OPTIONS = 64;
export const MAXIMUM_COMMAND_SET_VALUES = 64;
export const MAXIMUM_COMMAND_SET_STRING_BYTES = 256;
export const MAXIMUM_COMMAND_SET_OPERANDS = 1024;
export const MAXIMUM_COMMAND_SETS_BYTES = 128 * 1024;

const PROTOTYPE_NAMES = new Set(["__proto__", "prototype", "constructor"]);
// Bash 3.2+ builtins and reserved words, including conditionally enabled builtins.
// An administrator profile describes an external executable; Bash must not select a builtin.
const SHELL_NAMES = new Set(
  (
    ". : [ [[ ]] ! { } alias bg bind break builtin caller case cd command compgen complete " +
    "compopt continue coproc declare dirs disown do done echo elif else enable esac eval exec " +
    "exit export false fc fg fi for function getopts hash help history if in jobs kill let local " +
    "logout mapfile popd printf pushd pwd read readarray readonly return select set shift shopt " +
    "source suspend test then time times trap true type typeset ulimit umask unalias unset " +
    "until wait while"
  ).split(" "),
);

export function isCommandSetId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value) && !PROTOTYPE_NAMES.has(value);
}

export function isCommandSetCommand(value: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u.test(value) &&
    Buffer.byteLength(value) <= MAXIMUM_COMMAND_SET_STRING_BYTES &&
    !PROTOTYPE_NAMES.has(value) &&
    !SHELL_NAMES.has(value)
  );
}

export function isCommandSetFlag(value: string): boolean {
  return (
    /^(?:-[A-Za-z0-9]|--[A-Za-z0-9][A-Za-z0-9_-]*)$/u.test(value) &&
    Buffer.byteLength(value) <= MAXIMUM_COMMAND_SET_STRING_BYTES
  );
}

export function isCommandSetValue(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= MAXIMUM_COMMAND_SET_STRING_BYTES &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(value)
  );
}

/** Snapshot caller-owned arrays and maps before they can affect later decisions. */
export function freezeBashCommandSets(sets: BashCommandSets): BashCommandSets {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(sets).map(([id, rule]) => [
        id,
        Object.freeze({
          command: rule.command,
          mode: rule.mode,
          sessionGrant: rule.sessionGrant,
          requiredFlags: Object.freeze([...rule.requiredFlags]),
          optionalFlags: Object.freeze([...rule.optionalFlags]),
          options: Object.freeze(
            Object.fromEntries(
              Object.entries(rule.options).map(([name, values]) => [
                name,
                Object.freeze([...values]),
              ]),
            ),
          ),
          operands: Object.freeze({ ...rule.operands }),
        }),
      ]),
    ),
  );
}
