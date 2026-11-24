import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "@earendil-works/pi-ai";
import { ManagedCredentialStore, MAXIMUM_PERSONAL_CREDENTIAL_BYTES } from "./model-auth-store.js";

describe("bounded raw credential store", () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-raw-auth-"));
    path = join(directory, "auth.json");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const validate = (_id: string, value: unknown) => {
    if (!(value as { key?: string }).key) throw new Error("invalid personal record");
    return value as Credential;
  };
  it("does not open storage for administrator-owned reads", async () => {
    const store = new ManagedCredentialStore(directory, [], validate);
    await expect(store.read("admin")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });
  it("reads opaque strings and rejects invalid selected records without fallback", async () => {
    await writeFile(
      path,
      JSON.stringify({
        personal: { type: "api_key", key: "!literal $TOKEN" },
        broken: { type: "api_key" },
        admin: "uninterpreted",
      }),
    );
    const store = new ManagedCredentialStore(path, ["personal", "broken"], validate);
    await expect(store.read("personal")).resolves.toMatchObject({ key: "!literal $TOKEN" });
    await expect(store.read("broken")).rejects.toThrow(/invalid/);
    await expect(store.list()).resolves.toEqual([{ providerId: "personal", type: "api_key" }]);
  });
  it("bounds files and rejects nonregular or invalid UTF-8 sources", async () => {
    const store = new ManagedCredentialStore(path, ["personal"], validate);
    await writeFile(path, Buffer.from([0xff]));
    await expect(store.read("personal")).rejects.toThrow();
    await writeFile(path, " ".repeat(MAXIMUM_PERSONAL_CREDENTIAL_BYTES + 1));
    await expect(store.read("personal")).rejects.toThrow(/bounds/);
    await expect(
      new ManagedCredentialStore(directory, ["personal"], validate).read("personal"),
    ).rejects.toThrow(/bounds/);
  });
  it("read-only and unadmitted writes reject before backend creation", async () => {
    const backend = vi.fn();
    const store = new ManagedCredentialStore(path, ["personal"], validate, true, backend);
    await expect(store.delete("personal")).rejects.toThrow(/Read-only/);
    await expect(
      store.modify("admin", () => Promise.resolve({ type: "api_key", key: "new" })),
    ).rejects.toThrow(/administrator-managed/);
    expect(backend).not.toHaveBeenCalled();
  });
  it("locked mutations preserve unadmitted raw records", async () => {
    const untouched = { type: "unknown", key: "!command", arbitrary: ["$X"] };
    await writeFile(path, JSON.stringify({ admin: untouched }));
    const store = new ManagedCredentialStore(path, ["personal"], validate, false, () => ({
      async withLockAsync(callback) {
        const result = await callback(await readFile(path, "utf8"));
        if (result.next !== undefined) await writeFile(path, result.next);
        return result.result;
      },
    }));
    await store.modify("personal", () => Promise.resolve({ type: "api_key", key: "$literal" }));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      admin: untouched,
      personal: { type: "api_key", key: "$literal" },
    });
    await store.delete("personal");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ admin: untouched });
  });
  it("allows explicit login to repair an invalid record without refreshing or falling back on reads", async () => {
    const invalid = { type: "api_key" };
    await writeFile(path, JSON.stringify({ personal: invalid, unrelated: "untouched" }));
    const store = new ManagedCredentialStore(path, ["personal"], validate, false, () => ({
      async withLockAsync(callback) {
        const result = await callback(await readFile(path, "utf8"));
        if (result.next !== undefined) await writeFile(path, result.next);
        return result.result;
      },
    }));
    await expect(store.read("personal")).rejects.toThrow(/invalid/);
    const refresh = vi.fn((current: Credential | undefined) => {
      if (!current) throw new Error("Credential disappeared before refresh");
      return Promise.resolve(current);
    });
    await expect(store.modify("personal", refresh)).rejects.toThrow(/disappeared/);
    expect(refresh).toHaveBeenCalledWith(undefined);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ personal: invalid });
    await store.modify("personal", () => Promise.resolve({ type: "api_key", key: "replacement" }));
    await expect(store.read("personal")).resolves.toMatchObject({ key: "replacement" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ unrelated: "untouched" });
  });
});
