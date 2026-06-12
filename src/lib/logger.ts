export type AuditWorkflow = "audit-cron";

export type LogFields = {
  requestId: string;
  organizationId: string | null;
  workflow: AuditWorkflow;
  httpStatus: number | null;
  supabaseErrorCode: string | null;
  resendErrorCode: string | null;
  message: string;
  durationMs?: number;
  emailSent?: boolean;
  auditRunPersisted?: boolean;
};

export function logInfo(fields: LogFields): void {
  writeLog("info", fields);
}

export function logError(fields: LogFields): void {
  writeLog("error", fields);
}

function writeLog(level: "info" | "error", fields: LogFields): void {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      ...fields,
    })}\n`
  );
}
