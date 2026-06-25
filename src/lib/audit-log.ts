import { appendFileSync } from "fs";
import { join } from "path";

const LOG_PATH = join(process.cwd(), "audit.log");

export function writeAuditLog(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>
) {
  const line = [
    new Date().toISOString(),
    level,
    message,
    meta ? JSON.stringify(meta) : "",
  ]
    .filter(Boolean)
    .join(" | ");

  appendFileSync(LOG_PATH, `${line}\n`, "utf8");
}
