import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";

const mocks = vi.hoisted(() => ({
  getDomainSchema: vi.fn(),
  getPublicSchema: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  getDomainSchema: mocks.getDomainSchema,
  getPublicSchema: mocks.getPublicSchema,
}));

const period = { start: new Date("2026-07-21T00:00:00.000Z"), end: new Date("2026-07-22T00:00:00.000Z") };
const now = new Date("2026-07-21T12:00:00.000Z");

function ticket(overrides: Record<string, unknown>) {
  return {
    id: `ticket-${Math.random()}`,
    ticket_number: 1,
    title: "Sample ticket",
    status: "open",
    priority: "medium",
    review_status: "not_requested",
    sla_breached: false,
    sla_response_breached: false,
    sla_resolution_breached: false,
    resolution_due_at: null,
    response_due_at: null,
    sla_resolution_due: null,
    sla_first_response_due: null,
    first_response_at: null,
    first_agent_response_at: null,
    created_by: null,
    assigned_to: "agent-1",
    created_at: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

function resolvedTicket(overrides: Record<string, unknown>) {
  return {
    id: `resolved-${Math.random()}`,
    status: "resolved",
    created_at: "2026-07-18T08:00:00.000Z",
    resolved_at: "2026-07-19T08:00:00.000Z",
    closed_at: null,
    first_response_at: null,
    first_agent_response_at: null,
    resolution_due_at: null,
    response_due_at: null,
    sla_resolution_due: null,
    sla_first_response_due: null,
    ...overrides,
  };
}

function setupSchemas(
  tickets: unknown[],
  customers: unknown[] = [],
  organization: unknown = { name: "Vidal Lab" },
  resolved: unknown[] = []
) {
  const requesterCount = new Set(tickets.map((t: any) => t.created_by).filter(Boolean)).size;
  const customerBatches = Math.ceil(Math.min(requesterCount, 1000) / 100);
  const domainFrom = createFromQueue([
    { table: "hd_tickets", query: createQuery({ data: tickets, error: null }) },
    { table: "hd_tickets", query: createQuery({ data: resolved, error: null }) },
    ...Array.from({ length: customerBatches }, (_, index) => ({
      table: "hd_customers_info",
      query: createQuery({ data: customers.slice(index * 100, index * 100 + 100), error: null }),
    })),
  ]);
  const publicFrom = createFromQueue([{ table: "organizations", query: createQuery({ data: organization, error: null }) }]);

  mocks.getDomainSchema.mockReturnValue({ from: domainFrom });
  mocks.getPublicSchema.mockReturnValue({ from: publicFrom });

  return { domainFrom, publicFrom };
}

describe("buildSlaAuditReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the tickets query to the given organization", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    const { domainFrom } = setupSchemas([]);

    await buildSlaAuditReport("org-123", now, period);

    const ticketsQuery = domainFrom.mock.results[0].value;
    const resolvedQuery = domainFrom.mock.results[1].value;
    expect(ticketsQuery.eq).toHaveBeenCalledWith("organization_id", "org-123");
    expect(resolvedQuery.eq).toHaveBeenCalledWith("organization_id", "org-123");
  });

  it("excludes soft-deleted tickets from the report", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    const { domainFrom } = setupSchemas([]);

    await buildSlaAuditReport("org-123", now, period);

    expect(domainFrom.mock.results[0].value.is).toHaveBeenCalledWith("deleted_at", null);
    expect(domainFrom.mock.results[1].value.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("groups multiple tickets from the same company under one entry without double-counting", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas(
      [
        ticket({ ticket_number: 1, created_by: "profile-a" }),
        ticket({ ticket_number: 2, created_by: "profile-a" }),
      ],
      [{ id: "profile-a", company_name: "Acme Corp" }]
    );

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.companies).toEqual([{ company_id: "profile-a", company_name: "Acme Corp", active_ticket_count: 2 }]);
    expect(report.company_count).toBe(1);
    expect(report.active_ticket_count).toBe(2);
  });

  it("separates tickets across multiple companies with stable alphabetical ordering", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas(
      [
        ticket({ ticket_number: 1, created_by: "profile-b" }),
        ticket({ ticket_number: 2, created_by: "profile-a" }),
      ],
      [
        { id: "profile-a", company_name: "Acme Corp" },
        { id: "profile-b", company_name: "Zenith Ltd" },
      ]
    );

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.companies.map((c) => c.company_name)).toEqual(["Acme Corp", "Zenith Ltd"]);
    expect(report.company_count).toBe(2);
  });

  it("does not silently exclude tickets without a resolvable company", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas(
      [ticket({ ticket_number: 1, created_by: null }), ticket({ ticket_number: 2, created_by: "profile-unknown" })],
      []
    );

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.company_count).toBe(0);
    expect(report.unassigned_ticket_count).toBe(2);
    expect(report.companies).toEqual([{ company_id: null, company_name: "Unassigned", active_ticket_count: 2 }]);
    expect(report.tickets.every((t) => t.company_id === null && t.company_name === null)).toBe(true);
    expect(report.tickets.find((t) => t.ticket_reference === "TK-0002")?.customer_profile_id).toBe("profile-unknown");
    expect(report.tickets.find((t) => t.ticket_reference === "TK-0002")?.company_assignment_status).toBe("unassigned");
  });

  it("always returns null project fields — no ticket-to-project relationship exists in this schema", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([ticket({ ticket_number: 1, created_by: "profile-a" })], [{ id: "profile-a", company_name: "Acme Corp" }]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.tickets[0].project_id).toBeNull();
    expect(report.tickets[0].project_name).toBeNull();
  });

  it("classifies sla_status as breached, at_risk, or compliant based on sla_breached and due proximity", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({ ticket_number: 1, sla_breached: true }),
      ticket({ ticket_number: 2, sla_breached: false, sla_resolution_due: "2026-07-21T13:00:00.000Z" }), // 1h out
      ticket({ ticket_number: 3, sla_breached: false, sla_resolution_due: "2026-07-25T00:00:00.000Z" }), // days out
      ticket({ ticket_number: 4, sla_breached: false, sla_resolution_due: null }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);
    const byNumber = Object.fromEntries(report.tickets.map((t) => [t.ticket_reference, t.sla_status]));

    expect(byNumber["TK-0001"]).toBe("breached");
    expect(byNumber["TK-0002"]).toBe("at_risk");
    expect(byNumber["TK-0003"]).toBe("compliant");
    expect(byNumber["TK-0004"]).toBe("compliant");
  });

  it("flags vip_risk only for high/critical priority tickets that are also at_risk or breached", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({ ticket_number: 1, priority: "critical", sla_breached: true }),
      ticket({ ticket_number: 2, priority: "low", sla_breached: true }),
      ticket({ ticket_number: 3, priority: "high", sla_breached: false, sla_resolution_due: null }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);
    const byNumber = Object.fromEntries(report.tickets.map((t) => [t.ticket_reference, t.vip_risk]));

    expect(byNumber["TK-0001"]).toBe(true);
    expect(byNumber["TK-0002"]).toBe(false);
    expect(byNumber["TK-0003"]).toBe(false);
    expect(report.vip_risk_count).toBe(1);
  });

  it("orders vip_risks breached-first then by soonest due date, and derives action_items from that order", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({ ticket_number: 1, priority: "high", sla_breached: false, sla_resolution_due: "2026-07-21T15:00:00.000Z" }), // at_risk, 3h out
      ticket({ ticket_number: 2, priority: "critical", sla_breached: true }), // breached
      ticket({ ticket_number: 3, priority: "high", sla_breached: false, sla_resolution_due: "2026-07-21T12:30:00.000Z" }), // at_risk, 30m out
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.vip_risks.map((t) => t.ticket_reference)).toEqual(["TK-0002", "TK-0003", "TK-0001"]);
    expect(report.action_items).toHaveLength(3);
    expect(report.action_items[0]).toContain("TK-0002");
  });

  it("counts measured, unmeasured and breached tickets in the queue", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({ ticket_number: 1, resolution_due_at: "2026-07-25T00:00:00.000Z" }),
      ticket({ ticket_number: 2, sla_resolution_due: "2026-07-25T00:00:00.000Z" }),
      ticket({ ticket_number: 3, sla_breached: true }),
      ticket({ ticket_number: 4, sla_resolution_breached: true }),
      ticket({ ticket_number: 5 }), // no deadline and no breach flag: not measurable
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.active_ticket_count).toBe(5);
    expect(report.sla_measured_ticket_count).toBe(4);
    expect(report.sla_unmeasured_ticket_count).toBe(1);
    expect(report.breached_ticket_count).toBe(2);
    // Queue breaches no longer drive compliance %; that is the resolved window.
    expect(report.compliance_percentage).toBeNull();
    expect(report.health).toBe("action_required");
  });

  it("reports compliance as null, not 100%, when no active ticket has an SLA deadline", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([ticket({ ticket_number: 1, assigned_to: null }), ticket({ ticket_number: 2 })]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.compliance_percentage).toBeNull();
    expect(report.sla_unmeasured_ticket_count).toBe(2);
    expect(report.unowned_ticket_count).toBe(1);
    expect(report.health).toBe("attention");
  });

  it("keeps an empty backlog healthy without inventing a compliance figure", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.compliance_percentage).toBeNull();
    expect(report.compliance_window.resolved_ticket_count).toBe(0);
    expect(report.health).toBe("healthy");
    expect(report.oldest_active_age_days).toBeNull();
  });

  it("prefers the canonical resolution_due_at over the legacy column", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({
        ticket_number: 1,
        resolution_due_at: "2026-07-21T13:00:00.000Z",
        sla_resolution_due: "2026-07-30T00:00:00.000Z",
      }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.tickets[0].sla_status).toBe("at_risk");
    expect(report.tickets[0].due_at).toBe("2026-07-21T13:00:00.000Z");
  });

  it("counts waiting states separately and derives ticket age in whole days", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({ ticket_number: 1, status: "pending_customer", created_at: "2026-07-01T12:00:00.000Z" }),
      ticket({ ticket_number: 2, status: "pending_third_party" }),
      ticket({ ticket_number: 3, status: "open" }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.waiting_ticket_count).toBe(2);
    expect(report.oldest_active_age_days).toBe(20);
  });

  it("returns tickets sorted by ticket number for stable output", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([ticket({ ticket_number: 3 }), ticket({ ticket_number: 1 }), ticket({ ticket_number: 2 })]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.tickets.map((t) => t.ticket_reference)).toEqual(["TK-0001", "TK-0002", "TK-0003"]);
  });

  it("uses deterministic tie-breakers independent of input order and Unicode composition", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    const rows = [
      ticket({ id: "ticket-b", ticket_number: 7, title: "Cafe\u0301", priority: "high", sla_breached: true, created_by: "profile-b" }),
      ticket({ id: "ticket-a", ticket_number: 7, title: "Café", priority: "high", sla_breached: true, created_by: "profile-a" }),
    ];
    setupSchemas(rows, [
      { id: "profile-b", company_name: "Same" },
      { id: "profile-a", company_name: "Same" },
    ]);
    const first = await buildSlaAuditReport("org-123", now, period);
    setupSchemas([...rows].reverse(), [
      { id: "profile-a", company_name: "Same" },
      { id: "profile-b", company_name: "Same" },
    ]);
    const second = await buildSlaAuditReport("org-123", now, period);
    expect(first.tickets.map((t) => t.ticket_id)).toEqual(["ticket-a", "ticket-b"]);
    expect(second.tickets.map((t) => t.ticket_id)).toEqual(first.tickets.map((t) => t.ticket_id));
    expect(second.vip_risks.map((t) => t.ticket_id)).toEqual(first.vip_risks.map((t) => t.ticket_id));
    expect(second.companies).toEqual(first.companies);
  });

  it("batches at most 100 requester ids and caps lookup work at 1000", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    const rows = Array.from({ length: 205 }, (_, index) =>
      ticket({ id: `ticket-${index}`, ticket_number: index, created_by: `profile-${index}` })
    );
    const { domainFrom } = setupSchemas(rows);
    await buildSlaAuditReport("org-123", now, period);
    expect(domainFrom).toHaveBeenCalledTimes(5); // active + resolved tickets + 3 customer batches
  });

  // ---- Resolved-window compliance (finding 2) -------------------------------

  it("queries resolved/closed tickets in a rolling 7-day window by resolved_at, scoped to the organization", async () => {
    const { buildSlaAuditReport, RESOLVED_WINDOW_DAYS } = await import("../src/lib/sla-audit.js");
    const { domainFrom } = setupSchemas([]);

    const report = await buildSlaAuditReport("org-123", now, period);
    const resolvedQuery = domainFrom.mock.results[1].value;

    expect(RESOLVED_WINDOW_DAYS).toBe(7);
    expect(resolvedQuery.in).toHaveBeenCalledWith("status", ["resolved", "closed"]);
    expect(resolvedQuery.gte).toHaveBeenCalledWith("resolved_at", "2026-07-14T12:00:00.000Z");
    expect(report.compliance_window).toMatchObject({ days: 7, start: "2026-07-14T12:00:00.000Z", end: now.toISOString() });
  });

  it("honours a configurable window length", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    const { domainFrom } = setupSchemas([]);

    await buildSlaAuditReport("org-123", now, period, { resolvedWindowDays: 30 });

    expect(domainFrom.mock.results[1].value.gte).toHaveBeenCalledWith("resolved_at", "2026-06-21T12:00:00.000Z");
  });

  it("judges response and resolution separately for resolved tickets, like assessSla", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([], [], { name: "Vidal Lab" }, [
      // both met
      resolvedTicket({
        response_due_at: "2026-07-18T12:00:00.000Z",
        first_response_at: "2026-07-18T09:00:00.000Z",
        resolution_due_at: "2026-07-19T12:00:00.000Z",
      }),
      // response late, resolution met
      resolvedTicket({
        response_due_at: "2026-07-18T09:00:00.000Z",
        first_response_at: "2026-07-18T10:00:00.000Z",
        resolution_due_at: "2026-07-19T12:00:00.000Z",
      }),
      // response met (agent column wins over first_response_at), resolution late
      resolvedTicket({
        response_due_at: "2026-07-18T12:00:00.000Z",
        first_response_at: "2026-07-18T13:00:00.000Z",
        first_agent_response_at: "2026-07-18T11:00:00.000Z",
        sla_resolution_due: "2026-07-19T07:00:00.000Z",
      }),
      // no SLA at all: not measured
      resolvedTicket({}),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.compliance_window).toMatchObject({
      resolved_ticket_count: 4,
      measured_ticket_count: 3,
      compliant_ticket_count: 1,
      response: { measured: 3, met: 2 },
      resolution: { measured: 3, met: 2 },
    });
    expect(report.compliance_percentage).toBe(33.33);
  });

  it("treats a resolved ticket never answered after its response deadline as a response breach (assessSla semantics)", async () => {
    const { assessResolvedTicket } = await import("../src/lib/sla-audit.js");
    const row = resolvedTicket({ response_due_at: "2026-07-18T09:00:00.000Z", resolution_due_at: "2026-07-19T12:00:00.000Z" });

    expect(assessResolvedTicket(row, now)).toEqual({
      responseMeasured: true,
      responseBreached: true,
      resolutionMeasured: true,
      resolutionBreached: false,
    });
  });

  it("reports compliance as null (not 0%) when no ticket was resolved in the window, even with breaches in the queue", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([ticket({ ticket_number: 1, sla_breached: true })]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.compliance_percentage).toBeNull();
    expect(report.compliance_window.resolved_ticket_count).toBe(0);
    expect(report.breached_ticket_count).toBe(1);
  });

  // ---- Clock (finding 1) ------------------------------------------------------

  it("evaluates deadlines at the injected now, not at the dedupe period start", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    // Due 08:00. At period.start (00:00) this would look healthy; at 12:00 it is overdue.
    setupSchemas([ticket({ ticket_number: 1, resolution_due_at: "2026-07-21T08:00:00.000Z" })]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.generated_at).toBe("2026-07-21T12:00:00.000Z");
    expect(report.reporting_period.start).toBe("2026-07-21T00:00:00.000Z");
    expect(report.tickets[0].sla_status).toBe("breached");
    expect(report.tickets[0].risk_reason).toBe("Resolution overdue by 4h.");
  });

  // ---- Response vs resolution in the queue (finding 3) -------------------------

  it("counts an unanswered ticket past its response deadline as breached before the DB flag is written", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({
        ticket_number: 1,
        priority: "high",
        response_due_at: "2026-07-21T09:00:00.000Z",
        resolution_due_at: "2026-07-23T12:00:00.000Z",
        sla_response_breached: false,
        sla_breached: false,
      }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);
    const [row] = report.tickets;

    expect(row.sla_status).toBe("breached");
    expect(row.response_status).toBe("overdue");
    expect(row.resolution_status).toBe("running");
    expect(row.risk_reason).toBe("First response overdue by 3h; Resolution due in 2d.");
    expect(row.required_action).toBe("Send the first response now and escalate.");
    expect(row.due_at).toBe("2026-07-21T09:00:00.000Z");
    expect(report.breached_ticket_count).toBe(1);
    expect(report.vip_risk_count).toBe(1);
  });

  it("does not breach a ticket whose first response arrived on time", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({
        ticket_number: 1,
        response_due_at: "2026-07-21T09:00:00.000Z",
        first_response_at: "2026-07-21T08:00:00.000Z",
        resolution_due_at: "2026-07-25T12:00:00.000Z",
      }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.tickets[0].response_status).toBe("met");
    expect(report.tickets[0].sla_status).toBe("compliant");
    expect(report.tickets[0].risk_reason).toBeNull();
  });

  it("keeps a late first response as a breach and says how late it was", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({
        ticket_number: 1,
        response_due_at: "2026-07-21T09:00:00.000Z",
        first_agent_response_at: "2026-07-21T11:00:00.000Z",
        resolution_due_at: "2026-07-25T12:00:00.000Z",
      }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.tickets[0].response_status).toBe("missed");
    expect(report.tickets[0].sla_status).toBe("breached");
    expect(report.tickets[0].risk_reason).toBe("First response was 2h late; Resolution due in 4d.");
  });

  it("never presents a future deadline as past", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({ ticket_number: 1, created_at: null, resolution_due_at: "2026-07-21T12:45:00.000Z" }),
      // Flag says breached but the deadline is still ahead (e.g. not yet recalculated):
      ticket({ ticket_number: 2, sla_resolution_breached: true, sla_breached: true, resolution_due_at: "2026-07-21T15:00:00.000Z" }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);
    const byRef = Object.fromEntries(report.tickets.map((t) => [t.ticket_reference, t]));

    expect(byRef["TK-0001"].risk_reason).toBe("Resolution due in 45m.");
    expect(byRef["TK-0002"].sla_status).toBe("breached");
    expect(byRef["TK-0002"].risk_reason).toBe("Marked SLA breached (resolution) in the helpdesk; Resolution due in 3h.");
    for (const row of report.tickets) expect(row.risk_reason).not.toMatch(/ago|overdue/);
  });

  // ---- At-risk rule (finding 6) ---------------------------------------------------

  it("replicates the app's at-risk rule: ≤1h remaining or ≤25% of the window", async () => {
    const { openTargetState } = await import("../src/lib/sla-audit.js");
    const at = (iso: string) => iso;

    // Absolute rule only (no start time → no window).
    expect(openTargetState(at("2026-07-21T13:00:00.000Z"), null, now)).toBe("at_risk"); // exactly 1h
    expect(openTargetState(at("2026-07-21T13:01:00.000Z"), null, now)).toBe("running"); // 61m
    expect(openTargetState(at("2026-07-21T12:00:00.000Z"), null, now)).toBe("at_risk"); // due exactly now
    expect(openTargetState(at("2026-07-21T11:59:59.999Z"), null, now)).toBe("overdue");

    // Fractional rule: 12h window, 3h left = exactly 25%.
    expect(openTargetState("2026-07-21T15:00:00.000Z", "2026-07-21T03:00:00.000Z", now)).toBe("at_risk");
    // Same 3h left, window 11h58m → just over 25%.
    expect(openTargetState("2026-07-21T15:00:00.000Z", "2026-07-21T03:02:00.000Z", now)).toBe("running");
    // 4h left in a 100h window → at risk although far beyond the 1h floor.
    expect(openTargetState("2026-07-21T16:00:00.000Z", "2026-07-17T12:00:00.000Z", now)).toBe("at_risk");
    // The old fixed 4h rule flagged this one; the app does not (3h59m left of a 12h window = 33%).
    expect(openTargetState("2026-07-21T15:59:00.000Z", "2026-07-21T03:59:00.000Z", now)).toBe("running");
  });

  // ---- Admin approval (finding 7) ---------------------------------------------------

  it("reports in_progress tickets awaiting admin approval separately and not as needing an agent", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({ ticket_number: 1, status: "in_progress", review_status: "pending", assigned_to: null }),
      ticket({ ticket_number: 2, status: "in_progress", review_status: "approved", assigned_to: null }),
      ticket({ ticket_number: 3, status: "open", review_status: "pending", assigned_to: "agent-1" }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.awaiting_approval_count).toBe(1);
    expect(report.awaiting_approval.map((t) => t.ticket_reference)).toEqual(["TK-0001"]);
    expect(report.unowned_ticket_count).toBe(1); // only TK-0002
    expect(report.tickets.find((t) => t.ticket_reference === "TK-0001")?.review_status).toBe("pending");
    expect(report.health).toBe("attention");
  });

  // ---- Company grouping (finding 8) ---------------------------------------------------

  it("groups tickets by normalized company name, not by requester", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas(
      [
        ticket({ ticket_number: 1, created_by: "profile-b" }),
        ticket({ ticket_number: 2, created_by: "profile-a" }),
        ticket({ ticket_number: 3, created_by: "profile-c" }),
        ticket({ ticket_number: 4, created_by: "profile-d" }),
        ticket({ ticket_number: 5, created_by: "profile-e" }),
      ],
      [
        { id: "profile-a", company_name: "Acme  Corp" },
        { id: "profile-b", company_name: " acme corp " },
        { id: "profile-c", company_name: "Zenith Ltd" },
        { id: "profile-d", company_name: "   " },
        { id: "profile-e", company_name: null },
      ]
    );

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.company_count).toBe(2);
    expect(report.companies).toEqual([
      { company_id: "profile-a", company_name: "Acme Corp", active_ticket_count: 2 },
      { company_id: "profile-c", company_name: "Zenith Ltd", active_ticket_count: 1 },
      { company_id: null, company_name: "Unassigned", active_ticket_count: 2 },
    ]);
  });
});
