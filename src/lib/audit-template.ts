import type { AuditHealth, CompanySummary, SlaAuditReport, SlaAuditTicket } from "./sla-audit.js";
import { formatZurichDateTime, formatZurichLongDate, formatZurichShortDate } from "./zurich-time.js";

/**
 * Daily SLA brief. Layout is table-based with inline styles only: Gmail strips
 * <style> blocks in some clients and Outlook ignores flexbox, so this is the
 * one structure that renders the same in Gmail, Outlook and Apple Mail.
 */

export type AuditEmailOptions = {
  /** Optional https link to the helpdesk dashboard; the button is omitted when absent. */
  dashboardUrl?: string | null;
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const INK = "#14161a";
const MUTED = "#5b616e";
const FAINT = "#8a909c";
const LINE = "#e6e2d9";
const CANVAS = "#f3f0e8";
const PAPER = "#ffffff";

const HEALTH: Record<AuditHealth, { label: string; accent: string; tint: string }> = {
  action_required: { label: "Action required", accent: "#b42318", tint: "#fdf1ef" },
  attention: { label: "Needs attention", accent: "#b54708", tint: "#fdf6ea" },
  healthy: { label: "All clear", accent: "#067647", tint: "#eef8f1" },
};

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  pending_customer: "Waiting on customer",
  pending_third_party: "Waiting on third party",
};

const HIGH_PRIORITIES = new Set(["high", "critical"]);
const MAX_TICKET_ROWS = 10;
const STALE_AGE_DAYS = 14;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatDueDate(iso: string | null): string {
  if (!iso) return "No due date on file";
  return formatZurichDateTime(iso) || "Invalid due date";
}

/** One sentence that answers "do I need to do anything today?". */
export function describeVerdict(report: SlaAuditReport): string {
  if (report.active_ticket_count === 0) return "No active tickets. Nothing is waiting on the team.";
  if (report.breached_ticket_count > 0) {
    return `${plural(report.breached_ticket_count, "ticket in the queue has", "tickets in the queue have")} breached SLA and need escalation today.`;
  }
  if (report.vip_risk_count > 0) {
    return `${plural(report.vip_risk_count, "high-priority ticket is", "high-priority tickets are")} close to breaching SLA.`;
  }
  if (report.sla_measured_ticket_count === 0) {
    return `${plural(report.active_ticket_count, "active ticket")}, none with an SLA deadline — the queue cannot be measured against SLA.`;
  }
  if (report.at_risk_ticket_count > 0) {
    return `${plural(report.at_risk_ticket_count, "ticket is", "tickets are")} approaching the SLA deadline.`;
  }
  if (report.unowned_ticket_count > 0) {
    return `Within SLA, but ${plural(report.unowned_ticket_count, "ticket has", "tickets have")} no assigned agent.`;
  }
  if (report.awaiting_approval_count > 0) {
    return `Within SLA, but ${plural(report.awaiting_approval_count, "ticket is", "tickets are")} waiting for admin approval.`;
  }
  if (report.sla_unmeasured_ticket_count > 0) {
    return `Within SLA, but ${plural(report.sla_unmeasured_ticket_count, "ticket has", "tickets have")} no SLA deadline.`;
  }
  return `${plural(report.active_ticket_count, "active ticket")}, all within SLA and owned.`;
}

/** Subject fragment for resolved-window compliance; never a fake 0%/100%. */
function complianceSubject(report: SlaAuditReport): string {
  const days = report.compliance_window.days;
  if (report.compliance_percentage !== null) return `SLA ${days}d ${report.compliance_percentage}%`;
  return report.compliance_window.resolved_ticket_count === 0 ? `no resolved tickets in ${days}d` : `SLA ${days}d not measured`;
}

