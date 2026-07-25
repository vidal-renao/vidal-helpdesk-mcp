import { createHash } from "node:crypto";
import { Resend } from "resend";
import {
  claimAuditRunSlot,
  getUtcDayPeriod,
  markAuditRunFailed,
  markAuditRunSending,
  markAuditRunSent,
  markDeliveryUnknown,
  normalizeRecipient,
  type DeliveryPayload,
} from "./audit-runs.js";
import { auditTemplate } from "./audit-template.js";
import { getRuntimeEnv } from "./env.js";
import { logError, logInfo } from "./logger.js";
import { buildSlaAuditReport } from "./sla-audit.js";

const REPORT_TYPE = "sla_daily_audit";

export class AuditService {
  static async run({ requestId }: { requestId: string }) {
    const env = getRuntimeEnv({ requireAuditRuntime: true });
    const organizationId = env.MCP_ORGANIZATION_ID!;
    const recipient = normalizeRecipient(env.AUDIT_RECIPIENT_EMAIL || "htcpacoxo31@gmail.com");
    if (!env.AUDIT_EMAIL_ENABLED) return skipped(organizationId, "disabled");

    const period = getUtcDayPeriod();
    const claim = await claimAuditRunSlot({ organizationId, reportType: REPORT_TYPE, period, recipient });
    if (!claim.claimed) {
      event("info", requestId, organizationId, `Claim rejected: ${claim.reason}`);
      return skipped(organizationId, claim.reason);
    }

    let phase: "pending" | "sending" = "pending";
    try {
      const report = await buildSlaAuditReport(organizationId, period.start, period);
      const payload: DeliveryPayload = {
        from: env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev",
        to: recipient,
        subject: `VIDAL Daily SLA Report: ${report.compliance_percentage}% compliance - ${period.start.toISOString().slice(0, 10)}`,
        html: auditTemplate(report),
      };
      const prepared = await markAuditRunSending(claim.id, payload, claim.payloadHash);
      if (!prepared.ok) {
        await markAuditRunFailed(claim.id, "pending", prepared.reason, "Delivery payload or state conflict");
        throw new Error(prepared.reason === "payload_conflict" ? "Stable delivery payload conflict" : "Could not enter sending state");
      }
      phase = "sending";
      const idempotencyKey = `sla-audit/${claim.id}`;
      event("info", requestId, organizationId, "Email delivery started", claim.id, idempotencyKey);

      const outcome = await send(env.RESEND_API_KEY!, payload, idempotencyKey);
      if (outcome.kind === "rejected") {
        await markAuditRunFailed(claim.id, "sending", outcome.code, outcome.message);
        return result(report, claim.id, false, "send_rejected", outcome.message);
      }
      if (outcome.kind === "unknown") {
        await markDeliveryUnknown(claim.id, outcome.code, outcome.message);
        event("error", requestId, organizationId, "Delivery unknown; manual reconciliation required", claim.id, idempotencyKey);
        return result(report, claim.id, false, "delivery_unknown", outcome.message);
      }

      let persisted = false;
      for (let attempt = 0; attempt < 3 && !persisted; attempt += 1) {
        persisted = (await markAuditRunSent(claim.id, outcome.messageId)).ok;
      }
      if (!persisted) {
        await markDeliveryUnknown(claim.id, "sent_persistence_failed", "Provider confirmed but sent state could not be persisted", outcome.messageId);
        event("error", requestId, organizationId, "Provider confirmed; persistence failed; manual reconciliation required", claim.id, idempotencyKey);
        return result(report, claim.id, false, "delivery_unknown", "Provider confirmed; local state persistence failed");
      }
      event("info", requestId, organizationId, "Provider confirmed and sent state persisted", claim.id, idempotencyKey);
      return result(report, claim.id, true, null, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown audit error";
      if (phase === "pending") await markAuditRunFailed(claim.id, "pending", "pre_provider_failure", message);
      else await markDeliveryUnknown(claim.id, "unexpected_after_sending", message);
      throw error;
    }
  }
}

async function send(apiKey: string, payload: DeliveryPayload, idempotencyKey: string) {
  try {
    const { data, error } = await new Resend(apiKey).emails.send(payload, { idempotencyKey });
    if (error) return { kind: "rejected" as const, code: error.name, message: error.message };
    return { kind: "confirmed" as const, messageId: data?.id ?? null };
  } catch (error) {
    return {
      kind: "unknown" as const,
      code: "provider_response_unknown",
      message: error instanceof Error ? error.message : "Provider response unknown",
    };
  }
}

function result(report: Awaited<ReturnType<typeof buildSlaAuditReport>>, id: string, emailSent: boolean, skippedReason: string | null, emailError: string | null) {
  return {
    success: true,
    generatedAt: report.generated_at,
    organizationId: report.organization_id,
    organizationName: report.organization_name,
    stats: {
      compliance: report.compliance_percentage,
      totalTickets: report.active_ticket_count,
      companyCount: report.company_count,
      vipRiskCount: report.vip_risk_count,
    },
    auditRun: { id, claimed: true, skippedReason },
    emailSent,
    emailSkippedReason: skippedReason,
    emailError,
  };
}

function skipped(organizationId: string, reason: string) {
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    organizationId,
    organizationName: null,
    stats: { compliance: 0, totalTickets: 0, companyCount: 0, vipRiskCount: 0 },
    auditRun: { id: null, claimed: false, skippedReason: reason },
    emailSent: false,
    emailSkippedReason: reason,
    emailError: null,
  };
}

function event(level: "info" | "error", requestId: string, organizationId: string, message: string, auditRunId?: string, idempotencyKey?: string) {
  const suffix = auditRunId
    ? ` audit_run_id=${auditRunId} idempotency_key_hash=${createHash("sha256").update(idempotencyKey ?? "").digest("hex").slice(0, 16)}`
    : "";
  const fields = {
    requestId,
    organizationId,
    workflow: "audit-cron" as const,
    httpStatus: null,
    supabaseErrorCode: null,
    resendErrorCode: null,
    message: `${message}${suffix}`,
  };
  level === "info" ? logInfo(fields) : logError(fields);
}
