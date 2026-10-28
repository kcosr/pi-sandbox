/**
 * Shared contract for model Bash command analysis. See specs/bash-command-analysis.md.
 * Classification only selects an approval policy; it never changes what executes.
 */

import type { BashCommandSets } from "./command-set-contracts.js";

export const COMMAND_CLASSES = Object.freeze(["known_read_only"] as const);
export type CommandClass = (typeof COMMAND_CLASSES)[number];

/** Result class bound into an approval request; `unclassified` uses the main policy. */
export type BashRequestClass = CommandClass | "configured_command" | "unclassified";

export const BASH_EXECUTION_BACKENDS = Object.freeze(["bubblewrap", "seatbelt", "direct"] as const);
export type BashExecutionBackend = (typeof BASH_EXECUTION_BACKENDS)[number];

/** The exact context in which the executor runs `[bash, "-c", command]`. */
export interface BashExecutionContext {
  readonly backend: BashExecutionBackend;
  /** Canonical launch directory: the initial working directory of every command. */
  readonly cwd: string;
  /** Exact environment passed to `bash -c` children, including the effective PATH. */
  readonly environment: Readonly<Record<string, string>>;
  /** Administrator-approved argument forms; never part of the reviewed read-only registry. */
  readonly commandSets?: BashCommandSets;
  /** Effective host paths replaced by Bubblewrap mounts or denied by Seatbelt. */
  readonly hiddenPaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
}

/** Filesystem queries used by context checks; injectable for tests. */
export interface ExecutableProbe {
  /** Whether `path` is a regular file the current process may execute. */
  isExecutableFile(path: string): Promise<boolean>;
  /** Canonical path with every symbolic link resolved. */
  realpath(path: string): Promise<string>;
}

export const BASH_ANALYSIS_ISSUE_CODES = Object.freeze([
  "input_too_large",
  "unsupported_character",
  "unsupported_syntax",
  "unsupported_redirection",
  "empty_command",
  "unknown_command",
  "unsupported_option",
  "unsupported_operand",
  "unsafe_environment",
  "untrusted_executable",
  "executable_not_found",
] as const);
export type BashAnalysisIssueCode = (typeof BASH_ANALYSIS_ISSUE_CODES)[number];

export interface BashAnalysisIssue {
  readonly code: BashAnalysisIssueCode;
  /** Bounded plain-English explanation safe to show the model and the approver. */
  readonly message: string;
  /** UTF-16 offset into the analyzed command, when one location is responsible. */
  readonly offset?: number;
}

/** Independent proof for one stage; all stages must qualify for automatic approval. */
export interface BashStageCoverage {
  readonly command: string;
  readonly knownReadOnly: boolean;
  readonly commandSets: readonly string[];
}

export type BashAnalysis =
  | {
      readonly commandClass: "known_read_only";
      readonly version: number;
      /** Command name of every stage, in source order. */
      readonly commands: readonly string[];
    }
  | {
      readonly commandClass: "configured_command";
      readonly version: number;
      readonly commands: readonly string[];
      readonly stages: readonly BashStageCoverage[];
    }
  | {
      readonly commandClass: "unclassified";
      readonly version: number;
      readonly issue: BashAnalysisIssue;
    };

export type KnownReadOnlyCommandKind = "shell_builtin" | "executable";

/** Registry description used by diagnostics and the generated documentation table. */
export interface KnownReadOnlyCommandDescription {
  readonly name: string;
  readonly kind: KnownReadOnlyCommandKind;
  /** Accepted options and operands, rendered for administrators. */
  readonly summary: string;
}

export interface BashCommandAnalyzer {
  readonly version: number;
  readonly commands: readonly KnownReadOnlyCommandDescription[];
  analyze(command: string): Promise<BashAnalysis>;
}

export type CreateBashCommandAnalyzer = (
  context: BashExecutionContext,
  probe?: ExecutableProbe,
) => BashCommandAnalyzer;
