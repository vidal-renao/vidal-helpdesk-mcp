import { describe, expect, it } from "vitest";

import { auditTemplate, getAuditEmailSubject } from "../src/lib/audit-template.js";
import type { SlaAuditReport, SlaAuditTicket } from "../src/lib/sla-audit.js";

function baseReport(overrides: Partial<SlaAuditReport> = {}): SlaAuditReport {
  return {
    generated_at: "2026-07-22T05:17:00.000Z",
    organization_id: "org-123",
    organization_name: "Vidal Lab",
    reporting_period: { start: "2026-07-22T00:00:00.000Z", end: "2026-07-23T00:00:00.000Z" },
    compliance_percentage: null,
    compliance_window: {
      days: 7,
      start: "2026-07-15T05:17:00.000Z",
      end: "2026-07-22T05:17:00.000Z",
      resolved_ticket_count: 0,
      measured_ticket_count: 0,
      compliant_ticket_count: 0,
      response: { measured: 0, met: 0 },
      resolution: { measured: 0, met: 0 },
    },
    health: "healthy",
    sla_measured_ticket_count: 0,
    sla_unmeasured_ticket_count: 0,
    breached_ticket_count: 0,
    at_risk_ticket_count: 0,
    unowned_ticket_count: 0,
    waiting_ticket_count: 0,
    awaiting_approval_count: 0,
    oldest_active_age_days: null,
    active_ticket_count: 0,
    company_count: 0,
    unassigned_ticket_count: 0,
    vip_risk_count: 0,
    companies: [],
    tickets: [],
    vip_risks: [],
    awaiting_approval: [],
    action_items: [],
    ...overrides,
  };
}

function riskTicket(overrides: Partial<SlaAuditTicket> = {}): SlaAuditTicket {
  return {
    ticket_id: "t1",
    ticket_reference: "TK-0123",
    ticket_title: "VPN outage",
    ticket_status: "open",
    priority: "high",
    customer_profile_id: "a",
    company_id: "a",
    company_name: "Acme Corp",
    company_assignment_status: "assigned",
    project_id: null,
    project_name: null,
    sla_status: "breached",
    response_status: null,
    resolution_status: "overdue",
    response_due_at: null,
    resolution_due_at: "2026-07-22T03:00:00.000Z",
    first_response_at: null,
    sla_measured: true,
    has_owner: true,
    review_status: "not_requested",
    awaiting_approval: false,
    age_days: 3,
    vip_risk: true,
    risk_reason: "Resolution overdue by 2h.",
    required_action: "Escalate immediately and notify the account owner.",
    due_at: "2026-07-22T03:00:00.000Z",
    ...overrides,
  };
}

