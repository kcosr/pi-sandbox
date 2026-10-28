import { describe, expect, it } from "vitest";

import {
  KNOWN_READ_ONLY_COMMANDS,
  KNOWN_READ_ONLY_PROFILES,
  KNOWN_READ_ONLY_VERSION,
  knownReadOnlyProfile,
  renderKnownReadOnlyTable,
} from "./registry.js";
import { parseBashCommand } from "./syntax.js";

function check(input: string): string {
  const parsed = parseBashCommand(input);
  if (!parsed.ok) {
    throw new Error(`${input}: ${parsed.issue.message}`);
  }
  const words = parsed.script.statements[0]?.pipelines[0]?.commands[0]?.words ?? [];
  const name = words[0];
  const profile = knownReadOnlyProfile(name?.kind === "literal" ? name.value : "");
  if (profile === undefined) {
    throw new Error(`${input}: no profile`);
  }
  const result = profile.check(words.slice(1));
  return result.ok ? "ok" : result.issue.code;
}

const ACCEPTED: Readonly<Record<string, readonly string[]>> = {
  basename: [
    "basename /a/b.txt",
    "basename /a/b.txt .txt",
    "basename -a x y",
    "basename -s .c a.c --zero",
  ],
  cat: [
    "cat",
    "cat -",
    "cat -n a b",
    "cat -vET --number -- -x",
    "cat -A -b -e -s -t -u",
    "cat a -n",
  ],
  cd: [
    "cd",
    "cd /tmp",
    "cd -",
    "cd -L x",
    "cd -P -- x",
    "cd -LP",
    "cd -LP x",
    "cd ~/",
    "cd ~/project",
    "cd ~/../project",
    "cd -P ~/project",
    "cd -- ~/",
    "cd -L -P -L ~/project",
    "cd -P -- ~/project",
    "cd '-P' '--' ~/project",
    "cd '~/project'",
  ],
  cut: [
    "cut -d: -f1 /etc/passwd",
    "cut -d , -f 2-3 x",
    "cut -c1-5 --complement x",
    "cut --fields=1 --delimiter=: --output-delimiter=/ -s x",
    "cut -b 1 -n -z",
  ],
  diff: [
    "diff a b",
    "diff -u a b",
    "diff -U3 a b",
    "diff -U 0 a b",
    "diff -ruN a b",
    "diff --unified=5 --context --brief -q a b",
    "diff -y -W 100 --suppress-common-lines a b",
    "diff -x '*.o' -X list -I '^#' --strip-trailing-cr --color=never a b",
  ],
  dirname: ["dirname /a/b", "dirname -z a b"],
  du: ["du", "du -sh .", "du -d 1 -h", "du --max-depth=2 --apparent-size --si -c a", "du -akLHPmx"],
  echo: ["echo", "echo -n hi", "echo -e 'a\\tb' --help", "echo rm -rf /"],
  false: ["false", "false --anything"],
  find: [
    "find",
    "find .",
    "find . -name '*.ts'",
    "find -L src lib -type f -name x -print",
    "find . '(' -name a -o -iname b ')' '!' -path '*/node_modules/*' -print0",
    "find . -maxdepth 2 -mindepth 1 -type d -empty -prune -o -print",
    "find . -newer x -mtime -1 -size +10k -perm -644 -user root -ls",
    "find . -newermt 2024-01-01 -not -name -delete",
    "find . -depth -quit",
    "find . -regextype posix-extended -regex '.*[.]ts' -printf '%p\\n'",
    "find a -name -exec",
  ],
  grep: [
    "grep foo",
    "grep -rn foo .",
    "grep -E 'a|b' x",
    "grep -e -v -e x file",
    "grep -iwvc pattern x",
    "grep -A2 -B 3 -C4 x",
    "grep --include='*.ts' --exclude-dir=node_modules -rl x .",
    "grep --color=always --colour -o -q -s -H -h -b -n -I -a x",
    "grep -m 5 --max-count=6 -f patterns x",
    "grep -P '\\d+' x",
    "grep x a -n",
  ],
  head: [
    "head x",
    "head -20 x",
    "head -n 5 x",
    "head -n-5 x",
    "head -c 100 x",
    "head --lines=3 -q -v a b",
  ],
  ls: [
    "ls",
    "ls -la",
    "ls -1AFhiknpRrSstucxmgo x",
    "ls --color=auto --classify --group-directories-first",
    "ls --sort=size --time=ctime --full-time -d .",
    "ls -- -x",
    "ls a -l",
  ],
  nl: ["nl x", "nl -ba -w3 -s ': ' x", "nl --body-numbering=a --number-format=rz -v 0 -i 2 -p x"],
  pwd: ["pwd", "pwd -P", "pwd -L"],
  readlink: ["readlink x", "readlink -f x", "readlink -enqsvz --canonicalize-missing x"],
  realpath: [
    "realpath .",
    "realpath -e -m -q -s -z -L -P x",
    "realpath --relative-to=/tmp --no-symlinks x",
  ],
  rg: [
    "rg foo",
    "rg -n -i foo src",
    "rg -e -foo -e bar",
    "rg -tts -Tjs -g '!*.min.js' --hidden --no-ignore x",
    "rg -uuu --files",
    "rg -l -c --count-matches --json --vimgrep -o -w -x -v -F -U -P x",
    "rg -A 2 -B2 -C3 -m 1 -M 200 -d 3 --max-filesize 1M --sort path x",
    "rg --no-config --color never --no-heading -H -I -N -0 x",
    "rg -r '$1' x",
  ],
  sed: [
    "sed -n 1p x",
    "sed -n 1,20p x",
    "sed -n '$p' x",
    "sed -n '10,$p'",
    "sed --quiet 3p",
    "sed --silent -- 3,4p x",
    "sed -n '/class Handler/,/};/p' source.h",
    "sed -n '/Handler::reset/,/^}/p' source.cc",
    String.raw`sed -n '/reset (const char \*value)/,/^}/p' source.cc`,
    String.raw`sed -n '/^a\/b/,/^end/p' notes.txt`,
    String.raw`sed -n '/^a\\b/,/^end/p' notes.txt`,
    String.raw`sed -n '/^a\.b/,/^end/p' notes.txt`,
    String.raw`sed -n '/\^start/,/^end/p' notes.txt`,
    String.raw`sed -n '/\$start/,/^end/p' notes.txt`,
    "sed --quiet '/a,b;w e/,/end]/p' x",
    "sed --silent -- '/ /,/ /p'",
  ],
  sleep: [
    "sleep 0",
    "sleep 1",
    "sleep 10",
    "sleep 11",
    "sleep 40",
    "sleep 2147483647",
    "sleep '10'",
    'sleep "40"',
  ],
  sort: [
    "sort x",
    "sort -u x",
    "sort -rn -k2,2 -t: x",
    "sort -k 3 -t , -S 10M a b",
    "sort -bcCdfghiMmRsVz x",
    "sort --key=1 --field-separator=: --sort=version --unique --stable x",
  ],
  stat: [
    "stat x",
    "stat -L -c '%s %n' x",
    "stat --printf='%s\\n' --terse -f x",
    "stat --format=%y x",
  ],
  tail: [
    "tail x",
    "tail -5 x",
    "tail -n 5 x",
    "tail -n +5 x",
    "tail -n+2 x",
    "tail -c -10 --lines=3 -q -v x",
  ],
  tr: ["tr a-z A-Z", "tr -d '\\r'", "tr -cs a-z '\\n'", "tr -C -t abc xy", "tr --delete x"],
  true: ["true", "true x"],
  uniq: ["uniq", "uniq x", "uniq -c x", "uniq -cdiuD -f 1 -s 2 x", "uniq --count -- x", "uniq -"],
  wc: ["wc -l x", "wc -c -m -w -L a b", "wc --lines --words --bytes --chars --max-line-length"],
};

