import { describe, expect, it, vi } from "vitest";
import { createExportSource } from "./source.js";
import type { ExportOperation, ExportReply } from "./protocol.js";

describe("host-only export source ownership", () => {
  it("allows one reader and one pull at a time and releases ownership after close", async () => {
    let release!: (reply: ExportReply) => void;
    const request = vi.fn(async (operation: ExportOperation): Promise<ExportReply> => {
      if (operation.operation === "begin")
        return { operation: "begin", roots: [{ id: "home", label: "Home" }] };
      if (operation.operation === "read")
        return new Promise((resolve) => {
          release = resolve;
        });
      if (operation.operation === "end") return { operation: "end" };
      throw new Error("unexpected request");
    });
    const close = vi.fn(() => Promise.resolve());
    const source = createExportSource({
      writableHostPaths: [],
      connect: () => Promise.resolve({ request, close }),
    });
    const reader = await source.open();
    await expect(source.open()).rejects.toThrow("export_already_active");
    const pulling = reader.readChunk();
    await expect(reader.readChunk()).rejects.toThrow("export_request_already_active");
    expect(request.mock.calls.filter(([operation]) => operation.operation === "read")).toHaveLength(
      1,
    );
    release({ operation: "read", data: Buffer.from("hello").toString("base64") });
    expect(Buffer.from(await pulling).toString()).toBe("hello");
    await reader.close();
    expect(close).toHaveBeenCalledTimes(1);
    const again = await source.open();
    await again.close();
  });

  it("rejects an already cancelled save before connecting", async () => {
    const connect = vi.fn();
    const source = createExportSource({ writableHostPaths: [], connect });
    await expect(source.open(AbortSignal.abort())).rejects.toThrow("export_aborted");
    expect(connect).not.toHaveBeenCalled();
  });

  it("closing a reader aborts an in-flight listing before ending the remote session", async () => {
    const events: string[] = [];
    const request = (operation: ExportOperation, signal?: AbortSignal): Promise<ExportReply> => {
      events.push(operation.operation);
      if (operation.operation === "begin")
        return Promise.resolve({ operation: "begin", roots: [{ id: "home", label: "Home" }] });
      if (operation.operation === "list")
        return new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("export_aborted")), {
            once: true,
          });
        });
      if (operation.operation === "end") {
        expect(signal).toBeUndefined();
        return Promise.resolve({ operation: "end" });
      }
      return Promise.reject(new Error("unexpected request"));
    };
    const source = createExportSource({
      writableHostPaths: [],
      connect: () =>
        Promise.resolve({
          request,
          close: () => {
            events.push("close");
            return Promise.resolve();
          },
        }),
    });
    const reader = await source.open();
    const listing = reader.list("home", "");
    const rejected = expect(listing).rejects.toThrow("export_aborted");
    await reader.close();
    await rejected;
    expect(events).toEqual(["begin", "list", "end", "close"]);
  });

  it("ends an interrupted begin before releasing source ownership for another save", async () => {
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    let first = true;
    let remoteActive = false;
    const request = (operation: ExportOperation, signal?: AbortSignal): Promise<ExportReply> => {
      if (operation.operation === "begin") {
        expect(remoteActive).toBe(false);
        remoteActive = true;
        if (first) {
          first = false;
          return new Promise((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(new Error("export_aborted")), {
              once: true,
            });
            notify();
          });
        }
        return Promise.resolve({ operation: "begin", roots: [{ id: "home", label: "Home" }] });
      }
      if (operation.operation === "end") {
        expect(signal).toBeUndefined();
        remoteActive = false;
        return Promise.resolve({ operation: "end" });
      }
      return Promise.reject(new Error("unexpected request"));
    };
    const source = createExportSource({
      writableHostPaths: [],
      connect: () => Promise.resolve({ request, close: () => Promise.resolve() }),
    });
    const controller = new AbortController();
    const opening = source.open(controller.signal);
    await started;
    controller.abort();
    await expect(opening).rejects.toThrow("export_aborted");
    expect(remoteActive).toBe(false);
    const reader = await source.open();
    await reader.close();
    expect(remoteActive).toBe(false);
  });
});
