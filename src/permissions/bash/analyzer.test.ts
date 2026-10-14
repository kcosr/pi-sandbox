import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBashCommandAnalyzer } from "./analyzer.js";
import type { BashAnalysis, BashExecutionContext, ExecutableProbe } from "./contracts.js";
import { KNOWN_READ_ONLY_COMMANDS, KNOWN_READ_ONLY_VERSION } from "./registry.js";

const CWD = "/work/project";
const EXECUTABLES = KNOWN_READ_ONLY_COMMANDS.filter((command) => command.kind === "executable").map(
  (command) => command.name,
);

interface FakeProbe extends ExecutableProbe {
  readonly calls: string[];
}

function fakeProbe(
  executables: Readonly<Record<string, string>> = Object.fromEntries(
    EXECUTABLES.map((name) => [`/usr/bin/${name}`, `/usr/bin/${name}`]),
  ),
  directories: Readonly<Record<string, string>> = {},
): FakeProbe {
  const calls: string[] = [];
  return {
    calls,
    isExecutableFile(path) {
      calls.push(`exec:${path}`);
      return Promise.resolve(Object.hasOwn(executables, path));
    },
    realpath(path) {
      calls.push(`real:${path}`);
      const resolved = executables[path] ?? directories[path];
      return resolved === undefined
        ? Promise.reject(new Error(`ENOENT ${path}`))
        : Promise.resolve(resolved);
    },
  };
}

function context(
  environment: Readonly<Record<string, string>> = { PATH: "/usr/bin:/bin" },
): BashExecutionContext {
  return { backend: "bubblewrap", cwd: CWD, environment };
}

async function analyze(
  command: string,
  environment?: Readonly<Record<string, string>>,
  probe: ExecutableProbe = fakeProbe(),
): Promise<BashAnalysis> {
  return createBashCommandAnalyzer(context(environment), probe).analyze(command);
}

async function issueOf(
  command: string,
  environment?: Readonly<Record<string, string>>,
  probe?: ExecutableProbe,
): Promise<{ code: string; offset?: number; message: string }> {
  const result = await analyze(command, environment, probe);
  if (result.commandClass !== "unclassified") {
    throw new Error(`expected ${JSON.stringify(command)} to be unclassified`);
  }
  return result.issue;
}

