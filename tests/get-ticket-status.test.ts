import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  getSupabaseClient: mocks.getSupabaseClient,
}));

const originalEnv = { ...process.env };

describe("getTicketStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
  });

  it("resolves a ticket by TK-ref and reports SLA countdown", async () => {
    const { getTicketStatus } = await import("../src/tools/get-ticket-status.js");

    const futureDue = new Date(Date.now() + 60 * 60_000).toISOString();
    const ticketRow = {
      id: "ticket-1",
      ticket_number: 1001,
      title: "VPN outage",
      status: "open",
      priority: "high",
      detected_language: "en",
      sla_breached: false,
      sla_first_response_due: futureDue,
      sla_resolution_due: futureDue,
      contains_pii: false,
      created_at: "2026-07-20T00:00:00.000Z",
      resolved_at: null,
      categories: { id: "cat-1", name: "Networking", slug: "networking", color: "#000" },
      ai_analysis: {
        suggested_priority: "high",
        confidence_score: 90,
        summary: "VPN down",
        sentiment: "urgent",
        smart_response: "We are investigating.",
        reasoning: "Many users affected",
        contains_pii_detected: false,
        estimated_resolution_hours: 2,
        model_used: "claude-sonnet-4-20250514",
        processing_time_ms: 400,
      },
    };
    const from = createFromQueue([{ table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) }]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await getTicketStatus({ ticket_ref: "TK-1001" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.ticket.ref).toBe("TK-1001");
    expect(parsed.ticket.category).toBe("Networking");
    expect(typeof parsed.ticket.minutes_to_response_sla).toBe("number");
    expect(parsed.ticket.minutes_to_response_sla).toBeGreaterThan(0);
    expect(parsed.ai_analysis).toMatchObject({ suggested_priority: "high", confidence: 90 });
  });

  it("resolves a ticket by UUID", async () => {
    const { getTicketStatus } = await import("../src/tools/get-ticket-status.js");

    const uuid = "11111111-1111-1111-1111-111111111111";
    const ticketRow = {
      id: uuid,
      ticket_number: 5,
      title: "Printer jam",
      status: "resolved",
      priority: "low",
      detected_language: "de",
      sla_breached: false,
      sla_first_response_due: null,
      sla_resolution_due: null,
      contains_pii: false,
      created_at: "2026-07-19T00:00:00.000Z",
      resolved_at: "2026-07-19T02:00:00.000Z",
      categories: null,
      ai_analysis: null,
    };
    const query = createQuery({ data: ticketRow, error: null });
    const from = createFromQueue([{ table: "hd_tickets", query }]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await getTicketStatus({ ticket_ref: uuid });
    const parsed = JSON.parse(result);

    expect(parsed.ticket.id).toBe(uuid);
    expect(query.eq).toHaveBeenCalledWith("id", uuid);
    expect(parsed.ai_analysis).toBeNull();
  });

  it("returns success: false when the ticket is not found", async () => {
    const { getTicketStatus } = await import("../src/tools/get-ticket-status.js");

    const from = createFromQueue([
      { table: "hd_tickets", query: createQuery({ data: null, error: { message: "no rows" } }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await getTicketStatus({ ticket_ref: "TK-9999" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("TK-9999");
  });
});
