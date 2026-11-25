import type { AuditEvent } from "../audit/client.js";
import { exactKeys, isRecord } from "./json.js";

export const SERVICE_VERSION = 1;
export const POLICY_SCHEMA = 16;
export const MODEL_SCHEMA = "pi-1.5.0";
export type PolicyOrigin =
  { readonly source: "local" } | { readonly source: "service"; readonly revision: string };
export interface ServiceIdentity {
  readonly username: string;
  readonly machine_id?: string;
}
export interface ClientMetadata {
  readonly platform: "linux" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly application_version: string;
  readonly build_id: string;
}
export interface BootstrapResult {
  readonly policy: Record<string, unknown>;
  readonly overrides: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly models: Record<string, unknown>;
  readonly policy_revision: string;
}
export interface InspectionResult {
  readonly policy: Record<string, unknown>;
  readonly workspace_overrides: Record<string, unknown> | null;
}
export interface AuditHandle {
  readonly audit_session_id: string;
  readonly service_epoch: string;
  readonly audit_generation: number;
}
export interface AuditAcknowledgment extends AuditHandle {
  readonly next_sequence: number;
}
export interface OperationInputs {
  bootstrap: {
    readonly policy_schema: 16;
    readonly model_schema: "pi-1.5.0";
    readonly client: ClientMetadata;
  };
  policy_inspect: OperationInputs["bootstrap"];
  audit_open: {
    readonly client_instance_id: string;
    readonly audit_generation: number;
    readonly pi_session_id: string;
    readonly cwd: string;
    readonly policy_origin: PolicyOrigin;
  };
  audit_check: Pick<AuditHandle, "audit_session_id" | "service_epoch">;
  audit_event: OperationInputs["audit_check"] & {
    readonly sequence: number;
    readonly event: AuditEvent;
  };
  audit_close: OperationInputs["audit_check"] & { readonly sequence: number };
}
export interface OperationResults {
  bootstrap: BootstrapResult;
  policy_inspect: InspectionResult;
  audit_open: AuditAcknowledgment;
  audit_check: AuditHandle;
  audit_event: AuditAcknowledgment;
  audit_close: AuditAcknowledgment & { readonly closed: true };
}
export type ServiceOperation = keyof OperationInputs;
export interface ServiceTransport {
  request<K extends ServiceOperation>(
    operation: K,
    input: OperationInputs[K],
    timeoutMs?: number,
  ): Promise<OperationResults[K]>;
}
export const ERROR_STATUS = Object.freeze({
  authentication_required: 401,
  admission_denied: 403,
  invalid_request: 400,
  unsupported_version: 400,
  incompatible_client: 403,
  configuration_unavailable: 503,
  audit_disabled: 403,
  unknown_audit_session: 410,
  audit_out_of_order: 409,
  request_too_large: 413,
  audit_unavailable: 503,
  busy: 503,
});
export type ServiceErrorCode = keyof typeof ERROR_STATUS;
const ERROR_MESSAGES: Readonly<Record<ServiceErrorCode, string>> = {
  authentication_required: "Service authentication failed; contact the administrator",
  admission_denied: "The service did not admit this account or audit session",
  invalid_request: "The service rejected an invalid request",
  unsupported_version:
    "The service API version is incompatible; contact the administrator for a matching distribution",
  incompatible_client:
    "The service policy schema or platform is incompatible; contact the administrator for a matching distribution",
  configuration_unavailable:
    "Service configuration is unavailable or invalid; contact the administrator",
  audit_disabled: "The service does not admit new audit sessions",
  unknown_audit_session: "The audit session is no longer available",
  audit_out_of_order: "The service rejected the audit sequence or concurrent mutation",
  request_too_large: "The service request or response exceeds its size limit",
  audit_unavailable: "Audit delivery could not be confirmed",
  busy: "The service is busy or its request deadline expired",
};
export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    diagnostic = ERROR_MESSAGES[code],
  ) {
    super(`Managed service: ${diagnostic}`);
    this.name = "ServiceError";
  }
}
export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}
export function isText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    !/[\p{Cc}\uD800-\uDFFF]/u.test(value)
  );
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
export function parseServiceResponse<K extends ServiceOperation>(
  value: unknown,
  operation: K,
  requestId: string,
  status: number,
): OperationResults[K] {
  const invalid = (): never => {
    throw new Error("Managed service returned an invalid response");
  };
  if (!isIdentifier(requestId) || !isRecord(value) || value.version !== SERVICE_VERSION)
    return invalid();
  if (status !== 200) {
    if (
      !exactKeys(value, ["version", "error"], ["request_id"]) ||
      (value.request_id !== undefined && value.request_id !== requestId) ||
      !isRecord(value.error) ||
      !exactKeys(value.error, ["code", "message"]) ||
      !isText(value.error.message, 1024) ||
      typeof value.error.code !== "string" ||
      !Object.hasOwn(ERROR_STATUS, value.error.code) ||
      ERROR_STATUS[value.error.code as ServiceErrorCode] !== status
    )
      return invalid();
    const code = value.error.code as ServiceErrorCode;
    throw new ServiceError(
      code,
      code === "incompatible_client" || code === "unsupported_version"
        ? value.error.message
        : undefined,
    );
  }
  if (
    !exactKeys(value, ["version", "request_id", "operation", "result"]) ||
    value.request_id !== requestId ||
    value.operation !== operation ||
    !isRecord(value.result)
  )
    return invalid();
  const r = value.result;
  if (operation === "bootstrap") {
    if (
      !exactKeys(r, ["policy", "overrides", "environment", "models", "policy_revision"]) ||
      ![r.policy, r.overrides, r.environment, r.models].every(isRecord) ||
      !isIdentifier(r.policy_revision)
    )
      return invalid();
  } else if (operation === "policy_inspect") {
    if (
      !exactKeys(r, ["policy", "workspace_overrides"]) ||
      !isRecord(r.policy) ||
      (r.workspace_overrides !== null && !isRecord(r.workspace_overrides))
    )
      return invalid();
  } else {
    const fields = [
      "audit_session_id",
      "service_epoch",
      "audit_generation",
      ...(operation === "audit_check" ? [] : ["next_sequence"]),
      ...(operation === "audit_close" ? ["closed"] : []),
    ];
    if (
      !exactKeys(r, fields) ||
      !isIdentifier(r.audit_session_id) ||
      !isIdentifier(r.service_epoch) ||
      !positive(r.audit_generation) ||
      (operation !== "audit_check" && !positive(r.next_sequence)) ||
      (operation === "audit_close" && r.closed !== true)
    )
      return invalid();
  }
  return r as unknown as OperationResults[K];
}
