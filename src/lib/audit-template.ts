import type { CompanySummary, SlaAuditReport, SlaAuditTicket } from "./sla-audit.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDueDate(iso: string | null): string {
  if (!iso) return "No due date on file";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Invalid due date";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function renderCompanyRow(company: CompanySummary): string {
  const label = escapeHtml(company.company_name);
  const count = company.active_ticket_count;
  return `<li style="padding:4px 0;">${label} — ${count} active ticket${count === 1 ? "" : "s"}</li>`;
}

function renderVipRiskItem(ticket: SlaAuditTicket): string {
  const company = escapeHtml(ticket.company_name ?? "Company not assigned");
  const project = ticket.project_name ? escapeHtml(ticket.project_name) : "No project on file";
  const reference = escapeHtml(ticket.ticket_reference ?? ticket.ticket_id);
  const title = escapeHtml(ticket.ticket_title);
  const reason = escapeHtml(ticket.risk_reason ?? "SLA risk detected.");
  const action = escapeHtml(ticket.required_action ?? "Review required.");
  const due = formatDueDate(ticket.due_at);
  const severityColor = ticket.sla_status === "breached" ? "#ef4444" : "#f59e0b";

  return `
    <li style="margin-bottom:16px; padding:12px; border-left:3px solid ${severityColor}; background-color:#fafafa;">
      <div style="font-weight:600; font-size:13px;">${company} / ${project} / ${reference}</div>
      <div style="font-size:13px; color:#555; margin:4px 0;">${title}</div>
      <div style="font-size:12px; color:#333;"><strong>Risk:</strong> ${reason}</div>
      <div style="font-size:12px; color:#333;"><strong>Action:</strong> ${action}</div>
      <div style="font-size:12px; color:#888;"><strong>Due:</strong> ${due}</div>
    </li>`;
}

export function getAuditEmailHtml(report: SlaAuditReport): string {
  const complianceColor = report.compliance_percentage >= 95 ? "#10b981" : "#ef4444";
  const vipColor = report.vip_risk_count > 0 ? "#f59e0b" : "#10b981";

  const companiesSection =
    report.companies.length > 0
      ? `<ul style="list-style:none; padding:0; margin:0; font-size:13px;">${report.companies.map(renderCompanyRow).join("")}</ul>`
      : `<p style="font-size:13px; color:#888;">No companies represented in the current active ticket backlog.</p>`;

  const vipSection =
    report.vip_risks.length > 0
      ? `<ul style="list-style:none; padding:0; margin:0;">${report.vip_risks.map(renderVipRiskItem).join("")}</ul>`
      : `<p style="font-size:13px; color:#10b981;">No VIP risks detected.</p>`;

  const actionSection =
    report.action_items.length > 0
      ? `<ol style="font-size:13px; padding-left:18px; margin:0;">${report.action_items
          .map((item) => `<li style="margin-bottom:6px;">${escapeHtml(item)}</li>`)
          .join("")}</ol>`
      : `<p style="font-size:13px; color:#10b981;">No priority follow-ups required.</p>`;

  return `
<div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif; max-width:600px; width:100%; margin:auto; border:1px solid #e0e0e0; border-radius:8px; overflow:hidden;">
  <div style="background-color:#000; color:#fff; padding:20px; text-align:center;">
    <h1 style="margin:0; font-size:20px; letter-spacing:1px;">VIDAL ECOSYSTEM</h1>
    <p style="margin:5px 0 0; font-size:12px; opacity:0.8;">Daily SLA Report${report.organization_name ? ` — ${escapeHtml(report.organization_name)}` : ""}</p>
  </div>
  <div style="padding:24px; line-height:1.6; color:#333;">
    <div style="display:flex; flex-wrap:wrap; justify-content:space-between; margin:0 0 25px;">
      <div style="text-align:center; flex:1; min-width:80px; margin-bottom:12px;">
        <span style="font-size:10px; color:#888; text-transform:uppercase;">Compliance</span><br/>
        <strong style="font-size:22px; color:${complianceColor};">${report.compliance_percentage}%</strong>
      </div>
      <div style="text-align:center; flex:1; min-width:80px; margin-bottom:12px;">
        <span style="font-size:10px; color:#888; text-transform:uppercase;">Active tickets</span><br/>
        <strong style="font-size:22px;">${report.active_ticket_count}</strong>
      </div>
      <div style="text-align:center; flex:1; min-width:80px; margin-bottom:12px;">
        <span style="font-size:10px; color:#888; text-transform:uppercase;">Companies</span><br/>
        <strong style="font-size:22px;">${report.company_count}</strong>
      </div>
      <div style="text-align:center; flex:1; min-width:80px; margin-bottom:12px;">
        <span style="font-size:10px; color:#888; text-transform:uppercase;">VIP risks</span><br/>
        <strong style="font-size:22px; color:${vipColor};">${report.vip_risk_count}</strong>
      </div>
    </div>

    <h2 style="font-size:15px; border-bottom:2px solid #f0f0f0; padding-bottom:8px;">Companies</h2>
    ${companiesSection}

    <h2 style="font-size:15px; border-bottom:2px solid #f0f0f0; padding-bottom:8px; margin-top:24px;">VIP risks</h2>
    ${vipSection}

    <h2 style="font-size:15px; border-bottom:2px solid #f0f0f0; padding-bottom:8px; margin-top:24px;">Priority actions</h2>
    ${actionSection}
  </div>
  <div style="background-color:#f9f9f9; padding:15px; text-align:center; font-size:11px; color:#999;">
    Swiss DSG Compliant | VIDAL Helpdesk AI Audit
  </div>
</div>
`;
}

export const auditTemplate = getAuditEmailHtml;
