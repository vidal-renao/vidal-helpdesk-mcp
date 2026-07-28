import { describe, expect, it } from "vitest";

import { classifyAuditDelivery } from "../src/lib/audit-outcome.js";

describe("classifyAuditDelivery", () => {
  it("treats a confirmed send as delivered", () => {
    expect(classifyAuditDelivery({ emailSent: true, emailSkippedReason: null })).toEqual({
      delivered: true,
      httpStatus: 200,
      outcome: "delivered",
    });
  });

  it("treats a verified already_sent row as delivered without resending", () => {
    expect(classifyAuditDelivery({ emailSent: false, emailSkippedReason: "already_sent" })).toEqual({
      delivered: true,
      httpStatus: 200,
      outcome: "already_sent",
    });
  });

  // The exact production outage: the ledger was unreachable (PGRST106), the
  // claim failed, nothing was sent, and the endpoint answered 200 anyway.
  it("fails claim_failed instead of reporting a successful no-op", () => {
    const verdict = classifyAuditDelivery({ emailSent: false, emailSkippedReason: "claim_failed" });
    expect(verdict.delivered).toBe(false);
    expect(verdict.httpStatus).toBe(500);
    expect(verdict.outcome).toBe("claim_failed");
  });

  it("fails when audit email delivery is switched off", () => {
    const verdict = classifyAuditDelivery({ emailSent: false, emailSkippedReason: "disabled" });
    expect(verdict.delivered).toBe(false);
    expect(verdict.httpStatus).toBe(503);
  });

  it("fails a concurrent in-progress claim with a conflict status", () => {
    const verdict = classifyAuditDelivery({ emailSent: false, emailSkippedReason: "in_progress" });
    expect(verdict.delivered).toBe(false);
    expect(verdict.httpStatus).toBe(409);
  });

  it.each([
    "delivery_unknown",
    "send_rejected",
    "pre_provider_failure",
    "delivery_state_unconfirmed",
    "manual_reconciliation_required",
    "state_persistence_failed",
  ])("fails the %s outcome", (reason) => {
    const verdict = classifyAuditDelivery({ emailSent: false, emailSkippedReason: reason });
    expect(verdict.delivered).toBe(false);
    expect(verdict.httpStatus).toBe(500);
  });

  it("fails closed on an unrecognised or missing reason rather than defaulting to success", () => {
    expect(classifyAuditDelivery({}).delivered).toBe(false);
    expect(classifyAuditDelivery({ emailSent: false }).delivered).toBe(false);
    expect(classifyAuditDelivery({ emailSkippedReason: "a_reason_added_in_the_future" })).toMatchObject({
      delivered: false,
      httpStatus: 500,
    });
  });

  it("never treats a truthy-but-not-true emailSent value as a delivery", () => {
    expect(classifyAuditDelivery({ emailSent: "yes" as unknown as boolean }).delivered).toBe(false);
    expect(classifyAuditDelivery({ emailSent: 1 as unknown as boolean }).delivered).toBe(false);
  });
});
