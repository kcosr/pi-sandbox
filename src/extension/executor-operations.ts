import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  formatDimensionNote,
  generateDiffString,
  generateUnifiedPatch,
  resizeImage,
  truncateHead,
  truncateLine,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type TruncationResult,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";

import type {
  SandboxCommandResult,
  SandboxExecutor,
  SandboxExecutionOptions,
  ToolCommandName,
} from "../sandbox/index.js";

const FILE_TRANSFER_LIMIT = 8 * 1024 * 1024;
const SEARCH_TRANSFER_LIMIT = 64 * 1024 * 1024;
const POSIX_PATH_MAX_BYTES = 4096;
const POSIX_NAME_MAX_BYTES = 255;
const SANDBOX_HOME = "/run/pi-sandbox/home";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
const mutationQueues = new Map<string, Promise<void>>();
const CANONICAL_COMMANDS: Readonly<Record<string, ToolCommandName>> = Object.freeze({
  "/bin/bash": "bash",
  "/bin/sh": "sh",
  "/bin/cat": "cat",
  "/bin/chmod": "chmod",
  "/bin/mkdir": "mkdir",
  "/bin/mv": "mv",
  "/bin/rm": "rm",
  "/bin/grep": "grep",
  "/usr/bin/file": "file",
  "/usr/bin/find": "find",
  "/usr/bin/awk": "awk",
  "/usr/bin/head": "head",
  "/usr/bin/sha256sum": "sha256sum",
  "/usr/bin/sort": "sort",
  "/usr/bin/tail": "tail",
  "/usr/bin/test": "test",
  "/usr/bin/wc": "wc",
});

export interface TextToolResult<TDetails = Readonly<Record<string, unknown>> | undefined> {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly details: TDetails;
}

export interface ReadToolResult {
  readonly content: (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  )[];
  readonly details: { readonly truncation?: TruncationResult } | undefined;
}

export function normalizeSandboxPath(cwd: string, path: string, home = SANDBOX_HOME): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = home;
  else if (normalized.startsWith("~/")) normalized = resolve(home, normalized.slice(2));
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

async function withMutationQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  const tail = previous.then(() => current);
  mutationQueues.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(path) === tail) mutationQueues.delete(path);
  }
}

