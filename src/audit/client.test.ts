import type * as FsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FsPromises>()),
  lstat: vi.fn(),
}));
import { lstat } from "node:fs/promises";
import { connectAuditClient, type AuditClient } from "./client.js";

const event = { event: "session_started", pi_session_id: "pi-1", cwd: "/workspace" } as const;
const acknowledgment = `${JSON.stringify({ version: 1, ok: true, audit_session_id: "audit-1" })}\n`;
let directory: string;
let server: Server | undefined;
let client: AuditClient | undefined;
const sockets = new Set<Socket>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-audit-client-"));
  vi.mocked(lstat).mockImplementation((path) =>
    Promise.resolve({
      uid: 0,
      mode: String(path).endsWith("audit.sock") ? 0o666 : 0o755,
      isSocket: () => String(path).endsWith("audit.sock"),
      isSymbolicLink: () => false,
      isDirectory: () => !String(path).endsWith("audit.sock"),
    } as Awaited<ReturnType<typeof lstat>>),
  );
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function listen(handler: (socket: Socket) => void) {
  const path = join(directory, "audit.sock");
  server = createServer((socket) => {
    sockets.add(socket);
    handler(socket);
  });
  await new Promise<void>((resolve) => server!.listen(path, resolve));
  return path;
}

describe("audit client", () => {
  it.each([
    { path: "/bad\0path" },
    { path: "/bad\ud800path" },
    { path: "/" + "x".repeat(4096) },
    { command: "pwd\0", command_truncated: false },
    { command: "pwd\ud800", command_truncated: false },
    { repository: "x".repeat(8193), extension: "git-clone" },
  ])("rejects invalid metadata locally without poisoning the connection", async (metadata) => {
    const received: unknown[] = [];
    const path = await listen((socket) =>
      socket.on("data", (data) => {
        received.push(JSON.parse(data.toString()));
        socket.write(acknowledgment);
      }),
    );
    client = await connectAuditClient(path);
    await expect(
      client.submit({
        event: "tool_requested",
        pi_session_id: "pi-1",
        tool: "bash",
        invocation_id: "call-1",
        ...metadata,
      }),
    ).rejects.toThrow("Invalid audit event");
    await client.submit(event);
    expect(received).toEqual([{ version: 1, event }]);
  });

  it("serializes submissions and waits for fragmented acknowledgments", async () => {
    const requests: unknown[] = [];
    const path = await listen((socket) =>
      socket.on("data", (data) => {
        requests.push(JSON.parse(data.toString()));
        socket.write(acknowledgment.slice(0, 10));
        setTimeout(() => socket.write(acknowledgment.slice(10)), 5);
      }),
    );
    client = await connectAuditClient(path);
    await Promise.all([client.submit(event), client.submit(event)]);
    expect(requests).toEqual([
      { version: 1, event },
      { version: 1, event },
    ]);
  });

  it.each([
    '{"version":1,"ok":false,"code":"syslog_unavailable"}\n',
    '{"version":1,"ok":true,"audit_session_id":"a","extra":true}\n',
    "not json\n",
    acknowledgment + acknowledgment,
    "x".repeat(4097),
  ])("poisons the client after a rejected or malformed response", async (response) => {
    let requests = 0;
    const path = await listen((socket) =>
      socket.on("data", () => {
        requests++;
        socket.write(response);
      }),
    );
    client = await connectAuditClient(path);
    await expect(client.submit(event)).rejects.toThrow();
    await expect(client.submit(event)).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("rejects changed collector session identity", async () => {
    let count = 0;
    const path = await listen((socket) =>
      socket.on("data", () => {
        socket.write(count++ ? acknowledgment.replace("audit-1", "audit-2") : acknowledgment);
      }),
    );
    client = await connectAuditClient(path);
    await client.submit(event);
    await expect(client.submit(event)).rejects.toThrow("session changed");
  });

  it("rejects disconnection before acknowledgement", async () => {
    const path = await listen((socket) => socket.on("data", () => socket.destroy()));
    client = await connectAuditClient(path);
    await expect(client.submit(event)).rejects.toThrow("connection closed");
  });

  it("bounds command bytes before sending", async () => {
    let received = false;
    const path = await listen((socket) =>
      socket.on("data", () => {
        received = true;
      }),
    );
    client = await connectAuditClient(path);
    await expect(client.submit({ ...event, command: "é".repeat(2049) })).rejects.toThrow(
      "command exceeds",
    );
    expect(received).toBe(false);
  });

  it("bounds escaped command text bytes before sending", async () => {
    const path = await listen(() => {});
    client = await connectAuditClient(path);
    await expect(client.submit({ ...event, command: "\n".repeat(2049) })).rejects.toThrow(
      "command exceeds",
    );
  });

  it("fails a missing acknowledgment at the deadline without retrying", async () => {
    const path = await listen(() => {});
    client = await connectAuditClient(path);
    vi.useFakeTimers();
    const submitted = client.submit(event);
    const rejection = expect(submitted).rejects.toThrow("acknowledgment timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    await expect(client.submit(event)).rejects.toThrow("acknowledgment timed out");
  });

  it("bounds the whole request before sending", async () => {
    const path = await listen(() => {});
    client = await connectAuditClient(path);
    await expect(client.submit({ ...event, path: "x".repeat(32_768) })).rejects.toThrow(
      "request exceeds",
    );
  });

  it("rejects symlink sockets and non-normalized paths", async () => {
    vi.mocked(lstat).mockResolvedValue({
      uid: 0,
      mode: 0o666,
      isSocket: () => true,
      isSymbolicLink: () => true,
      isDirectory: () => false,
    } as Awaited<ReturnType<typeof lstat>>);
    await expect(connectAuditClient(join(directory, "audit.sock"))).rejects.toThrow(
      "root-owned Unix socket",
    );
    await expect(connectAuditClient("/run/../run/audit.sock")).rejects.toThrow("normalized");
  });

  it("rejects writable ancestors before connecting", async () => {
    vi.mocked(lstat).mockResolvedValue({
      uid: 0,
      mode: 0o777,
      isSocket: () => true,
      isSymbolicLink: () => false,
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof lstat>>);
    await expect(connectAuditClient(join(directory, "audit.sock"))).rejects.toThrow(
      "protected directories",
    );
  });
});
