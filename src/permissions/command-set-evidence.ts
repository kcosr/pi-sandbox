import {
  isCommandSetCommand,
  isCommandSetId,
  MAXIMUM_COMMAND_SETS,
} from "./bash/command-set-contracts.js";
import type { BashStageCoverage } from "./bash/contracts.js";

/** Configured approval evidence is independently bounded; larger invocations fall back to Bash policy. */
export function validCommandStages(value: unknown): value is readonly BashStageCoverage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 256 &&
    value.every((stage: unknown) => {
      if (typeof stage !== "object" || stage === null || Array.isArray(stage)) return false;
      const record = stage as Record<string, unknown>;
      return (
        Object.keys(record).sort().join(",") === "command,commandSets,knownReadOnly" &&
        typeof record.command === "string" &&
        (isCommandSetCommand(record.command) ||
          (record.knownReadOnly === true && /^[A-Za-z][A-Za-z0-9_]*$/.test(record.command))) &&
        typeof record.knownReadOnly === "boolean" &&
        Array.isArray(record.commandSets) &&
        record.commandSets.length <= MAXIMUM_COMMAND_SETS &&
        new Set(record.commandSets).size === record.commandSets.length &&
        record.commandSets.every((id: unknown) => typeof id === "string" && isCommandSetId(id)) &&
        (record.knownReadOnly || record.commandSets.length > 0)
      );
    }) &&
    (value as readonly BashStageCoverage[]).some((stage) => stage.commandSets.length > 0)
  );
}

export function freezeCommandStages(
  stages: readonly BashStageCoverage[],
): readonly BashStageCoverage[] {
  return Object.freeze(
    stages.map((stage) =>
      Object.freeze({
        command: stage.command,
        knownReadOnly: stage.knownReadOnly,
        commandSets: Object.freeze([...stage.commandSets]),
      }),
    ),
  );
}