function failure(result: SandboxCommandResult, operation: string): Error {
  const detail = result.stderr.toString("utf8").trim();
  return new Error(
    detail.length > 0
      ? `${operation}: ${detail}`
      : `${operation} exited with code ${String(result.exitCode)}`,
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function execute(
  executor: SandboxExecutor,
  argv: readonly [string, ...string[]],
  signal: AbortSignal | undefined,
  options: {
    readonly stdin?: string | Uint8Array;
    readonly maxOutputBytes?: number;
    readonly execution?: Omit<SandboxExecutionOptions, "signal">;
  } = {},
): Promise<SandboxCommandResult> {
  const portableArgv = resolvePortableArgv(executor, argv);
  return executor.execute(
    {
      argv: portableArgv,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      maxOutputBytes: options.maxOutputBytes ?? FILE_TRANSFER_LIMIT,
    },
    { ...(signal === undefined ? {} : { signal }), ...options.execution },
  );
}

function resolvePortableArgv(
  executor: SandboxExecutor,
  argv: readonly [string, ...string[]],
): readonly [string, ...string[]] {
  const commandName = CANONICAL_COMMANDS[argv[0]];
  const resolved = [...argv] as [string, ...string[]];
  if (commandName !== undefined) resolved[0] = executor.commands[commandName];
  if (commandName !== "bash" && commandName !== "sh") return resolved;
  const optionIndex = resolved.indexOf("-c");
  if (optionIndex < 0 || optionIndex + 1 >= resolved.length) return resolved;
  let source = resolved[optionIndex + 1]!;
  const translations = Object.entries(CANONICAL_COMMANDS).toSorted(
    ([left], [right]) => right.length - left.length,
  );
  for (const [canonical, name] of translations) {
    source = source.replaceAll(canonical, executor.commands[name]);
  }
  resolved[optionIndex + 1] = source;
  return resolved;
}

async function executeSuccess(
  executor: SandboxExecutor,
  argv: readonly [string, ...string[]],
  signal: AbortSignal | undefined,
  options: { readonly stdin?: string | Uint8Array; readonly maxOutputBytes?: number } = {},
): Promise<SandboxCommandResult> {
  const result = await execute(executor, argv, signal, options);
  if (result.exitCode !== 0) throw failure(result, argv[0]);
  return result;
}

async function detectImageMime(
  executor: SandboxExecutor,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const result = await executeSuccess(
    executor,
    ["/usr/bin/file", "--brief", "--mime-type", "--", path],
    signal,
    { maxOutputBytes: 4096 },
  );
  const mime = result.stdout.toString("utf8").trim();
  return mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/gif" ||
    mime === "image/webp" ||
    mime === "image/bmp"
    ? mime
    : undefined;
}

export async function executeRead(
  executor: SandboxExecutor,
  input: ReadToolInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<ReadToolResult> {
  const path = normalizeSandboxPath(cwd, input.path, executor.home);
  const offset = input.offset ?? 1;
  if (!Number.isSafeInteger(offset) || offset < 1)
    throw new Error("read offset must be a positive integer");
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
    throw new Error("read limit must be a positive integer");
  await executeSuccess(executor, ["/usr/bin/test", "-f", path, "-a", "-r", path], signal, {
    maxOutputBytes: 4096,
  });
  const mimeType = await detectImageMime(executor, path, signal);
  if (mimeType !== undefined) {
    const result = await executeSuccess(executor, ["/bin/cat", "--", path], signal, {
      maxOutputBytes: SEARCH_TRANSFER_LIMIT,
    });
    const resized = await resizeImage(result.stdout, mimeType);
    if (resized === null)
      return {
        content: [
          {
            type: "text",
            text: `Read image file [${mimeType}]\nImage could not be safely resized for the model.`,
          },
        ],
        details: undefined,
      };
    const dimensionNote = formatDimensionNote(resized);
    return {
      content: [
        {
          type: "text",
          text: `Read image file [${resized.mimeType}]${dimensionNote === undefined ? "" : `\n${dimensionNote}`}`,
        },
        { type: "image", data: resized.data, mimeType: resized.mimeType },
      ],
      details: undefined,
    };
  }
  const lineCount = input.limit ?? DEFAULT_MAX_LINES + 1;
  const result = await executeSuccess(
    executor,
    [
      "/bin/bash",
      "-o",
      "pipefail",
      "-c",
      'total=$(( $(/usr/bin/wc -l < "$1") + 1 )); first_bytes=$(/usr/bin/head -n "$2" -- "$1" | /usr/bin/tail -n 1 | /usr/bin/wc -c); printf "PI_SANDBOX_TOTAL_LINES=%s\\nPI_SANDBOX_FIRST_LINE_BYTES=%s\\n" "$total" "$first_bytes" >&2; set +e; /usr/bin/tail -n +"$2" -- "$1" | /usr/bin/head -n "$3" | /usr/bin/head -c "$4"; codes=("${PIPESTATUS[@]}"); for code in "${codes[@]}"; do if [ "$code" -ne 0 ] && [ "$code" -ne 141 ]; then exit "$code"; fi; done; exit 0',
      "pi-sandbox-read",
      path,
      String(offset),
      String(lineCount),
      String(DEFAULT_MAX_BYTES * 2),
    ],
    signal,
    { maxOutputBytes: DEFAULT_MAX_BYTES * 2 + 4096 },
  );
  const totalMatch = /^PI_SANDBOX_TOTAL_LINES=(\d+)$/mu.exec(result.stderr.toString("utf8"));
  const totalLines = totalMatch === null ? undefined : Number(totalMatch[1]);
  if (totalLines === undefined || !Number.isSafeInteger(totalLines))
    throw new Error("read could not determine the file line count");
  if (offset > totalLines)
    throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
  const firstLineBytesMatch = /^PI_SANDBOX_FIRST_LINE_BYTES=(\d+)$/mu.exec(
    result.stderr.toString("utf8"),
  );
  let selected = result.stdout.toString("utf8");
  if (selected.endsWith("\n") && offset + lineCount - 1 < totalLines)
    selected = selected.slice(0, -1);
  const truncation = truncateHead(selected, {
    maxLines: input.limit ?? DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const startLine = offset;
  const endLine = startLine + truncation.outputLines - 1;
  let text: string;
  if (truncation.firstLineExceedsLimit) {
    const firstLineBytes = Number(firstLineBytesMatch?.[1]);
    const size = Number.isSafeInteger(firstLineBytes) ? formatSize(firstLineBytes) : "over 50KB";
    text = `[Line ${startLine} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' ${input.path} | head -c ${DEFAULT_MAX_BYTES}]`;
  } else if (truncation.truncated) {
    text = truncation.content;
    const byteNote =
      truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}${byteNote}. Use offset=${endLine + 1} to continue.]`;
  } else if (input.limit !== undefined && endLine < totalLines) {
    text = `${truncation.content}\n\n[${totalLines - endLine} more lines in file. Use offset=${endLine + 1} to continue.]`;
  } else text = truncation.content;
  return {
    content: [{ type: "text", text }],
    details: truncation.truncated ? { truncation } : undefined,
  };
}

export async function executeWrite(
  executor: SandboxExecutor,
  input: WriteToolInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<TextToolResult<undefined>> {
  const path = normalizeSandboxPath(cwd, input.path, executor.home);
  return withMutationQueue(path, async () => {
    const tempPath = temporarySibling(path, "write");
    try {
      await executeSuccess(
        executor,
        [
          "/bin/sh",
          "-c",
          '/bin/mkdir -p -- "$1"; trap \'/bin/rm -f -- "$3"\' EXIT HUP INT TERM; (set -C; : > "$3") || exit 74; /bin/cat > "$3" || exit; if [ -e "$2" ]; then /bin/chmod --reference="$2" -- "$3" || exit; fi; /bin/mv -fT -- "$3" "$2"; trap - EXIT HUP INT TERM',
          "pi-sandbox-write",
          dirname(path),
          path,
          tempPath,
        ],
        signal,
        { stdin: input.content, maxOutputBytes: 4096 },
      );
    } catch (error) {
      await cleanupTemp(executor, tempPath);
      if (isAborted(signal))
        throw new Error("Operation aborted; atomic commit status is unknown", { cause: error });
      throw error;
    }
    return {
      content: [
        { type: "text", text: `Successfully wrote ${input.content.length} bytes to ${input.path}` },
      ],
      details: undefined,
    };
  });
}

function normalizeNewlines(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function applyEdits(
  original: string,
  edits: EditToolInput["edits"],
  path: string,
): { readonly updated: string; readonly baseContent: string; readonly newContent: string } {
  if (edits.length === 0) throw new Error("Edit tool input is invalid: edits must not be empty");
  const hadBom = original.startsWith("\uFEFF");
  const withoutBom = hadBom ? original.slice(1) : original;
  const normalized = normalizeNewlines(withoutBom);
  const replacements = edits.map((edit, index) => {
    const oldText = normalizeNewlines(edit.oldText);
    const newText = normalizeNewlines(edit.newText);
    if (oldText.length === 0) throw new Error(`Edit ${index + 1} for ${path} has empty oldText`);
    const start = normalized.indexOf(oldText);
    if (start < 0) throw new Error(`Could not find oldText for edit ${index + 1} in ${path}`);
    if (normalized.indexOf(oldText, start + 1) >= 0)
      throw new Error(`oldText for edit ${index + 1} is not unique in ${path}`);
    return { start, end: start + oldText.length, newText };
  });
  replacements.sort((left, right) => left.start - right.start);
  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1];
    const current = replacements[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end)
      throw new Error(`Edits overlap in ${path}`);
  }
  let output = normalized;
  for (const replacement of replacements.toReversed())
    output = `${output.slice(0, replacement.start)}${replacement.newText}${output.slice(replacement.end)}`;
  const usesCrlf = withoutBom.includes("\r\n");
  const restored = usesCrlf ? output.replaceAll("\n", "\r\n") : output;
  return {
    updated: hadBom ? `\uFEFF${restored}` : restored,
    baseContent: normalized,
    newContent: output,
  };
}

export async function executeEdit(
  executor: SandboxExecutor,
  input: EditToolInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<TextToolResult<EditToolDetails>> {
  const path = normalizeSandboxPath(cwd, input.path, executor.home);
  return withMutationQueue(path, async () => {
    const read = await executeSuccess(executor, ["/bin/cat", "--", path], signal);
    if (signal?.aborted === true) throw new Error("Operation aborted");
    const applied = applyEdits(read.stdout.toString("utf8"), input.edits, input.path);
    const expectedHash = createHash("sha256").update(read.stdout).digest("hex");
    const tempPath = temporarySibling(path, "edit");
    try {
      await executeSuccess(
        executor,
        [
          "/bin/sh",
          "-c",
          'trap \'/bin/rm -f -- "$3"\' EXIT HUP INT TERM; (set -C; : > "$3") || exit 74; /bin/cat > "$3" || exit; /bin/chmod --reference="$1" -- "$3" || exit; actual=$(/usr/bin/sha256sum -- "$1"); actual=${actual%% *}; [ "$actual" = "$2" ] || { echo "file changed during edit" >&2; exit 73; }; /bin/mv -fT -- "$3" "$1"; trap - EXIT HUP INT TERM',
          "pi-sandbox-edit",
          path,
          expectedHash,
          tempPath,
        ],
        signal,
        { stdin: applied.updated, maxOutputBytes: 4096 },
      );
    } catch (error) {
      await cleanupTemp(executor, tempPath);
      if (isAborted(signal))
        throw new Error("Operation aborted; atomic commit status is unknown", { cause: error });
      throw error;
    }
    const diff = generateDiffString(applied.baseContent, applied.newContent);
    return {
      content: [
        {
          type: "text",
          text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.`,
        },
      ],
      details: {
        diff: diff.diff,
        patch: generateUnifiedPatch(input.path, applied.baseContent, applied.newContent),
        ...(diff.firstChangedLine === undefined ? {} : { firstChangedLine: diff.firstChangedLine }),
      },
    };
  });
}

