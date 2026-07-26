import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  getSupabaseClient: mocks.getSupabaseClient,
}));

const originalEnv = { ...process.env };

function ticket(overrides: Record<string, unknown>) {
  return {
    id: `t-${Math.random()}`,
    organization_id: "org-123",
    priority: "medium",
    status: "open",
    sla_breached: false,
    created_at: "2026-07-15T00:00:00.000Z",
    resolved_at: null,
    categories: { name: "Other" },
    ...overrides,
  };
}

describe("generateReport", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
  });

  it("computes compliance, priority breakdown, and top categories in JSON format", async () => {
    const { generateReport } = await import("../src/tools/generate-report.js");

    const tickets = [
      ticket({ priority: "critical", status: "resolved", sla_breached: false, resolved_at: "2026-07-15T02:00:00.000Z", categories: { name: "Networking" } }),
      ticket({ priority: "high", status: "open", sla_breached: true, categories: { name: "Networking" } }),
      ticket({ priority: "medium", status: "in_progress", sla_breached: false, categories: { name: "Hardware" } }),
      ticket({ priority: "low", status: "resolved", sla_breached: false, resolved_at: "2026-07-15T05:00:00.000Z", categories: { name: "Software" } }),
    ];
    const from = createFromQueue([{ table: "tickets", query: createQuery({ data: tickets, error: null }) }]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await generateReport({ period: "week", format: "json" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.report.total).toBe(4);
    expect(parsed.report.resolved).toBe(2);
    expect(parsed.report.open).toBe(1);
    expect(parsed.report.in_progress).toBe(1);
    expect(parsed.report.sla_breached).toBe(1);
    expect(parsed.report.sla_compliance_rate).toBe(75);
    expect(parsed.report.by_priority).toEqual({ critical: 1, high: 1, medium: 1, low: 1 });
    expect(parsed.report.top_categories[0]).toEqual({ category: "Networking", count: 2 });
  });

  it("returns a formatted text report", async () => {
    const { generateReport } = await import("../src/tools/generate-report.js");

    const tickets = [ticket({ priority: "low", status: "resolved", resolved_at: "2026-07-15T01:00:00.000Z" })];
    const from = createFromQueue([{ table: "tickets", query: createQuery({ data: tickets, error: null }) }]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await generateReport({ period: "today", format: "text" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.report_text).toContain("HELPDESK AI REPORT — TODAY");
    expect(parsed.report_text).toContain("SLA Compliance: 100%");
  });

  it("throws when the Supabase query fails", async () => {
    const { generateReport } = await import("../src/tools/generate-report.js");

    const from = createFromQueue([
      { table: "tickets", query: createQuery({ data: null, error: { message: "timeout" } }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    await expect(generateReport({ period: "month", format: "json" })).rejects.toThrow("Supabase error: timeout");
  });
});
