import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeService, deferred } from "../service/fixture.test-support.js";
import { ServiceError } from "../service/protocol.js";
import { AuditManager, type AuditEvent } from "./client.js";
import { createExportAudit } from "./exports.js";
const event: AuditEvent = {
  event: "tool_requested",
  pi_session_id: "pi-1",
  invocation_id: "call",
  tool: "bash",
  boundary: "bubblewrap",
};
function fixture() {
  const service = new FakeService();
  const client = new AuditManager(service, "/workspace", { source: "local" });
  return { service, client };
}
afterEach(() => vi.useRealTimers());
describe("audit generations and explicit reconnection", () => {
  it("keeps startup usable, gates tools, and reconnects only on explicit submission", async () => {
    const { service, client } = fixture();
    service.before = () => Promise.reject(new Error("offline"));
    await client.setSession("pi-1");
    await expect(client.captureInvocation("pi-1")).rejects.toThrow("resubmit");
    expect(service.calls).toHaveLength(1);
    service.before = undefined;
    const binding = await client.checkpoint();
    await client.submit(binding, event);
    expect(service.calls.map((x) => x.operation)).toEqual([
      "audit_open",
      "audit_open",
      "audit_event",
    ]);
    expect(service.calls[1]!.input).toMatchObject({ audit_generation: 2 });
  });
  it("serializes acknowledgments without replay and invalidates all queued work on failure", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    const binding = await client.captureInvocation("pi-1");
    const hold = deferred();
    service.before = async (op) => {
      if (op === "audit_event") await hold.promise;
    };
    const first = client.submit(binding, event);
    const second = client.submit(binding, event);
    const results = Promise.allSettled([first, second]);
    expect(service.calls.filter((x) => x.operation === "audit_event")).toHaveLength(1);
    hold.reject(new Error("lost ACK"));
    expect((await results).every((x) => x.status === "rejected")).toBe(true);
    service.before = undefined;
    const recovered = await client.checkpoint();
    await expect(client.submit(binding, event)).rejects.toThrow();
    await client.submit(recovered, event);
    expect(service.calls.filter((x) => x.operation === "audit_event")).toHaveLength(2);
    expect(service.events.filter((x) => x.event === "tool_requested")).toHaveLength(1);
  });
  it("shares concurrent checkpoints and opens exactly once after server restart", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    service.handles.clear();
    const hold = deferred();
    service.before = async (op) => {
      if (op === "audit_check") await hold.promise;
    };
    const a = client.checkpoint(),
      b = client.checkpoint();
    expect(a).toBe(b);
    hold.resolve();
    expect(await a).toBe(await b);
    expect(service.calls.map((x) => x.operation)).toEqual([
      "audit_open",
      "audit_check",
      "audit_open",
    ]);
  });
  it("does not retry authentication or ordinary audit-check failures", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    service.before = () => Promise.reject(new ServiceError("authentication_required"));
    await expect(client.checkpoint()).rejects.toThrow();
    expect(service.calls.map((x) => x.operation)).toEqual(["audit_open", "audit_check"]);
    await expect(client.captureInvocation("pi-1")).rejects.toThrow();
  });
  it("rejects a successful check invalidated by a concurrent event failure", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    const binding = await client.captureInvocation("pi-1");
    const hold = deferred();
    service.before = async (op) => {
      if (op === "audit_check") await hold.promise;
      if (op === "audit_event") throw new Error("sink");
    };
    const checkpoint = client.checkpoint();
    const result = Promise.allSettled([checkpoint]);
    await expect(client.submit(binding, event)).rejects.toThrow();
    hold.resolve();
    expect((await result)[0].status).toBe("rejected");
    expect(client.diagnostics().connected).toBe(false);
  });
  it("fences an in-flight open across a session change", async () => {
    const { service, client } = fixture();
    const hold = deferred();
    service.before = async (op, input) => {
      if (op === "audit_open" && "pi_session_id" in input && input.pi_session_id === "pi-1")
        await hold.promise;
    };
    const start = client.setSession("pi-1");
    await client.setSession("pi-2");
    hold.resolve();
    await start;
    const binding = await client.captureInvocation("pi-2");
    expect(binding.piSessionId).toBe("pi-2");
    await expect(client.captureInvocation("pi-1")).rejects.toThrow();
  });
  it("does not let an old late event failure poison a replacement session", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    const old = await client.captureInvocation("pi-1");
    const hold = deferred();
    service.before = async (op, input) => {
      if (op === "audit_event" && "event" in input && input.event.pi_session_id === "pi-1")
        await hold.promise;
    };
    const pending = client.submit(old, event);
    const result = Promise.allSettled([pending]);
    await client.setSession("pi-2");
    hold.reject(new Error("old socket"));
    await result;
    expect(service.calls.some((x) => x.operation === "audit_close")).toBe(false);
    const current = await client.captureInvocation("pi-2");
    await client.submit(current, { ...event, pi_session_id: "pi-2" });
    expect(client.isCurrent(current)).toBe(true);
  });
  it("preserves failure across session switches until an explicit checkpoint", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    const old = await client.captureInvocation("pi-1");
    service.before = () => Promise.reject(new Error("sink"));
    await expect(client.submit(old, event)).rejects.toThrow();
    service.before = undefined;
    await client.setSession("pi-2");
    expect(service.calls).toHaveLength(2);
    await expect(client.captureInvocation("pi-2")).rejects.toThrow();
    expect((await client.checkpoint()).piSessionId).toBe("pi-2");
  });
  it("bounds queue residence and detaches the whole generation on expiry", async () => {
    vi.useFakeTimers();
    const { service, client } = fixture();
    await client.setSession("pi-1");
    const binding = await client.captureInvocation("pi-1");
    const hold = deferred();
    service.before = async (op) => {
      if (op === "audit_event") await hold.promise;
    };
    const first = client.submit(binding, event),
      second = client.submit(binding, event);
    const results = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(client.isCurrent(binding)).toBe(false);
    hold.resolve();
    expect((await results).every((x) => x.status === "rejected")).toBe(true);
  });
  it("bounds queued events, captures immutable inputs and assigns sequence only at dispatch", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    const binding = await client.captureInvocation("pi-1");
    const hold = deferred();
    service.before = async (op) => {
      if (op === "audit_event") await hold.promise;
    };
    const mutable = { ...event, path: "/original" };
    const work = [client.submit(binding, mutable)];
    mutable.path = "/changed";
    for (let i = 1; i < 65; i++) work.push(client.submit(binding, event));
    const results = Promise.allSettled(work);
    hold.resolve();
    expect((await results).every((x) => x.status === "rejected")).toBe(true);
    expect(service.calls[1]!.input).toMatchObject({ sequence: 1, event: { path: "/original" } });
    expect(service.calls.filter((x) => x.operation === "audit_event")).toHaveLength(1);
  });
  it("closes only idle handles and never reopens after process shutdown", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    await client.close();
    await client.close();
    expect(service.calls.map((x) => x.operation)).toEqual(["audit_open", "audit_close"]);
    await expect(client.checkpoint()).rejects.toThrow();
  });
  it("checks export readiness once per reviewed publication and keeps the resulting binding", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    const audit = await createExportAudit(client, "pi-1");
    await audit({
      type: "export_intent",
      sessionId: "pi-1",
      operationId: "save",
      destination: "/out",
      roots: ["home"],
      entryCount: 0,
      fileCount: 0,
      totalBytes: 0,
      manifestDigest: "a".repeat(64),
    });
    await client.setSession("pi-2");
    await expect(
      audit({
        type: "export_complete",
        sessionId: "pi-1",
        operationId: "save",
        destination: "/out",
        savedFiles: 0,
        savedBytes: 0,
        failedFiles: 0,
        notSavedFiles: 0,
        cancelled: false,
      }),
    ).rejects.toThrow();
    expect(service.calls.filter((x) => x.operation === "audit_check")).toHaveLength(1);
  });
  it("rejects a delayed export confirmation from an outgoing session without rebinding", async () => {
    const { service, client } = fixture();
    await client.setSession("pi-1");
    await client.setSession("pi-2");
    const binding = await client.captureInvocation("pi-2");
    const calls = service.calls.length;
    await expect(createExportAudit(client, "pi-1")).rejects.toThrow("resubmit");
    expect(service.calls).toHaveLength(calls);
    expect(client.isCurrent(binding)).toBe(true);
    await createExportAudit(client, "pi-2");
    expect(service.calls.at(-1)?.operation).toBe("audit_check");
  });
  it.each([
    { path: "/bad\0path" },
    { path: "/bad\ud800" },
    { path: "/" + "x".repeat(4096) },
    { command: "x\0", command_truncated: false },
    { repository: "x".repeat(8193), extension: "git" },
    { child_id: "alone" },
    { child_id: "child", child_task_id: "task", child_session_id: "s".repeat(257) },
  ])("rejects invalid metadata without losing the handle: %j", async (metadata) => {
    const { client } = fixture();
    await client.setSession("pi-1");
    const binding = await client.captureInvocation("pi-1");
    await expect(client.submit(binding, { ...event, ...metadata })).rejects.toThrow(
      "Invalid audit event",
    );
    await client.submit(binding, event);
  });
  it.each(["x".repeat(4097), "\n".repeat(2049)])(
    "bounds escaped command bytes",
    async (command) => {
      const { client } = fixture();
      await client.setSession("pi-1");
      const binding = await client.captureInvocation("pi-1");
      await expect(
        client.submit(binding, { ...event, command, command_truncated: false }),
      ).rejects.toThrow("size limit");
    },
  );
});