const REJECTED: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  basename: [["basename --suffi=x a", "unsupported_option"]],
  cat: [
    ["cat -l x", "unsupported_option"],
    ["cat -nl x", "unsupported_option"],
    ["cat --show x", "unsupported_option"],
  ],
  cd: [
    ["cd a b", "unsupported_operand"],
    ["cd a -L", "unsupported_operand"],
    ["cd -e x", "unsupported_option"],
    ["cd -@ x", "unsupported_option"],
    ["cd ~/project extra", "unsupported_operand"],
    ["cd ~/project -P", "unsupported_operand"],
    ["cd ~/a ~/b", "unsupported_operand"],
    ["cd literal ~/project", "unsupported_operand"],
    ["cd -LP ~/project", "unsupported_operand"],
    ["cd -PL ~/project", "unsupported_operand"],
    ["cd -- -P ~/project", "unsupported_operand"],
    ["cd -- -- ~/project", "unsupported_operand"],
    ["cd -e ~/project", "unsupported_operand"],
  ],
  cut: [["cut -w x", "unsupported_option"]],
  diff: [
    ["diff -l a b", "unsupported_option"],
    ["diff --paginate a b", "unsupported_option"],
    ["diff -ul a b", "unsupported_option"],
    ["diff --from-file=a b", "unsupported_option"],
    ["diff -C x a b", "unsupported_option"],
  ],
  du: [
    ["du -g x", "unsupported_option"],
    ["du --files0-from=x", "unsupported_option"],
    ["du --max-dep=1", "unsupported_option"],
  ],
  find: [
    ["find . -exec rm '{}' ';'", "unsupported_option"],
    ["find . -execdir x ';'", "unsupported_option"],
    ["find . -ok x ';'", "unsupported_option"],
    ["find . -okdir x ';'", "unsupported_option"],
    ["find . -delete", "unsupported_option"],
    ["find . -fprint x", "unsupported_option"],
    ["find . -fprint0 x", "unsupported_option"],
    ["find . -fprintf x y", "unsupported_option"],
    ["find . -fls x", "unsupported_option"],
    ["find . -name", "unsupported_option"],
    ["find . -name x -exit", "unsupported_option"],
    ["find . -depth 2", "unsupported_option"],
    ["find . -depth -2", "unsupported_option"],
    ["find -E . -regex x", "unsupported_option"],
    ["find -f x", "unsupported_option"],
    ["find . -newerXY x", "unsupported_option"],
    ["find . -name a , -print", "unsupported_option"],
    ["find . -name a ';'", "unsupported_option"],
    ["find -", "unsupported_option"],
    ["find . -D tree", "unsupported_option"],
    ["find . -files0-from x", "unsupported_option"],
  ],
  grep: [
    ["grep -Z x", "unsupported_option"],
    ["grep -z x", "unsupported_option"],
    ["grep -J x", "unsupported_option"],
    ["grep --decompress x", "unsupported_option"],
    ["grep -d recurse x", "unsupported_option"],
    ["grep -5 x", "unsupported_option"],
    ["grep --exclude-from=x y", "unsupported_option"],
    ["grep --regex=x", "unsupported_option"],
  ],
  head: [
    ["head -5c x", "unsupported_option"],
    ["head -n 5k x", "unsupported_option"],
    ["head -z x", "unsupported_option"],
  ],
  ls: [
    ["ls -w 80", "unsupported_option"],
    ["ls -T", "unsupported_option"],
    ["ls -D x", "unsupported_option"],
    ["ls --hyperlink", "unsupported_option"],
    ["ls --colo", "unsupported_option"],
    ["ls -l@", "unsupported_option"],
  ],
  pwd: [
    ["pwd x", "unsupported_operand"],
    ["pwd -x", "unsupported_option"],
  ],
  readlink: [["readlink --canon x", "unsupported_option"]],
  realpath: [["realpath --relative x", "unsupported_option"]],
  rg: [
    ["rg --pre=sh x", "unsupported_option"],
    ["rg --pre sh x", "unsupported_option"],
    ["rg --pre-glob='*' x", "unsupported_option"],
    ["rg -z x", "unsupported_option"],
    ["rg -iz x", "unsupported_option"],
    ["rg --search-zip x", "unsupported_option"],
    ["rg --hostname-bin=x y", "unsupported_option"],
    ["rg --hyperlink-format=x y", "unsupported_option"],
    ["rg --ignore-file=x y", "unsupported_option"],
    ["rg --type-add='x:*.x' y", "unsupported_option"],
    ["rg --pr=sh x", "unsupported_option"],
    ["rg -j 2 x", "unsupported_option"],
  ],
  sed: [
    ["sed 1p x", "unsupported_option"],
    ["sed -n 1e x", "unsupported_operand"],
    ["sed -n '1p;1e' x", "unsupported_operand"],
    ["sed -n 's/a/b/w out' x", "unsupported_operand"],
    ["sed -n 1w x", "unsupported_operand"],
    ["sed -n 1p a b", "unsupported_operand"],
    ["sed -n 1p a -n", "unsupported_operand"],
    ["sed -n", "unsupported_operand"],
    ["sed -n ' 1p' x", "unsupported_operand"],
    ["sed -n -e 1p x", "unsupported_option"],
    ["sed -n -i 1p x", "unsupported_option"],
    ["sed -ni 1p x", "unsupported_option"],
    ["sed -n -s 1p x", "unsupported_option"],
    ["sed -n -E 1p x", "unsupported_option"],
    ["sed -n -f script x", "unsupported_option"],
    ["sed -n /x/p x", "unsupported_operand"],
    ["sed -n '//,/end/p' x", "unsupported_operand"],
    ["sed -n '/start/,//p' x", "unsupported_operand"],
    ["sed -n '/start/,/end/p; e id' x", "unsupported_operand"],
    ["sed -n '/start/,/end/w out' x", "unsupported_operand"],
    ["sed -n '/start/,/end/p;w out' x", "unsupported_operand"],
    ["sed -n '/start/,/end/p;r input' x", "unsupported_operand"],
    ["sed -n '/start/,/end/Ip' x", "unsupported_operand"],
    ["sed -n '/start/I,/end/p' x", "unsupported_operand"],
    ["sed -n '/start/,/end/Mp' x", "unsupported_operand"],
    ["sed -n '/[A-Z]/,/end/p' x", "unsupported_operand"],
    ["sed -n '/[^x]/,/end/p' x", "unsupported_operand"],
    ["sed -n '/[]]/,/end/p' x", "unsupported_operand"],
    ["sed -n '/[/]/,/end/p' x", "unsupported_operand"],
    ["sed -n '/[[:alpha:]]/,/end/p' x", "unsupported_operand"],
    ["sed -n '/start/,/[end/p' x", "unsupported_operand"],
    ["sed -n '/start/,/end/p ' x", "unsupported_operand"],
    ["sed -n '/start/,/end/p#comment' x", "unsupported_operand"],
    ["sed -n '/start/,/end/p\n' x", "unsupported_operand"],
    ["sed -n '/sta\nrt/,/end/p' x", "unsupported_operand"],
    ["sed -n '/sta\trt/,/end/p' x", "unsupported_operand"],
    ["sed -n '/café/,/end/p' x", "unsupported_operand"],
    ["sed -n '/start/, /end/p' x", "unsupported_operand"],
    ["sed -n '/start/,/end/ p' x", "unsupported_operand"],
    ["sed -n '/start/,10p' x", "unsupported_operand"],
    ["sed -n '1,/end/p' x", "unsupported_operand"],
    ["sed -n '/start/,/end/!p' x", "unsupported_operand"],
    ["sed -n '/start/,/end/{p}' x", "unsupported_operand"],
    ["sed -n '/start/,/end/p' a b", "unsupported_operand"],
    ["sed -n '/start/,/end/p' a -n", "unsupported_operand"],
    [String.raw`sed -n '\%start%,\%end%p' x`, "unsupported_operand"],
    [String.raw`sed -n '/sta\nrt/,/end/p' x`, "unsupported_operand"],
    [String.raw`sed -n '/sta\x2frt/,/end/p' x`, "unsupported_operand"],
    [String.raw`sed -n '/\[start/,/end/p' x`, "unsupported_operand"],
    [String.raw`sed -n '/start/,/end\' x`, "unsupported_operand"],
    [String.raw`sed -n '/start\/,/end/p' x`, "unsupported_operand"],
  ],
  sleep: [
    "sleep",
    "sleep 1 2",
    "sleep -- 10",
    "sleep 10 --",
    "sleep --help",
    "sleep --version",
    "sleep -1",
    "sleep +1",
    "sleep 00",
    "sleep 01",
    "sleep 1.0",
    "sleep .1",
    "sleep 1e1",
    "sleep 10s",
    "sleep 1m",
    "sleep inf",
    "sleep NaN",
    "sleep 2147483648",
    "sleep 9999999999",
    "sleep 10000000000",
    "sleep ' 1'",
    "sleep '1 '",
    "sleep '1\n'",
    "sleep '1\t'",
    "sleep '١'",
    "sleep ''",
  ].map((input) => [input, "unsupported_operand"] as const),
  sort: [
    ["sort -o out x", "unsupported_option"],
    ["sort -oout x", "unsupported_option"],
    ["sort -uo out x", "unsupported_option"],
    ["sort x -o out", "unsupported_option"],
    ["sort --output=out x", "unsupported_option"],
    ["sort -T /tmp x", "unsupported_option"],
    ["sort --temporary-directory=/tmp x", "unsupported_option"],
    ["sort --compress-program=sh x", "unsupported_option"],
    ["sort --compress=sh x", "unsupported_option"],
    ["sort --files0-from=x", "unsupported_option"],
    ["sort --random-source=x y", "unsupported_option"],
    ["sort --parallel=2 x", "unsupported_option"],
  ],
  stat: [
    ["stat -x f", "unsupported_option"],
    ["stat --cached=never f", "unsupported_option"],
  ],
  tail: [
    ["tail -f x", "unsupported_option"],
    ["tail -F x", "unsupported_option"],
    ["tail -5f x", "unsupported_option"],
    ["tail -nf x", "unsupported_option"],
    ["tail --follow x", "unsupported_option"],
    ["tail --follow=name x", "unsupported_option"],
    ["tail --retry x", "unsupported_option"],
    ["tail --pid=1 x", "unsupported_option"],
    ["tail -s 1 x", "unsupported_option"],
    ["tail --sleep-interval=1 x", "unsupported_option"],
    ["tail -r x", "unsupported_option"],
    ["tail +5f x", "unsupported_operand"],
    ["tail -n 5 +3f x", "unsupported_operand"],
    ["tail +5 x", "unsupported_operand"],
    ["tail -n 5f x", "unsupported_option"],
  ],
  tr: [["tr -u a b", "unsupported_option"]],
  uniq: [
    ["uniq a b", "unsupported_operand"],
    ["uniq a -c", "unsupported_operand"],
    ["uniq a --", "unsupported_operand"],
    ["uniq - out", "unsupported_operand"],
    ["uniq -f 1 a b", "unsupported_operand"],
    ["uniq +5 a", "unsupported_operand"],
    ["uniq -w 3 a", "unsupported_option"],
    ["uniq --all-repeated a", "unsupported_option"],
  ],
  wc: [["wc --files0-from=x", "unsupported_option"]],
};

