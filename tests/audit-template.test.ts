import { describe, expect, it } from "vitest";

import { auditTemplate, getAuditEmailSubject } from "../src/lib/audit-template.js";
import type { SlaAuditReport } from "../src/lib/sla-audit.js";

function baseReport(overrides: Partial<SlaAuditReport> = {}): SlaAuditReport {
  return {
    generated_at: "2026-07-22T06:00:00.000Z",
    organization_id: "org-123",
    organization_name: "Vidal Lab",
    reporting_period: { start: "2026-07-22T00:00:00.000Z", end: "2026-07-23T00:00:00.000Z" },
    compliance_percentage: 100,
    health: "healthy",
    sla_measured_ticket_count: 0,
    sla_unmeasured_ticket_count: 0,
    breached_ticket_count: 0,
    at_risk_ticket_count: 0,
    unowned_ticket_count: 0,
    waiting_ticket_count: 0,
    oldest_active_age_days: null,
    active_ticket_count: 0,
    company_count: 0,
    unassigned_ticket_count: 0,
    vip_risk_count: 0,
    companies: [],
    tickets: [],
    vip_risks: [],
    action_items: [],
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

  it("renders VIP risk detail: company, project fallback, reference, risk, action, due date", () => {
    const html = auditTemplate(
      baseReport({
        vip_risk_count: 1,
        vip_risks: [
          {
            ticket_id: "t1",
            ticket_reference: "TK-0123",
            ticket_title: "VPN outage",
            ticket_status: "open",
            priority: "high",
            company_id: "a",
            company_name: "Acme Corp",
            project_id: null,
            project_name: null,
            sla_status: "breached",
            sla_measured: true,
            has_owner: true,
            age_days: 3,
            vip_risk: true,
            risk_reason: "SLA resolution was due 2h ago and has not been resolved.",
            required_action: "Escalate immediately and notify the account owner.",
            due_at: "2026-07-22T10:00:00.000Z",
          },
        ],
        action_items: ["TK-0123 (Acme Corp) — Escalate immediately and notify the account owner."],
      })
    );

    expect(html).toContain("Acme Corp / No project on file / TK-0123");
    expect(html).toContain("VPN outage");
    expect(html).toContain("SLA resolution was due 2h ago");
    expect(html).toContain("Escalate immediately and notify the account owner.");
    expect(html).toContain("TK-0123 (Acme Corp)");
  });

  it("shows an explicit empty state when there are no VIP risks", () => {
    const html = auditTemplate(baseReport());

    expect(html).toContain("No VIP risks detected.");
  });

  it("shows a neutral fallback when company information is unavailable", () => {
    const html = auditTemplate(
      baseReport({
        vip_risk_count: 1,
        vip_risks: [
          {
            ticket_id: "t2",
            ticket_reference: "TK-0456",
            ticket_title: "Slow laptop",
            ticket_status: "open",
            priority: "high",
            company_id: null,
            company_name: null,
            project_id: null,
            project_name: null,
            sla_status: "at_risk",
            sla_measured: true,
            has_owner: true,
            age_days: 3,
            vip_risk: true,
            risk_reason: "Resolution due within 2h — approaching SLA breach.",
            required_action: "Assign an owner and respond before the SLA window closes.",
            due_at: null,
          },
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
        companies: [{ company_id: "a", company_name: '<img src=x onerror=alert(1)>', active_ticket_count: 1 }],
        vip_risk_count: 1,
        vip_risks: [
          {
            ticket_id: "t3",
            ticket_reference: "TK-0789",
            ticket_title: '"><script>alert(1)</script>',
            ticket_status: "open",
            priority: "high",
            company_id: "a",
            company_name: '<img src=x onerror=alert(1)>',
            project_id: null,
            project_name: null,
            sla_status: "breached",
            sla_measured: true,
            has_owner: true,
            age_days: 3,
            vip_risk: true,
            risk_reason: "SLA has been marked breached.",
            required_action: "Escalate immediately and notify the account owner.",
            due_at: null,
          },
        ],
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

  it("does not present unmeasured tickets as 100% compliant", () => {
    const report = baseReport({
      compliance_percentage: null,
      health: "attention",
      active_ticket_count: 5,
      sla_unmeasured_ticket_count: 5,
      unowned_ticket_count: 3,
    });
    const html = auditTemplate(report);

    expect(html).not.toContain(">100%<");
    expect(html).toContain("0 of 5 have an SLA");
    expect(html).toContain("compliance cannot be measured");
    expect(html).toContain("Assign an agent to 3 active tickets");
    expect(html).toContain("5 tickets have no SLA deadline on file");
    expect(getAuditEmailSubject(report)).toBe(
      "[Needs attention] 5 active tickets · SLA not measured · 3 unowned — Vidal Lab · 22 Jul"
    );
  });

  it("leads the subject and banner with the verdict when tickets have breached", () => {
    const report = baseReport({
      compliance_percentage: 50,
      health: "action_required",
      active_ticket_count: 4,
      breached_ticket_count: 2,
    });

    expect(getAuditEmailSubject(report)).toMatch(/^\[Action required\] 4 active tickets · 50% SLA/);
    expect(auditTemplate(report)).toContain("2 tickets have breached SLA and need escalation today.");
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
          {
            ticket_id: "t9",
            ticket_reference: "TK-0009",
            ticket_title: "Confidential payroll issue",
            ticket_status: "pending_customer",
            priority: "critical",
            customer_profile_id: null,
            company_id: null,
            company_name: null,
            company_assignment_status: "unassigned",
            project_id: null,
            project_name: null,
            sla_status: "compliant",
            sla_measured: false,
            has_owner: false,
            age_days: 33,
            vip_risk: false,
            risk_reason: null,
            required_action: null,
            due_at: null,
          },
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
