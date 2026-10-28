import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";

import type {
  BashAnalysis,
  BashAnalysisIssue,
  BashAnalysisIssueCode,
  CreateBashCommandAnalyzer,
  ExecutableProbe,
} from "./contracts.js";
import {
  freezeBashCommandSets,
  isCommandSetCommand,
  isCommandSetAbsolutePath,
} from "./command-set-contracts.js";
import { matchCommandSet } from "./command-set-matcher.js";
import {
  KNOWN_READ_ONLY_COMMANDS,
  KNOWN_READ_ONLY_VERSION,
  knownReadOnlyProfile,
  type KnownReadOnlyProfile,
} from "./registry.js";
import { excerpt, parseBashCommand, type BashSimpleCommand } from "./syntax.js";

/** Bash command analyzer for the known read-only class (specs/bash-command-analysis.md Section 6). */

type Problem = readonly [BashAnalysisIssueCode, string];

interface AcceptedStage {
  readonly command: BashSimpleCommand;
  readonly name: string;
  readonly profile: KnownReadOnlyProfile | undefined;
  readonly environment: KnownReadOnlyProfile["environment"];
  readonly optionNames: ReadonlySet<string>;
  readonly knownReadOnly: boolean;
  readonly commandSets: readonly string[];
}

/** Variables Bash imports at startup that can run code or change parsing and lookup. */
const UNSAFE_SHELL_VARIABLES: readonly (readonly [string, string])[] = [
  ["BASH_ENV", "Bash startup code could redefine commands"],
  ["SHELLOPTS", "imported shell options change how commands run"],
  ["BASHOPTS", "imported shell options change how commands run"],
  ["EXECIGNORE", "it changes executable lookup"],
];

