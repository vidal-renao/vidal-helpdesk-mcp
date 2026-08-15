import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  getSupabaseClient: mocks.getSupabaseClient,
}));

const originalEnv = { ...process.env };

describe("updateTicketStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
    process.env.MCP_AGENT_ID = "agent-456";
  });

  it("sets resolved_at when moving a ticket to resolved and records the comment", async () => {
    const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");

    const ticketRow = { id: "ticket-1", ticket_number: 12, status: "in_progress", priority: "high", title: "VPN outage" };
    const updateQuery = createQuery({ data: null, error: null });
    const commentQuery = createQuery({ data: { id: "comment-1" }, error: null });
    const from = createFromQueue([
      { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
      { table: "hd_tickets", query: updateQuery },
      { table: "hd_ticket_comments", query: commentQuery },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await updateTicketStatus({ ticket_ref: "TK-0012", status: "resolved", comment: "Fixed the uplink." });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.previous_status).toBe("in_progress");
    expect(parsed.new_status).toBe("resolved");
    expect(parsed.comment_added).toBe(true);
    const updatePayload = (updateQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updatePayload.status).toBe("resolved");
    expect(typeof updatePayload.resolved_at).toBe("string");
    expect(updatePayload.closed_at).toBeUndefined();
  });

  it("sets closed_at when moving a ticket to closed", async () => {
    const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");

    const ticketRow = { id: "ticket-2", ticket_number: 13, status: "resolved", priority: "low", title: "Printer jam" };
    const updateQuery = createQuery({ data: null, error: null });
    const from = createFromQueue([
      { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
      { table: "hd_tickets", query: updateQuery },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await updateTicketStatus({ ticket_ref: "TK-0013", status: "closed" });
    const parsed = JSON.parse(result);

    expect(parsed.comment_added).toBe(false);
    const updatePayload = (updateQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof updatePayload.closed_at).toBe("string");
  });

  it("returns success: false when the ticket is not found", async () => {
    const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");

    const from = createFromQueue([
      { table: "hd_tickets", query: createQuery({ data: null, error: { message: "not found" } }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await updateTicketStatus({ ticket_ref: "TK-9999", status: "open" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
  });

  it("throws when the update itself fails", async () => {
    const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");

    const ticketRow = { id: "ticket-3", ticket_number: 14, status: "open", priority: "low", title: "Test" };
    const from = createFromQueue([
      { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
      { table: "hd_tickets", query: createQuery({ data: null, error: { message: "db unavailable" } }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    await expect(updateTicketStatus({ ticket_ref: "TK-0014", status: "in_progress" })).rejects.toThrow(
      "Failed to update: db unavailable"
    );
  });
});