export function getAuditEmailSubject(report: SlaAuditReport): string {
  const org = report.organization_name ? ` — ${report.organization_name}` : "";
  const day = formatZurichShortDate(report.generated_at);
  const parts = [`${plural(report.active_ticket_count, "active ticket")}`];
  if (report.breached_ticket_count > 0) parts.push(`${report.breached_ticket_count} breached`);
  parts.push(complianceSubject(report));
  if (report.unowned_ticket_count > 0) parts.push(`${report.unowned_ticket_count} unowned`);
  return `[${HEALTH[report.health].label}] ${parts.join(" · ")}${org} · ${day}`;
}

/** Ordered, deduplicated to-do list for the reader, most urgent first. */
function buildTodayActions(report: SlaAuditReport): string[] {
  const actions = [...report.action_items];

  for (const ticket of report.tickets) {
    if (!ticket.sla_measured && HIGH_PRIORITIES.has(ticket.priority)) {
      const age = ticket.age_days == null ? "" : `, open ${ticket.age_days} days,`;
      actions.push(
        `${ticket.ticket_reference ?? ticket.ticket_id} is ${ticket.priority} priority${age} and has no SLA deadline — confirm it is being worked.`
      );
    }
  }
  if (report.unowned_ticket_count > 0) {
    actions.push(
      `Assign an agent to ${plural(report.unowned_ticket_count, "active ticket")} that nobody currently owns.`
    );
  }
  if (report.awaiting_approval_count > 0) {
    actions.push(
      `Review ${plural(report.awaiting_approval_count, "ticket")} waiting for admin approval.`
    );
  }
  if (report.sla_unmeasured_ticket_count > 0) {
    actions.push(
      `${plural(report.sla_unmeasured_ticket_count, "ticket has", "tickets have")} no SLA deadline on file — check that an active SLA policy exists for their priority.`
    );
  }
  if (report.oldest_active_age_days != null && report.oldest_active_age_days >= STALE_AGE_DAYS) {
    actions.push(`The oldest active ticket has been open ${report.oldest_active_age_days} days — confirm it is still moving.`);
  }
  return actions;
}

function kpiCell(label: string, value: string, note: string, valueColor = INK, last = false): string {
  return `
            <td width="25%" valign="top" style="padding:16px 12px;${last ? "" : ` border-right:1px solid ${LINE};`}">
              <div style="font-family:${FONT}; font-size:10px; letter-spacing:1.2px; text-transform:uppercase; color:${FAINT};">${label}</div>
              <div style="font-family:${FONT}; font-size:26px; line-height:32px; font-weight:700; color:${valueColor}; padding-top:4px;">${value}</div>
              <div style="font-family:${FONT}; font-size:11px; line-height:15px; color:${MUTED}; padding-top:2px;">${note}</div>
            </td>`;
}

function sectionTitle(title: string, meta = ""): string {
  return `
      <tr>
        <td style="padding:28px 32px 10px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-family:${FONT}; font-size:11px; letter-spacing:1.4px; text-transform:uppercase; font-weight:700; color:${INK};">${title}</td>
              <td align="right" style="font-family:${FONT}; font-size:11px; color:${FAINT};">${meta}</td>
            </tr>
          </table>
        </td>
      </tr>`;
}

function renderActions(actions: string[], accent: string): string {
  if (actions.length === 0) {
    return `
      <tr>
        <td style="padding:0 32px;">
          <div style="font-family:${FONT}; font-size:14px; color:${HEALTH.healthy.accent};">No priority follow-ups required.</div>
        </td>
      </tr>`;
  }
  const rows = actions
    .map(
      (action, index) => `
            <tr>
              <td width="28" valign="top" style="padding:10px 0; border-top:1px solid ${LINE}; font-family:${MONO}; font-size:12px; font-weight:700; color:${accent};">${String(index + 1).padStart(2, "0")}</td>
              <td valign="top" style="padding:10px 0; border-top:1px solid ${LINE}; font-family:${FONT}; font-size:14px; line-height:20px; color:${INK};">${escapeHtml(action)}</td>
            </tr>`
    )
    .join("");
  return `
      <tr>
        <td style="padding:0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
          </table>
        </td>
      </tr>`;
}

