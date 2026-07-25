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
  keywords: ["vpn", "outage"],
  smart_response: "We are on it.",
  estimated_resolution_hours: 2,
  reasoning: "Multiple users affected",
  contains_pii: false,
  model_used: "claude-sonnet-4-20250514",
  input_tokens: 10,
  output_tokens: 20,
  processing_time_ms: 500,
};

describe("createTicket", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
    process.env.MCP_AGENT_ID = "agent-456";
  });

  it("creates a ticket and applies the AI priority when confidence >= 60%", async () => {
    const { createTicket } = await import("../src/tools/create-ticket.js");

    const ticketRow = {
      id: "ticket-1",
      ticket_number: 42,
      priority: "high",
      sla_first_response_due: "2026-08-01T00:00:00.000Z",
    };
    const ticketsQuery = createQuery({ data: ticketRow, error: null });
    const aiAnalysisQuery = createQuery({ data: null, error: null });
    const from = createFromQueue([
      { table: "tickets", query: ticketsQuery },
      { table: "ai_analysis", query: aiAnalysisQuery },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.resolveCategoryId.mockResolvedValue("category-1");
    mocks.triageTicket.mockResolvedValue({
      ...baseTriage,
      suggested_priority: "high",
      confidence_score: 85,
      summary: "VPN down for the whole office",
    });

    const result = await createTicket({
      title: "VPN is down for the whole office",
      description: "Nobody can connect to the VPN since this morning.",
      requester_name: "Jane Doe",
      language: "en",
      source: "api",
    });

    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.ticket_ref).toBe("TK-0042");
    expect(parsed.priority).toBe("high");
    expect(parsed.confidence).toBe(85);
    expect(ticketsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-123",
        created_by: "agent-456",
        category_id: "category-1",
        priority: "high",
      })
    );
    expect(aiAnalysisQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({ ticket_id: "ticket-1", suggested_category: "Networking" })
    );
  });

  it("falls back to medium priority when AI confidence is below 60%", async () => {
    const { createTicket } = await import("../src/tools/create-ticket.js");

    const ticketRow = { id: "ticket-2", ticket_number: 7, priority: "medium", sla_first_response_due: null };
    const ticketsQuery = createQuery({ data: ticketRow, error: null });
    const aiAnalysisQuery = createQuery({ data: null, error: null });
    const from = createFromQueue([
      { table: "tickets", query: ticketsQuery },
      { table: "ai_analysis", query: aiAnalysisQuery },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.resolveCategoryId.mockResolvedValue(null);
    mocks.triageTicket.mockResolvedValue({
      ...baseTriage,
      suggested_priority: "critical",
      confidence_score: 40,
      summary: "Minor question",
    });

    const result = await createTicket({
      title: "Quick question about printer",
      description: "How do I change the toner cartridge on the office printer?",
      requester_name: "John Smith",
      language: "en",
      source: "portal",
    });

    const parsed = JSON.parse(result);
    expect(parsed.priority).toBe("medium");
    expect(ticketsQuery.insert).toHaveBeenCalledWith(expect.objectContaining({ priority: "medium", category_id: null }));
  });

  it("throws when MCP_ORGANIZATION_ID or MCP_AGENT_ID is missing", async () => {
    delete process.env.MCP_ORGANIZATION_ID;
    const { createTicket } = await import("../src/tools/create-ticket.js");

    await expect(
      createTicket({
        title: "Test ticket title",
        description: "Some description that is long enough.",
        requester_name: "Jane Doe",
        language: "en",
        source: "api",
      })
    ).rejects.toThrow("Missing MCP_ORGANIZATION_ID or MCP_AGENT_ID");
  });
});
