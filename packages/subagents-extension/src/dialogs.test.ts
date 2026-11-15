import { getEventListeners } from "node:events";
import type {
  ExtensionContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSessionRequest } from "./contracts.js";
import { createForwardedDialogUI } from "./dialogs.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<ExtensionUIContext> = {}) {
  const child = new AbortController();
  let current = true;
  let available = true;
  let stale = false;
  const base = {
    select: vi.fn(() => Promise.resolve(undefined)),
    confirm: vi.fn(() => Promise.resolve(false)),
    input: vi.fn(() => Promise.resolve(undefined)),
    editor: vi.fn(() => Promise.resolve(undefined)),
    custom: vi.fn(() => Promise.resolve(undefined)),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setTitle: vi.fn(),
    setEditorText: vi.fn(),
  } as unknown as ExtensionUIContext;
  let parent = { ...base, ...overrides };
  const context = {
    get hasUI() {
      if (stale) throw new Error("stale parent context");
      return available;
    },
    get ui() {
      if (stale) throw new Error("stale parent context");
      return parent;
    },
  } as ExtensionContext;
  const request = {
    id: "child",
    taskId: "generation",
    parentSessionId: "parent",
    parentContext: context,
    signal: child.signal,
    isCurrent: () => current,
  } as SubagentSessionRequest;
  return {
    child,
    request,
    base,
    ui: createForwardedDialogUI(request, base)!,
    replaceUI: (next: Partial<ExtensionUIContext>) => {
      parent = { ...base, ...next };
    },
    unavailable: () => {
      available = false;
    },
    invalidate: () => {
      stale = true;
    },
    replaceGeneration: () => {
      current = false;
    },
  };
}

