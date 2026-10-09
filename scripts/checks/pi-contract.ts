/** Compile only against the patched build's declarations, never the published Pi package. */
import type {
  createCodemodeExtension,
  createMcpExtension,
  ExtensionFactory,
  main,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ManagedCodemodeOptions } from "../../src/codemode/index.js";
import type { ManagedMcpFactory, ManagedMcpOptions } from "../../src/mcp/runtime.js";
import type {
  ManagedMain,
  ManagedMainOptions,
  ManagedModelRuntimeFactory,
  ManagedModelRuntimeOptions,
} from "../../src/runtime/main.js";

type Assert<T extends true> = T;
type Assignable<From, To> = 0 extends 1 & (From | To) ? false : [From] extends [To] ? true : false;
type KeysKnown<From, To> = 0 extends 1 & (From | To)
  ? false
  : Exclude<keyof From, keyof To> extends never
    ? true
    : false;

type PiMain = NonNullable<Parameters<typeof main>[1]>;
type PiInlineExtension = Exclude<
  NonNullable<PiMain["extensionFactories"]>[number],
  ExtensionFactory
>;
type PiModels = NonNullable<Parameters<typeof ModelRuntime.create>[0]>;
type PiCodemode = NonNullable<Parameters<typeof createCodemodeExtension>[0]>;
type PiMcp = NonNullable<Parameters<typeof createMcpExtension>[0]>;
type PiManagement = Extract<NonNullable<PiMcp["management"]>, object>;
type PiCatalogAdapter = NonNullable<PiMcp["adaptTools"]>;
type PiServerObserver = NonNullable<PiMcp["onServerState"]>;
type ManagedConfig = ReturnType<ManagedMcpOptions["loadConfig"]>;
type PiConfig = ReturnType<NonNullable<PiMcp["loadConfig"]>>;

// Assignability checks values and callback variance; key checks also reject silently
// ignored options. In particular, optional nested keys can disappear without making
// otherwise structurally compatible functions or objects unassignable.
export type ManagedPiContract = [
  Assert<Assignable<typeof main, ManagedMain>>,
  Assert<Assignable<ManagedMainOptions, PiMain>>,
  Assert<KeysKnown<ManagedMainOptions, PiMain>>,
  Assert<KeysKnown<ManagedMainOptions["extensionFactories"][number], PiInlineExtension>>,
  Assert<
    KeysKnown<
      Parameters<ManagedMainOptions["beforeRun"]>[0],
      Parameters<NonNullable<PiMain["beforeRun"]>>[0]
    >
  >,
  Assert<Assignable<ManagedModelRuntimeOptions, PiModels>>,
  Assert<KeysKnown<ManagedModelRuntimeOptions, PiModels>>,
  Assert<Assignable<ManagedModelRuntimeFactory, NonNullable<PiMain["createModelRuntime"]>>>,
  Assert<Assignable<ManagedCodemodeOptions, PiCodemode>>,
  Assert<KeysKnown<ManagedCodemodeOptions, PiCodemode>>,
  Assert<
    KeysKnown<ManagedCodemodeOptions["executionLimits"], NonNullable<PiCodemode["executionLimits"]>>
  >,
  Assert<Assignable<typeof createMcpExtension, ManagedMcpFactory>>,
  Assert<Assignable<ManagedMcpOptions, PiMcp>>,
  Assert<KeysKnown<ManagedMcpOptions, PiMcp>>,
  Assert<KeysKnown<ManagedMcpOptions["management"], PiManagement>>,
  Assert<
    KeysKnown<
      Parameters<ManagedMcpOptions["management"]["updateConfig"]>[1],
      Parameters<PiManagement["updateConfig"]>[1]
    >
  >,
  Assert<KeysKnown<ManagedConfig, PiConfig>>,
  Assert<KeysKnown<ManagedConfig["servers"][number], PiConfig["servers"][number]>>,
  Assert<Assignable<Parameters<PiCatalogAdapter>, Parameters<ManagedMcpOptions["adaptTools"]>>>,
  Assert<Assignable<ReturnType<ManagedMcpOptions["adaptTools"]>, ReturnType<PiCatalogAdapter>>>,
  Assert<Assignable<Parameters<PiServerObserver>, Parameters<ManagedMcpOptions["onServerState"]>>>,
];