function describeDeadlines(ticket: SlaAuditTicket): string {
  const parts: string[] = [];
  if (ticket.response_due_at) {
    parts.push(
      ticket.first_response_at
        ? `First response due ${formatDueDate(ticket.response_due_at)} (answered ${formatDueDate(ticket.first_response_at)})`
        : `First response due ${formatDueDate(ticket.response_due_at)}`
    );
  }
  if (ticket.resolution_due_at) parts.push(`Resolution due ${formatDueDate(ticket.resolution_due_at)}`);
  return parts.length > 0 ? parts.join(" · ") : formatDueDate(ticket.due_at);
}

function renderRiskItem(ticket: SlaAuditTicket): string {
  const company = escapeHtml(ticket.company_name ?? "Company not assigned");
  const reference = escapeHtml(ticket.ticket_reference ?? ticket.ticket_id);
  const title = escapeHtml(ticket.ticket_title);
  const reason = escapeHtml(ticket.risk_reason ?? "SLA risk detected.");
  const action = escapeHtml(ticket.required_action ?? "Review required.");
  const due = escapeHtml(describeDeadlines(ticket));
  const accent = ticket.sla_status === "breached" ? HEALTH.action_required.accent : HEALTH.attention.accent;
  const tint = ticket.sla_status === "breached" ? HEALTH.action_required.tint : HEALTH.attention.tint;

  return `
            <tr>
              <td style="padding:0 0 10px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${tint}; border-left:3px solid ${accent};">
                  <tr>
                    <td style="padding:12px 14px; font-family:${FONT};">
                      <div style="font-size:12px; font-weight:700; color:${INK};">${company} / ${reference} · ${escapeHtml(ticket.priority)}</div>
                      <div style="font-size:14px; color:${INK}; padding:4px 0;">${title}</div>
                      <div style="font-size:12px; line-height:18px; color:${MUTED};"><strong style="color:${INK};">Risk:</strong> ${reason}</div>
                      <div style="font-size:12px; line-height:18px; color:${MUTED};"><strong style="color:${INK};">Action:</strong> ${action}</div>
                      <div style="font-size:12px; line-height:18px; color:${FAINT};"><strong>Due:</strong> ${due}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

function renderHighPriorityRisks(report: SlaAuditReport): string {
  const body =
    report.vip_risks.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${report.vip_risks
          .map(renderRiskItem)
          .join("")}
          </table>`
      : `<div style="font-family:${FONT}; font-size:14px; color:${HEALTH.healthy.accent};">No high-priority SLA risks.</div>`;
  return `
      <tr>
        <td style="padding:0 32px;">${body}</td>
      </tr>`;
}

function renderAwaitingApproval(report: SlaAuditReport): string {
  if (report.awaiting_approval.length === 0) return "";
  const rows = report.awaiting_approval
    .map((ticket) => {
      const reference = escapeHtml(ticket.ticket_reference ?? ticket.ticket_id.slice(0, 8));
      const company = escapeHtml(ticket.company_name ?? "No company on file");
      const age = ticket.age_days == null ? "—" : `${ticket.age_days}d`;
      const sla =
        ticket.sla_status === "breached" ? "SLA breached" : ticket.sla_status === "at_risk" ? "SLA at risk" : "";
      return `
            <tr>
              <td style="padding:8px 0; border-top:1px solid ${LINE}; font-family:${MONO}; font-size:12px; font-weight:700; color:${INK};">${reference}</td>
              <td style="padding:8px 6px; border-top:1px solid ${LINE}; font-family:${FONT}; font-size:12px; color:${INK};">${company}${sla ? ` <span style="color:${HEALTH.attention.accent}; font-weight:700;">· ${sla}</span>` : ""}</td>
              <td align="right" style="padding:8px 0; border-top:1px solid ${LINE}; font-family:${MONO}; font-size:12px; color:${INK};">${age}</td>
            </tr>`;
    })
    .join("");
  return `${sectionTitle("Waiting for admin approval", plural(report.awaiting_approval_count, "ticket"))}
      <tr>
        <td style="padding:0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
          </table>
        </td>
      </tr>`;
}

