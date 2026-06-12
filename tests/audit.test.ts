import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
  auditRunsInsert: vi.fn(),
  resendSend: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  SUPABASE_SCHEMA: "helpdesk",
  getSupabaseClient: mocks.getSupabaseClient,
  getHelpdeskSchema: () => mocks.getSupabaseClient().schema("helpdesk"),
  getPublicSchema: () => mocks.getSupabaseClient().schema("public"),
}));

vi.mock("../src/lib/audit-runs.js", () => ({
  auditRunsTable: () => ({
    insert: mocks.auditRunsInsert,
  }),
  buildAuditFingerprint: (parts: Array<string | number | boolean | null | undefined>) =>
    parts.map((part) => (part == null ? "null" : String(part).trim())).join("|"),
  formatSupabaseError: (error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined) =>
    error
      ? {
          message: error.message ?? null,
          code: error.code ?? null,
          details: error.details ?? null,
          hint: error.hint ?? null,
          schema: "helpdesk",
        }
      : null,
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: mocks.resendSend,
    };
  },
}));

type MockRequest = {
  method: string;
  headers: Record<string, string | undefined>;
  url: string;
};

type MockResponse = {
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: string;
  setHeader: (name: string, value: string | number | string[]) => void;
  writeHead: (statusCode: number, headers?: Record<string, string | number | string[]>) => void;
  end: (chunk?: string | Buffer) => void;
};

const allowedOrigin = "https://ops.vidal.local";

function createRequest(method: string, authorization?: string, origin = allowedOrigin): MockRequest {
  return {
    method,
    url: "/api/cron/audit",
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(origin ? { origin } : {}),
    },
  };
}

function createResponse(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) {
        this.headers[name.toLowerCase()] = value;
      }
    },
    end(chunk) {
      this.body = chunk ? chunk.toString() : "";
    },
  };
}

function createTicketCountQuery(count: number, error: unknown = null) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    then: vi.fn((resolve, reject) => Promise.resolve({ count, error }).then(resolve, reject)),
  };

  return query;
}

function createOrganizationQuery(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(() => Promise.resolve({ data, error })),
  };

  return query;
}

function mockSupabaseAuditData({
  totalTickets = 4,
  compliantTickets = 3,
  vipBreaches = 2,
  organization = { name: "VIDAL Lab", slug: "vidal-lab" },
  totalTicketsError = null,
}: {
  totalTickets?: number;
  compliantTickets?: number;
  vipBreaches?: number;
  organization?: unknown;
  totalTicketsError?: unknown;
} = {}) {
  const ticketQueries = [
    createTicketCountQuery(totalTickets, totalTicketsError),
    createTicketCountQuery(compliantTickets),
    createTicketCountQuery(vipBreaches),
  ];
  const organizationQuery = createOrganizationQuery(organization);

  const helpdeskSchema = {
    from: vi.fn((table: string) => {
      if (table === "tickets") {
        const query = ticketQueries.shift();
        if (!query) throw new Error("Unexpected tickets query");
        return query;
      }

      if (table === "organizations") {
        return organizationQuery;
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  const publicSchema = {
    from: vi.fn((table: string) => {
      if (table === "organizations") {
        return organizationQuery;
      }

      throw new Error(`Unexpected public table: ${table}`);
    }),
  };

  mocks.getSupabaseClient.mockReturnValue({
    schema: vi.fn((schema: string) => {
      if (schema === "helpdesk") {
        return helpdeskSchema;
      }

      if (schema === "public") {
        return publicSchema;
      }

      throw new Error(`Unexpected schema: ${schema}`);
    }),
  });
}

async function callAudit(method: string, authorization?: string, origin = allowedOrigin) {
  const { default: handler } = await import("../api/cron/audit.js");
  const req = createRequest(method, authorization, origin);
  const res = createResponse();

  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);

  return {
    res,
    json: res.body ? JSON.parse(res.body) : null,
  };
}

const originalEnv = { ...process.env };

describe("api/cron/audit", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.MCP_ORGANIZATION_ID = "org-123";
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "audit@example.com";
    process.env.ALLOWED_ORIGINS = allowedOrigin;

    delete process.env.AUDIT_CRON_SECRET;

    mocks.auditRunsInsert.mockResolvedValue({ error: null });
    mocks.resendSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
    mockSupabaseAuditData();
  });

  it("returns 405 for non-POST requests", async () => {
    const { res, json } = await callAudit("GET");

    expect(res.statusCode).toBe(405);
    expect(json).toMatchObject({ error: "Method not allowed" });
    expect(typeof json.requestId).toBe("string");
  });

  it("returns 403 when the request origin is not allowlisted", async () => {
    const { res, json } = await callAudit("POST", undefined, "https://evil.example");

    expect(res.statusCode).toBe(403);
    expect(json).toEqual({ error: "Forbidden origin" });
    expect(mocks.getSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 with an explicit runtime error when ALLOWED_ORIGINS is empty", async () => {
    process.env.ALLOWED_ORIGINS = "";

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.error).toBe("ALLOWED_ORIGINS must be configured with at least one origin at runtime");
    expect(mocks.getSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 204 for allowed CORS preflight requests", async () => {
    const { res, json } = await callAudit("OPTIONS");

    expect(res.statusCode).toBe(204);
    expect(json).toBeNull();
    expect(res.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(res.headers["access-control-allow-methods"]).toBe("POST, OPTIONS");
  });

  it("returns 401 when AUDIT_CRON_SECRET is configured and bearer token is invalid", async () => {
    process.env.AUDIT_CRON_SECRET = "expected-secret";

    const { res, json } = await callAudit("POST", "Bearer wrong-secret");

    expect(res.statusCode).toBe(401);
    expect(json).toMatchObject({ error: "Unauthorized" });
    expect(typeof json.requestId).toBe("string");
    expect(mocks.getSupabaseClient).not.toHaveBeenCalled();
  });

  it("allows the audit request when AUDIT_CRON_SECRET is not configured", async () => {
    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(200);
    expect(json.success).toBe(true);
    expect(json.auditRun.persisted).toBe(true);
  });

  it("calculates compliance, SLA findings, VIP breaches, and persists the audit run", async () => {
    mockSupabaseAuditData({
      totalTickets: 8,
      compliantTickets: 6,
      vipBreaches: 2,
    });

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(200);
    expect(json.stats).toEqual({
      compliance: 75,
      totalTickets: 8,
      vipBreaches: 2,
    });
    expect(json.auditRun).toMatchObject({
      overallSeverity: "critical",
      findingsCount: 2,
      persisted: true,
    });
    expect(mocks.resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "audit@example.com",
        to: "htcpacoxo31@gmail.com",
        subject: expect.stringContaining("75% SLA Compliance"),
      })
    );
    expect(mocks.auditRunsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-123",
        overall_severity: "critical",
        findings_count: 2,
        payload: expect.objectContaining({
          compliance: 75,
          totalTickets: 8,
          compliantTickets: 6,
          vipBreaches: 2,
          emailSent: true,
        }),
      })
    );
  });

  it("returns 500 with a controlled error body when required environment is missing", async () => {
    delete process.env.MCP_ORGANIZATION_ID;

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.error).toBe("Missing runtime env vars: MCP_ORGANIZATION_ID");
    expect(typeof json.stack).toBe("string");
  });

  it("returns 500 with Supabase diagnostic detail when a required query fails", async () => {
    mockSupabaseAuditData({
      totalTicketsError: {
        message: "relation helpdesk.tickets does not exist",
        code: "42P01",
      },
    });

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.error).toBe("Supabase total tickets query failed: relation helpdesk.tickets does not exist");
  });
});
