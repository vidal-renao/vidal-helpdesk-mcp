import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildSlaAuditReport: vi.fn(),
}));

vi.mock("../src/lib/sla-audit.js", () => ({
  buildSlaAuditReport: mocks.buildSlaAuditReport,
}));

const originalEnv = { ...process.env };

describe("getSlaAuditReport", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
  });

  it("returns the report scoped to MCP_ORGANIZATION_ID", async () => {
    const { getSlaAuditReport } = await import("../src/tools/get-sla-audit-report.js");

    mocks.buildSlaAuditReport.mockResolvedValue({
      generated_at: "2026-07-21T10:00:00.000Z",
      organization_id: "org-123",
      organization_name: "Vidal Lab",
      reporting_period: { start: "2026-07-21T00:00:00.000Z", end: "2026-07-22T00:00:00.000Z" },
      compliance_percentage: 100,
      active_ticket_count: 0,
      company_count: 0,
      unassigned_ticket_count: 0,
      vip_risk_count: 0,
      companies: [],
      tickets: [],
      vip_risks: [],
      action_items: [],
    });

    const result = await getSlaAuditReport({});
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.report.organization_id).toBe("org-123");
    expect(mocks.buildSlaAuditReport).toHaveBeenCalledWith("org-123", expect.any(Date), expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }));
  });

  it("throws when MCP_ORGANIZATION_ID is missing", async () => {
    delete process.env.MCP_ORGANIZATION_ID;
    const { getSlaAuditReport } = await import("../src/tools/get-sla-audit-report.js");

    await expect(getSlaAuditReport({})).rejects.toThrow("Missing MCP_ORGANIZATION_ID");
    expect(mocks.buildSlaAuditReport).not.toHaveBeenCalled();
  });
});
