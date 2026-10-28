import {
  freezeBashCommandSets,
  isCommandSetCommand,
  isCommandSetFlag,
  isCommandSetId,
  isCommandSetValue,
  MAXIMUM_COMMAND_SETS,
  MAXIMUM_COMMAND_SETS_BYTES,
  MAXIMUM_COMMAND_SET_OPERANDS,
  MAXIMUM_COMMAND_SET_OPTIONS,
  MAXIMUM_COMMAND_SET_STRING_BYTES,
  MAXIMUM_COMMAND_SET_VALUES,
  type BashCommandSet,
  type BashCommandSets,
} from "../permissions/bash/command-set-contracts.js";

type Table = Record<string, unknown>;

function table(value: unknown, path: string): Table {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date)
    throw new Error(`${path} must be a table`);
  return value as Table;
}

function keys(
  value: Table,
  required: readonly string[],
  optional: readonly string[],
  path: string,
) {
  for (const key of required)
    if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
  for (const key of Object.keys(value))
    if (![...required, ...optional].includes(key))
      throw new Error(`${path}.${key} is not a recognized field`);
}

function stringList(
  value: unknown,
  path: string,
  limit: number,
  validate: (value: string) => boolean,
): string[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error(`${path} must be an array with at most ${limit} entries`);
  if (value.some((entry) => typeof entry !== "string" || !validate(entry)))
    throw new Error(
      `${path} contains an invalid entry (maximum ${MAXIMUM_COMMAND_SET_STRING_BYTES} bytes)`,
    );
  if (new Set(value).size !== value.length) throw new Error(`${path} must not contain duplicates`);
  return value as string[];
}

function operandCount(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_COMMAND_SET_OPERANDS
  )
    throw new Error(`${path} must be an integer between 0 and ${MAXIMUM_COMMAND_SET_OPERANDS}`);
  return value;
}

function parseRule(value: unknown, path: string): BashCommandSet {
  const rule = table(value, path);
  keys(
    rule,
    ["command", "mode", "session_grant", "operands"],
    ["required_flags", "optional_flags", "options"],
    path,
  );
  if (typeof rule.command !== "string" || !isCommandSetCommand(rule.command))
    throw new Error(
      `${path}.command must name a bare external executable, not a Bash builtin or reserved word`,
    );
  if (rule.mode !== "allow") throw new Error(`${path}.mode must be allow`);
  if (rule.session_grant !== "never") throw new Error(`${path}.session_grant must be never`);
  const requiredFlags = stringList(
    Object.hasOwn(rule, "required_flags") ? rule.required_flags : [],
    `${path}.required_flags`,
    MAXIMUM_COMMAND_SET_OPTIONS,
    isCommandSetFlag,
  );
  const optionalFlags = stringList(
    Object.hasOwn(rule, "optional_flags") ? rule.optional_flags : [],
    `${path}.optional_flags`,
    MAXIMUM_COMMAND_SET_OPTIONS,
    isCommandSetFlag,
  );
  const options = table(Object.hasOwn(rule, "options") ? rule.options : {}, `${path}.options`);
  const names = [...requiredFlags, ...optionalFlags, ...Object.keys(options)];
  if (names.length > MAXIMUM_COMMAND_SET_OPTIONS)
    throw new Error(`${path} may define at most ${MAXIMUM_COMMAND_SET_OPTIONS} option spellings`);
  if (new Set(names).size !== names.length)
    throw new Error(`${path} must not repeat a flag or option spelling across fields`);
  const parsedOptions = Object.fromEntries(
    Object.entries(options).map(([name, values]) => {
      if (!isCommandSetFlag(name))
        throw new Error(`${path}.options contains an invalid option spelling`);
      const parsed = stringList(
        values,
        `${path}.options.${name}`,
        MAXIMUM_COMMAND_SET_VALUES,
        isCommandSetValue,
      );
      if (parsed.length === 0)
        throw new Error(`${path}.options.${name} must list at least one value`);
      return [name, parsed];
    }),
  );
  const operands = table(rule.operands, `${path}.operands`);
  keys(operands, ["min", "max"], [], `${path}.operands`);
  const min = operandCount(operands.min, `${path}.operands.min`);
  const max = operandCount(operands.max, `${path}.operands.max`);
  if (min > max) throw new Error(`${path}.operands.min must not exceed max`);
  return {
    command: rule.command,
    mode: "allow",
    sessionGrant: "never",
    requiredFlags,
    optionalFlags,
    options: parsedOptions,
    operands: { min, max },
  };
}

/** Parse only main-policy definitions. Broker/user/group overrides cannot define command sets. */
export function parseBashCommandSets(value: unknown, path: string): BashCommandSets {
  const rules = table(value, path);
  if (Object.keys(rules).length > MAXIMUM_COMMAND_SETS)
    throw new Error(`${path} may contain at most ${MAXIMUM_COMMAND_SETS} command sets`);
  if (Buffer.byteLength(JSON.stringify(rules)) > MAXIMUM_COMMAND_SETS_BYTES)
    throw new Error(`${path} exceeds ${MAXIMUM_COMMAND_SETS_BYTES} bytes`);
  return freezeBashCommandSets(
    Object.fromEntries(
      Object.entries(rules).map(([id, rule]) => {
        if (!isCommandSetId(id))
          throw new Error(`${path} contains an invalid command-set identifier`);
        return [id, parseRule(rule, `${path}.${id}`)];
      }),
    ),
  );
}