describe("Bash command analyzer classification", () => {
  it("exposes the registry version and command descriptions", () => {
    const analyzer = createBashCommandAnalyzer(context(), fakeProbe());
    expect(analyzer.version).toBe(KNOWN_READ_ONLY_VERSION);
    expect(analyzer.commands).toBe(KNOWN_READ_ONLY_COMMANDS);
    expect(Object.isFrozen(analyzer)).toBe(true);
  });

  it.each([
    ["ls", ["ls"]],
    ["ls -la | grep -i x | head -3", ["ls", "grep", "head"]],
    ["cd src && pwd; echo hi || false\ntrue", ["cd", "pwd", "echo", "false", "true"]],
    ["cat <in 2>/dev/null | sort -u >/dev/null", ["cat", "sort"]],
    ["rg -n 'TODO|FIXME' src 2>&1 | wc -l", ["rg", "wc"]],
    ["find . -name '*.ts' -print0 &>/dev/null", ["find"]],
    ["sed -n '1,20p' README.md", ["sed"]],
    ["echo 'rm -rf /; $(id)' \"a b\"", ["echo"]],
    ["ls '|' ';' '&&' '>x'", ["ls"]],
    ["tail -n +5 x | uniq -c | sort -rn", ["tail", "uniq", "sort"]],
    [
      "diff -u a b; du -sh .; stat -c %s x; readlink -f x; realpath x",
      ["diff", "du", "stat", "readlink", "realpath"],
    ],
    [
      "basename a/b; dirname a/b; cut -d: -f1 x; nl x; tr a b <x",
      ["basename", "dirname", "cut", "nl", "tr"],
    ],
  ])("classifies %j as known read-only", async (command, commands) => {
    expect(await analyze(command)).toEqual({
      commandClass: "known_read_only",
      version: KNOWN_READ_ONLY_VERSION,
      commands,
    });
  });

  const bypasses: readonly string[] = [
    "rg --pre{=,=sh} x",
    "rg --pre=sh x",
    "rg --pre sh x",
    "rg -z x",
    "rg --search-zip x",
    "rg --hostname-bin=sh x",
    "find . -de\\lete",
    "find . -delete",
    "find . -exec rm '{}' ';'",
    "find . -exec rm {} ;",
    "find . -fprint out",
    "ls \\\n-la",
    "ls\\\n",
    "$'\\x6c\\x73'",
    "echo $'\\x6c\\x73'",
    "echo ${x@P}",
    "echo $(( $(id) ))",
    "echo $HOME",
    'echo "$(id)"',
    "echo `id`",
    "PAGER=curl ls",
    "LD_PRELOAD=./x.so ls",
    "sort --compress=sh x",
    "sort --compress-program=sh x",
    "sort -o out x",
    "sort -uo out x",
    "sort x -o out",
    "sort -T /tmp x",
    "uniq a b",
    "uniq a -c",
    "sed -n 1e x",
    "sed -n 1w x",
    "sed 's/a/b/' x",
    "cat </dev/tcp/1.2.3.4/80",
    "cat 0</dev/udp/1.2.3.4/53",
    "ls &>>/dev/null",
    "ls &",
    "ls & echo hi",
    "ls | grep x | head -3\nrm -rf build",
    "ls; rm -rf build",
    "ls && rm x",
    "ls || rm x",
    "true > x > /dev/null",
    "> x",
    ">/dev/null",
    "ls > out",
    "ls 2> err",
    "ls >/dev/null 2>err",
    "ls 2>&3",
    "ls 3>/dev/null",
    "ls >&file",
    "ls >&-",
    "ls <>x",
    "ls >|/dev/null",
    "./ls",
    "/bin/ls",
    "../bin/ls",
    "l\\s",
    "ls #c",
    "ls ~",
    "ls ~root",
    "ls *",
    "ls *.ts",
    "ls ?",
    "ls [ab]",
    "{ls,-la}",
    "ls a{b,c}",
    "(ls)",
    "{ ls; }",
    "! ls",
    "time ls",
    "ls |& head",
    "cat <<EOF\nx\nEOF",
    "cat <<<x",
    "cat <(ls)",
    "ls >(cat)",
    "ls\r",
    "ls\r\nrm x",
    "ls\u00a0-la",
    "ls\u2028",
    "cd a b",
    "cd -e x",
    "tail -f x",
    "tail -F x",
    "tail +5f x",
    "tail -n 5 +3f x",
    "cat -l x",
    "diff -l a b",
    "git status",
    "git log",
    "eval ls",
    "exec ls",
    "command ls",
    "builtin ls",
    "env ls",
    "xargs ls",
    "timeout 1 ls",
    "nice ls",
    "sh -c ls",
    "bash -c ls",
    "source x",
    ". x",
    "printf x",
    "test -f x",
    "[ -f x ]",
    "[[ -f x ]]",
    "alias ls=rm",
    "export X=1",
    "X=1",
    "ls() { rm x; }",
    "function ls { rm x; }",
    "if true; then ls; fi",
    "for x in a; do ls; done",
    "while false; do ls; done",
    "case x in x) ls;; esac",
    "coproc ls",
    "ls;;",
    "ls; ;",
    ": x",
    "true &&",
    "ls |",
    "ls 'unterminated",
    "",
    "\n",
    `echo '${"x".repeat(17_000)}'`,
  ];

  it.each(bypasses)("keeps %j unclassified", async (command) => {
    const result = await analyze(command);
    expect(result.commandClass).toBe("unclassified");
  });

  it("returns bounded plain messages", async () => {
    const spoofing = ["'\u202ecat' x", "ls '\u2028' --x\u00e9", "ls\u00a0x", "'\u{1f600}' x"];
    for (const command of [...bypasses, ...spoofing]) {
      const issue = await issueOf(command);
      expect(issue.message.length).toBeLessThanOrEqual(160);
      expect(issue.message).toMatch(/^[ -~]+$/);
    }
    expect((await issueOf("'\u202ecat' x")).message).toBe(
      '"\\u202ecat" is not a known read-only command',
    );
    const long = await issueOf(`${"a".repeat(500)} x`);
    expect(long).toMatchObject({ code: "unknown_command", offset: 0 });
    expect(long.message.length).toBeLessThan(100);
  });

  it("reports specific issue codes and offsets", async () => {
    expect(await issueOf("ls; rm x")).toMatchObject({ code: "unknown_command", offset: 4 });
    expect(await issueOf("/bin/ls")).toMatchObject({ code: "unknown_command", offset: 0 });
    expect(await issueOf("ls > out")).toMatchObject({ code: "unsupported_redirection", offset: 3 });
    expect(await issueOf("ls --hyperlink")).toMatchObject({
      code: "unsupported_option",
      offset: 3,
    });
    expect(await issueOf("uniq a b")).toMatchObject({ code: "unsupported_operand", offset: 7 });
    expect(await issueOf("ls $x")).toMatchObject({ code: "unsupported_character", offset: 3 });
    expect(await issueOf("ls &")).toMatchObject({ code: "unsupported_syntax", offset: 3 });
    expect(await issueOf("")).toMatchObject({ code: "empty_command" });
    expect(await issueOf("ls > out", {})).toMatchObject({ code: "unsupported_redirection" });
    expect((await issueOf("ls > out")).message).toBe(
      "output redirection to a file is not read-only (only /dev/null is accepted)",
    );
  });

  it("returns the first issue in source order", async () => {
    expect(await issueOf("rm a; ls $x")).toMatchObject({ code: "unknown_command", offset: 0 });
    expect(await issueOf("ls --bad; rm x")).toMatchObject({
      code: "unsupported_option",
      offset: 3,
    });
    expect(
      await issueOf("ls; rg x; rm y", { PATH: "/usr/bin", RIPGREP_CONFIG_PATH: "/c" }),
    ).toMatchObject({ code: "unsafe_environment", offset: 4 });
    const probe = fakeProbe({ "/usr/bin/cat": "/usr/bin/cat" });
    expect(await issueOf("cat a; ls b; rm c", undefined, probe)).toMatchObject({
      code: "executable_not_found",
      offset: 7,
    });
  });
});

