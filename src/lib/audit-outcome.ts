/**
 * Single source of truth for "did the daily audit actually deliver?".
 *
 * Phase 4A.16: every scheduled run between 2026-07-26 and 2026-07-28 answered
 * HTTP 200 while sending nothing, because api/cron/audit.ts returned 200 for
 * any outcome AuditService did not throw on, and .github/workflows/audit.yml
 * asserted nothing beyond the status code. Two independent layers therefore
 * reported success for a total no-op. This module makes the logical outcome
 * -- not the absence of an exception -- decide the HTTP status, so both the
 * workflow and any future caller fail loudly on a silent no-op.
 */

export type AuditDeliveryPayload = {
  emailSent?: boolean;
  emailSkippedReason?: string | null;
};

export type AuditDeliveryVerdict = {
  delivered: boolean;
  httpStatus: number;
  /** Stable, log-safe machine reason. Never contains recipient or payload data. */
  outcome: string;
};

/**
 * The only two states that prove today's report is accounted for:
 *
 *  - emailSent === true          the provider accepted this run's send.
 *  - already_sent                claimAuditRunSlot re-read the persisted row and
 *                                found status='sent' for the exact
 *                                (organization, report_type, period_start,
 *                                recipient) idempotency key. That is a verified
 *                                prior delivery, not an assumption.
 *
 * Everything else -- disabled, claim_failed, in_progress, delivery_unknown,
 * send_rejected, pre_provider_failure, delivery_state_unconfirmed,
 * manual_reconciliation_required -- is an operational failure and must not be
 * reported as success.
 */
export function classifyAuditDelivery(payload: AuditDeliveryPayload): AuditDeliveryVerdict {
  if (payload.emailSent === true) {
    return { delivered: true, httpStatus: 200, outcome: "delivered" };
  }

  const reason = payload.emailSkippedReason ?? "unknown";

  if (reason === "already_sent") {
    return { delivered: true, httpStatus: 200, outcome: "already_sent" };
  }

  // Deliberately explicit rather than a catch-all, so a newly introduced skip
  // reason lands on the safe branch (500) instead of silently passing.
  if (reason === "disabled") {
    return { delivered: false, httpStatus: 503, outcome: "disabled" };
  }

  if (reason === "in_progress") {
    return { delivered: false, httpStatus: 409, outcome: "in_progress" };
  }

  return { delivered: false, httpStatus: 500, outcome: reason };
}
