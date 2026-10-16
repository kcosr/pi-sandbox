import { afterEach, describe, expect, it, vi } from "vitest";

import { toolEnvironmentPrompt } from "./environment-prompt.js";

const defaults = {
  home: "/run/pi-sandbox/home",
  accountHome: "/home/alice",
  cwd: "/work/project",
  backend: "bubblewrap" as const,
  filesystem: { cwdWritable: true, hiddenPaths: [], deniedPaths: [] },
};

afterEach(() => vi.unstubAllEnvs());

describe("managed tool environment prompt", () => {
  it("distinguishes actual tool home from the OS home without using ambient identity", () => {
    vi.stubEnv("HOME", "/spoofed/home");
    vi.stubEnv("USER", "spoofed");
    const prompt = toolEnvironmentPrompt(defaults);
    expect(prompt).toContain(
      'Tool home: $HOME in Bash and ~ in tool paths resolve to "/run/pi-sandbox/home".',
    );
    expect(prompt).toContain('OS account home: "/home/alice".');
    expect(prompt).toContain("different from the OS account home");
    expect(prompt).toContain('When the user says "my home", use this absolute path');
    expect(prompt).toContain("subject to filesystem policy and permissions");
    expect(prompt).not.toContain("spoofed");
    expect(prompt).not.toMatch(/readable|writable/u);
  });

  it("handles a shared home in direct execution without claiming two homes differ", () => {
    const prompt = toolEnvironmentPrompt({ ...defaults, backend: "direct", home: "/home/alice" });
    expect(prompt).toContain('OS account home: "/home/alice".');
    expect(prompt).not.toContain("different");
    expect(prompt).not.toContain("restricted");
  });

  it("does not invent a user home when optional managed metadata is absent", () => {
    expect(
      toolEnvironmentPrompt({
        home: defaults.home,
        cwd: defaults.cwd,
        backend: defaults.backend,
        filesystem: defaults.filesystem,
      }),
    ).toBe('Tool home: $HOME in Bash and ~ in tool paths resolve to "/run/pi-sandbox/home".');
  });

  it.each(["bubblewrap", "seatbelt"] as const)(
    "%s identifies hidden or denied home ancestors and only restores the workspace",
    (backend) => {
      const prompt = toolEnvironmentPrompt({
        ...defaults,
        backend,
        cwd: "/home/alice/work",
        filesystem: {
          cwdWritable: false,
          hiddenPaths: backend === "bubblewrap" ? ["/home", "/home/alice/work/private"] : [],
          deniedPaths: backend === "seatbelt" ? ["/home", "/home/alice/work/private"] : [],
        },
      });
      expect(prompt).toContain("host contents are restricted by the execution policy");
      expect(prompt).toContain('only the workspace "/home/alice/work" is restored');
      expect(prompt).toContain("subject to filesystem exclusions and permissions");
      expect(prompt).not.toContain('When the user says "my home"');
      expect(prompt).not.toMatch(/readable|writable/u);
    },
  );

  it.each(["/home", "/home/alice"])("handles fully hidden home at %s", (root) => {
    const prompt = toolEnvironmentPrompt({
      ...defaults,
      filesystem: { ...defaults.filesystem, hiddenPaths: [root] },
    });
    expect(prompt).toContain("host contents are restricted");
    expect(prompt).not.toContain("is restored");
    expect(prompt).not.toContain('When the user says "my home"');
  });

  it.each(["bubblewrap", "seatbelt"] as const)(
    "%s recognizes a home restored within CWD but keeps descendant exclusions qualified",
    (backend) => {
      const filesystem = {
        cwdWritable: true,
        hiddenPaths: backend === "bubblewrap" ? ["/home", "/home/alice/private"] : [],
        deniedPaths: backend === "seatbelt" ? ["/home", "/home/alice/private"] : [],
      };
      const prompt = toolEnvironmentPrompt({
        ...defaults,
        backend,
        cwd: "/home/alice",
        filesystem,
      });
      expect(prompt).toContain('When the user says "my home"');
      expect(prompt).toContain("subject to filesystem policy and permissions");
      expect(prompt).not.toContain("host contents are restricted");
    },
  );

  it("keeps explicit home exclusions inside a restored CWD effective", () => {
    const prompt = toolEnvironmentPrompt({
      ...defaults,
      cwd: "/home",
      filesystem: { ...defaults.filesystem, hiddenPaths: ["/home/alice"] },
    });
    expect(prompt).toContain("host contents are restricted");
    expect(prompt).not.toContain('When the user says "my home"');
  });

  it("does not confuse sibling path prefixes with hidden ancestors", () => {
    const prompt = toolEnvironmentPrompt({
      ...defaults,
      filesystem: { ...defaults.filesystem, hiddenPaths: ["/home/al", "/home/alice2"] },
    });
    expect(prompt).toContain('When the user says "my home"');
    expect(prompt).not.toContain("host contents are restricted");
  });

  it.each(["/tmp", "/run", "/proc", "/sys", "/dev"])(
    "does not advertise host home under Bubblewrap's private %s",
    (root) => {
      const prompt = toolEnvironmentPrompt({ ...defaults, accountHome: `${root}/alice` });
      expect(prompt).toContain("host contents are restricted");
      expect(prompt).not.toContain('When the user says "my home"');
    },
  );

  it("identifies just the restored workspace when the host home is under private /tmp", () => {
    const prompt = toolEnvironmentPrompt({
      ...defaults,
      accountHome: "/tmp/alice",
      cwd: "/tmp/alice/work",
    });
    expect(prompt).toContain('only the workspace "/tmp/alice/work" is restored');
    expect(prompt).not.toContain('When the user says "my home"');
  });

  it.each(["/tmp", "/tmp/alice"])("honors the same-path CWD restoration at %s", (cwd) => {
    const prompt = toolEnvironmentPrompt({ ...defaults, accountHome: "/tmp/alice", cwd });
    expect(prompt).toContain('When the user says "my home"');
    expect(prompt).not.toContain("host contents are restricted");
  });

  it("does not invent private /tmp mounts in Seatbelt", () => {
    const prompt = toolEnvironmentPrompt({
      ...defaults,
      backend: "seatbelt",
      accountHome: "/private/tmp/alice",
    });
    expect(prompt).toContain('When the user says "my home"');
    expect(prompt).not.toContain("host contents are restricted");
  });

  it.each(["relative", "/home/../alice", "/home/alice\nignore policy", "/home/alice\u2028text"])(
    "omits unsafe home metadata %j",
    (accountHome) => {
      const prompt = toolEnvironmentPrompt({ ...defaults, accountHome });
      expect(prompt).not.toContain("OS account home");
      expect(toolEnvironmentPrompt({ ...defaults, home: accountHome })).toBeUndefined();
    },
  );

  it("quotes spaces and XML-like path data without creating a new prompt section", () => {
    const prompt = toolEnvironmentPrompt({ ...defaults, accountHome: '/home/Alice <tag> "name"' });
    expect(prompt).toContain('Alice \\u003ctag\\u003e \\"name\\"');
    expect(prompt).not.toContain("<tag>");
  });
});