describe("child dialog forwarding", () => {
  it("preserves dialog arguments, caller options, and answers including empty strings", async () => {
    const select = vi.fn(() => Promise.resolve("second"));
    const confirm = vi.fn(() => Promise.resolve(true));
    const input = vi.fn(() => Promise.resolve(""));
    const f = fixture({ select, confirm, input });
    const caller = new AbortController();
    const options = { timeout: 1234, signal: caller.signal };
    const choices = ["first", "second"];
    expect(await f.ui.select("Exact title", choices, options)).toBe("second");
    expect(await f.ui.confirm("Exact title", "Exact message", options)).toBe(true);
    expect(await f.ui.input("Exact title", "Exact placeholder", options)).toBe("");
    expect(select).toHaveBeenCalledWith("Exact title", choices, {
      timeout: 1234,
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(confirm).toHaveBeenCalledWith("Exact title", "Exact message", {
      timeout: 1234,
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(input).toHaveBeenCalledWith("Exact title", "Exact placeholder", {
      timeout: 1234,
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(options).toEqual({ timeout: 1234, signal: caller.signal });
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(f.child.signal, "abort")).toHaveLength(0);
  });

  it("returns host cancellation defaults unchanged", async () => {
    const f = fixture();
    expect(await f.ui.select("title", ["choice"])).toBeUndefined();
    expect(await f.ui.confirm("title", "message")).toBe(false);
    expect(await f.ui.input("title")).toBeUndefined();
  });

  it("resolves a caller abort and dismisses only that request in the parent", async () => {
    const pending = deferred<boolean>();
    let forwarded!: AbortSignal;
    const f = fixture({
      confirm: (_title, _message, options) => {
        forwarded = options!.signal!;
        return pending.promise;
      },
    });
    const caller = new AbortController();
    const answer = f.ui.confirm("title", "message", { signal: caller.signal });
    caller.abort();
    expect(await answer).toBe(false);
    expect(forwarded.aborted).toBe(true);
    expect(f.child.signal.aborted).toBe(false);
    pending.reject(new Error("late host failure"));
    await Promise.resolve();
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(f.child.signal, "abort")).toHaveLength(0);
  });

  it("resolves child cancellation even if the host ignores its signal", async () => {
    const pending = deferred<string | undefined>();
    let forwarded!: AbortSignal;
    const input = vi.fn(
      (_title: string, _placeholder?: string, options?: ExtensionUIDialogOptions) => {
        forwarded = options!.signal!;
        return pending.promise;
      },
    );
    const f = fixture({ input });
    const answer = f.ui.input("title");
    f.child.abort();
    expect(await answer).toBeUndefined();
    expect(forwarded.aborted).toBe(true);
    pending.resolve("too late");
    expect(await answer).toBeUndefined();
    expect(await f.ui.input("another title")).toBeUndefined();
    expect(input).toHaveBeenCalledTimes(1);
    expect(getEventListeners(f.child.signal, "abort")).toHaveLength(0);
  });

  it("enforces a supplied timeout locally and cleans all timer and signal listeners", async () => {
    vi.useFakeTimers();
    const pending = deferred<string | undefined>();
    let forwarded!: AbortSignal;
    const f = fixture({
      input: (_title, _placeholder, options) => {
        forwarded = options!.signal!;
        expect(options!.timeout).toBe(25);
        return pending.promise;
      },
    });
    const caller = new AbortController();
    const answer = f.ui.input("title", undefined, { timeout: 25, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(25);
    expect(await answer).toBeUndefined();
    expect(forwarded.aborted).toBe(true);
    expect(getEventListeners(f.child.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve("late answer");
    expect(await answer).toBeUndefined();
  });

  it("does not invent a timeout when one is omitted or zero", async () => {
    vi.useFakeTimers();
    const f = fixture({ input: () => new Promise(() => {}) });
    const first = f.ui.input("omitted");
    const second = f.ui.input("zero", undefined, { timeout: 0 });
    expect(vi.getTimerCount()).toBe(0);
    f.child.abort();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
  });

  it("cancels the timeout after a successful answer", async () => {
    vi.useFakeTimers();
    const f = fixture({ input: () => Promise.resolve("answered") });
    expect(await f.ui.input("title", undefined, { timeout: 100 })).toBe("answered");
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(f.child.signal, "abort")).toHaveLength(0);
  });

  it.each(["throw", "reject"])(
    "returns the default when the parent UI fails by %s",
    async (failure) => {
      const f = fixture({
        confirm: () => {
          if (failure === "throw") throw new Error("host unavailable");
          return Promise.reject(new Error("host unavailable"));
        },
      });
      expect(await f.ui.confirm("title", "message")).toBe(false);
      expect(getEventListeners(f.child.signal, "abort")).toHaveLength(0);
    },
  );

  it.each(["unavailable", "invalidate", "replaceGeneration"] as const)(
    "defaults new requests after the parent becomes %s",
    async (change) => {
      const input = vi.fn(() => Promise.resolve("unexpected"));
      const f = fixture({ input });
      f[change]();
      expect(await f.ui.input("title")).toBeUndefined();
      expect(input).not.toHaveBeenCalled();
      expect(createForwardedDialogUI(f.request, f.base)).toBeUndefined();
    },
  );

  it.each(["invalidate", "replaceGeneration"] as const)(
    "ignores an answer from a parent/task that became %s while pending",
    async (change) => {
      const pending = deferred<string | undefined>();
      const f = fixture({ input: () => pending.promise });
      const answer = f.ui.input("title");
      f[change]();
      pending.resolve("stale answer");
      expect(await answer).toBeUndefined();
    },
  );

  it("does not call the parent when the caller is already aborted", async () => {
    const input = vi.fn(() => Promise.resolve("unexpected"));
    const f = fixture({ input });
    const caller = new AbortController();
    caller.abort();
    expect(await f.ui.input("title", undefined, { signal: caller.signal })).toBeUndefined();
    expect(input).not.toHaveBeenCalled();
  });

  it("gets the parent's current UI for each request", async () => {
    const f = fixture({ input: () => Promise.resolve("first UI") });
    expect(await f.ui.input("title")).toBe("first UI");
    f.replaceUI({ input: () => Promise.resolve("rebound UI") });
    expect(await f.ui.input("title")).toBe("rebound UI");
  });

  it("keeps same-title questions from different children independent and permits out-of-order answers", async () => {
    const requests = [deferred<string | undefined>(), deferred<string | undefined>()];
    let count = 0;
    const input = vi.fn(() => requests[count++]!.promise);
    const first = fixture({ input });
    const second = fixture({ input });
    const firstAnswer = first.ui.input("same title");
    const secondAnswer = second.ui.input("same title");
    requests[1]!.resolve("second child");
    expect(await secondAnswer).toBe("second child");
    requests[0]!.resolve("first child");
    expect(await firstAnswer).toBe("first child");
  });

  it("does not cancel a peer question when one child is cancelled", async () => {
    const pending = deferred<string | undefined>();
    const signals: AbortSignal[] = [];
    const input: ExtensionUIContext["input"] = (_title, _placeholder, options) => {
      signals.push(options!.signal!);
      return pending.promise;
    };
    const first = fixture({ input });
    const second = fixture({ input });
    const firstAnswer = first.ui.input("same title");
    const secondAnswer = second.ui.input("same title");
    first.child.abort();
    expect(await firstAnswer).toBeUndefined();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    pending.resolve("second child");
    expect(await secondAnswer).toBe("second child");
  });

  it("retains child no-op methods instead of forwarding editor or presentation writes", async () => {
    const editor = vi.fn(() => Promise.resolve("unexpected"));
    const notify = vi.fn();
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const setTitle = vi.fn();
    const setEditorText = vi.fn();
    const f = fixture({ editor, notify, setStatus, setWidget, setTitle, setEditorText });
    expect(await f.ui.editor("title", "prefill")).toBeUndefined();
    f.ui.notify("message");
    f.ui.setStatus("status", "text");
    f.ui.setWidget("widget", ["text"]);
    f.ui.setTitle("title");
    f.ui.setEditorText("text");
    for (const method of [editor, notify, setStatus, setWidget, setTitle, setEditorText])
      expect(method).not.toHaveBeenCalled();
  });
});
