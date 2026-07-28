import { Resend } from "resend";
import {
  claimAuditRunSlot,
  getUtcDayPeriod,
  markAuditRunFailed,
  markAuditRunSending,
  markAuditRunSent,
  markDeliveryUnknown,
  normalizeRecipient,
  stablePayloadHash,
  type AuditRunStatus,
  type DeliveryPayload,
} from "./audit-runs.js";
import { auditTemplate } from "./audit-template.js";
import { getRuntimeEnv } from "./env.js";
import { logError, logInfo } from "./logger.js";
import { classifyResendException, classifyResendResponse } from "./resend-outcome.js";
import { buildSlaAuditReport, type SlaAuditReport } from "./sla-audit.js";

const REPORT_TYPE = "sla_daily_audit";

type OperationalState = {
  effectiveDeliveryOutcome: "not_attempted" | "definitive_failure" | "ambiguous_delivery" | "provider_confirmed";
  persistedDeliveryState: AuditRunStatus;
  persistenceConfirmed: boolean;
  manualReconciliationRequired: boolean;
};

export class AuditService {
  static async run({ requestId }: { requestId: string }) {
    const env = getRuntimeEnv({ requireAuditRuntime: true });
    const organizationId = env.MCP_ORGANIZATION_ID!;
    const recipient = normalizeRecipient(env.AUDIT_RECIPIENT_EMAIL || "htcpacoxo31@gmail.com");
    if (!env.AUDIT_EMAIL_ENABLED) return skipped(organizationId, "disabled", false);

    const period = getUtcDayPeriod();
    const claim = await claimAuditRunSlot({ organizationId, reportType: REPORT_TYPE, period, recipient });
    if (!claim.claimed) {
      // claim_failed means the ledger itself is unreachable or misconfigured --
      // that is an incident, not routine bookkeeping, so it is logged at error
      // level with the underlying database error code attached (Phase 4A.16).
      const level = claim.reason === "claim_failed" ? "error" : "info";
      const detail = claim.errorCode ? ` (db error: ${claim.errorCode})` : "";
      event(level, requestId, organizationId, `Claim rejected: ${claim.reason}${detail}`);
      return skipped(organizationId, claim.reason, true, claim.errorCode ?? null);
    }

    let report: SlaAuditReport | null = null;
    let payload: DeliveryPayload;
    const idempotencyKey = claim.idempotencyKey ?? `sla-audit/${claim.id}`;

    if (claim.retry) {
      if (
        !claim.payloadSnapshot ||
        !claim.payloadHash ||
        claim.idempotencyKey !== `sla-audit/${claim.id}` ||
        stablePayloadHash(claim.payloadSnapshot) !== claim.payloadHash
      ) {
        event("error", requestId, organizationId, "Retry blocked: persisted delivery snapshot is missing or invalid", {
          auditRunId: claim.id,
          idempotencyKey,
          deliveryOutcome: "not_attempted",
          persistenceConfirmed: true,
        });
        return result(null, claim.id, false, "manual_reconciliation_required", "Persisted snapshot is missing or invalid", {
          effectiveDeliveryOutcome: "not_attempted",
          persistedDeliveryState: "pending",
          persistenceConfirmed: true,
          manualReconciliationRequired: true,
        });
      }
      payload = claim.payloadSnapshot;
    } else {
      try {
        report = await buildSlaAuditReport(organizationId, period.start, period);
        payload = {
          from: env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev",
          to: recipient,
          subject: `VIDAL Daily SLA Report: ${report.compliance_percentage}% compliance - ${period.start.toISOString().slice(0, 10)}`,
          html: auditTemplate(report),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Audit report generation failed";
        const failed = await markAuditRunFailed(claim.id, "pending", "pre_provider_failure", message);
        if (!failed.ok) {
          event("error", requestId, organizationId, "Could not persist pre-provider failure", {
            auditRunId: claim.id,
            idempotencyKey,
            deliveryOutcome: "not_attempted",
            persistenceConfirmed: false,
          });
        }
        throw error;
      }
    }

    const prepared = await markAuditRunSending(claim.id, payload, claim.payloadHash, claim.retry);
    if (!prepared.ok) {
      const failed = await markAuditRunFailed(claim.id, "pending", prepared.reason, "Delivery payload or state conflict");
      return result(report, claim.id, false, "pre_provider_failure", "Could not enter sending state", {
        effectiveDeliveryOutcome: "not_attempted",
        persistedDeliveryState: failed.ok ? "failed" : "pending",
        persistenceConfirmed: failed.ok,
        manualReconciliationRequired: !failed.ok,
      });
    }

    event("info", requestId, organizationId, "Email delivery started", {
      auditRunId: claim.id,
      idempotencyKey,
      deliveryOutcome: "not_attempted",
      persistenceConfirmed: true,
    });

    const outcome = await send(env.RESEND_API_KEY!, payload, idempotencyKey);
    if (outcome.kind === "definitive_failure") {
      const failed = await markAuditRunFailed(claim.id, "sending", outcome.code, outcome.message);
      return result(report, claim.id, false, failed.ok ? "send_rejected" : "state_persistence_failed", outcome.message, {
        effectiveDeliveryOutcome: "definitive_failure",
        persistedDeliveryState: failed.ok ? "failed" : "sending",
        persistenceConfirmed: failed.ok,
        manualReconciliationRequired: !failed.ok,
      });
    }

    if (outcome.kind === "ambiguous_delivery") {
      const unknown = await markDeliveryUnknown(claim.id, outcome.code, outcome.message);
      event("error", requestId, organizationId, "Delivery outcome ambiguous; manual reconciliation required", {
        auditRunId: claim.id,
        idempotencyKey,
        deliveryOutcome: "ambiguous_delivery",
        persistenceConfirmed: unknown.ok,
      });
      return result(report, claim.id, false, "delivery_unknown", outcome.message, {
        effectiveDeliveryOutcome: "ambiguous_delivery",
        persistedDeliveryState: unknown.ok ? "delivery_unknown" : "sending",
        persistenceConfirmed: unknown.ok,
        manualReconciliationRequired: true,
      });
    }

    event("info", requestId, organizationId, "Provider confirmed delivery", {
      auditRunId: claim.id,
      providerMessageId: outcome.messageId,
      idempotencyKey,
      deliveryOutcome: "provider_confirmed",
      persistenceConfirmed: false,
    });

    let sentPersisted = false;
    for (let attempt = 0; attempt < 3 && !sentPersisted; attempt += 1) {
      sentPersisted = (await markAuditRunSent(claim.id, outcome.messageId)).ok;
    }
    if (sentPersisted) {
      event("info", requestId, organizationId, "Provider confirmation persisted", {
        auditRunId: claim.id,
        providerMessageId: outcome.messageId,
        idempotencyKey,
        deliveryOutcome: "provider_confirmed",
        persistenceConfirmed: true,
      });
      return result(report, claim.id, true, null, null, {
        effectiveDeliveryOutcome: "provider_confirmed",
        persistedDeliveryState: "sent",
        persistenceConfirmed: true,
        manualReconciliationRequired: false,
      });
    }

    const unknown = await markDeliveryUnknown(
      claim.id,
      "sent_persistence_failed",
      "Provider confirmed but sent state could not be persisted",
      outcome.messageId
    );
    event("error", requestId, organizationId, "Provider confirmed; database reconciliation required", {
      auditRunId: claim.id,
      providerMessageId: outcome.messageId,
      idempotencyKey,
      deliveryOutcome: "provider_confirmed",
      persistenceConfirmed: unknown.ok,
    });
    return result(report, claim.id, false, "delivery_state_unconfirmed", "Provider confirmed; local state persistence failed", {
      effectiveDeliveryOutcome: "provider_confirmed",
      persistedDeliveryState: unknown.ok ? "delivery_unknown" : "sending",
      persistenceConfirmed: unknown.ok,
      manualReconciliationRequired: true,
    });
  }
}

async function send(apiKey: string, payload: DeliveryPayload, idempotencyKey: string) {
  try {
    const { data, error } = await new Resend(apiKey).emails.send(payload, { idempotencyKey });
    return classifyResendResponse(data, error);
  } catch (error) {
    return classifyResendException(error);
  }
}

function result(
  report: SlaAuditReport | null,
  id: string,
  emailSent: boolean,
  skippedReason: string | null,
  emailError: string | null,
  operationalState: OperationalState
) {
  return {
    success: true,
    generatedAt: report?.generated_at ?? null,
    organizationId: report?.organization_id ?? null,
    organizationName: report?.organization_name ?? null,
    stats: report
      ? { compliance: report.compliance_percentage, totalTickets: report.active_ticket_count, companyCount: report.company_count, vipRiskCount: report.vip_risk_count }
      : null,
    auditRun: { id, claimed: true, skippedReason },
    emailSent,
    emailEnabled: true,
    emailSkippedReason: skippedReason,
    emailError,
    effectiveDeliveryOutcome: operationalState.effectiveDeliveryOutcome,
    persistedDeliveryState: operationalState.persistedDeliveryState,
    persistenceConfirmed: operationalState.persistenceConfirmed,
    manualReconciliationRequired: operationalState.manualReconciliationRequired,
  };
}

function skipped(organizationId: string, reason: string, emailEnabled = true, claimErrorCode: string | null = null) {
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    organizationId,
    organizationName: null,
    stats: { compliance: 0, totalTickets: 0, companyCount: 0, vipRiskCount: 0 },
    auditRun: { id: null, claimed: false, skippedReason: reason },
    emailSent: false,
    emailEnabled,
    emailSkippedReason: reason,
    emailError: null,
    claimErrorCode,
  };
}

function event(
  level: "info" | "error",
  requestId: string,
  organizationId: string,
  message: string,
  evidence: {
    auditRunId?: string;
    providerMessageId?: string | null;
    idempotencyKey?: string;
    deliveryOutcome?: string;
    persistenceConfirmed?: boolean;
  } = {}
) {
  const fields = {
    requestId,
    organizationId,
    workflow: "audit-cron" as const,
    httpStatus: null,
    supabaseErrorCode: null,
    resendErrorCode: null,
    message,
    ...evidence,
  };
  level === "info" ? logInfo(fields) : logError(fields);
}