export const defaultExecutableProbe: ExecutableProbe = Object.freeze({
  async isExecutableFile(path: string): Promise<boolean> {
    try {
      if (!(await stat(path)).isFile()) {
        return false;
      }
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  realpath: (path: string): Promise<string> => realpath(path),
});

function issue(code: BashAnalysisIssueCode, message: string, offset?: number): BashAnalysisIssue {
  return Object.freeze(offset === undefined ? { code, message } : { code, message, offset });
}

function isInside(path: string, directory: string): boolean {
  return directory === "/" || path === directory || path.startsWith(`${directory}/`);
}

function exportedFunctionNames(environment: Readonly<Record<string, string>>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    const match = /^(?:BASH_FUNC_(.+)|__BASH_FUNC<(.+)>)(?:%%|\(\))$/.exec(key);
    const name = match?.[1] ?? match?.[2];
    if (name !== undefined) {
      names.add(name);
    } else if (value.startsWith("()")) {
      names.add(key);
    }
  }
  return names;
}

/** Dynamic-loader and C-library hooks that can make any program load code or write files. */
function loaderIssue(environment: Readonly<Record<string, string>>): BashAnalysisIssue | undefined {
  const variable = Object.keys(environment)
    .filter(
      (name) =>
        (name.startsWith("LD_") || name.startsWith("DYLD_") || name === "GCONV_PATH") &&
        environment[name] !== "",
    )
    .sort()[0];
  if (variable === undefined) {
    return undefined;
  }
  const name = /^[A-Za-z0-9_]{1,40}$/.test(variable) ? `"${variable}"` : "a loader variable";
  return issue(
    "unsafe_environment",
    `${name} is set; loader and C library variables can load code or write files`,
  );
}

function localeIssue(
  command: string,
  environment: Readonly<Record<string, string>>,
): BashAnalysisIssue | undefined {
  const nonAscii = command.search(/[^\t\n -~]/);
  if (nonAscii < 0) {
    return undefined;
  }
  const locale = [environment.LC_ALL, environment.LC_CTYPE, environment.LANG].find(
    (value) => value !== undefined && value !== "",
  );
  if (locale === undefined || /^(?:C|POSIX)$/.test(locale) || /utf-?8/i.test(locale)) {
    return undefined;
  }
  return issue(
    "unsafe_environment",
    "non-ASCII text requires a UTF-8 or C locale in the execution environment",
    nonAscii,
  );
}

export const createBashCommandAnalyzer: CreateBashCommandAnalyzer = (
  context,
  probe = defaultExecutableProbe,
) => {
  const cwd = context.cwd;
  const environment: Readonly<Record<string, string>> = Object.freeze({ ...context.environment });
  const unavailablePaths = Object.freeze(
    context.backend === "bubblewrap"
      ? ["/tmp", "/run", "/proc", "/sys", "/dev", ...(context.hiddenPaths ?? [])]
      : context.backend === "seatbelt"
        ? [...(context.deniedPaths ?? [])]
        : [],
  );
  const functions = exportedFunctionNames(environment);
  const loader = loaderIssue(environment);
  const commandSets = Object.entries(freezeBashCommandSets(context.commandSets ?? {})).filter(
    ([, rule]) =>
      rule.commands.length > 0 &&
      rule.commands.every((name) => isCommandSetCommand(name) || isCommandSetAbsolutePath(name)),
  );

  function unavailable(path: string): boolean {
    return unavailablePaths.some((directory) => isInside(path, directory));
  }

  async function isExecutable(path: string): Promise<boolean> {
    try {
      return await probe.isExecutableFile(path);
    } catch {
      return false;
    }
  }

  async function canonical(path: string, depth = 0): Promise<string> {
    try {
      return await probe.realpath(path);
    } catch {
      const parent = posix.dirname(path);
      if (parent === path || depth > 64) {
        return posix.normalize(path);
      }
      return posix.join(await canonical(parent, depth + 1), posix.basename(path));
    }
  }

  /** Bash PATH search for `name`; the outcome is shared by every stage of one analysis. */
  async function resolveExecutable(name: string): Promise<Problem | undefined> {
    const path = environment.PATH;
    if (path === undefined || path === "") {
      return ["unsafe_environment", "PATH is missing or empty in the execution environment"];
    }
    for (const entry of path.split(":")) {
      if (!entry.startsWith("/")) {
        return [
          "unsafe_environment",
          `PATH has an empty or relative entry before ${excerpt(name, 24)} is found`,
        ];
      }
      const resolvedEntry = await canonical(entry);
      if (isInside(posix.normalize(entry), cwd) || isInside(resolvedEntry, cwd)) {
        return [
          "unsafe_environment",
          `PATH has a directory inside the launch directory before ${excerpt(name, 24)} is found`,
        ];
      }
      if (unavailable(posix.normalize(entry)) || unavailable(resolvedEntry))
        return [
          "untrusted_executable",
          "PATH enters a private, hidden or denied path before the command is found",
        ];
      const candidate = entry.endsWith("/") ? `${entry}${name}` : `${entry}/${name}`;
      if (await isExecutable(candidate)) {
        let resolved: string;
        try {
          resolved = await probe.realpath(candidate);
        } catch {
          return ["untrusted_executable", `${excerpt(name, 24)} could not be resolved on PATH`];
        }
        if (unavailable(candidate) || unavailable(resolved))
          return [
            "untrusted_executable",
            "PATH executable resolves into a private, hidden or denied path",
          ];
        return isInside(resolved, cwd)
          ? ["untrusted_executable", `${excerpt(name, 24)} resolves inside the launch directory`]
          : undefined;
      }
    }
    return ["executable_not_found", `${excerpt(name, 24)} was not found on PATH`];
  }

  /** Absolute alternatives use their literal spelling; realpath never creates aliases. */
  async function resolveAbsoluteExecutable(name: string): Promise<Problem | undefined> {
    if (unavailable(name))
      return [
        "untrusted_executable",
        "configured executable is in a private, hidden or denied path",
      ];
    if (isInside(name, cwd))
      return ["untrusted_executable", "configured executable is inside the launch directory"];
    let parent: string;
    try {
      parent = await probe.realpath(posix.dirname(name));
    } catch {
      return ["untrusted_executable", "configured executable directory could not be resolved"];
    }
    if (isInside(parent, cwd))
      return [
        "untrusted_executable",
        "configured executable directory resolves inside the launch directory",
      ];
    if (unavailable(parent))
      return [
        "untrusted_executable",
        "configured executable directory resolves into a private, hidden or denied path",
      ];
    if (!(await isExecutable(name)))
      return ["executable_not_found", "configured executable is not an executable regular file"];
    try {
      const resolved = await probe.realpath(name);
      if (unavailable(resolved))
        return [
          "untrusted_executable",
          "configured executable resolves into a private, hidden or denied path",
        ];
      return isInside(resolved, cwd)
        ? ["untrusted_executable", "configured executable resolves inside the launch directory"]
        : undefined;
    } catch {
      return ["untrusted_executable", "configured executable could not be resolved"];
    }
  }

  async function stageIssue(
    stage: AcceptedStage,
    resolutions: Map<string, Promise<Problem | undefined>>,
  ): Promise<BashAnalysisIssue | undefined> {
    const { name, command, profile } = stage;
    if (functions.has(name)) {
      return issue(
        "unsafe_environment",
        `an exported shell function overrides ${excerpt(name, 24)}`,
        command.offset,
      );
    }
    if (profile?.kind !== "shell_builtin") {
      if (functions.has("command_not_found_handle")) {
        return issue(
          "unsafe_environment",
          "an exported command_not_found_handle function could run instead",
          command.offset,
        );
      }
      let resolution = resolutions.get(name);
      if (resolution === undefined) {
        resolution = name.startsWith("/")
          ? resolveAbsoluteExecutable(name)
          : resolveExecutable(name);
        resolutions.set(name, resolution);
      }
      const problem = await resolution;
      if (problem !== undefined) {
        return issue(problem[0], problem[1], command.offset);
      }
    }
    for (const dependency of stage.environment ?? []) {
      const value = environment[dependency.variable];
      if (
        value !== undefined &&
        value !== "" &&
        (dependency.unlessOption === undefined || !stage.optionNames.has(dependency.unlessOption))
      ) {
        return issue(
          "unsafe_environment",
          `${dependency.variable} is set for ${name}` +
            (dependency.unlessOption === undefined ? "" : ` (add ${dependency.unlessOption})`),
          command.offset,
        );
      }
    }
    return undefined;
  }

  async function analyze(command: string): Promise<BashAnalysis> {
    const stages: AcceptedStage[] = [];
    const parsed = parseBashCommand(command, {
      commandName(word) {
        const configured = commandSets.some(([, rule]) => rule.commands.includes(word.value));
        if (word.value.includes("/")) {
          return isCommandSetAbsolutePath(word.value) && configured
            ? undefined
            : issue(
                "unknown_command",
                "command path is not an explicitly configured alternative",
                word.offset,
              );
        }
        return knownReadOnlyProfile(word.value) === undefined && !configured
          ? issue(
              "unknown_command",
              `${excerpt(word.value, 32)} is not a known read-only command`,
              word.offset,
            )
          : undefined;
      },
      command(simple) {
        const commandWord = simple.words[0];
        if (commandWord?.kind !== "literal") {
          return issue("unknown_command", "a literal command name is required", simple.offset);
        }
        const name = commandWord.value;
        const profile = name.startsWith("/") ? undefined : knownReadOnlyProfile(name);
        const arguments_ = simple.words.slice(1);
        if (name !== "cd") {
          const symbolic = arguments_.find((word) => word.kind !== "literal");
          if (symbolic !== undefined) {
            return issue(
              "unsupported_operand",
              "home-relative paths are supported only as the directory operand of cd",
              symbolic.offset,
            );
          }
        }
        const checked = profile?.check(arguments_);
        const matching: string[] = [];
        const optionNames = new Set(checked?.ok ? checked.optionNames : []);
        let configuredIssue: BashAnalysisIssue | undefined;
        for (const [id, rule] of commandSets) {
          if (!rule.commands.includes(name)) continue;
          const candidate = matchCommandSet(rule, arguments_);
          if (candidate.ok) {
            matching.push(id);
            for (const option of candidate.optionNames) optionNames.add(option);
          } else configuredIssue ??= candidate.issue;
        }
        if (!checked?.ok && matching.length === 0)
          return (
            checked?.issue ??
            configuredIssue ??
            issue("unknown_command", `${excerpt(name, 32)} has no matching command rule`)
          );
        stages.push({
          command: simple,
          name,
          profile,
          environment: knownReadOnlyProfile(posix.basename(name))?.environment ?? [],
          optionNames,
          knownReadOnly: checked?.ok === true,
          commandSets: Object.freeze(matching),
        });
        return undefined;
      },
    });

    let found: BashAnalysisIssue | undefined;
    for (const [variable, reason] of UNSAFE_SHELL_VARIABLES) {
      const value = environment[variable];
      if (value !== undefined && value !== "") {
        found = issue("unsafe_environment", `${variable} is set; ${reason}`);
        break;
      }
    }
    found ??= loader;
    found ??= localeIssue(command, environment);
    const resolutions = new Map<string, Promise<Problem | undefined>>();
    for (const stage of stages) {
      if (found !== undefined) {
        break;
      }
      found = await stageIssue(stage, resolutions);
    }
    if (found === undefined && !parsed.ok) {
      found = parsed.issue;
    }
    if (found !== undefined) {
      return Object.freeze({
        commandClass: "unclassified",
        version: KNOWN_READ_ONLY_VERSION,
        issue: found,
      });
    }
    if (stages.some((stage) => stage.commandSets.length > 0)) {
      return Object.freeze({
        commandClass: "configured_command",
        version: KNOWN_READ_ONLY_VERSION,
        commands: Object.freeze(stages.map((stage) => stage.name)),
        stages: Object.freeze(
          stages.map((stage) =>
            Object.freeze({
              command: stage.name,
              knownReadOnly: stage.knownReadOnly,
              commandSets: stage.commandSets,
            }),
          ),
        ),
      });
    }
    return Object.freeze({
      commandClass: "known_read_only",
      version: KNOWN_READ_ONLY_VERSION,
      commands: Object.freeze(stages.map((stage) => stage.name)),
    });
  }

  return Object.freeze({
    version: KNOWN_READ_ONLY_VERSION,
    commands: KNOWN_READ_ONLY_COMMANDS,
    analyze,
  });
};
