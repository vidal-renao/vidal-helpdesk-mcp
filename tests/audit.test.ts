import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";

import type { SlaAuditReport } from "../src/lib/sla-audit.js";

const mocks = vi.hoisted(() => ({
  claimAuditRunSlot: vi.fn(),
  markAuditRunSending: vi.fn(),
  markAuditRunSent: vi.fn(),
  markAuditRunFailed: vi.fn(),
  markDeliveryUnknown: vi.fn(),
  buildSlaAuditReport: vi.fn(),
  auditTemplate: vi.fn(),
  resendSend: vi.fn(),
}));

vi.mock("../src/lib/audit-runs.js", () => ({
  claimAuditRunSlot: mocks.claimAuditRunSlot,
  markAuditRunSending: mocks.markAuditRunSending,
  markAuditRunSent: mocks.markAuditRunSent,
  markAuditRunFailed: mocks.markAuditRunFailed,
  markDeliveryUnknown: mocks.markDeliveryUnknown,
  normalizeRecipient: (value: string) => value.trim().toLowerCase(),
  getUtcDayPeriod: () => ({ start: new Date("2026-07-21T00:00:00.000Z"), end: new Date("2026-07-22T00:00:00.000Z") }),
  stablePayloadHash: () => "persisted-hash",
  buildAuditFingerprint: (parts: unknown[]) => parts.map(String).join("|"),
}));

vi.mock("../src/lib/sla-audit.js", () => ({
  buildSlaAuditReport: mocks.buildSlaAuditReport,
}));

