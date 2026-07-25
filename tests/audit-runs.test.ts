import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";

const mocks = vi.hoisted(() => ({
  getHelpdeskSchema: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  getHelpdeskSchema: mocks.getHelpdeskSchema,
}));

const period = { start: new Date("2026-07-21T00:00:00.000Z"), end: new Date("2026-07-22T00:00:00.000Z") };
const baseInput = { organizationId: "org-123", reportType: "sla_daily_audit", period, recipient: "ops@example.com" };

describe("claimAuditRunSlot", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("wins the claim outright when no row exists yet for the period", async () => {
    const { claimAuditRunSlot } = await import("../src/lib/audit-runs.js");

    const from = createFromQueue([{ table: "audit_runs", query: createQuery({ data: { id: "run-1" }, error: null }) }]);
    mocks.getHelpdeskSchema.mockReturnValue({ from });

    const result = await claimAuditRunSlot(baseInput);

    expect(result).toMatchObject({ claimed: true, id: "run-1", retry: false, payloadHash: null });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("reports already_sent without reclaiming when the existing row was already sent", async () => {
    const { claimAuditRunSlot } = await import("../src/lib/audit-runs.js");

    const from = createFromQueue([
      { table: "audit_runs", query: createQuery({ data: null, error: { code: "23505", message: "duplicate key" } }) },
      { table: "audit_runs", query: createQuery({ data: { id: "run-1", status: "sent", updated_at: new Date().toISOString() }, error: null }) },
    ]);
    mocks.getHelpdeskSchema.mockReturnValue({ from });

    const result = await claimAuditRunSlot(baseInput);

    expect(result).toEqual({ claimed: false, reason: "already_sent" });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("reclaims and succeeds when the existing row previously failed", async () => {
    const { claimAuditRunSlot } = await import("../src/lib/audit-runs.js");

    const from = createFromQueue([
      { table: "audit_runs", query: createQuery({ data: null, error: { code: "23505", message: "duplicate key" } }) },
      { table: "audit_runs", query: createQuery({ data: { id: "run-1", status: "failed", updated_at: new Date().toISOString() }, error: null }) },
      { table: "audit_runs", query: createQuery({ data: { id: "run-1" }, error: null }) },
    ]);
    mocks.getHelpdeskSchema.mockReturnValue({ from });

    const result = await claimAuditRunSlot(baseInput);

    expect(result).toMatchObject({ claimed: true, id: "run-1", retry: true, payloadHash: null });
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("reports in_progress and does not reclaim a fresh (non-stale) pending row", async () => {
    const { claimAuditRunSlot } = await import("../src/lib/audit-runs.js");

    const from = createFromQueue([
      { table: "audit_runs", query: createQuery({ data: null, error: { code: "23505", message: "duplicate key" } }) },
      { table: "audit_runs", query: createQuery({ data: { id: "run-1", status: "pending", updated_at: new Date().toISOString() }, error: null }) },
    ]);
    mocks.getHelpdeskSchema.mockReturnValue({ from });

    const result = await claimAuditRunSlot(baseInput);

    expect(result).toEqual({ claimed: false, reason: "in_progress" });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("does not reclaim a stale pending row automatically", async () => {
    const { claimAuditRunSlot } = await import("../src/lib/audit-runs.js");

    const staleTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
    const from = createFromQueue([
      { table: "audit_runs", query: createQuery({ data: null, error: { code: "23505", message: "duplicate key" } }) },
      { table: "audit_runs", query: createQuery({ data: { id: "run-1", status: "pending", updated_at: staleTimestamp }, error: null }) },
    ]);
    mocks.getHelpdeskSchema.mockReturnValue({ from });

    const result = await claimAuditRunSlot(baseInput);

    expect(result).toEqual({ claimed: false, reason: "in_progress" });
  });

  it("loses the race when a concurrent process already reclaimed the failed row", async () => {
    const { claimAuditRunSlot } = await import("../src/lib/audit-runs.js");

    const from = createFromQueue([
      { table: "audit_runs", query: createQuery({ data: null, error: { code: "23505", message: "duplicate key" } }) },
      { table: "audit_runs", query: createQuery({ data: { id: "run-1", status: "failed", updated_at: new Date().toISOString() }, error: null }) },
      // The conditional UPDATE ... WHERE status = 'failed' matches zero rows because another
      // process already flipped it to 'pending' first.
      { table: "audit_runs", query: createQuery({ data: null, error: null }) },
    ]);
    mocks.getHelpdeskSchema.mockReturnValue({ from });

    const result = await claimAuditRunSlot(baseInput);

    expect(result).toEqual({ claimed: false, reason: "in_progress" });
  });

  it("treats a different reporting period as an independent slot", async () => {
    const { claimAuditRunSlot } = await import("../src/lib/audit-runs.js");

    const from = createFromQueue([{ table: "audit_runs", query: createQuery({ data: { id: "run-2" }, error: null }) }]);
    mocks.getHelpdeskSchema.mockReturnValue({ from });

    const nextDay = { start: new Date("2026-07-22T00:00:00.000Z"), end: new Date("2026-07-23T00:00:00.000Z") };
    const result = await claimAuditRunSlot({ ...baseInput, period: nextDay });

    expect(result).toMatchObject({ claimed: true, id: "run-2", retry: false, payloadHash: null });
  });

  it("treats a different recipient as an independent slot", async () => {
    const { claimAuditRunSlot } = await import("../src/lib/audit-runs.js");

    const from = createFromQueue([{ table: "audit_runs", query: createQuery({ data: { id: "run-3" }, error: null }) }]);
    mocks.getHelpdeskSchema.mockReturnValue({ from });

    const result = await claimAuditRunSlot({ ...baseInput, recipient: "someone-else@example.com" });

    expect(result).toMatchObject({ claimed: true, id: "run-3", retry: false, payloadHash: null });
  });
});

describe("getUtcDayPeriod", () => {
  it("returns the UTC midnight-to-midnight window containing the given instant", async () => {
    const { getUtcDayPeriod } = await import("../src/lib/audit-runs.js");

    const period = getUtcDayPeriod(new Date("2026-07-21T23:59:59.000Z"));

    expect(period.start.toISOString()).toBe("2026-07-21T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-07-22T00:00:00.000Z");
  });

  it("normalizes recipients and hashes stable payloads deterministically", async () => {
    const { normalizeRecipient, stablePayloadHash } = await import("../src/lib/audit-runs.js");
    const payload = { from: "audit@example.com", to: " OPS@Example.com ", subject: "Daily", html: "<p>Stable</p>" };
    expect(normalizeRecipient(payload.to)).toBe("ops@example.com");
    expect(stablePayloadHash(payload)).toBe(stablePayloadHash({ ...payload }));
    expect(stablePayloadHash(payload)).not.toBe(stablePayloadHash({ ...payload, html: "<p>Changed</p>" }));
  });
});
