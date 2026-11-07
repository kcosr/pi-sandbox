import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ManagedChildInvocation {
  readonly childId: string;
  readonly childTaskId: string;
  readonly childSessionId: string;
  readonly label: string;
  readonly rootContext: ExtensionContext;
  readonly isCurrent: () => boolean;
  readonly setActivity: (activity: string) => void;
  readonly beforeApproval?: () => void;
}

const activeChild = new AsyncLocalStorage<ManagedChildInvocation>();

export function currentManagedChild(): ManagedChildInvocation | undefined {
  return activeChild.getStore();
}

export function withManagedChild<T>(child: ManagedChildInvocation, invoke: () => T): T {
  if (!child.isCurrent()) throw new Error("Subagent task is no longer active");
  return activeChild.run(child, invoke);
}

export function assertCurrentManagedChild(): void {
  const child = currentManagedChild();
  if (child !== undefined && !child.isCurrent())
    throw new Error("Subagent task is no longer active");
}
