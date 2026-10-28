import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBashCommandAnalyzer } from "../../src/permissions/bash/analyzer.js";
import { selectedTestToolBundle } from "../support/tool-bundle.js";

const BASH = "/bin/bash";
const available = existsSync(BASH);
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const bundle = selectedTestToolBundle();
const paths = [
  { label: "system", path: "/usr/bin:/bin" },
  ...(bundle === undefined
    ? []
    : [{ label: "selected bundle", path: `${bundle.root}/bin:/usr/bin:/bin` }]),
];

describe.skipIf(!available).each(paths)(
  "read-only profiles with native Bash and $label utilities",
  ({ path }) => {
    let root: string;
    let work: string;
    const baseEnvironment = { PATH: path, LC_ALL: "C" };

    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-read-only-native-")));
      work = join(root, "work");
      mkdirSync(work);
      writeFileSync(join(work, "marker"), "work-marker\n");
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    async function run(command: string, home: string = work) {
      const environment = { ...baseEnvironment, HOME: home };
      const analyzer = createBashCommandAnalyzer({ backend: "direct", cwd: work, environment });
      expect(await analyzer.analyze(command), command).toMatchObject({
        commandClass: "known_read_only",
        version: 2,
      });
      const result = spawnSync(BASH, ["-c", command], {
        cwd: work,
        env: environment,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return result;
    }

    it.each(["ordinary", "space and * [glob]", "$(touch injected) `touch injected` $HOME"])(
      "uses HOME as one literal directory value: %s",
      async (name) => {
        const home = join(root, name);
        mkdirSync(join(home, "child"), { recursive: true });
        writeFileSync(join(home, "child", "marker"), "home-marker\n");
        for (const prefix of ["", "-L -P -L ", "-P -- "]) {
          const result = await run(`cd ${prefix}~/child && pwd && cat marker`, home);
          expect(result.status).toBe(0);
          expect(result.stdout).toBe(`${home}/child\nhome-marker\n`);
          expect(result.stderr).toBe("");
        }
        const failed = await run("cd ~/missing && echo wrong || cat marker", home);
        expect(failed.status).toBe(0);
        expect(failed.stdout).toBe("work-marker\n");
        const pipeline = await run("cd ~/child | cat; pwd; cat marker", home);
        expect(pipeline.status).toBe(0);
        expect(pipeline.stdout).toBe(`${work}\nwork-marker\n`);
        expect(existsSync(join(work, "injected"))).toBe(false);
        expect(existsSync(join(home, "injected"))).toBe(false);
      },
    );

    it.each(["-P", "-"])("keeps option-like HOME %s inside the cd builtin", async (home) => {
      mkdirSync(join(work, home, "child"), { recursive: true });
      const withoutTerminator = await run("cd ~/child", home);
      // Bash 3.2 reports builtin usage errors as 1; newer Bash uses 2.
      expect([1, 2]).toContain(withoutTerminator.status);
      expect(withoutTerminator.stdout).toBe("");
      expect(withoutTerminator.stderr).toMatch(/invalid option/);
      const withTerminator = await run("cd -- ~/child && pwd", home);
      expect(withTerminator.status).toBe(0);
      expect(withTerminator.stdout).toBe(`${work}/${home}/child\n`);
    });

    it("preserves Bash's empty HOME and account fallback semantics", async () => {
      const empty = await run("cd ~/ && pwd", "");
      expect(empty.status).toBe(0);
      expect(empty.stdout).toBe("/\n");
      // Pass an explicit unset HOME; the helper's default applies only when omitted.
      const environment = { ...baseEnvironment };
      const command = "cd ~/ && pwd -P";
      expect(
        await createBashCommandAnalyzer({ backend: "direct", cwd: work, environment }).analyze(
          command,
        ),
      ).toMatchObject({ commandClass: "known_read_only" });
      const unset = spawnSync(BASH, ["-c", command], {
        cwd: work,
        env: environment,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(unset.status).toBe(0);
      expect(unset.stdout).toBe(`${realpathSync(userInfo().homedir)}\n`);
    });

    it.each([
      ["/start/,/end/p", "skip\nstart\nmiddle\nend\nskip\n", "start\nmiddle\nend\n"],
      ["/start/,/};/p", "start\nbody\n};\nskip\n", "start\nbody\n};\n"],
      [String.raw`/\*start/,/end$/p`, "skip\n*start\nbody\nend\nskip\n", "*start\nbody\nend\n"],
      [String.raw`/a\/b/,/c\/d/p`, "a/b\nbody\nc/d\nskip\n", "a/b\nbody\nc/d\n"],
      [String.raw`/a\\/,/end/p`, "a\\\nbody\nend\nskip\n", "a\\\nbody\nend\n"],
      [String.raw`/a\\\/b/,/end/p`, "a\\/b\nbody\nend\nskip\n", "a\\/b\nbody\nend\n"],
      [String.raw`/\^start/,/end\$/p`, "^start\nbody\nend$\nskip\n", "^start\nbody\nend$\n"],
      [String.raw`/a\.b/,/end/p`, "axb\na.b\nend\nskip\n", "a.b\nend\n"],
      ["/start here/,/end here/p", "start here\nbody\nend here\n", "start here\nbody\nend here\n"],
      ["/a,b/,/end/p", "a,b\nend\nskip\n", "a,b\nend\n"],
      ["1,2p", "a\nb\nc\n", "a\nb\n"],
      ["$p", "a\nb\nc\n", "c\n"],
    ])("prints only the expected native sed range: %s", async (program, input, expected) => {
      writeFileSync(join(work, "input"), input);
      const result = await run(`sed -n ${quote(program)} input`);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(expected);
    });

    it.each([0, 1])("runs native sleep %s without changing timeout behavior", async (seconds) => {
      const result = await run(`sleep ${seconds}`);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  },
);