describe("auditTemplate", () => {
  it("renders company names and per-company active-ticket counts", () => {
    const html = auditTemplate(
      baseReport({
        companies: [
          { company_id: "a", company_name: "Acme Corp", active_ticket_count: 2 },
          { company_id: "b", company_name: "Zenith Ltd", active_ticket_count: 1 },
        ],
      })
    );

    expect(html).toContain("Acme Corp");
    expect(html).toContain("2 active tickets");
    expect(html).toContain("Zenith Ltd");
    expect(html).toContain("1 active ticket<");
  });

  it("renders high-priority SLA risk detail without a project segment", () => {
    const html = auditTemplate(
      baseReport({
        vip_risk_count: 1,
        vip_risks: [riskTicket()],
        action_items: ["TK-0123 (Acme Corp) — Escalate immediately and notify the account owner."],
      })
    );

    expect(html).toContain("High-priority SLA risks");
    expect(html).toContain("Acme Corp / TK-0123 · high");
    expect(html).not.toContain("No project on file");
    expect(html).toContain("VPN outage");
    expect(html).toContain("Resolution overdue by 2h.");
    expect(html).toContain("Escalate immediately and notify the account owner.");
    expect(html).toContain("TK-0123 (Acme Corp)");
    expect(html).toContain("Resolution due 2026-07-22 05:00 CEST");
  });

  it("shows both deadlines for a risk with a response target", () => {
    const html = auditTemplate(
      baseReport({
        vip_risk_count: 1,
        vip_risks: [
          riskTicket({
            response_status: "overdue",
            resolution_status: "running",
            response_due_at: "2026-07-22T02:00:00.000Z",
            resolution_due_at: "2026-07-24T02:00:00.000Z",
            risk_reason: "First response overdue by 3h; Resolution due in 2d.",
          }),
        ],
      })
    );

    expect(html).toContain("First response due 2026-07-22 04:00 CEST · Resolution due 2026-07-24 04:00 CEST");
  });

  it("never uses the misleading VIP wording in the email", () => {
    const html = auditTemplate(baseReport({ vip_risk_count: 1, vip_risks: [riskTicket()] }));
    const empty = auditTemplate(baseReport());

    expect(html).not.toMatch(/VIP/i);
    expect(empty).not.toMatch(/VIP/i);
    expect(empty).toContain("No high-priority SLA risks.");
  });

  it("shows a neutral fallback when company information is unavailable", () => {
    const html = auditTemplate(
      baseReport({
        vip_risk_count: 1,
        vip_risks: [
          riskTicket({
            company_id: null,
            company_name: null,
            sla_status: "at_risk",
            resolution_status: null,
            resolution_due_at: null,
            due_at: null,
          }),
        ],
      })
    );

    expect(html).toContain("Company not assigned");
    expect(html).toContain("No due date on file");
  });

  it("shows an explicit empty state when there are no priority actions", () => {
    const html = auditTemplate(baseReport());

    expect(html).toContain("No priority follow-ups required.");
  });

  it("escapes untrusted company and ticket-title content before inserting it into HTML", () => {
    const html = auditTemplate(
      baseReport({
        companies: [{ company_id: "a", company_name: "<img src=x onerror=alert(1)>", active_ticket_count: 1 }],
        vip_risk_count: 1,
        vip_risks: [riskTicket({ ticket_title: '"><script>alert(1)</script>', company_name: "<img src=x onerror=alert(1)>" })],
      })
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("keeps the corrected provider wording and does not claim Gemini or legal certification", () => {
    const html = auditTemplate(baseReport());

    expect(html).not.toContain("Gemini");
    expect(html).not.toContain("DSG Compliant");
    expect(html).toContain("VIDAL Helpdesk AI Audit");
  });

  it("shows '—' and 'No resolved tickets in the last 7 days' instead of 0% when nothing was resolved", () => {
    const report = baseReport({
      health: "attention",
      active_ticket_count: 5,
      sla_unmeasured_ticket_count: 5,
      unowned_ticket_count: 3,
    });
    const html = auditTemplate(report);

    expect(html).not.toContain(">0%<");
    expect(html).not.toContain(">100%<");
    expect(html).toContain(">—<");
    expect(html).toContain("No resolved tickets in the last 7 days");
    expect(html).toContain("the queue cannot be measured against SLA");
    expect(html).toContain("Assign an agent to 3 active tickets");
    expect(html).toContain("5 tickets have no SLA deadline on file");
    expect(getAuditEmailSubject(report)).toBe(
      "[Needs attention] 5 active tickets · no resolved tickets in 7d · 3 unowned — Vidal Lab · 22 Jul"
    );
  });

  it("reports resolved-window compliance separately from breaches in the queue", () => {
    const report = baseReport({
      compliance_percentage: 75,
      compliance_window: {
        days: 7,
        start: "2026-07-15T05:17:00.000Z",
        end: "2026-07-22T05:17:00.000Z",
        resolved_ticket_count: 5,
        measured_ticket_count: 4,
        compliant_ticket_count: 3,
        response: { measured: 4, met: 4 },
        resolution: { measured: 4, met: 3 },
      },
      health: "action_required",
      active_ticket_count: 4,
      sla_measured_ticket_count: 4,
      breached_ticket_count: 2,
      at_risk_ticket_count: 1,
    });
    const html = auditTemplate(report);

    expect(html).toContain(">75%<");
    expect(html).toContain("resolved in last 7 days · 3 of 4 met");
    expect(html).toContain("Breached in queue");
    expect(html).toContain("1 more at risk");
    expect(html).toContain(
      "SLA compliance (resolved in last 7 days, since 2026-07-15 07:17 CEST): 5 tickets resolved · first response met 4 of 4 · resolution met 3 of 4."
    );
    expect(getAuditEmailSubject(report)).toMatch(/^\[Action required\] 4 active tickets · 2 breached · SLA 7d 75%/);
    expect(html).toContain("2 tickets in the queue have breached SLA and need escalation today.");
  });

  it("lists tickets waiting for admin approval in their own section, not as unowned", () => {
    const pending = riskTicket({
      ticket_id: "t5",
      ticket_reference: "TK-0005",
      ticket_status: "in_progress",
      priority: "medium",
      sla_status: "compliant",
      sla_measured: false,
      has_owner: false,
      review_status: "pending",
      awaiting_approval: true,
      vip_risk: false,
      risk_reason: null,
      required_action: null,
      age_days: 2,
    });
    const html = auditTemplate(
      baseReport({
        health: "attention",
        active_ticket_count: 1,
        awaiting_approval_count: 1,
        awaiting_approval: [pending],
        tickets: [pending],
      })
    );

    expect(html).toContain("Waiting for admin approval");
    expect(html).toContain("Review 1 ticket waiting for admin approval.");
    expect(html).toContain("Awaiting approval");
    expect(html).not.toContain(">Unowned</span>");
    expect(html).not.toContain("Assign an agent");
    expect(html).toContain("1 awaiting approval");
  });

  it("omits the approval section when nothing is pending", () => {
    expect(auditTemplate(baseReport())).not.toContain("Waiting for admin approval");
  });

  it("states the real snapshot time in Europe/Zurich, in winter (CET) and summer (CEST)", () => {
    const winter = auditTemplate(baseReport({ generated_at: "2026-11-14T05:17:00.000Z" }));
    const summer = auditTemplate(baseReport({ generated_at: "2026-07-22T05:17:00.000Z" }));

    expect(winter).toContain("Snapshot taken 2026-11-14 06:17 CET");
    expect(winter).toContain("Saturday 14 November 2026");
    expect(summer).toContain("Snapshot taken 2026-07-22 07:17 CEST");
    expect(summer).not.toMatch(/\bUTC\b/);
  });

  it("puts the verdict in a hidden inbox preheader", () => {
    const html = auditTemplate(baseReport());

    expect(html).toContain("All clear: No active tickets.");
  });

  it("lists active tickets by reference without their titles", () => {
    const html = auditTemplate(
      baseReport({
        active_ticket_count: 1,
        tickets: [
          riskTicket({
            ticket_id: "t9",
            ticket_reference: "TK-0009",
            ticket_title: "Confidential payroll issue",
            ticket_status: "pending_customer",
            priority: "critical",
            customer_profile_id: null,
            company_id: null,
            company_name: null,
            company_assignment_status: "unassigned",
            sla_status: "compliant",
            resolution_status: null,
            resolution_due_at: null,
            sla_measured: false,
            has_owner: false,
            age_days: 33,
            vip_risk: false,
            risk_reason: null,
            required_action: null,
            due_at: null,
          }),
        ],
      })
    );

    expect(html).toContain("TK-0009");
    expect(html).toContain("Waiting on customer");
    expect(html).toContain("Unowned");
    expect(html).toContain("No SLA");
    expect(html).toContain("33d");
    expect(html).toContain("TK-0009 is critical priority, open 33 days, and has no SLA deadline");
    expect(html).not.toContain("Confidential payroll issue");
  });

  it("renders the dashboard button only for an https link", () => {
    expect(auditTemplate(baseReport(), { dashboardUrl: "https://app.example.ch/dashboard" })).toContain(
      'href="https://app.example.ch/dashboard"'
    );
    expect(auditTemplate(baseReport(), { dashboardUrl: "javascript:alert(1)" })).not.toContain("javascript:");
    expect(auditTemplate(baseReport())).not.toContain("Open the helpdesk dashboard");
  });

  it("stays within a mobile-safe fixed max-width container", () => {
    const html = auditTemplate(baseReport());

    expect(html).toContain("max-width:600px");
    expect(html).toContain("width:100%");
  });
});
