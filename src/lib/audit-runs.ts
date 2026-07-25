import { createHash } from "node:crypto";
import { getHelpdeskSchema } from "./supabase.js";

export type AuditRunStatus = "pending" | "sending" | "sent" | "failed" | "delivery_unknown";
export type ReportingPeriod = { start: Date; end: Date };
export type DeliveryPayload = { from: string; to: string; subject: string; html: string };
export type ClaimAuditRunInput = {
  organizationId: string;
  reportType: string;
  period: ReportingPeriod;
  recipient: string;
};
export type ClaimAuditRunResult =
  | { claimed: true; id: string; payloadHash: string | null }
  | { claimed: false; reason: "already_sent" | "in_progress" | "delivery_unknown" | "claim_failed" };

function table() {
  return getHelpdeskSchema().from("audit_runs");
}

export function normalizeRecipient(recipient: string): string {
  return recipient.trim().toLowerCase();
}

export function getUtcDayPeriod(now: Date = new Date()): ReportingPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export function stablePayloadHash(payload: DeliveryPayload): string {
  const canonical = JSON.stringify({
    from: payload.from,
    html: payload.html,
    subject: payload.subject,
    to: normalizeRecipient(payload.to),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function claimAuditRunSlot(input: ClaimAuditRunInput): Promise<ClaimAuditRunResult> {
  const recipient = normalizeRecipient(input.recipient);
  const periodStart = input.period.start.toISOString();
  const periodEnd = input.period.end.toISOString();
  const { data: inserted, error } = await table()
    .insert({
      organization_id: input.organizationId,
      report_type: input.reportType,
      reporting_period_start: periodStart,
      reporting_period_end: periodEnd,
      recipient,
      status: "pending",
      fingerprint: "",
      overall_severity: "pending",
      findings_count: 0,
      payload: {},
      idempotency_key: null,
      payload_hash: null,
    })
    .select("id, payload_hash")
    .maybeSingle();
  if (!error && inserted) {
    return { claimed: true, id: inserted.id as string, payloadHash: null };
  }
  if (error?.code !== "23505") return { claimed: false, reason: "claim_failed" };

  const { data: existing, error: fetchError } = await table()
    .select("id, status, payload_hash")
    .eq("organization_id", input.organizationId)
    .eq("report_type", input.reportType)
    .eq("reporting_period_start", periodStart)
    .eq("recipient", recipient)
    .maybeSingle();
  if (fetchError || !existing) return { claimed: false, reason: "claim_failed" };
  if (existing.status === "sent") return { claimed: false, reason: "already_sent" };
  if (existing.status === "delivery_unknown") return { claimed: false, reason: "delivery_unknown" };
  if (existing.status !== "failed") return { claimed: false, reason: "in_progress" };

  const { data: reclaimed, error: reclaimError } = await table()
    .update({ status: "pending", state_changed_at: new Date().toISOString(), last_error_message: null })
    .eq("id", existing.id as string)
    .eq("status", "failed")
    .select("id, payload_hash")
    .maybeSingle();
  if (reclaimError || !reclaimed) return { claimed: false, reason: "in_progress" };
  return {
    claimed: true,
    id: reclaimed.id as string,
    payloadHash: (reclaimed.payload_hash as string | null) ?? null,
  };
}

export async function markAuditRunSending(id: string, payload: DeliveryPayload, existingHash: string | null) {
  const payloadHash = stablePayloadHash(payload);
  if (existingHash && existingHash !== payloadHash) {
    return { ok: false as const, reason: "payload_conflict" as const, payloadHash };
  }
  const { data, error } = await table()
    .update({
      status: "sending",
      idempotency_key: `sla-audit/${id}`,
      payload_hash: payloadHash,
      payload_snapshot: payload,
      delivery_attempted_at: new Date().toISOString(),
      state_changed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  return { ok: !error && Boolean(data), reason: error ? "database_error" as const : "state_conflict" as const, payloadHash };
}

async function transition(
  id: string,
  expected: AuditRunStatus,
  next: AuditRunStatus,
  fields: Record<string, unknown> = {}
) {
  const { data, error } = await table()
    .update({ status: next, state_changed_at: new Date().toISOString(), ...fields })
    .eq("id", id)
    .eq("status", expected)
    .select("id")
    .maybeSingle();
  return { ok: !error && Boolean(data), error };
}

export function markAuditRunSent(id: string, providerMessageId: string | null) {
  return transition(id, "sending", "sent", {
    provider_message_id: providerMessageId,
    provider_confirmed_at: new Date().toISOString(),
    last_error_code: null,
    last_error_message: null,
  });
}

export function markAuditRunFailed(id: string, expected: "pending" | "sending", code: string, message: string) {
  return transition(id, expected, "failed", { last_error_code: code, last_error_message: message });
}

export function markDeliveryUnknown(id: string, code: string, message: string, providerMessageId: string | null = null) {
  return transition(id, "sending", "delivery_unknown", {
    last_error_code: code,
    last_error_message: message,
    provider_message_id: providerMessageId,
  });
}
