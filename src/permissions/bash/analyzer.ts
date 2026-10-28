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
  readonly profile: KnownReadOnlyProfile;
  readonly optionNames: ReadonlySet<string>;
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
  const functions = exportedFunctionNames(environment);
  const loader = loaderIssue(environment);

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
      if (isInside(posix.normalize(entry), cwd) || isInside(await canonical(entry), cwd)) {
        return [
          "unsafe_environment",
          `PATH has a directory inside the launch directory before ${excerpt(name, 24)} is found`,
        ];
      }
      const candidate = entry.endsWith("/") ? `${entry}${name}` : `${entry}/${name}`;
      if (await isExecutable(candidate)) {
        let resolved: string;
        try {
          resolved = await probe.realpath(candidate);
        } catch {
          return ["untrusted_executable", `${excerpt(name, 24)} could not be resolved on PATH`];
        }
        return isInside(resolved, cwd)
          ? ["untrusted_executable", `${excerpt(name, 24)} resolves inside the launch directory`]
          : undefined;
      }
    }
    return ["executable_not_found", `${excerpt(name, 24)} was not found on PATH`];
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
    if (profile.kind === "executable") {
      if (functions.has("command_not_found_handle")) {
        return issue(
          "unsafe_environment",
          "an exported command_not_found_handle function could run instead",
          command.offset,
        );
      }
      let resolution = resolutions.get(name);
      if (resolution === undefined) {
        resolution = resolveExecutable(name);
        resolutions.set(name, resolution);
      }
      const problem = await resolution;
      if (problem !== undefined) {
        return issue(problem[0], problem[1], command.offset);
      }
    }
    for (const dependency of profile.environment) {
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
        if (word.value.includes("/")) {
          return issue(
            "unknown_command",
            "commands given by path are not known read-only commands",
            word.offset,
          );
        }
        return knownReadOnlyProfile(word.value) === undefined
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
        const profile = knownReadOnlyProfile(name);
        if (profile === undefined) {
          return issue("unknown_command", `${excerpt(name, 32)} is not a known read-only command`);
        }
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
        const checked = profile.check(arguments_);
        if (!checked.ok) {
          return checked.issue;
        }
        stages.push({ command: simple, name, profile, optionNames: checked.optionNames });
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