vi.mock("../src/lib/audit-template.js", () => ({
  auditTemplate: mocks.auditTemplate,
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

async function callAudit(method: string, authorization: string | undefined = "Bearer audit-secret", origin = allowedOrigin) {
  const { default: handler } = await import("../api/cron/audit.js");
  const req = createRequest(method, authorization, origin);
  const res = createResponse();

  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);

  return {
    res,
    json: res.body ? JSON.parse(res.body) : null,
  };
}

function fakeReport(overrides: Partial<SlaAuditReport> = {}): SlaAuditReport {
  return {
    generated_at: "2026-07-21T10:00:00.000Z",
    organization_id: "org-123",
    organization_name: "Vidal Lab",
    reporting_period: { start: "2026-07-21T00:00:00.000Z", end: "2026-07-22T00:00:00.000Z" },
    compliance_percentage: 75,
    active_ticket_count: 8,
    company_count: 2,
    unassigned_ticket_count: 6,
    vip_risk_count: 2,
    companies: [],
    tickets: [],
    vip_risks: [],
    action_items: [],
    ...overrides,
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

    process.env.AUDIT_CRON_SECRET = "audit-secret";

    mocks.buildSlaAuditReport.mockResolvedValue(fakeReport());
    mocks.auditTemplate.mockReturnValue("<html></html>");
    mocks.claimAuditRunSlot.mockResolvedValue({
      claimed: true, id: "run-1", retry: false, payloadHash: null, payloadSnapshot: null, idempotencyKey: null,
    });
    mocks.markAuditRunSending.mockResolvedValue({ ok: true, payloadHash: "hash" });
    mocks.markAuditRunSent.mockResolvedValue({ ok: true });
    mocks.markAuditRunFailed.mockResolvedValue({ ok: true });
    mocks.markDeliveryUnknown.mockResolvedValue({ ok: true });
    mocks.resendSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
  });

  it("returns 405 for non-POST requests", async () => {
    const { res, json } = await callAudit("GET");

    expect(res.statusCode).toBe(405);
    expect(json).toMatchObject({ error: "Method not allowed" });
    expect(typeof json.requestId).toBe("string");
  });

  it("returns 403 when the request origin is not allowlisted", async () => {
    const { res, json } = await callAudit("POST", "Bearer audit-secret", "https://evil.example");

    expect(res.statusCode).toBe(403);
    expect(json).toEqual({ error: "Forbidden origin" });
    expect(mocks.claimAuditRunSlot).not.toHaveBeenCalled();
  });

  it("returns 500 with an explicit runtime error when ALLOWED_ORIGINS is empty", async () => {
    process.env.ALLOWED_ORIGINS = "";

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.error).toBe("ALLOWED_ORIGINS must be configured with at least one origin at runtime");
    expect(mocks.claimAuditRunSlot).not.toHaveBeenCalled();
  });

  it("returns 204 for allowed CORS preflight requests", async () => {
    const { res, json } = await callAudit("OPTIONS");

    expect(res.statusCode).toBe(204);
    expect(json).toBeNull();
    expect(res.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(res.headers["access-control-allow-methods"]).toBe("POST, OPTIONS");
  });

  it("returns 401 when AUDIT_CRON_SECRET is configured and bearer token is invalid", async () => {
    const { res, json } = await callAudit("POST", "Bearer wrong-secret");

    expect(res.statusCode).toBe(401);
    expect(json).toMatchObject({ error: "Unauthorized" });
    expect(mocks.claimAuditRunSlot).not.toHaveBeenCalled();
  });

  it("returns 500 with a controlled error body (no stack) when required environment is missing", async () => {
    delete process.env.MCP_ORGANIZATION_ID;

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.error).toBe("Missing runtime env vars: MCP_ORGANIZATION_ID");
    expect(json.stack).toBeUndefined();
  });

  it("sends the first report of the day and marks the claimed slot sent with the provider message id", async () => {
    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(200);
    expect(json.success).toBe(true);
    expect(json.stats).toMatchObject({ compliance: 75, totalTickets: 8, companyCount: 2, vipRiskCount: 2 });
    expect(json.auditRun).toEqual({ id: "run-1", claimed: true, skippedReason: null });
    expect(json.emailSent).toBe(true);
    expect(mocks.claimAuditRunSlot).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-123", reportType: "sla_daily_audit", recipient: "htcpacoxo31@gmail.com" })
    );
    expect(mocks.resendSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: "audit@example.com", to: "htcpacoxo31@gmail.com" }),
      { idempotencyKey: "sla-audit/run-1" }
    );
    expect(mocks.markAuditRunSent).toHaveBeenCalledWith("run-1", "email-123");
    expect(mocks.markAuditRunFailed).not.toHaveBeenCalled();
  });

  it("skips a second invocation for the same period once a report has already been sent", async () => {
    mocks.claimAuditRunSlot.mockResolvedValue({ claimed: false, reason: "already_sent" });

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(200);
    expect(json.auditRun).toEqual({ id: null, claimed: false, skippedReason: "already_sent" });
    expect(json.emailSent).toBe(false);
    expect(json.emailSkippedReason).toBe("already_sent");
    expect(mocks.buildSlaAuditReport).not.toHaveBeenCalled();
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it("skips a concurrent invocation for the same period while another claim is in progress", async () => {
    mocks.claimAuditRunSlot.mockResolvedValue({ claimed: false, reason: "in_progress" });

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(409);
    expect(json.emailSkippedReason).toBe("in_progress");
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it("marks the claimed run failed and reports the email error when Resend rejects the send", async () => {
    mocks.resendSend.mockResolvedValue({ data: null, error: { name: "validation_error", message: "invalid recipient" } });

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.emailSent).toBe(false);
    expect(json.emailError).toBe("invalid recipient");
    expect(mocks.markAuditRunFailed).toHaveBeenCalledWith("run-1", "sending", "validation_error", "invalid recipient");
    expect(mocks.markAuditRunSent).not.toHaveBeenCalled();
  });

  it("returns 503 when AUDIT_CRON_SECRET is not configured", async () => {
    delete process.env.AUDIT_CRON_SECRET;
    const { res, json } = await callAudit("POST");
    expect(res.statusCode).toBe(503);
    expect(json.error).toBe("Service unavailable");
    expect(mocks.claimAuditRunSlot).not.toHaveBeenCalled();
  });

  it("moves an ambiguous provider timeout to delivery_unknown without automatic resend", async () => {
    mocks.resendSend.mockRejectedValue(new Error("timeout after request upload"));
    const { json } = await callAudit("POST");
    expect(json.emailSkippedReason).toBe("delivery_unknown");
    expect(json.persistedDeliveryState).toBe("delivery_unknown");
    expect(json.persistenceConfirmed).toBe(true);
    expect(mocks.markDeliveryUnknown).toHaveBeenCalledWith(
      "run-1",
      "provider_response_unknown",
      "timeout after request upload"
    );
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
  });

  it("does not call Resend again while retrying sent-state persistence", async () => {
    mocks.markAuditRunSent.mockResolvedValue({ ok: false });
    const { json } = await callAudit("POST");
    expect(json.emailSkippedReason).toBe("delivery_state_unconfirmed");
    expect(mocks.markAuditRunSent).toHaveBeenCalledTimes(3);
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    expect(mocks.markDeliveryUnknown).toHaveBeenCalledWith(
      "run-1",
      "sent_persistence_failed",
      expect.any(String),
      "email-123"
    );
  });

  it("rejects a changed payload under the persisted idempotency key", async () => {
    mocks.markAuditRunSending.mockResolvedValue({ ok: false, reason: "payload_conflict", payloadHash: "new" });
    const { res, json } = await callAudit("POST");
    expect(res.statusCode).toBe(500);
    expect(json.emailSkippedReason).toBe("pre_provider_failure");
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  // Phase 4A.16 regression, at the HTTP boundary. This is the exact production
  // response that three consecutive scheduled runs returned while sending
  // nothing -- and that the workflow accepted as success purely because the
  // status line said 200.
  it("returns 500, not 200, when the ledger is unreachable and nothing was sent", async () => {
    mocks.claimAuditRunSlot.mockResolvedValue({ claimed: false, reason: "claim_failed", errorCode: "PGRST106" });

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.emailSent).toBe(false);
    expect(json.emailSkippedReason).toBe("claim_failed");
    expect(json.claimErrorCode).toBe("PGRST106");
    expect(json.deliveryVerdict).toBe("claim_failed");
    expect(mocks.buildSlaAuditReport).not.toHaveBeenCalled();
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it("returns 503 and advertises emailEnabled=false when audit email is switched off", async () => {
    process.env.AUDIT_EMAIL_ENABLED = "false";

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(503);
    expect(json.emailEnabled).toBe(false);
    expect(json.emailSkippedReason).toBe("disabled");
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it("advertises emailEnabled=true on a successful delivery so callers can assert on it", async () => {
    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(200);
    expect(json.emailEnabled).toBe(true);
    expect(json.deliveryVerdict).toBe("delivered");
  });

  it.each([
    ["delivery_unknown", () => mocks.resendSend.mockRejectedValue(new Error("timeout"))],
    ["delivery_state_unconfirmed", () => mocks.markAuditRunSent.mockResolvedValue({ ok: false })],
  ])("returns 500 for the %s outcome so the workflow cannot go green on it", async (_label, arrange) => {
    arrange();

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.emailSent).toBe(false);
  });

  it("allows a retry after a previous failure to reclaim the slot and succeed", async () => {
    // claimAuditRunSlot itself owns the failed->pending reclaim logic (tested at
    // the unit level in audit-runs.test.ts); from the service's perspective a
    // reclaimed slot looks identical to a fresh claim.
    const snapshot = { from: "audit@example.com", to: "htcpacoxo31@gmail.com", subject: "Stable", html: "<p>stored</p>" };
    mocks.claimAuditRunSlot.mockResolvedValue({
      claimed: true,
      id: "run-1",
      retry: true,
      payloadHash: "persisted-hash",
      payloadSnapshot: snapshot,
      idempotencyKey: "sla-audit/run-1",
    });

    const { json } = await callAudit("POST");

    expect(json.emailSent).toBe(true);
    expect(mocks.buildSlaAuditReport).not.toHaveBeenCalled();
    expect(mocks.resendSend).toHaveBeenCalledWith(snapshot, { idempotencyKey: "sla-audit/run-1" });
    expect(mocks.markAuditRunSent).toHaveBeenCalledWith("run-1", "email-123");
  });

  it("reports sending when neither sent nor delivery_unknown can be persisted", async () => {
    mocks.markAuditRunSent.mockResolvedValue({ ok: false });
    mocks.markDeliveryUnknown.mockResolvedValue({ ok: false });
    const { json } = await callAudit("POST");
    expect(json.effectiveDeliveryOutcome).toBe("provider_confirmed");
    expect(json.persistedDeliveryState).toBe("sending");
    expect(json.persistenceConfirmed).toBe(false);
    expect(json.manualReconciliationRequired).toBe(true);
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
  });

  it("skips claiming entirely when AUDIT_EMAIL_ENABLED is false", async () => {
    process.env.AUDIT_EMAIL_ENABLED = "false";

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(503);
    expect(json.emailSkippedReason).toBe("disabled");
    expect(mocks.claimAuditRunSlot).not.toHaveBeenCalled();
    expect(mocks.buildSlaAuditReport).not.toHaveBeenCalled();
  });

  it("marks the claimed run failed and returns 500 when report generation throws", async () => {
    mocks.buildSlaAuditReport.mockRejectedValue(new Error("Supabase tickets query failed: relation does not exist"));

    const { res, json } = await callAudit("POST");

    expect(res.statusCode).toBe(500);
    expect(json.error).toBe("Supabase tickets query failed: relation does not exist");
    expect(mocks.markAuditRunFailed).toHaveBeenCalledWith(
      "run-1",
      "pending",
      "pre_provider_failure",
      "Supabase tickets query failed: relation does not exist"
    );
  });
});
