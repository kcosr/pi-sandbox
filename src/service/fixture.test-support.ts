import { AuditManager, type AuditEvent } from "../audit/client.js";
import {
  ServiceError,
  type AuditAcknowledgment,
  type OperationInputs,
  type OperationResults,
  type ServiceOperation,
  type ServiceTransport,
} from "./protocol.js";

export class FakeService implements ServiceTransport {
  readonly calls: Array<{ operation: ServiceOperation; input: OperationInputs[ServiceOperation] }> =
    [];
  readonly events: AuditEvent[] = [];
  readonly handles = new Map<
    string,
    Omit<AuditAcknowledgment, "next_sequence"> & { next_sequence: number; piSessionId: string }
  >();
  before?:
    | ((operation: ServiceOperation, input: OperationInputs[ServiceOperation]) => Promise<void>)
    | undefined;
  sink?: (event: AuditEvent) => Promise<void>;
  private serial = 0;
  async request<K extends ServiceOperation>(
    operation: K,
    input: OperationInputs[K],
  ): Promise<OperationResults[K]> {
    this.calls.push({ operation, input: structuredClone(input) });
    await this.before?.(operation, input);
    if (operation === "audit_open") {
      const open = input as OperationInputs["audit_open"];
      const event: AuditEvent = {
        event: "session_started",
        pi_session_id: open.pi_session_id,
        cwd: open.cwd,
      };
      this.events.push(event);
      await this.sink?.(event);
      const handle = {
        audit_session_id: (++this.serial).toString(16).padStart(32, "0"),
        service_epoch: "e".repeat(32),
        audit_generation: open.audit_generation,
        next_sequence: 1,
        piSessionId: open.pi_session_id,
      };
      this.handles.set(handle.audit_session_id, handle);
      const response = acknowledgment(handle);
      return response as OperationResults[K];
    }
    const address = input as OperationInputs["audit_event"];
    const handle = this.handles.get(address.audit_session_id);
    if (!handle) throw new ServiceError("unknown_audit_session");
    if (operation === "audit_check") {
      const response = {
        audit_session_id: handle.audit_session_id,
        service_epoch: handle.service_epoch,
        audit_generation: handle.audit_generation,
      };
      return response as OperationResults[K];
    }
    if (address.sequence !== handle.next_sequence) throw new ServiceError("audit_out_of_order");
    const event: AuditEvent =
      operation === "audit_close"
        ? { event: "session_ended", pi_session_id: handle.piSessionId }
        : address.event;
    this.events.push(event);
    await this.sink?.(event);
    handle.next_sequence++;
    const response = acknowledgment(handle);
    if (operation === "audit_close") this.handles.delete(handle.audit_session_id);
    return {
      ...response,
      ...(operation === "audit_close" ? { closed: true } : {}),
    } as OperationResults[K];
  }
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function createTestAuditClient(sink: (event: AuditEvent) => Promise<void>) {
  const service = new FakeService();
  service.sink = sink;
  return new AuditManager(service, "/work/project", { source: "local" });
}

function acknowledgment(handle: AuditAcknowledgment): AuditAcknowledgment {
  return {
    audit_session_id: handle.audit_session_id,
    service_epoch: handle.service_epoch,
    audit_generation: handle.audit_generation,
    next_sequence: handle.next_sequence,
  };
}
