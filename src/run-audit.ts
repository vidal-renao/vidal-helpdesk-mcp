import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Force-load .env so our values win over any system-level COMPOSIO_API_KEY
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
try {
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    process.env[key] = value;
  }
} catch {
  // .env not found — rely on whatever env is already set
}

import { auditSlaSchema, auditSlaTickets } from "./tools/audit-sla.js";

function validateAuditEnv() {
  const required = [
    "COMPOSIO_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "MCP_ORGANIZATION_ID",
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

async function main() {
  validateAuditEnv();

  const input = auditSlaSchema.parse({
    riskWindowHours: Number(process.env.AUDIT_RISK_WINDOW_HOURS ?? 4),
    overdueThresholdHours: Number(process.env.AUDIT_OVERDUE_THRESHOLD_HOURS ?? 24),
    escalationThresholdHours: Number(process.env.AUDIT_ESCALATION_THRESHOLD_HOURS ?? 48),
    notifyEmail: process.env.AUDIT_NOTIFY_EMAIL !== "false",
    createGithubIssue: process.env.AUDIT_CREATE_GITHUB_ISSUE === "true",
    minRepeatedTicketsForIssue: Number(
      process.env.AUDIT_MIN_REPEATED_TICKETS_FOR_ISSUE ?? 3
    ),
    dryRun: process.env.AUDIT_DRY_RUN === "true",
    includeRca: process.env.AUDIT_INCLUDE_RCA !== "false",
    prepareWebhookPayloads: process.env.AUDIT_PREPARE_WEBHOOK_PAYLOADS !== "false",
  });

  const result = await auditSlaTickets(input);
  const parsed = JSON.parse(result) as {
    success: boolean;
    summary?: string;
    notifications?: { email?: string | null; github?: string | null };
  };

  if (parsed.summary) {
    console.log(`[AUDIT] ${parsed.summary}`);
  }
  if (parsed.notifications?.email) {
    console.log(`[AUDIT] Email notification: ${parsed.notifications.email}`);
  }
  if (parsed.notifications?.github) {
    console.log(`[AUDIT] GitHub action: ${parsed.notifications.github}`);
  }

  console.log(result);
}

main().catch((error) => {
  console.error("Audit failed:", error);
  process.exit(1);
});
