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
      { table: "hd_admin_audit_logs", query: createQuery({ data: null, error: null }) },
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

  describe("resolution SLA verdict (REQ-F1-03)", () => {
    async function resolve(ticketRow: Record<string, unknown>) {
      const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
      const updateQuery = createQuery({ data: null, error: null });
      mocks.getSupabaseClient.mockReturnValue({
        from: createFromQueue([
          { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
          { table: "hd_tickets", query: updateQuery },
          { table: "hd_admin_audit_logs", query: createQuery({ data: null, error: null }) },
        ]),
      });
      await updateTicketStatus({ ticket_ref: "TK-0020", status: "resolved" });
      return (updateQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }
    const base = { id: "ticket-20", ticket_number: 20, status: "in_progress", priority: "high", title: "Late" };

    it("marks a late resolution as breached and keeps a response breach in the aggregate", async () => {
      const payload = await resolve({
        ...base,
        resolution_due_at: "2000-01-01T00:00:00.000Z",
        sla_response_breached: false,
      });
      expect(payload).toMatchObject({ sla_resolution_breached: true, sla_resolution_met: false, sla_breached: true });
    });

    it("marks an on-time resolution as met", async () => {
      const payload = await resolve({
        ...base,
        resolution_due_at: "2999-01-01T00:00:00.000Z",
        sla_response_breached: false,
      });
      expect(payload).toMatchObject({ sla_resolution_breached: false, sla_resolution_met: true, sla_breached: false });
    });

    it("falls back to the legacy deadline column and keeps an earlier response breach", async () => {
      const payload = await resolve({
        ...base,
        resolution_due_at: null,
        sla_resolution_due: "2999-01-01T00:00:00.000Z",
        sla_response_breached: true,
      });
      expect(payload).toMatchObject({ sla_resolution_met: true, sla_breached: true });
    });

    it("writes no verdict when the ticket has no resolution deadline", async () => {
      const payload = await resolve({ ...base, resolution_due_at: null, sla_resolution_due: null });
      expect(payload).not.toHaveProperty("sla_resolution_met");
      expect(payload).not.toHaveProperty("sla_resolution_breached");
    });
  });

  it("records the MCP actor in details, not in the profile foreign key", async () => {
    const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
    const auditQuery = createQuery({ data: null, error: null });
    mocks.getSupabaseClient.mockReturnValue({
      from: createFromQueue([
        { table: "hd_tickets", query: createQuery({ data: { id: "t-30", ticket_number: 30, status: "open", priority: "low", title: "x" }, error: null }) },
        { table: "hd_tickets", query: createQuery({ data: null, error: null }) },
        { table: "hd_admin_audit_logs", query: auditQuery },
      ]),
    });
    await updateTicketStatus({ ticket_ref: "TK-0030", status: "in_progress" });
    const row = (auditQuery.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(row.actor_id).toBeNull();
    expect(row.actor_type).toBe("mcp");
    expect(row.details).toMatchObject({ agent_id: "agent-456", from: "open", to: "in_progress" });
  });

  it("sets closed_at when moving a ticket to closed", async () => {
    const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");

    const ticketRow = { id: "ticket-2", ticket_number: 13, status: "resolved", priority: "low", title: "Printer jam" };
    const updateQuery = createQuery({ data: null, error: null });
    const from = createFromQueue([
      { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
      { table: "hd_tickets", query: updateQuery },
      { table: "hd_admin_audit_logs", query: createQuery({ data: null, error: null }) },
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

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await updateTicketStatus({ ticket_ref: "TK-0014", status: "in_progress" }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Failed to update ticket status");
    // No audit event for a status change that did not happen (queue has no audit entry).
    expect(from).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  describe("audit event (REQ-F1-06)", () => {
    const TICKET_UUID = "3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c";
    const ticketRow = { id: TICKET_UUID, ticket_number: 12, status: "in_progress", priority: "high", title: "VPN outage" };

    it("writes the agreed hd_admin_audit_logs row after a successful change", async () => {
      const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
      const auditQuery = createQuery({ data: null, error: null });
      const from = createFromQueue([
        { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
        { table: "hd_tickets", query: createQuery({ data: null, error: null }) },
        { table: "hd_admin_audit_logs", query: auditQuery },
        { table: "hd_ticket_comments", query: createQuery({ data: { id: "c-1" }, error: null }) },
      ]);
      mocks.getSupabaseClient.mockReturnValue({ from });

      const parsed = JSON.parse(
        await updateTicketStatus({ ticket_ref: "TK-0012", status: "resolved", comment: "Secret customer note" })
      );

      expect(parsed.success).toBe(true);
      expect(parsed.audit_logged).toBe(true);
      const payload = (auditQuery.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload).toEqual({
        organization_id: "org-123",
        actor_id: null,
        actor_type: "mcp",
        action: "ticket.status_changed",
        target_type: "ticket",
        target_id: TICKET_UUID,
        outcome: "success",
        details: { from: "in_progress", to: "resolved", ticket_number: 12, agent_id: "agent-456" },
      });
      expect(JSON.stringify(payload)).not.toContain("Secret customer note");
    });

    it("uses a null actor_id when MCP_AGENT_ID is not configured", async () => {
      delete process.env.MCP_AGENT_ID;
      const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
      const auditQuery = createQuery({ data: null, error: null });
      mocks.getSupabaseClient.mockReturnValue({
        from: createFromQueue([
          { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
          { table: "hd_tickets", query: createQuery({ data: null, error: null }) },
          { table: "hd_admin_audit_logs", query: auditQuery },
        ]),
      });

      await updateTicketStatus({ ticket_ref: "TK-0012", status: "open" });

      expect((auditQuery.insert as ReturnType<typeof vi.fn>).mock.calls[0][0].actor_id).toBeNull();
    });

    it("reports audit_logged: false and logs only the code when the audit write fails", async () => {
      const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.getSupabaseClient.mockReturnValue({
        from: createFromQueue([
          { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
          { table: "hd_tickets", query: createQuery({ data: null, error: null }) },
          {
            table: "hd_admin_audit_logs",
            query: createQuery({ data: null, error: { code: "42P01", message: 'relation "hd_admin_audit_logs" does not exist' } }),
          },
        ]),
      });

      const raw = await updateTicketStatus({ ticket_ref: "TK-0012", status: "resolved" });
      const parsed = JSON.parse(raw);

      expect(parsed.success).toBe(true);
      expect(parsed.new_status).toBe("resolved");
      expect(parsed.audit_logged).toBe(false);
      expect(raw).not.toContain("does not exist");
      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).toContain("42P01");
      expect(logged).not.toContain("does not exist");
      consoleError.mockRestore();
    });

    it("does not throw when the audit client call itself rejects", async () => {
      const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const rejecting = createQuery();
      (rejecting.insert as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("network down with secret detail");
      });
      mocks.getSupabaseClient.mockReturnValue({
        from: createFromQueue([
          { table: "hd_tickets", query: createQuery({ data: ticketRow, error: null }) },
          { table: "hd_tickets", query: createQuery({ data: null, error: null }) },
          { table: "hd_admin_audit_logs", query: rejecting },
        ]),
      });

      const raw = await updateTicketStatus({ ticket_ref: "TK-0012", status: "closed" });
      const parsed = JSON.parse(raw);
      expect(parsed.success).toBe(true);
      expect(parsed.audit_logged).toBe(false);
      expect(raw).not.toContain("secret detail");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret detail");
      consoleError.mockRestore();
    });
  });

  describe("input hardening", () => {
    it.each(["abc", "TK-", "TK-12345678", "TK-12; drop", "12", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", "------------------------------------"])(
      "rejects malformed ticket_ref %j in the schema",
      async (ref) => {
        const { updateTicketStatusSchema } = await import("../src/tools/update-ticket-status.js");
        expect(updateTicketStatusSchema.safeParse({ ticket_ref: ref, status: "open" }).success).toBe(false);
      }
    );

    it.each(["TK-0012", "TK12", "tk-1", "TK-1234567", "3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c", "3F2B8C1E-7A4D-4E9B-9C1A-5D6E7F8A9B0C"])(
      "accepts ticket_ref %j",
      async (ref) => {
        const { updateTicketStatusSchema } = await import("../src/tools/update-ticket-status.js");
        expect(updateTicketStatusSchema.safeParse({ ticket_ref: ref, status: "open" }).success).toBe(true);
      }
    );

    it("never queries with NaN: a malformed ref passed directly returns not found without touching the database", async () => {
      const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
      const from = createFromQueue([]);
      mocks.getSupabaseClient.mockReturnValue({ from });

      const parsed = JSON.parse(await updateTicketStatus({ ticket_ref: "garbage", status: "open" }));
      expect(parsed.success).toBe(false);
      expect(from).not.toHaveBeenCalled();
    });

    it("looks a TK reference up by its numeric ticket_number", async () => {
      const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
      const lookup = createQuery({ data: null, error: { message: "not found" } });
      mocks.getSupabaseClient.mockReturnValue({ from: createFromQueue([{ table: "hd_tickets", query: lookup }]) });

      await updateTicketStatus({ ticket_ref: "tk-0012", status: "open" });

      expect(lookup.eq).toHaveBeenCalledWith("organization_id", "org-123");
      expect(lookup.eq).toHaveBeenCalledWith("ticket_number", 12);
    });

    it("caps the comment at 2000 characters", async () => {
      const { updateTicketStatusSchema } = await import("../src/tools/update-ticket-status.js");
      const base = { ticket_ref: "TK-1", status: "open" };
      expect(updateTicketStatusSchema.safeParse({ ...base, comment: "x".repeat(2000) }).success).toBe(true);
      expect(updateTicketStatusSchema.safeParse({ ...base, comment: "x".repeat(2001) }).success).toBe(false);
    });

    it("excludes soft-deleted tickets from the lookup and scopes the update by organization", async () => {
      const { updateTicketStatus } = await import("../src/tools/update-ticket-status.js");
      const lookup = createQuery({ data: { id: "t-1", ticket_number: 5, status: "open" }, error: null });
      const updateQuery = createQuery({ data: null, error: null });
      mocks.getSupabaseClient.mockReturnValue({
        from: createFromQueue([
          { table: "hd_tickets", query: lookup },
          { table: "hd_tickets", query: updateQuery },
          { table: "hd_admin_audit_logs", query: createQuery({ data: null, error: null }) },
        ]),
      });

      await updateTicketStatus({ ticket_ref: "TK-5", status: "in_progress" });

      expect(lookup.is).toHaveBeenCalledWith("deleted_at", null);
      expect(updateQuery.eq).toHaveBeenCalledWith("organization_id", "org-123");
      expect(updateQuery.is).toHaveBeenCalledWith("deleted_at", null);
    });
  });
});
