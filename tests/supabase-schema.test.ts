import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  schema: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
  SupabaseClient: class {},
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  vi.clearAllMocks();
});

async function loadSupabaseModule(schema?: string) {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  if (schema === undefined) delete process.env.SUPABASE_SCHEMA;
  else process.env.SUPABASE_SCHEMA = schema;

  mocks.schema.mockReturnValue({ from: vi.fn(() => "query-builder") });
  mocks.createClient.mockReturnValue({ schema: mocks.schema });

  return import("../src/lib/supabase.js");
}

/**
 * Phase 4A.16 guard. PostgREST on this project exposes only
 * (public, omnisciencia, aura_core). Code that targets `helpdesk` typechecks,
 * passes every mocked unit test, and then fails in production with PGRST106 --
 * which is how three days of daily audit reports were lost. These tests pin the
 * one property the other mocks cannot express: which schema the code actually
 * asks PostgREST for.
 */
describe("Supabase schema routing", () => {
  it("routes the audit ledger through the exposed public schema, never helpdesk", async () => {
    const supabase = await loadSupabaseModule();

    expect(supabase.getAuditRunsTable()).toBe("query-builder");
    expect(mocks.schema).toHaveBeenCalledWith("public");
    expect(mocks.schema).not.toHaveBeenCalledWith("helpdesk");
  });

  it("no longer exports a helpdesk schema accessor", async () => {
    const supabase = await loadSupabaseModule();
    expect(supabase).not.toHaveProperty("getHelpdeskSchema");
  });

  it("defaults to the public schema when SUPABASE_SCHEMA is unset", async () => {
    const supabase = await loadSupabaseModule();

    expect(supabase.SUPABASE_SCHEMA).toBe("public");
    expect(() => supabase.getDomainSchema()).not.toThrow();
    expect(mocks.schema).toHaveBeenCalledWith("public");
  });

  it("refuses a SUPABASE_SCHEMA that PostgREST cannot serve instead of failing one query later", async () => {
    const supabase = await loadSupabaseModule("helpdesk");

    expect(() => supabase.getDomainSchema()).toThrow(/PostgREST does not expose/);
    expect(mocks.schema).not.toHaveBeenCalledWith("helpdesk");
  });
});
