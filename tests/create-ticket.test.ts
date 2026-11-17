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
      { table: "hd_tickets", query: ticketsQuery },
      { table: "hd_ai_analysis", query: aiAnalysisQuery },
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
      { table: "hd_tickets", query: ticketsQuery },
      { table: "hd_ai_analysis", query: aiAnalysisQuery },
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

  it("throws a generic error without leaking the database message when the insert fails", async () => {
    const { createTicket } = await import("../src/tools/create-ticket.js");

    const from = createFromQueue([
      {
        table: "hd_tickets",
        query: createQuery({ data: null, error: { message: 'column "tags" of relation "hd_tickets" does not exist' } }),
      },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.resolveCategoryId.mockResolvedValue(null);
    mocks.triageTicket.mockResolvedValue({ ...baseTriage, suggested_priority: "low", confidence_score: 70, summary: "x" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const attempt = createTicket({
      title: "Printer offline again",
      description: "The printer on floor 2 is offline.",
      requester_name: "Jane Doe",
      language: "en",
      source: "api",
    });

    await expect(attempt).rejects.toThrow("Failed to create ticket");
    await expect(attempt).rejects.not.toThrow(/tags|relation/);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps the created ticket and reports analysis_saved: false when the analysis insert fails", async () => {
    const { createTicket } = await import("../src/tools/create-ticket.js");

    const from = createFromQueue([
      { table: "hd_tickets", query: createQuery({ data: { id: "t-9", ticket_number: 9, priority: "low" }, error: null }) },
      { table: "hd_ai_analysis", query: createQuery({ data: null, error: { message: "boom" } }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.resolveCategoryId.mockResolvedValue(null);
    mocks.triageTicket.mockResolvedValue({ ...baseTriage, suggested_priority: "low", confidence_score: 70, summary: "x" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const parsed = JSON.parse(
      await createTicket({
        title: "Printer offline again",
        description: "The printer on floor 2 is offline.",
        requester_name: "Jane Doe",
        language: "en",
        source: "api",
      })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.ticket_ref).toBe("TK-0009");
    expect(parsed.analysis_saved).toBe(false);
    consoleError.mockRestore();
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

  describe("when AI triage is unavailable (REQ-F1-09)", () => {
    const input = {
      title: "Laptop does not boot at all",
      description: "Confidential detail: the CFO laptop shows a black screen.",
      requester_name: "Jane Doe",
      language: "de" as const,
      source: "api" as const,
    };

    it("still creates the ticket with medium priority and no analysis row", async () => {
      const { createTicket } = await import("../src/tools/create-ticket.js");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const ticketsQuery = createQuery({
        data: { id: "ticket-7", ticket_number: 7, priority: "medium", sla_first_response_due: null },
        error: null,
      });
      // Only one from() call is queued: an hd_ai_analysis insert would throw.
      const from = createFromQueue([{ table: "hd_tickets", query: ticketsQuery }]);
      mocks.getSupabaseClient.mockReturnValue({ from });
      mocks.triageTicket.mockRejectedValue(new TypeError("provider said: invalid x-api-key sk-secret"));

      const raw = await createTicket(input);
      const parsed = JSON.parse(raw);

      expect(parsed.success).toBe(true);
      expect(parsed.ticket_ref).toBe("TK-0007");
      expect(parsed.priority).toBe("medium");
      expect(parsed.ai_triage).toBe("unavailable");
      expect(parsed.analysis_saved).toBe(false);
      expect(parsed.message).toMatch(/AI triage (was )?unavailable/i);
      expect(raw).not.toContain("sk-secret");
      expect(raw).not.toContain("provider said");

      const payload = (ticketsQuery.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload).toMatchObject({
        organization_id: "org-123",
        created_by: "agent-456",
        priority: "medium",
        category_id: null,
        detected_language: "de",
        contains_pii: false,
        status: "open",
        metadata: { requester_name: "Jane Doe", mcp_created: true, triage_status: "unavailable" },
      });
      expect(mocks.resolveCategoryId).not.toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(1);
      consoleError.mockRestore();
    });

    it("logs only the error class, never the provider message or ticket content", async () => {
      const { createTicket } = await import("../src/tools/create-ticket.js");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.getSupabaseClient.mockReturnValue({
        from: createFromQueue([
          { table: "hd_tickets", query: createQuery({ data: { id: "t-8", ticket_number: 8, priority: "medium" }, error: null }) },
        ]),
      });
      mocks.triageTicket.mockRejectedValue(new TypeError("provider said: invalid x-api-key sk-secret"));

      await createTicket(input);

      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).toContain("TypeError");
      expect(logged).not.toContain("sk-secret");
      expect(logged).not.toContain("provider said");
      expect(logged).not.toContain("CFO laptop");
      expect(logged).not.toContain("Laptop does not boot");
      consoleError.mockRestore();
    });

    it("reports ai_triage completed on the normal path", async () => {
      const { createTicket } = await import("../src/tools/create-ticket.js");
      mocks.getSupabaseClient.mockReturnValue({
        from: createFromQueue([
          { table: "hd_tickets", query: createQuery({ data: { id: "t-9", ticket_number: 9, priority: "high" }, error: null }) },
          { table: "hd_ai_analysis", query: createQuery({ data: null, error: null }) },
        ]),
      });
      mocks.resolveCategoryId.mockResolvedValue("category-1");
      mocks.triageTicket.mockResolvedValue({ ...baseTriage, suggested_priority: "high", confidence_score: 90, summary: "s" });

      const parsed = JSON.parse(await createTicket({ ...input, language: "en" }));
      expect(parsed.ai_triage).toBe("completed");
    });
  });
});
