import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createManagedModelRuntimeFactory,
  validateManagedModelConfiguration,
} from "./model-runtime.js";

const models = {
  providers: {
    custom: {
      api: "openai-completions",
      baseUrl: "https://example.test",
      apiKey: "$KEY",
      headers: { "X-User": "$USER" },
      models: [{ id: "one" }],
    },
  },
};
afterEach(() => vi.restoreAllMocks());
describe("managed model runtime factory", () => {
  it.each([
    "modelsPath",
    "modelsConfig",
    "credentials",
    "authPolicy",
    "authContext",
    "modelsStore",
    "authPath",
  ])("rejects caller %s before constructing a runtime", async (name) => {
    const create = vi.spyOn(ModelRuntime, "create");
    const factory = createManagedModelRuntimeFactory({
      models,
      environment: {},
      personalProviders: [],
    });
    await expect(factory({ [name]: "override" })).rejects.toThrow(/override/);
    expect(create).not.toHaveBeenCalled();
  });
  it("captures object source and Pi environment across recreations", async () => {
    const environment = { KEY: "managed", USER: "managed-user" };
    const source = structuredClone(models);
    const fake = { getError: () => undefined, refresh: vi.fn(async () => {}) };
    const create = vi
      .spyOn(ModelRuntime, "create")
      .mockResolvedValue(fake as unknown as ModelRuntime);
    const factory = createManagedModelRuntimeFactory({
      models: source,
      environment,
      personalProviders: [],
    });
    environment.KEY = "changed";
    source.providers.custom.apiKey = "changed";
    await factory({ refreshOnCreate: false, readOnlyCredentials: true });
    await factory({ refreshOnCreate: false });
    const first = create.mock.calls[0]![0] as unknown as {
      modelsConfig: unknown;
      authPolicy: { environment: Record<string, string> };
      includeBuiltinCatalog: boolean;
    };
    expect(first.modelsConfig).toEqual(models);
    expect(first.authPolicy.environment).toEqual({ KEY: "managed", USER: "managed-user" });
    expect(first.includeBuiltinCatalog).toBe(false);
    expect(create.mock.calls[1]![0]).toMatchObject({
      modelsConfig: models,
      allowModelNetwork: false,
    });
  });
  it("static catalog validation does not consult personal state", async () => {
    const create = vi
      .spyOn(ModelRuntime, "create")
      .mockResolvedValue({ getError: () => "bad catalog" } as ModelRuntime);
    await expect(validateManagedModelConfiguration(models, ["custom"])).rejects.toThrow(
      /bad catalog/,
    );
    expect(create.mock.calls[0]![0]).toMatchObject({
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  });
  it("rejects malformed administrative Google JSON even with personal admission", () => {
    expect(() =>
      createManagedModelRuntimeFactory({
        models,
        environment: { GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"external_account"}' },
        personalProviders: ["custom"],
      }),
    ).toThrow(/service-account/);
  });
});
