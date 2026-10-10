export type ManagedToolFailure = "cancelled" | "timeout" | "error";

/** A trusted execution outcome; message text and untrusted tool payloads never select it. */
export class ManagedToolExecutionError extends Error {
  public constructor(public readonly code: ManagedToolFailure) {
    super(
      `Managed tool ${code === "error" ? "failed" : code === "timeout" ? "timed out" : "cancelled"}`,
    );
    this.name = "ManagedToolExecutionError";
  }
}
