import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
  resolveCategoryId: vi.fn(),
  triageTicket: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  getSupabaseClient: mocks.getSupabaseClient,
  resolveCategoryId: mocks.resolveCategoryId,
}));

vi.mock("../src/lib/ai.js", () => ({
  triageTicket: mocks.triageTicket,
}));

const originalEnv = { ...process.env };

const baseTriage = {
  suggested_category: "Networking",
  sentiment: "urgent",
  detected_language: "en",
  keywords: ["vpn"],
  smart_response: "We are on it.",
  estimated_resolution_hours: 2,
  reasoning: "Escalated by customer",
  contains_pii: false,
  model_used: "claude-sonnet-4-20250514",
  input_tokens: 12,
  output_tokens: 18,
  processing_time_ms: 300,
};

describe("prioritizeIncident", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
  });

  it("updates priority when new AI confidence is >= 60% and differs from the current priority", async () => {
    const { prioritizeIncident } = await import("../src/tools/prioritize-incident.js");

    const ticketRow = {
      id: "ticket-1",
      ticket_number: 5,
      title: "VPN outage",
      description: "VPN is unreachable.",
      priority: "medium",
      category_id: "cat-old",
    };
    const selectQuery = createQuery({ data: ticketRow, error: null });
    const updateQuery = createQuery({ data: null, error: null });
    const upsertQuery = createQuery({ data: null, error: null });
    const from = createFromQueue([
      { table: "tickets", query: selectQuery },
      { table: "tickets", query: updateQuery },
      { table: "ai_analysis", query: upsertQuery },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.resolveCategoryId.mockResolvedValue("cat-new");
    mocks.triageTicket.mockResolvedValue({
      ...baseTriage,
      suggested_priority: "critical",
      confidence_score: 95,
      summary: "Full outage confirmed",
    });

    const result = await prioritizeIncident({
      ticket_ref: "TK-0005",
      additional_context: "Confirmed 200 users affected.",
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.previous_priority).toBe("medium");
    expect(parsed.new_priority).toBe("critical");
    expect(parsed.priority_changed).toBe(true);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ priority: "critical", category_id: "cat-new" })
    );
    expect(upsertQuery.upsert).toHaveBeenCalledWith(expect.objectContaining({ ticket_id: "ticket-1" }), {
      onConflict: "ticket_id",
    });
  });

  it("keeps the previous priority when AI confidence is below 60%", async () => {
    const { prioritizeIncident } = await import("../src/tools/prioritize-incident.js");

    const ticketRow = {
      id: "ticket-2",
      ticket_number: 6,
      title: "Slow laptop",
      description: "Laptop is slow.",
      priority: "low",
      category_id: "cat-old",
    };
    const updateQuery = createQuery({ data: null, error: null });
    const from = createFromQueue([
      { table: "tickets", query: createQuery({ data: ticketRow, error: null }) },
      { table: "tickets", query: updateQuery },
      { table: "ai_analysis", query: createQuery({ data: null, error: null }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.resolveCategoryId.mockResolvedValue("cat-old");
    mocks.triageTicket.mockResolvedValue({
      ...baseTriage,
      suggested_priority: "critical",
      confidence_score: 30,
      summary: "Uncertain",
    });

    const result = await prioritizeIncident({ ticket_ref: "TK-0006" });
    const parsed = JSON.parse(result);

    expect(parsed.new_priority).toBe("low");
    expect(parsed.priority_changed).toBe(false);
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ priority: "low" }));
  });

  it("returns success: false when the ticket is not found", async () => {
    const { prioritizeIncident } = await import("../src/tools/prioritize-incident.js");

    const from = createFromQueue([
      { table: "tickets", query: createQuery({ data: null, error: { message: "not found" } }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await prioritizeIncident({ ticket_ref: "TK-9999" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(mocks.triageTicket).not.toHaveBeenCalled();
  });
});