function ticketUrgency(ticket: SlaAuditTicket): number {
  if (ticket.sla_status === "breached") return 0;
  if (ticket.sla_status === "at_risk") return 1;
  if (HIGH_PRIORITIES.has(ticket.priority)) return 2;
  if (!ticket.has_owner && !ticket.awaiting_approval) return 3;
  return 4;
}

function renderTicketRow(ticket: SlaAuditTicket): string {
  const reference = escapeHtml(ticket.ticket_reference ?? ticket.ticket_id.slice(0, 8));
  const company = escapeHtml(ticket.company_name ?? "No company on file");
  const status = escapeHtml(STATUS_LABELS[ticket.ticket_status] ?? ticket.ticket_status);
  const age = ticket.age_days == null ? "—" : `${ticket.age_days}d`;
  const priority = HIGH_PRIORITIES.has(ticket.priority)
    ? `<strong style="color:${HEALTH.action_required.accent};">${escapeHtml(ticket.priority)}</strong>`
    : escapeHtml(ticket.priority);
  const owner = ticket.awaiting_approval
    ? `<span style="color:${MUTED};">Awaiting approval</span>`
    : ticket.has_owner
      ? `<span style="color:${MUTED};">Assigned</span>`
      : `<span style="color:${HEALTH.attention.accent}; font-weight:700;">Unowned</span>`;
  const sla =
    ticket.sla_status === "breached"
      ? `<span style="color:${HEALTH.action_required.accent}; font-weight:700;">Breached</span>`
      : ticket.sla_status === "at_risk"
        ? `<span style="color:${HEALTH.attention.accent}; font-weight:700;">At risk</span>`
        : ticket.sla_measured
          ? `<span style="color:${HEALTH.healthy.accent};">On track</span>`
          : `<span style="color:${FAINT};">No SLA</span>`;
  const cell = `padding:9px 6px; border-top:1px solid ${LINE}; font-family:${FONT}; font-size:12px; color:${INK};`;

  return `
            <tr>
              <td style="${cell} font-family:${MONO}; font-weight:700;">${reference}</td>
              <td style="${cell}">${company}<div style="color:${FAINT}; font-size:11px;">${status} · ${priority}</div></td>
              <td style="${cell}">${sla}</td>
              <td style="${cell}">${owner}</td>
              <td align="right" style="${cell} font-family:${MONO};">${age}</td>
            </tr>`;
}

function renderTickets(report: SlaAuditReport): string {
  if (report.tickets.length === 0) return "";
  const rows = [...report.tickets]
    .sort((a, b) => ticketUrgency(a) - ticketUrgency(b) || (b.age_days ?? 0) - (a.age_days ?? 0))
    .slice(0, MAX_TICKET_ROWS);
  const more = report.tickets.length - rows.length;
  const head = `padding:0 6px 6px; font-family:${FONT}; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:${FAINT}; font-weight:400;`;

  return `${sectionTitle("Active tickets", more > 0 ? `Top ${rows.length} of ${report.tickets.length}` : "")}
      <tr>
        <td style="padding:0 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <th align="left" style="${head}">Ref</th>
              <th align="left" style="${head}">Company</th>
              <th align="left" style="${head}">SLA</th>
              <th align="left" style="${head}">Owner</th>
              <th align="right" style="${head}">Age</th>
            </tr>${rows.map(renderTicketRow).join("")}
          </table>
        </td>
      </tr>`;
}

