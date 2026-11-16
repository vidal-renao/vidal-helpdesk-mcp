import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";
import { HD_AI_ANALYSIS_COLUMNS, HD_TICKETS_COLUMNS, unknownColumns } from "./helpers/schema-contract.js";

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

const triage = {
  suggested_category: "Networking",
  suggested_priority: "high",
  confidence_score: 85,
  summary: "VPN down",
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

function firstArg(fn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(fn).toHaveBeenCalled();
  return fn.mock.calls[0][0] as Record<string, unknown>;
}

describe("write payloads match the production column contract", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
    process.env.MCP_AGENT_ID = "agent-456";
    mocks.resolveCategoryId.mockResolvedValue("category-1");
    mocks.triageTicket.mockResolvedValue(triage);
  });

  it("create_ticket only writes existing hd_tickets and hd_ai_analysis columns", async () => {
    const { createTicket } = await import("../src/tools/create-ticket.js");
    const ticketsQuery = createQuery({ data: { id: "t-1", ticket_number: 1, priority: "high" }, error: null });
    const analysisQuery = createQuery({ data: null, error: null });
    mocks.getSupabaseClient.mockReturnValue({
      from: createFromQueue([
        { table: "hd_tickets", query: ticketsQuery },
        { table: "hd_ai_analysis", query: analysisQuery },
      ]),
    });

    await createTicket({
      title: "VPN is down for the whole office",
      description: "Nobody can connect to the VPN since this morning.",
      requester_name: "Jane Doe",
      language: "en",
      source: "api",
    });

    expect(unknownColumns(firstArg(ticketsQuery.insert), HD_TICKETS_COLUMNS)).toEqual([]);
    expect(unknownColumns(firstArg(analysisQuery.insert), HD_AI_ANALYSIS_COLUMNS)).toEqual([]);
  });

  it("prioritize_incident only writes existing hd_tickets and hd_ai_analysis columns", async () => {
    const { prioritizeIncident } = await import("../src/tools/prioritize-incident.js");
    const updateQuery = createQuery({ data: null, error: null });
    const upsertQuery = createQuery({ data: null, error: null });
    mocks.getSupabaseClient.mockReturnValue({
      from: createFromQueue([
        {
          table: "hd_tickets",
          query: createQuery({
            data: { id: "t-1", ticket_number: 1, title: "VPN", description: "Down", priority: "low", category_id: null },
            error: null,
          }),
        },
        { table: "hd_tickets", query: updateQuery },
        { table: "hd_ai_analysis", query: upsertQuery },
      ]),
    });

    await prioritizeIncident({ ticket_ref: "TK-0001" });

    expect(unknownColumns(firstArg(updateQuery.update), HD_TICKETS_COLUMNS)).toEqual([]);
    expect(unknownColumns(firstArg(upsertQuery.upsert), HD_AI_ANALYSIS_COLUMNS)).toEqual([]);
  });
});
