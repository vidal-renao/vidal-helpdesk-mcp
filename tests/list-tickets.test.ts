import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFromQueue, createQuery } from "./helpers/supabase-mock.js";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  getSupabaseClient: mocks.getSupabaseClient,
}));

const originalEnv = { ...process.env };

describe("listTickets", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_ORGANIZATION_ID = "org-123";
  });

  it("lists tickets and unwraps object-shaped embedded relations", async () => {
    const { listTickets } = await import("../src/tools/list-tickets.js");

    const rows = [
      {
        id: "t1",
        ticket_number: 10,
        title: "VPN outage",
        status: "open",
        priority: "high",
        detected_language: "en",
        sla_breached: false,
        contains_pii: false,
        created_at: "2026-07-20T00:00:00.000Z",
        categories: { name: "Networking" },
        ai_analysis: { sentiment: "urgent", confidence_score: 90, summary: "VPN down" },
      },
    ];
    const query = createQuery({ data: rows, error: null });
    const from = createFromQueue([{ table: "tickets", query }]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await listTickets({ limit: 10, status: "open", priority: "high" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.tickets[0]).toMatchObject({ ref: "TK-0010", category: "Networking", sentiment: "urgent" });
    expect(query.eq).toHaveBeenCalledWith("organization_id", "org-123");
    expect(query.eq).toHaveBeenCalledWith("status", "open");
    expect(query.eq).toHaveBeenCalledWith("priority", "high");
    expect(query.limit).toHaveBeenCalledWith(10);
  });

  it("unwraps array-shaped embedded relations", async () => {
    const { listTickets } = await import("../src/tools/list-tickets.js");

    const rows = [
      {
        id: "t2",
        ticket_number: 11,
        title: "Printer jam",
        status: "resolved",
        priority: "low",
        detected_language: "de",
        sla_breached: false,
        contains_pii: false,
        created_at: "2026-07-19T00:00:00.000Z",
        categories: [{ name: "Hardware" }],
        ai_analysis: [{ sentiment: "calm", confidence_score: 70, summary: "Toner replacement" }],
      },
    ];
    const from = createFromQueue([{ table: "tickets", query: createQuery({ data: rows, error: null }) }]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    const result = await listTickets({ limit: 10 });
    const parsed = JSON.parse(result);

    expect(parsed.tickets[0]).toMatchObject({ ref: "TK-0011", category: "Hardware", sentiment: "calm" });
  });

  it("throws when the Supabase query fails", async () => {
    const { listTickets } = await import("../src/tools/list-tickets.js");

    const from = createFromQueue([
      { table: "tickets", query: createQuery({ data: null, error: { message: "connection reset" } }) },
    ]);
    mocks.getSupabaseClient.mockReturnValue({ from });

    await expect(listTickets({ limit: 10 })).rejects.toThrow("Supabase error: connection reset");
  });
});