function renderCompanyRow(company: CompanySummary, max: number): string {
  const label = escapeHtml(company.company_name);
  const count = company.active_ticket_count;
  const width = Math.max(4, Math.round((count / max) * 100));
  return `
            <tr>
              <td width="46%" style="padding:7px 0; font-family:${FONT}; font-size:13px; color:${INK};">${label}</td>
              <td style="padding:7px 12px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="${width}%" style="background-color:${INK}; height:6px; font-size:0; line-height:0;">&nbsp;</td>
                    <td style="background-color:${LINE}; height:6px; font-size:0; line-height:0;">&nbsp;</td>
                  </tr>
                </table>
              </td>
              <td width="96" align="right" style="padding:7px 0; font-family:${FONT}; font-size:12px; color:${MUTED}; white-space:nowrap;">${count} active ticket${count === 1 ? "" : "s"}</td>
            </tr>`;
}

function renderCompanies(report: SlaAuditReport): string {
  if (report.companies.length === 0) {
    return `${sectionTitle("Companies")}
      <tr>
        <td style="padding:0 32px; font-family:${FONT}; font-size:13px; color:${FAINT};">No companies represented in the current active ticket backlog.</td>
      </tr>`;
  }
  const max = Math.max(...report.companies.map((c) => c.active_ticket_count), 1);
  return `${sectionTitle("Companies", plural(report.company_count, "company", "companies"))}
      <tr>
        <td style="padding:0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${report.companies
            .map((company) => renderCompanyRow(company, max))
            .join("")}
          </table>
        </td>
      </tr>`;
}

