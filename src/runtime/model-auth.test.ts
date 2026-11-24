import { describe, expect, it } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import { validatePersonalCredential } from "./model-auth.js";

const provider = (id: string) => ({ id, auth: { apiKey: {}, oauth: {} } }) as Provider;
const validate = (id: string, value: unknown, env: Record<string, string> = {}) =>
  validatePersonalCredential(provider(id), value, env, false);

describe("literal personal credential admission", () => {
  it.each(["$HOST_KEY", "${HOST_KEY}", "!touch /should-never-exist"])("keeps %s literal", (key) => {
    expect(validate("custom", { type: "api_key", key })).toEqual({ type: "api_key", key });
  });
  it("rejects arbitrary environment and unknown raw fields", () => {
    expect(() =>
      validate("custom", { type: "api_key", key: "x", env: { HTTP_PROXY: "http://evil" } }),
    ).toThrow();
    expect(() => validate("custom", { type: "api_key", key: "x", endpoint: "evil" })).toThrow();
  });
  it("admits only explicit AWS choices", () => {
    expect(
      validate("amazon-bedrock", { type: "api_key", env: { AWS_PROFILE: "personal" } }),
    ).toMatchObject({ env: { AWS_PROFILE: "personal" } });
    expect(() => validate("amazon-bedrock", { type: "api_key" })).toThrow(/explicit/);
    expect(() =>
      validate("amazon-bedrock", {
        type: "api_key",
        env: { AWS_PROFILE: "personal", AWS_REGION: "user-region" },
      }),
    ).toThrow();
  });
  it("requires native Google routing repeats to match administrative values", () => {
    const record = {
      type: "api_key",
      env: {
        GOOGLE_CLOUD_PROJECT: "project",
        GOOGLE_CLOUD_LOCATION: "region",
        GOOGLE_APPLICATION_CREDENTIALS: "/personal.json",
      },
    };
    expect(
      validate("google-vertex", record, {
        GOOGLE_CLOUD_PROJECT: "project",
        GOOGLE_CLOUD_LOCATION: "region",
      }),
    ).toEqual(record);
    expect(() =>
      validate("google-vertex", record, {
        GOOGLE_CLOUD_PROJECT: "other",
        GOOGLE_CLOUD_LOCATION: "region",
      }),
    ).toThrow(/cannot change/);
    expect(() => validate("google-vertex", record)).toThrow(/administrative/);
  });
  it("validates native OAuth fields without interpreting tokens", () => {
    const token = {
      type: "oauth",
      access: "!literal",
      refresh: "$literal",
      expires: 10,
      clientId: "native",
      scopes: ["api"],
    };
    expect(validate("openai", token)).toEqual(token);
    expect(() => validate("openai", { ...token, scopes: "api" })).toThrow();
    expect(() =>
      validate("openai", { ...token, env: { PI_OAUTH_CALLBACK_HOST: "evil" } }),
    ).toThrow();
    expect(() =>
      validate("openai-codex", { type: "oauth", access: "a", refresh: "r", expires: 10 }),
    ).toThrow();
  });
  it("accepts native Copilot model metadata and bounds its optional array", () => {
    const record = {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 10,
      availableModelIds: ["gpt-4.1", "claude-sonnet"],
    };
    expect(validate("github-copilot", record)).toEqual(record);
    expect(() => validate("github-copilot", { ...record, availableModelIds: "wrong" })).toThrow();
    expect(() => validate("github-copilot", { ...record, availableModelIds: [false] })).toThrow();
    expect(() =>
      validate("github-copilot", { ...record, availableModelIds: Array(4097).fill("model") }),
    ).toThrow();
  });
  it.each(["openai", "openai-codex"])(
    "validates Radius independently of the %s native OAuth shape",
    (id) => {
      const record = { type: "oauth", access: "a", refresh: "r", expires: 10, scope: "api" };
      expect(validatePersonalCredential(provider(id), record, {}, true)).toEqual(record);
      expect(() =>
        validatePersonalCredential(provider(id), { ...record, clientId: "native" }, {}, true),
      ).toThrow();
    },
  );
});