describe("Bash command analyzer execution context", () => {
  it.each([
    ["BASH_ENV", "/home/u/.bashrc"],
    ["SHELLOPTS", "xtrace"],
    ["SHELLOPTS", "keyword"],
    ["BASHOPTS", "expand_aliases"],
    ["EXECIGNORE", "/usr/bin/*"],
  ])("treats non-empty %s as unsafe for every command", async (variable, value) => {
    const environment = { PATH: "/usr/bin", [variable]: value };
    for (const command of ["echo hi", "ls", "rm x"]) {
      expect(await issueOf(command, environment)).toEqual({
        code: "unsafe_environment",
        message: expect.stringContaining(variable) as string,
      });
    }
    expect((await analyze("ls", { PATH: "/usr/bin", [variable]: "" })).commandClass).toBe(
      "known_read_only",
    );
  });

  it.each([
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "LD_DEBUG_OUTPUT",
    "LD_PROFILE_OUTPUT",
    "LD_",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_PRINT_TO_FILE",
    "GCONV_PATH",
  ])("treats non-empty loader variable %s as unsafe for every command", async (variable) => {
    const environment = { PATH: "/usr/bin", [variable]: "/tmp/x" };
    for (const command of ["echo hi", "cd x && pwd", "ls", "rm x"]) {
      expect(await issueOf(command, environment)).toEqual({
        code: "unsafe_environment",
        message: `"${variable}" is set; loader and C library variables can load code or write files`,
      });
    }
    expect((await analyze("ls", { PATH: "/usr/bin", [variable]: "" })).commandClass).toBe(
      "known_read_only",
    );
  });

  it("matches only loader variable names and keeps their messages bounded", async () => {
    for (const variable of ["OLD_PRELOAD", "ld_preload", "XLD_PRELOAD", "GCONV_PATHS", "DYLD"]) {
      expect((await analyze("ls", { PATH: "/usr/bin", [variable]: "/tmp/x" })).commandClass).toBe(
        "known_read_only",
      );
    }
    for (const variable of [`LD_${"\u202e".repeat(100)}`, `LD_${"A".repeat(200)}`, "LD_-x"]) {
      expect((await issueOf("ls", { PATH: "/usr/bin", [variable]: "x" })).message).toBe(
        "a loader variable is set; loader and C library variables can load code or write files",
      );
    }
    expect(
      await issueOf("ls", { PATH: "/usr/bin", LD_Z: "1", DYLD_A: "1", GCONV_PATH: "1" }),
    ).toMatchObject({
      message: expect.stringContaining('"DYLD_A"') as string,
    });
  });

  it("rejects exported functions for any used command", async () => {
    for (const key of [
      "BASH_FUNC_ls%%",
      "BASH_FUNC_ls()",
      "__BASH_FUNC<ls>%%",
      "__BASH_FUNC<ls>()",
    ]) {
      expect(
        await issueOf("echo a | ls", { PATH: "/usr/bin", [key]: "() { rm x; }" }),
      ).toMatchObject({
        code: "unsafe_environment",
        offset: 9,
      });
    }
    expect(
      await issueOf("echo a", { PATH: "/usr/bin", "BASH_FUNC_echo%%": "() { :; }" }),
    ).toMatchObject({ code: "unsafe_environment", offset: 0 });
    expect(await issueOf("cd x", { PATH: "/usr/bin", cd: "() { rm x; }" })).toMatchObject({
      code: "unsafe_environment",
    });
    expect(
      (await analyze("ls", { PATH: "/usr/bin", "BASH_FUNC_cat%%": "() { :; }" })).commandClass,
    ).toBe("known_read_only");
  });

  it("treats a missing or empty PATH as unsafe for executables only", async () => {
    expect(await issueOf("ls", {})).toMatchObject({ code: "unsafe_environment", offset: 0 });
    expect(await issueOf("echo a | cat", { PATH: "" })).toMatchObject({
      code: "unsafe_environment",
      offset: 9,
      message: "PATH is missing or empty in the execution environment",
    });
    expect((await analyze("cd x && pwd; echo y; true; false", {})).commandClass).toBe(
      "known_read_only",
    );
  });

  it.each([
    ["/usr/bin::/bin", "/usr/local/bin"],
    [":/usr/bin", ""],
    ["bin:/usr/bin", ""],
    ["./bin:/usr/bin", ""],
    ["/usr/bin/:.", "/nowhere"],
  ])("rejects PATH %j with relative entries before the command", async (path) => {
    const probe = fakeProbe({ "/bin/ls": "/bin/ls", "/usr/bin/cat": "/usr/bin/cat" });
    expect(await issueOf("ls", { PATH: path }, probe)).toMatchObject({
      code: "unsafe_environment",
    });
  });

  it("ignores PATH entries after the command is found", async () => {
    const probe = fakeProbe({ "/usr/bin/ls": "/usr/bin/ls" });
    expect((await analyze("ls", { PATH: `/usr/bin:.:${CWD}/bin` }, probe)).commandClass).toBe(
      "known_read_only",
    );
  });

  it("rejects PATH directories inside the launch directory before the command", async () => {
    const probe = fakeProbe(
      { "/usr/bin/ls": "/usr/bin/ls" },
      { "/opt/link": `${CWD}/tools`, "/opt/link/bin": `${CWD}/tools/bin` },
    );
    for (const path of [
      `${CWD}:/usr/bin`,
      `${CWD}/bin:/usr/bin`,
      `${CWD}/./bin/../bin:/usr/bin`,
      "/work/../work/project/x:/usr/bin",
      "/opt/link/bin:/usr/bin",
      "/opt/link/missing/deeper:/usr/bin",
    ]) {
      expect([path, await issueOf("ls", { PATH: path }, probe)]).toEqual([
        path,
        expect.objectContaining({ code: "unsafe_environment", offset: 0 }) as unknown,
      ]);
    }
    expect(
      (await analyze("ls", { PATH: "/work/project-other:/usr/bin" }, probe)).commandClass,
    ).toBe("known_read_only");
  });

  it("rejects executables that resolve inside the launch directory", async () => {
    const probe = fakeProbe({ "/usr/local/bin/ls": `${CWD}/node_modules/.bin/ls` });
    expect(await issueOf("ls", { PATH: "/usr/local/bin" }, probe)).toMatchObject({
      code: "untrusted_executable",
      offset: 0,
    });
    const everywhere = createBashCommandAnalyzer(
      { backend: "direct", cwd: "/", environment: { PATH: "/usr/bin" } },
      fakeProbe(),
    );
    expect(await everywhere.analyze("ls")).toMatchObject({
      issue: { code: "unsafe_environment" },
    });
    expect((await everywhere.analyze("echo hi")).commandClass).toBe("known_read_only");
  });

  it("reports executables missing from PATH", async () => {
    expect(
      await issueOf("ls | rg x", { PATH: "/usr/bin" }, fakeProbe({ "/usr/bin/ls": "/usr/bin/ls" })),
    ).toEqual({
      code: "executable_not_found",
      message: '"rg" was not found on PATH',
      offset: 5,
    });
  });

  it("does not resolve builtins on PATH", async () => {
    const probe = fakeProbe({});
    expect(
      (await analyze("cd /tmp && pwd -P; echo x; true; false", { PATH: "/usr/bin" }, probe))
        .commandClass,
    ).toBe("known_read_only");
    expect(probe.calls).toEqual([]);
  });

  it("applies profile environment dependencies", async () => {
    const environment = { PATH: "/usr/bin", RIPGREP_CONFIG_PATH: "/home/u/.ripgreprc" };
    expect(await issueOf("rg x", environment)).toMatchObject({
      code: "unsafe_environment",
      message: "RIPGREP_CONFIG_PATH is set for rg (add --no-config)",
    });
    expect((await analyze("rg --no-config x", environment)).commandClass).toBe("known_read_only");
    expect((await analyze("rg x", { ...environment, RIPGREP_CONFIG_PATH: "" })).commandClass).toBe(
      "known_read_only",
    );
    expect((await analyze("grep x", environment)).commandClass).toBe("known_read_only");
    expect(await issueOf("grep x", { PATH: "/usr/bin", GREP_OPTIONS: "-Z" })).toMatchObject({
      code: "unsafe_environment",
    });
  });

  it("requires a UTF-8 or C locale for non-ASCII text", async () => {
    for (const locale of [
      {},
      { LANG: "C" },
      { LC_ALL: "C.UTF-8" },
      { LANG: "en_US.utf8" },
      { LC_CTYPE: "POSIX" },
    ]) {
      expect((await analyze("echo 'é'", { PATH: "/usr/bin", ...locale })).commandClass).toBe(
        "known_read_only",
      );
    }
    expect(await issueOf("echo 'x日本'", { PATH: "/usr/bin", LC_ALL: "ja_JP.SJIS" })).toMatchObject(
      {
        code: "unsafe_environment",
        offset: 7,
      },
    );
    expect(
      await issueOf("echo 'é'", { PATH: "/usr/bin", LANG: "C.UTF-8", LC_CTYPE: "zh_TW.Big5" }),
    ).toMatchObject({
      code: "unsafe_environment",
    });
    expect((await analyze("echo x", { PATH: "/usr/bin", LC_ALL: "ja_JP.SJIS" })).commandClass).toBe(
      "known_read_only",
    );
  });

  it("queries the filesystem on every analysis without caching", async () => {
    const probe = fakeProbe();
    const analyzer = createBashCommandAnalyzer(context(), probe);
    await analyzer.analyze("ls");
    const first = probe.calls.length;
    expect(first).toBeGreaterThan(0);
    await analyzer.analyze("ls");
    expect(probe.calls.length).toBe(first * 2);
    await analyzer.analyze("ls; ls | ls && ls");
    expect(probe.calls.length).toBe(first * 3);
  });

  it("analyzes a maximum-size command with thousands of stages promptly", async () => {
    const command = "ls;".repeat(5461);
    expect(Buffer.byteLength(command)).toBeLessThanOrEqual(16 * 1024);
    const started = performance.now();
    const result = await analyze(command);
    expect(result.commandClass).toBe("known_read_only");
    expect(result.commandClass === "known_read_only" && result.commands.length).toBe(5461);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("rejects an exported command_not_found_handle for executables", async () => {
    const environment = { PATH: "/usr/bin", "BASH_FUNC_command_not_found_handle%%": "() { id; }" };
    expect(await issueOf("echo a | ls", environment)).toMatchObject({
      code: "unsafe_environment",
      offset: 9,
    });
    expect((await analyze("echo a; cd x; pwd", environment)).commandClass).toBe("known_read_only");
  });

  it("treats probe failures as not executable", async () => {
    const probe: ExecutableProbe = {
      isExecutableFile: () => Promise.reject(new Error("EIO")),
      realpath: (path) => Promise.resolve(path),
    };
    expect(await issueOf("ls", { PATH: "/usr/bin" }, probe)).toMatchObject({
      code: "executable_not_found",
    });
  });
});

describe("Bash command analyzer default filesystem probe", () => {
  let root: string;
  let cwd: string;
  let bin: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-bash-analyzer-")));
    cwd = join(root, "project");
    bin = join(root, "bin");
    await mkdir(join(cwd, "bin"), { recursive: true });
    await mkdir(bin);
    for (const name of ["ls", "cat"]) {
      await writeFile(join(bin, name), "#!/bin/sh\n");
      await chmod(join(bin, name), 0o755);
    }
    await writeFile(join(bin, "wc"), "not executable\n");
    await chmod(join(bin, "wc"), 0o644);
    await mkdir(join(bin, "sort"));
    await writeFile(join(cwd, "bin", "head"), "#!/bin/sh\n");
    await chmod(join(cwd, "bin", "head"), 0o755);
    await symlink(join(cwd, "bin", "head"), join(bin, "head"));
    await symlink(join(cwd, "bin"), join(root, "linked-bin"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function analyzer(path: string) {
    return createBashCommandAnalyzer({ backend: "direct", cwd, environment: { PATH: path } });
  }

  it("resolves regular executable files outside the launch directory", async () => {
    expect(await analyzer(bin).analyze("ls | cat")).toMatchObject({
      commandClass: "known_read_only",
    });
  });

  it("skips non-executable files and directories", async () => {
    expect(await analyzer(bin).analyze("wc")).toMatchObject({
      issue: { code: "executable_not_found" },
    });
    expect(await analyzer(bin).analyze("sort")).toMatchObject({
      issue: { code: "executable_not_found" },
    });
  });

  it("rejects symbolic links into the launch directory", async () => {
    expect(await analyzer(bin).analyze("head x")).toMatchObject({
      issue: { code: "untrusted_executable" },
    });
    expect(await analyzer(`${join(root, "linked-bin")}:${bin}`).analyze("ls")).toMatchObject({
      issue: { code: "unsafe_environment" },
    });
  });
});
