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
    sla_breached: false,
    sla_resolution_due: null,
    sla_first_response_due: null,
    created_by: null,
    ...overrides,
  };
}

function setupSchemas(tickets: unknown[], customers: unknown[] = [], organization: unknown = { name: "Vidal Lab" }) {
  const requesterCount = new Set(tickets.map((t: any) => t.created_by).filter(Boolean)).size;
  const customerBatches = Math.ceil(Math.min(requesterCount, 1000) / 100);
  const domainFrom = createFromQueue([
    { table: "hd_tickets", query: createQuery({ data: tickets, error: null }) },
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
    expect(ticketsQuery.eq).toHaveBeenCalledWith("organization_id", "org-123");
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

  it("computes compliance_percentage from the returned, correctly scoped ticket set", async () => {
    const { buildSlaAuditReport } = await import("../src/lib/sla-audit.js");
    setupSchemas([
      ticket({ ticket_number: 1, sla_breached: false, sla_resolution_due: null }),
      ticket({ ticket_number: 2, sla_breached: false, sla_resolution_due: null }),
      ticket({ ticket_number: 3, sla_breached: true }),
      ticket({ ticket_number: 4, sla_breached: true }),
    ]);

    const report = await buildSlaAuditReport("org-123", now, period);

    expect(report.active_ticket_count).toBe(4);
    expect(report.compliance_percentage).toBe(50);
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
    expect(domainFrom).toHaveBeenCalledTimes(4); // tickets + 3 customer batches
  });
});