describe("known read-only registry", () => {
  it("contains exactly the version-2 commands", () => {
    expect(KNOWN_READ_ONLY_VERSION).toBe(2);
    expect(KNOWN_READ_ONLY_COMMANDS.map((command) => `${command.name}:${command.kind}`)).toEqual([
      "basename:executable",
      "cat:executable",
      "cd:shell_builtin",
      "cut:executable",
      "diff:executable",
      "dirname:executable",
      "du:executable",
      "echo:shell_builtin",
      "false:shell_builtin",
      "find:executable",
      "grep:executable",
      "head:executable",
      "ls:executable",
      "nl:executable",
      "pwd:shell_builtin",
      "readlink:executable",
      "realpath:executable",
      "rg:executable",
      "sed:executable",
      "sleep:executable",
      "sort:executable",
      "stat:executable",
      "tail:executable",
      "tr:executable",
      "true:shell_builtin",
      "uniq:executable",
      "wc:executable",
    ]);
    expect(Object.keys(ACCEPTED).sort()).toEqual(
      KNOWN_READ_ONLY_PROFILES.map((profile) => profile.name),
    );
    expect(Object.isFrozen(KNOWN_READ_ONLY_COMMANDS)).toBe(true);
    expect(knownReadOnlyProfile("ls ")).toBeUndefined();
    expect(knownReadOnlyProfile("LS")).toBeUndefined();
    expect(knownReadOnlyProfile("/bin/ls")).toBeUndefined();
    expect(knownReadOnlyProfile("toString")).toBeUndefined();
  });

  for (const [name, inputs] of Object.entries(ACCEPTED)) {
    it(`${name} accepts its reviewed forms`, () => {
      for (const input of inputs) {
        expect([input, check(input)]).toEqual([input, "ok"]);
      }
    });
  }

  for (const [name, cases] of Object.entries(REJECTED)) {
    it(`${name} rejects unreviewed forms`, () => {
      for (const [input, code] of cases) {
        expect([input, check(input)]).toEqual([input, code]);
      }
    });
  }

  it("rejects symbolic words in direct calls to every literal-only profile", () => {
    const parsed = parseBashCommand("cd ~/project");
    if (!parsed.ok) {
      throw new Error(parsed.issue.message);
    }
    const home = parsed.script.statements[0]?.pipelines[0]?.commands[0]?.words[1];
    expect(home?.kind).toBe("home_relative");
    if (home === undefined) {
      throw new Error("missing symbolic directory fixture");
    }
    for (const profile of KNOWN_READ_ONLY_PROFILES) {
      if (profile.name === "cd") {
        continue;
      }
      expect(profile.check([home])).toMatchObject({
        ok: false,
        issue: { code: "unsupported_operand", offset: 3 },
      });
    }
  });

  it("keeps sed delimiters distinct from escaped slash data", () => {
    expect(check(String.raw`sed -n '/a\\/,/end/p' x`)).toBe("ok");
    expect(check(String.raw`sed -n '/a\\\//,/end/p' x`)).toBe("ok");
    expect(check(String.raw`sed -n '/a\\\/,/end/p' x`)).toBe("unsupported_operand");
  });

  it("bounds sleep input before numeric conversion", () => {
    expect(check(`sleep ${"1".repeat(1000)}`)).toBe("unsupported_operand");
    expect(check(`sleep '${"0".repeat(1000)}'`)).toBe("unsupported_operand");
  });

  it("reports rg configuration and grep option environment dependencies", () => {
    expect(knownReadOnlyProfile("rg")?.environment).toEqual([
      { variable: "RIPGREP_CONFIG_PATH", unlessOption: "--no-config" },
    ]);
    expect(knownReadOnlyProfile("grep")?.environment).toEqual([{ variable: "GREP_OPTIONS" }]);
    const rg = knownReadOnlyProfile("rg");
    const parsed = parseBashCommand("rg --no-config x");
    const words = parsed.ok
      ? (parsed.script.statements[0]?.pipelines[0]?.commands[0]?.words ?? [])
      : [];
    const result = rg?.check(words.slice(1));
    expect(result?.ok === true && result.optionNames.has("--no-config")).toBe(true);
  });

  it("renders a deterministic administrator table with one row per command", () => {
    const table = renderKnownReadOnlyTable();
    expect(renderKnownReadOnlyTable()).toBe(table);
    const lines = table.trimEnd().split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "| Command | Kind | Accepted options and operands |",
      "| --- | --- | --- |",
    ]);
    expect(lines).toHaveLength(KNOWN_READ_ONLY_COMMANDS.length + 2);
    for (const [index, command] of KNOWN_READ_ONLY_COMMANDS.entries()) {
      expect(lines[index + 2]?.startsWith(`| \`${command.name}\` | `)).toBe(true);
    }
    expect(table).toContain(
      "| `sort` | executable | Options: `-b`/`--ignore-leading-blanks`, `-c`, `-C`,",
    );
    expect(table).toContain(
      "Unclassified while `RIPGREP_CONFIG_PATH` is non-empty unless `--no-config` is given.",
    );
    expect(table).not.toMatch(
      /--output=|--compress-program|--pre[=`]|--paginate|--search-zip|--hostname-bin|--sleep-interval/,
    );
  });
});
