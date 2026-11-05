export interface ExportFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface ExportAuditBase {
  readonly operationId: string;
  readonly sessionId: string;
  readonly destination: string;
}

export type UserExportAuditEvent = ExportAuditBase &
  (
    | {
        readonly type: "export_intent";
        readonly roots: readonly string[];
        readonly entryCount: number;
        readonly fileCount: number;
        readonly totalBytes: number;
        readonly manifestDigest: string;
      }
    | {
        readonly type: "export_complete";
        readonly savedFiles: number;
        readonly savedBytes: number;
        readonly failedFiles: number;
        readonly notSavedFiles: number;
        readonly cancelled: boolean;
        readonly error?: string;
      }
    | {
        readonly type: "export_replace_intent";
        readonly path: string;
        readonly prior: ExportFileIdentity;
      }
    | {
        readonly type: "export_replace_complete";
        readonly path: string;
        readonly prior: ExportFileIdentity;
        readonly outcome: "saved" | "failed";
        readonly error?: string;
      }
  );

export type ExportAudit = (event: UserExportAuditEvent) => Promise<void>;

export interface ExportFileOutcome {
  readonly path: string;
  readonly status: "saved" | "failed" | "not_saved";
  readonly bytes: number;
  readonly sha256?: string;
  readonly error?: string;
}

export interface ExportResult {
  readonly operationId: string;
  readonly destination: string;
  readonly outcomes: readonly ExportFileOutcome[];
  readonly cancelled: boolean;
  readonly error?: string;
}
