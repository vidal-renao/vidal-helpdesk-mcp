import type { IncomingMessage, ServerResponse } from "http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDomainSchema: vi.fn(),
}));

vi.mock("../src/lib/supabase.js", () => ({
  SUPABASE_SCHEMA: "public",
  getDomainSchema: mocks.getDomainSchema,
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
const originalEnv = { ...process.env };

describe("api/health/audit", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ALLOWED_ORIGINS = allowedOrigin;
    process.env.AUDIT_CRON_SECRET = "secret";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.RESEND_API_KEY = "re_test";
    process.env.MCP_ORGANIZATION_ID = "org-123";

    const query = {
      select: vi.fn(() => query),
      limit: vi.fn(() => Promise.resolve({ error: null })),
    };
    mocks.getDomainSchema.mockReturnValue({
      from: vi.fn(() => query),
    });
  });

  it("returns health status without sending email", async () => {
    const { res, json } = await callHealth("GET", "Bearer secret");

    expect(res.statusCode).toBe(200);
    expect(json).toMatchObject({
      status: "ok",
      supabase: "ok",
      resend: "configured",
      schema: "public",
      organizationId: "set",
      emailEnabled: true,
    });
  });

  it("requires the audit bearer token", async () => {
    const { res, json } = await callHealth("GET", "Bearer wrong");

    expect(res.statusCode).toBe(401);
    expect(json.error).toBe("Unauthorized");
  });

  it("fails closed when the audit secret is not configured", async () => {
    delete process.env.AUDIT_CRON_SECRET;
    const { res, json } = await callHealth("GET", "Bearer anything");
    expect(res.statusCode).toBe(503);
    expect(json.error).toBe("Service unavailable");
  });
});

async function callHealth(method: string, authorization?: string) {
  const { default: handler } = await import("../api/health/audit.js");
  const req = createRequest(method, authorization);
  const res = createResponse();

  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);

  return {
    res,
    json: res.body ? JSON.parse(res.body) : null,
  };
}

function createRequest(method: string, authorization?: string): MockRequest {
  return {
    method,
    url: "/api/health/audit",
    headers: {
      origin: allowedOrigin,
      ...(authorization ? { authorization } : {}),
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
