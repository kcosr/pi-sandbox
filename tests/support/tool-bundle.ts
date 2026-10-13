import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOOL_COMMAND_NAMES,
  type ToolBundle,
} from "../../packages/sandbox-extension/src/runtime/contracts.js";

/** Explicit test fixture input; production selection is compiled from the build manifest. */
export function selectedTestToolBundle(): ToolBundle | undefined {
  const root = process.env.PI_SANDBOX_TEST_TOOL_BUNDLE;
  if (root === undefined) return undefined;
  const inventory = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8")) as {
    files: { path: string }[];
  };
  const files = new Set(inventory.files.map((file) => file.path));
  return {
    root,
    commands: Object.fromEntries(
      TOOL_COMMAND_NAMES.filter((name) => files.has(`bin/${name}`)).map((name) => [
        name,
        join(root, "bin", name),
      ]),
    ),
  };
}