function temporarySibling(path: string, operation: string): string {
  return resolve(dirname(path), `.${basename(path)}.pi-sandbox-${operation}-${randomUUID()}`);
}

async function cleanupTemp(executor: SandboxExecutor, path: string): Promise<void> {
  await executor
    .execute({ argv: [executor.commands.rm, "-f", "--", path], maxOutputBytes: 4096 })
    .catch(() => undefined);
}

export async function executeLs(
  executor: SandboxExecutor,
  input: LsToolInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<TextToolResult> {
  const path = normalizeSandboxPath(cwd, input.path ?? ".", executor.home);
  const limit = input.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("ls limit must be a positive integer");
  const result = await executeSuccess(
    executor,
    [
      "/bin/bash",
      "-o",
      "pipefail",
      "-c",
      '[ -d "$1" ] || { echo "Not a directory: $1" >&2; exit 20; }; set +e; /usr/bin/find -H "$1" -mindepth 1 -maxdepth 1 -printf "%f\\t%y\\0" | /usr/bin/sort -z -f | /usr/bin/head -z -n "$2"; codes=("${PIPESTATUS[@]}"); for code in "${codes[@]}"; do if [ "$code" -ne 0 ] && [ "$code" -ne 141 ]; then exit "$code"; fi; done; exit 0',
      "pi-sandbox-ls",
      path,
      String(limit + 1),
    ],
    signal,
    {
      maxOutputBytes: Math.min(SEARCH_TRANSFER_LIMIT, (limit + 1) * (POSIX_NAME_MAX_BYTES + 3)),
    },
  );
  const records = result.stdout.toString("utf8").split("\0");
  const entries: string[] = [];
  for (const record of records) {
    const separator = record.lastIndexOf("\t");
    if (separator < 0) continue;
    const name = record.slice(0, separator);
    const type = record.slice(separator + 1);
    if (name.length > 0) entries.push(`${name}${type === "d" ? "/" : ""}`);
  }
  const entryLimitReached = entries.length > limit;
  const limited = entries.slice(0, limit);
  const truncation = truncateHead(limited.length === 0 ? "(empty directory)" : limited.join("\n"));
  const output = truncation.content;
  const details: Record<string, unknown> = {};
  if (entryLimitReached) details.entryLimitReached = limit;
  if (truncation.truncated) details.truncation = truncation;
  return {
    content: [
      {
        type: "text",
        text: entryLimitReached ? `${output}\n\n[${limit} entries limit reached]` : output,
      },
    ],
    details: Object.keys(details).length === 0 ? undefined : details,
  };
}

export async function executeFind(
  executor: SandboxExecutor,
  input: FindToolInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<TextToolResult> {
  const path = normalizeSandboxPath(cwd, input.path ?? ".", executor.home);
  const limit = input.limit ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("find limit must be a positive integer");
  const result = await executeSuccess(
    executor,
    [
      "/bin/bash",
      "-o",
      "pipefail",
      "-c",
      'set +e; if [ "$3" = base ]; then /usr/bin/find -H "$1" -type f -not -path "*/.git/*" -not -path "*/node_modules/*" -name "$4" -printf "%p\\0"; else /usr/bin/find -H "$1" -type f -not -path "*/.git/*" -not -path "*/node_modules/*" -path "$1/$4" -printf "%p\\0"; fi | /usr/bin/head -z -n "$2"; codes=("${PIPESTATUS[@]}"); for code in "${codes[@]}"; do if [ "$code" -ne 0 ] && [ "$code" -ne 141 ]; then exit "$code"; fi; done; exit 0',
      "pi-sandbox-find",
      path,
      String(limit + 1),
      input.pattern.includes("/") ? "path" : "base",
      input.pattern,
    ],
    signal,
    { maxOutputBytes: Math.min(SEARCH_TRANSFER_LIMIT, (limit + 1) * (POSIX_PATH_MAX_BYTES + 1)) },
  );
  const candidates = result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => relative(path, entry).split(sep).join("/"));
  const resultLimitReached = candidates.length > limit;
  const entries = candidates.slice(0, limit);
  const truncation = truncateHead(entries.join("\n"));
  const details: Record<string, unknown> = {};
  if (resultLimitReached) details.resultLimitReached = limit;
  if (truncation.truncated) details.truncation = truncation;
  return {
    content: [
      {
        type: "text",
        text: entries.length === 0 ? "No files found matching pattern" : truncation.content,
      },
    ],
    details: Object.keys(details).length === 0 ? undefined : details,
  };
}

export async function executeGrep(
  executor: SandboxExecutor,
  input: GrepToolInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<TextToolResult> {
  const path = normalizeSandboxPath(cwd, input.path ?? ".", executor.home);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("grep limit must be a positive integer");
  const argv: [string, ...string[]] = ["/bin/grep", "-R", "-n", "-I", "--exclude-dir=.git"];
  if (input.ignoreCase === true) argv.push("-i");
  if (input.literal === true) argv.push("-F");
  if (input.context !== undefined) argv.push("-C", String(input.context));
  if (input.glob !== undefined) argv.push(`--include=${input.glob}`);
  argv.push("--", input.pattern, path);
  const result = await execute(
    executor,
    [
      "/bin/bash",
      "-o",
      "pipefail",
      "-c",
      `set +e; /bin/grep "\${@:3}" | /usr/bin/awk -v limit="$1" 'BEGIN { matches=0 } /:[0-9]+:/ { matches++; if (matches > limit) { print "PI_SANDBOX_MATCH_LIMIT=1" > "/dev/stderr"; exit 0 } } { if (length($0) > 10000) { print substr($0,1,10000) "... [line truncated]"; print "PI_SANDBOX_LINES_TRUNCATED=1" > "/dev/stderr" } else print }' | /usr/bin/head -c "$2"; codes=("\${PIPESTATUS[@]}"); grep_code=\${codes[0]}; for code in "\${codes[@]:1}"; do if [ "$code" -ne 0 ] && [ "$code" -ne 141 ]; then exit "$code"; fi; done; if [ "$grep_code" -ne 0 ] && [ "$grep_code" -ne 1 ] && [ "$grep_code" -ne 141 ]; then exit "$grep_code"; fi; exit 0`,
      "pi-sandbox-grep",
      String(limit),
      String(DEFAULT_MAX_BYTES * 2),
      ...argv.slice(1),
    ],
    signal,
    { maxOutputBytes: DEFAULT_MAX_BYTES * 2 + 4096 },
  );
  if (result.exitCode !== 0) throw failure(result, "grep");
  const lines = result.stdout.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const kept: string[] = [];
  let matchCount = 0;
  let matchLimitReached = result.stderr.toString("utf8").includes("PI_SANDBOX_MATCH_LIMIT=1");
  for (const line of lines) {
    const isMatch = /:\d+:/.test(line);
    if (isMatch) {
      matchCount += 1;
      if (matchCount > limit) {
        matchLimitReached = true;
        break;
      }
    }
    kept.push(line);
  }
  const lineResults = kept.map((line) => truncateLine(line));
  const boundedLines = lineResults.map((line) => line.text);
  const truncation = truncateHead(boundedLines.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const output = truncation.content;
  const details: Record<string, unknown> = {};
  if (matchLimitReached) details.matchLimitReached = limit;
  if (
    lineResults.some((line) => line.wasTruncated) ||
    result.stderr.toString("utf8").includes("PI_SANDBOX_LINES_TRUNCATED=1")
  )
    details.linesTruncated = true;
  if (truncation.truncated) details.truncation = truncation;
  return {
    content: [{ type: "text", text: output.length === 0 ? "No matches found" : output }],
    details: Object.keys(details).length === 0 ? undefined : details,
  };
}
