import type { AuditClient, AuditEvent } from "./client.js";
import type { ExportAudit, UserExportAuditEvent } from "../exports/contracts.js";

type Details<T> = T extends unknown ? Omit<T, "type" | "sessionId"> : never;
export type UserExportAuditDetails = Details<UserExportAuditEvent>;
export const EXPORT_AUDIT_EVENTS = [
  "export_intent",
  "export_complete",
  "export_replace_intent",
  "export_replace_complete",
] as const;

export function createExportAudit(client: AuditClient): ExportAudit {
  return async ({ type, sessionId, ...details }) => {
    await client.submit({ event: type, pi_session_id: sessionId, user_export: details });
  };
}

/** Keep the export authority separate from model-tool events on the wire. */
export function validExportAuditEvent(
  event: AuditEvent,
  text: (value: unknown, max: number) => boolean,
): boolean {
  if (!EXPORT_AUDIT_EVENTS.includes(event.event as (typeof EXPORT_AUDIT_EVENTS)[number]))
    return false;
  if (Object.keys(event).some((key) => !["event", "pi_session_id", "user_export"].includes(key)))
    return false;
  if (!text(event.pi_session_id, 256)) return false;
  const details = event.user_export as unknown;
  if (!record(details)) return false;
  const common = ["operationId", "destination"];
  if (!text(details.operationId, 256) || !absolute(details.destination, text)) return false;
  const exact = (required: string[], optional: string[] = []) =>
    [...common, ...required].every((key) => Object.hasOwn(details, key)) &&
    Object.keys(details).every((key) => [...common, ...required, ...optional].includes(key));
  const count = (name: string, max = 100_000) =>
    Number.isSafeInteger(details[name]) &&
    (details[name] as number) >= 0 &&
    (details[name] as number) <= max;
  if (event.event === "export_intent")
    return (
      exact(["roots", "entryCount", "fileCount", "totalBytes", "manifestDigest"]) &&
      Array.isArray(details.roots) &&
      details.roots.length > 0 &&
      details.roots.length <= 2 &&
      new Set(details.roots).size === details.roots.length &&
      details.roots.every((root) => root === "home" || root === "tmp") &&
      count("entryCount") &&
      count("fileCount") &&
      (details.fileCount as number) <= (details.entryCount as number) &&
      count("totalBytes", 4 * 1024 ** 3) &&
      typeof details.manifestDigest === "string" &&
      /^[a-f0-9]{64}$/.test(details.manifestDigest)
    );
  if (event.event === "export_complete")
    return (
      exact(["savedFiles", "savedBytes", "failedFiles", "notSavedFiles", "cancelled"], ["error"]) &&
      count("savedFiles") &&
      count("savedBytes", 4 * 1024 ** 3) &&
      count("failedFiles") &&
      count("notSavedFiles") &&
      typeof details.cancelled === "boolean" &&
      (details.error === undefined || text(details.error, 1024))
    );
  const complete = event.event === "export_replace_complete";
  if (!exact(["path", "prior", ...(complete ? ["outcome"] : [])], complete ? ["error"] : []))
    return false;
  if (
    !text(details.path, 4096) ||
    typeof details.path !== "string" ||
    details.path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return false;
  const prior = details.prior;
  if (
    !record(prior) ||
    Object.keys(prior).length !== 5 ||
    !["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
      (key) => typeof prior[key] === "string" && /^-?[0-9]{1,30}$/.test(prior[key]),
    )
  )
    return false;
  if (["dev", "ino", "size"].some((key) => (prior[key] as string).startsWith("-"))) return false;
  return (
    !complete ||
    (["saved", "failed"].includes(details.outcome as string) &&
      (details.error === undefined || text(details.error, 1024)))
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function absolute(value: unknown, text: (value: unknown, max: number) => boolean): boolean {
  return text(value, 4096) && typeof value === "string" && value.startsWith("/");
}