function renderButton(url: string | null | undefined): string {
  if (!url || !/^https:\/\//i.test(url)) return "";
  return `
      <tr>
        <td style="padding:28px 32px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="background-color:${INK}; border-radius:6px;">
                <a href="${escapeHtml(url)}" style="display:inline-block; padding:12px 22px; font-family:${FONT}; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none;">Open the helpdesk dashboard &rarr;</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
}

export function getAuditEmailHtml(report: SlaAuditReport, options: AuditEmailOptions = {}): string {
  const health = HEALTH[report.health];
  const verdict = escapeHtml(describeVerdict(report));
  const org = report.organization_name ? escapeHtml(report.organization_name) : "Helpdesk";
  const reportDate = formatZurichLongDate(report.generated_at);
  const actions = buildTodayActions(report);
  const window = report.compliance_window;

  const complianceValue = report.compliance_percentage === null ? "—" : `${report.compliance_percentage}%`;
  const complianceNote =
    window.resolved_ticket_count === 0
      ? `No resolved tickets in the last ${window.days} days`
      : report.compliance_percentage === null
        ? `resolved in last ${window.days} days · none had an SLA`
        : `resolved in last ${window.days} days · ${window.compliant_ticket_count} of ${window.measured_ticket_count} met`;
  const complianceColor =
    report.compliance_percentage === null
      ? FAINT
      : report.compliance_percentage >= 95
        ? HEALTH.healthy.accent
        : HEALTH.action_required.accent;
  const breachedColor = report.breached_ticket_count > 0 ? HEALTH.action_required.accent : INK;
  const breachedNote =
    report.at_risk_ticket_count > 0 ? `${report.at_risk_ticket_count} more at risk` : "of active tickets";
  const unownedColor = report.unowned_ticket_count > 0 ? HEALTH.attention.accent : INK;
  const activeNoteParts = [
    report.waiting_ticket_count > 0 ? `${report.waiting_ticket_count} waiting on others` : null,
    report.awaiting_approval_count > 0 ? `${report.awaiting_approval_count} awaiting approval` : null,
    report.oldest_active_age_days != null ? `oldest ${report.oldest_active_age_days}d` : null,
  ].filter((part): part is string => part !== null);
  const activeNote = activeNoteParts.length > 0 ? activeNoteParts.join(" · ") : "tickets open";
  const windowLine =
    window.resolved_ticket_count === 0
      ? `SLA compliance (resolved in last ${window.days} days): no resolved tickets since ${formatZurichDateTime(window.start)}.`
      : `SLA compliance (resolved in last ${window.days} days, since ${formatZurichDateTime(window.start)}): ${plural(window.resolved_ticket_count, "ticket")} resolved · first response met ${window.response.met} of ${window.response.measured} · resolution met ${window.resolution.met} of ${window.resolution.measured}.`;

  // Hidden preheader: the line inbox previews show next to the subject.
  const preheader = `${health.label}: ${verdict}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>Daily SLA brief — ${org}</title>
</head>
<body style="margin:0; padding:0; background-color:${CANVAS};">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">${preheader}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CANVAS};">
  <tr>
    <td align="center" style="padding:28px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:${PAPER}; border:1px solid ${LINE}; border-radius:10px; overflow:hidden;">
      <tr>
        <td style="padding:22px 32px 18px; background-color:${INK};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-family:${FONT}; font-size:11px; letter-spacing:2px; font-weight:700; color:#ffffff;">VIDAL&nbsp;HELPDESK</td>
              <td align="right" style="font-family:${FONT}; font-size:11px; color:#a7adb8;">Daily SLA brief</td>
            </tr>
          </table>
          <div style="font-family:${FONT}; font-size:22px; line-height:28px; font-weight:700; color:#ffffff; padding-top:18px;">${org}</div>
          <div style="font-family:${FONT}; font-size:13px; color:#a7adb8; padding-top:2px;">${reportDate}</div>
        </td>
      </tr>
      <tr>
        <td style="background-color:${health.tint}; border-left:6px solid ${health.accent}; padding:18px 26px;">
          <div style="font-family:${FONT}; font-size:11px; letter-spacing:1.4px; text-transform:uppercase; font-weight:700; color:${health.accent};">${health.label}</div>
          <div style="font-family:${FONT}; font-size:17px; line-height:24px; color:${INK}; padding-top:4px;">${verdict}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:0 20px; border-bottom:1px solid ${LINE};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>${kpiCell("SLA compliance", complianceValue, complianceNote, complianceColor)}${kpiCell(
              "Breached in queue",
              String(report.breached_ticket_count),
              breachedNote,
              breachedColor
            )}${kpiCell("Active", String(report.active_ticket_count), activeNote)}${kpiCell(
              "Unowned",
              String(report.unowned_ticket_count),
              "no agent assigned",
              unownedColor,
              true
            )}
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 32px; border-bottom:1px solid ${LINE}; font-family:${FONT}; font-size:11px; line-height:16px; color:${MUTED};">${escapeHtml(windowLine)}</td>
      </tr>
${sectionTitle("Today", actions.length > 0 ? plural(actions.length, "action") : "")}${renderActions(actions, health.accent)}
${sectionTitle("High-priority SLA risks", report.vip_risk_count > 0 ? plural(report.vip_risk_count, "ticket") : "")}${renderHighPriorityRisks(report)}
${renderAwaitingApproval(report)}
${renderTickets(report)}
${renderCompanies(report)}
${renderButton(options.dashboardUrl)}
      <tr>
        <td style="padding:32px 32px 26px;">
          <div style="border-top:1px solid ${LINE}; padding-top:14px; font-family:${FONT}; font-size:11px; line-height:17px; color:${FAINT};">
            Snapshot taken ${escapeHtml(formatZurichDateTime(report.generated_at))} from the live ticket queue. Sent once a day to the operations recipient. All times Europe/Zurich.<br>
            VIDAL Helpdesk AI Audit · SLA compliance counts tickets resolved in the last ${window.days} days (first response and resolution judged separately); queue status is computed live from ticket deadlines. Tickets without a deadline are reported, not counted as compliant. High-priority SLA risks are high/critical tickets that are at risk or breached.
          </div>
        </td>
      </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;
}

export const auditTemplate = getAuditEmailHtml;
