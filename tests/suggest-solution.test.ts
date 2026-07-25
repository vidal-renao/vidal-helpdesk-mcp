import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
  generateSolution: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  getSupabaseClient: mocks.getSupabaseClient,
}));

vi.mock("../src/lib/ai.js", () => ({
  generateSolution: mocks.generateSolution,
}));

const originalEnv = { ...process.env };

describe("suggestSolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
    process.env.MCP_AGENT_ID = "agent-456";
  });

  it("saves the solution as an internal comment and moves an open ticket to in_progress", async () => {
    const { suggestSolution } = await import("../src/tools/suggest-solution.js");

    const ticketRow = {
      id: "ticket-1",
      ticket_number: 3,
      title: "VPN outage",
      description: "VPN unreachable",
      priority: "high",
      status: "open",
      detected_language: "en",
      ai_analysis: { suggested_category: "Networking", sentiment: "urgent", smart_response: "..." },
    };
    const commentQuery = createQuery({ data: { id: "comment-1" }, error: null });
    const statusUpdateQuery = createQuery({ data: null, error: null });
    const from = createFromQueue([
      { table: "tickets", query: createQuery({ data: ticketRow, error: null }) },
      { table: "ticket_comments", query: commentQuery },
      { table: "tickets", query: statusUpdateQuery },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.generateSolution.mockResolvedValue({
      solution: "Restart the VPN concentrator.",
      confidence: "high",
      steps: ["Check WAN uplink", "Restart VPN service"],
      escalate: false,
    });

    const result = await suggestSolution({ ticket_ref: "TK-0003", save_as_comment: true });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.saved_as_comment).toBe(true);
    expect(parsed.escalate).toBe(false);
    expect(commentQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({ ticket_id: "ticket-1", is_internal: true, is_ai_generated: true })
    );
    expect(statusUpdateQuery.update).toHaveBeenCalledWith({ status: "in_progress" });
  });

  it("does not change ticket status when the solution requires escalation", async () => {
    const { suggestSolution } = await import("../src/tools/suggest-solution.js");

    const ticketRow = {
      id: "ticket-2",
      ticket_number: 4,
      title: "Data breach suspected",
      description: "Unusual login activity",
      priority: "critical",
      status: "open",
      detected_language: "en",
      ai_analysis: { suggested_category: "Security", sentiment: "urgent", smart_response: "..." },
    };
    const from = createFromQueue([
      { table: "tickets", query: createQuery({ data: ticketRow, error: null }) },
      { table: "ticket_comments", query: createQuery({ data: { id: "comment-2" }, error: null }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.generateSolution.mockResolvedValue({
      solution: "Requires on-site security review.",
      confidence: "low",
      steps: ["Contact security team"],
      escalate: true,
    });

    const result = await suggestSolution({ ticket_ref: "TK-0004", save_as_comment: true });
    const parsed = JSON.parse(result);

    expect(parsed.escalate).toBe(true);
    expect(parsed.message).toContain("requires escalation");
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("skips saving a comment when save_as_comment is false", async () => {
    const { suggestSolution } = await import("../src/tools/suggest-solution.js");

    const ticketRow = {
      id: "ticket-3",
      ticket_number: 8,
      title: "Slow laptop",
      description: "Laptop is slow",
      priority: "low",
      status: "open",
      detected_language: "en",
      ai_analysis: null,
    };
    const from = createFromQueue([{ table: "tickets", query: createQuery({ data: ticketRow, error: null }) }]);
    mocks.getSupabaseClient.mockReturnValue({ from });
    mocks.generateSolution.mockResolvedValue({
      solution: "Run disk cleanup.",
      confidence: "medium",
      steps: ["Free disk space"],
      escalate: false,
    });

    const result = await suggestSolution({ ticket_ref: "TK-0008", save_as_comment: false });
    const parsed = JSON.parse(result);

    expect(parsed.saved_as_comment).toBe(false);
    expect(from).toHaveBeenCalledTimes(1);
  });
});
