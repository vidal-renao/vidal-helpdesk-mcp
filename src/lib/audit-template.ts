import type { AuditHealth, CompanySummary, SlaAuditReport, SlaAuditTicket } from "./sla-audit.js";
import {
  AUDIT_TIME_ZONE,
  formatZurichDateTime,
  formatZurichLongDate,
  formatZurichShortDate,
  formatZurichTime,
} from "./zurich-time.js";

/**
 * Daily SLA brief (HTML + plain-text alternative).
 *
 * Layout is table-based with inline styles and bgcolor attributes: Gmail strips
 * <style> blocks in some contexts and Outlook ignores flexbox/grid, so this is
 * the one structure that renders the same in Gmail, Outlook and Apple Mail.
 * The single <style> block only adds a mobile media query (KPI tiles 2x2) as
 * progressive enhancement; the email stays readable without it. No external
 * images: the wordmark is text, because many clients block images by default.
 */

export type AuditEmailOptions = {
  /** Optional https link to the helpdesk dashboard; the button is omitted when absent. */
  dashboardUrl?: string | null;
};

const BRAND = "VIDAL ECOSYSTEM";
const PRODUCT = "HelpDesk AI";
const TAGLINE = "Reliable IT today. AI-ready tomorrow.";
const LOCATION = "Basel, Switzerland";
const SOURCE_LINE =
  "Source: HelpDesk AI live ticket queue (Supabase), evaluated by the vidal-helpdesk-mcp SLA audit.";
const RECIPIENT_LINE = "Sent once a day to the operations recipient.";
const NO_REPLY_LINE = "Automated message — please do not reply.";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const NUM = "font-variant-numeric:tabular-nums;";

const NAVY = "#0F1B2D";
const ACCENT = "#5B8DB8";
const HEADER_MUTED = "#A9B8CC";
const CANVAS = "#F4F6F9";
const CARD = "#FFFFFF";
const INK = "#1F2937";
const MUTED = "#6B7280";
const LINE = "#E5E7EB";
const ZEBRA = "#F9FAFB";
const FOOTER_BAND = "#E9EDF2";
const NEUTRAL_TINT = "#F3F4F6";

type Tone = { accent: string; tint: string };

const TONE = {
  breached: { accent: "#B42318", tint: "#FEF3F2" },
  atRisk: { accent: "#B54708", tint: "#FFFAEB" },
  met: { accent: "#067647", tint: "#ECFDF3" },
  neutral: { accent: MUTED, tint: NEUTRAL_TINT },
} satisfies Record<string, Tone>;

const HEALTH: Record<AuditHealth, Tone & { label: string }> = {
  action_required: { label: "Action required", ...TONE.breached },
  attention: { label: "Needs attention", ...TONE.atRisk },
  healthy: { label: "All clear", ...TONE.met },
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

/** Escapes every dynamic string before it enters HTML text or an attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatDueDate(iso: string | null): string {
  if (!iso) return "No due date on file";
  return formatZurichDateTime(iso) || "Invalid due date";
}

/** Copyright year as the calendar year in Zurich at snapshot time. */
function zurichYear(iso: string): string {
  const date = new Date(iso);
  const source = Number.isFinite(date.getTime()) ? date : new Date();
  return new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: AUDIT_TIME_ZONE }).format(source);
}

/** One sentence that answers "do I need to do anything today?". */
export function describeVerdict(report: SlaAuditReport): string {
  if (report.active_ticket_count === 0) return "No active tickets. Nothing is waiting on the team.";
  if (report.breached_ticket_count > 0) {
    return `${plural(report.breached_ticket_count, "ticket in the queue has breached SLA and needs", "tickets in the queue have breached SLA and need")} escalation today.`;
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

function ticketUrgency(ticket: SlaAuditTicket): number {
  if (ticket.sla_status === "breached") return 0;
  if (ticket.sla_status === "at_risk") return 1;
  if (HIGH_PRIORITIES.has(ticket.priority)) return 2;
  if (!ticket.has_owner && !ticket.awaiting_approval) return 3;
  return 4;
}

function sortedTickets(report: SlaAuditReport): { rows: SlaAuditTicket[]; total: number } {
  const rows = [...report.tickets]
    .sort((a, b) => ticketUrgency(a) - ticketUrgency(b) || (b.age_days ?? 0) - (a.age_days ?? 0))
    .slice(0, MAX_TICKET_ROWS);
  return { rows, total: report.tickets.length };
}

// ---------------------------------------------------------------------------
// Shared view model: every number and sentence both renderers print.
// ---------------------------------------------------------------------------

type Kpi = { label: string; value: string; note: string; tone: Tone | null };

type AuditEmailView = {
  health: (typeof HEALTH)[AuditHealth];
  verdict: string;
  org: string;
  reportDate: string;
  reportTime: string;
  snapshot: string;
  year: string;
  actions: string[];
  kpis: Kpi[];
  windowLine: string;
  methodology: string;
};

function buildView(report: SlaAuditReport): AuditEmailView {
  const window = report.compliance_window;

  const complianceValue = report.compliance_percentage === null ? "—" : `${report.compliance_percentage}%`;
  const complianceNote =
    window.resolved_ticket_count === 0
      ? `No resolved tickets in the last ${window.days} days`
      : report.compliance_percentage === null
        ? `resolved in last ${window.days} days · none had an SLA`
        : `resolved in last ${window.days} days · ${window.compliant_ticket_count} of ${window.measured_ticket_count} met`;
  const complianceTone =
    report.compliance_percentage === null
      ? TONE.neutral
      : report.compliance_percentage >= 95
        ? TONE.met
        : TONE.breached;
  const breachedNote =
    report.at_risk_ticket_count > 0 ? `${report.at_risk_ticket_count} more at risk` : "of active tickets";
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

  return {
    health: HEALTH[report.health],
    verdict: describeVerdict(report),
    org: report.organization_name ?? "Helpdesk",
    reportDate: formatZurichLongDate(report.generated_at),
    reportTime: formatZurichTime(report.generated_at),
    snapshot: formatZurichDateTime(report.generated_at),
    year: zurichYear(report.generated_at),
    actions: buildTodayActions(report),
    kpis: [
      { label: `SLA compliance ${window.days}d`, value: complianceValue, note: complianceNote, tone: complianceTone },
      {
        label: "Breached in queue",
        value: String(report.breached_ticket_count),
        note: breachedNote,
        tone: report.breached_ticket_count > 0 ? TONE.breached : null,
      },
      { label: "Active", value: String(report.active_ticket_count), note: activeNote, tone: null },
      {
        label: "Unowned",
        value: String(report.unowned_ticket_count),
        note: "no agent assigned",
        tone: report.unowned_ticket_count > 0 ? TONE.atRisk : null,
      },
    ],
    windowLine,
    methodology: `VIDAL Helpdesk AI Audit · SLA compliance counts tickets resolved in the last ${window.days} days (first response and resolution judged separately); queue status is computed live from ticket deadlines. Tickets without a deadline are reported, not counted as compliant. High-priority SLA risks are high/critical tickets that are at risk or breached.`,
  };
}

// ---------------------------------------------------------------------------
// HTML building blocks
// ---------------------------------------------------------------------------

function pill(label: string, tone: Tone, bold = true): string {
  return `<span style="display:inline-block; padding:2px 8px; border-radius:10px; background-color:${tone.tint}; color:${tone.accent}; font-family:${FONT}; font-size:11px; line-height:16px; ${bold ? "font-weight:600; " : ""}white-space:nowrap;">${label}</span>`;
}

function priorityBadge(priority: string): string {
  return pill(escapeHtml(priority), HIGH_PRIORITIES.has(priority) ? TONE.breached : TONE.neutral);
}

function spacer(height: number): string {
  return `
  <tr>
    <td height="${height}" style="height:${height}px; font-size:0; line-height:0;">&nbsp;</td>
  </tr>`;
}

/** White card with a title row; `meta` is shown as a count on the right. */
function card(title: string, meta: string, inner: string): string {
  return `${spacer(16)}
  <tr>
    <td style="padding:0 24px;" class="px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="background-color:${CARD}; border:1px solid ${LINE}; border-radius:8px;">
        <tr>
          <td style="padding:16px 20px 12px; border-bottom:1px solid ${LINE};" class="cp">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:${FONT}; font-size:13px; line-height:18px; font-weight:700; color:${INK};">${title}</td>
                <td align="right" style="font-family:${FONT}; font-size:12px; line-height:18px; color:${MUTED}; ${NUM}">${meta}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 20px 16px;" class="cp">${inner}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function emptyState(text: string, tone: Tone = TONE.met): string {
  return `
            <div style="font-family:${FONT}; font-size:14px; line-height:20px; color:${tone.accent};">${text}</div>`;
}

function renderHeader(view: AuditEmailView): string {
  return `
  <tr>
    <td bgcolor="${NAVY}" style="background-color:${NAVY}; padding:24px 32px 22px;" class="px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="top" class="stack">
            <div style="font-family:${FONT}; font-size:14px; line-height:18px; letter-spacing:3px; font-weight:700; color:#FFFFFF;">VIDAL&nbsp;ECOSYSTEM</div>
            <div style="font-family:${FONT}; font-size:12px; line-height:18px; color:${HEADER_MUTED}; padding-top:4px;">${PRODUCT} &middot; Daily SLA brief</div>
          </td>
          <td valign="top" align="right" class="stack stack-left">
            <div style="font-family:${FONT}; font-size:13px; line-height:18px; font-weight:600; color:#FFFFFF;">${escapeHtml(view.org)}</div>
            <div style="font-family:${FONT}; font-size:12px; line-height:18px; color:${HEADER_MUTED}; padding-top:4px; ${NUM}">${escapeHtml(view.reportDate)} &middot; ${escapeHtml(view.reportTime)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td height="3" bgcolor="${ACCENT}" style="height:3px; background-color:${ACCENT}; font-size:0; line-height:0;">&nbsp;</td>
  </tr>`;
}

function renderStatusBanner(view: AuditEmailView): string {
  const { health } = view;
  return `${spacer(24)}
  <tr>
    <td style="padding:0 24px;" class="px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${health.tint}" style="background-color:${health.tint}; border:1px solid ${LINE}; border-left:4px solid ${health.accent}; border-radius:6px;">
        <tr>
          <td style="padding:14px 18px;">
            <div style="font-family:${FONT}; font-size:11px; line-height:16px; letter-spacing:1.2px; text-transform:uppercase; font-weight:700; color:${health.accent};">${health.label}</div>
            <div style="font-family:${FONT}; font-size:16px; line-height:23px; color:${INK}; padding-top:3px;">${escapeHtml(view.verdict)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function kpiTile(kpi: Kpi): string {
  const valueColor = kpi.tone ? kpi.tone.accent : INK;
  return `
          <td width="25%" valign="top" class="kpi" style="padding:6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="background-color:${CARD}; border:1px solid ${LINE}; border-radius:8px;">
              <tr>
                <td style="padding:14px 14px 13px;">
                  <div style="font-family:${FONT}; font-size:10px; line-height:14px; letter-spacing:1px; text-transform:uppercase; color:${MUTED};">${escapeHtml(kpi.label)}</div>
                  <div style="font-family:${FONT}; font-size:28px; line-height:34px; font-weight:700; color:${valueColor}; padding-top:6px; ${NUM}">${escapeHtml(kpi.value)}</div>
                  <div style="font-family:${FONT}; font-size:11px; line-height:15px; color:${MUTED}; padding-top:2px; ${NUM}">${escapeHtml(kpi.note)}</div>
                </td>
              </tr>
            </table>
          </td>`;
}

function renderKpis(view: AuditEmailView): string {
  return `${spacer(10)}
  <tr>
    <td style="padding:0 18px;" class="px-kpi">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;">
        <tr>${view.kpis.map(kpiTile).join("")}
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:6px 24px 0; font-family:${FONT}; font-size:11px; line-height:16px; color:${MUTED}; ${NUM}" class="px">${escapeHtml(view.windowLine)}</td>
  </tr>`;
}

function renderActions(view: AuditEmailView): string {
  const { actions } = view;
  if (actions.length === 0) return card("Today&#39;s actions", "", emptyState("No priority follow-ups required."));
  const rows = actions
    .map(
      (action, index) => `
              <tr>
                <td width="34" valign="top" style="padding:9px 0;${index === 0 ? "" : ` border-top:1px solid ${LINE};`}">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="22" height="22" align="center" bgcolor="${NAVY}" style="width:22px; height:22px; background-color:${NAVY}; border-radius:11px; font-family:${FONT}; font-size:11px; line-height:22px; font-weight:700; color:#FFFFFF; ${NUM}">${index + 1}</td></tr></table>
                </td>
                <td valign="top" style="padding:10px 0 9px;${index === 0 ? "" : ` border-top:1px solid ${LINE};`} font-family:${FONT}; font-size:14px; line-height:20px; color:${INK};">${escapeHtml(action)}</td>
              </tr>`
    )
    .join("");
  return card(
    "Today&#39;s actions",
    plural(actions.length, "action"),
    `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
            </table>`
  );
}

function renderAwaitingApproval(report: SlaAuditReport): string {
  if (report.awaiting_approval.length === 0) return "";
  const rows = report.awaiting_approval
    .map((ticket, index) => {
      const reference = escapeHtml(ticket.ticket_reference ?? ticket.ticket_id.slice(0, 8));
      const company = escapeHtml(ticket.company_name ?? "No company on file");
      const age = ticket.age_days == null ? "—" : `${ticket.age_days}d`;
      const sla =
        ticket.sla_status === "breached"
          ? ` ${pill("SLA breached", TONE.breached)}`
          : ticket.sla_status === "at_risk"
            ? ` ${pill("SLA at risk", TONE.atRisk)}`
            : "";
      const border = index === 0 ? "" : ` border-top:1px solid ${LINE};`;
      return `
              <tr>
                <td style="padding:8px 0;${border} font-family:${MONO}; font-size:12px; font-weight:700; color:${INK}; white-space:nowrap;">${reference}</td>
                <td style="padding:8px 8px;${border} font-family:${FONT}; font-size:13px; color:${INK};">${company}${sla}</td>
                <td align="right" style="padding:8px 0;${border} font-family:${FONT}; font-size:12px; color:${INK}; ${NUM}">${age}</td>
              </tr>`;
    })
    .join("");
  return card(
    "Waiting for admin approval",
    plural(report.awaiting_approval_count, "ticket"),
    `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
            </table>`
  );
}

function renderRiskItem(ticket: SlaAuditTicket, index: number): string {
  const company = escapeHtml(ticket.company_name ?? "Company not assigned");
  const reference = escapeHtml(ticket.ticket_reference ?? ticket.ticket_id);
  const title = escapeHtml(ticket.ticket_title);
  const reason = escapeHtml(ticket.risk_reason ?? "SLA risk detected.");
  const action = escapeHtml(ticket.required_action ?? "Review required.");
  const due = escapeHtml(describeDeadlines(ticket));
  const tone = ticket.sla_status === "breached" ? TONE.breached : TONE.atRisk;
  const status = ticket.sla_status === "breached" ? "Breached" : "At risk";
  const label = `font-weight:600; color:${INK};`;

  return `
              <tr>
                <td style="padding:${index === 0 ? "0" : "10px"} 0 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${tone.tint}" style="background-color:${tone.tint}; border-left:3px solid ${tone.accent}; border-radius:4px;">
                    <tr>
                      <td style="padding:12px 14px; font-family:${FONT};">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                          <tr>
                            <td style="font-family:${FONT}; font-size:12px; line-height:18px; font-weight:700; color:${INK};">${company} / ${reference} · ${escapeHtml(ticket.priority)}</td>
                            <td align="right" style="white-space:nowrap;">${pill(status, { accent: tone.accent, tint: CARD })}</td>
                          </tr>
                        </table>
                        <div style="font-size:14px; line-height:20px; color:${INK}; padding:4px 0 6px;">${title}</div>
                        <div style="font-size:12px; line-height:18px; color:${MUTED};"><span style="${label}">Risk:</span> ${reason}</div>
                        <div style="font-size:12px; line-height:18px; color:${MUTED};"><span style="${label}">Action:</span> ${action}</div>
                        <div style="font-size:12px; line-height:18px; color:${MUTED}; ${NUM}"><span style="${label}">Due:</span> ${due}</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>`;
}

function renderHighPriorityRisks(report: SlaAuditReport): string {
  const body =
    report.vip_risks.length > 0
      ? `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${report.vip_risks
              .map(renderRiskItem)
              .join("")}
            </table>`
      : emptyState("No high-priority SLA risks.");
  return card("High-priority SLA risks", report.vip_risk_count > 0 ? plural(report.vip_risk_count, "ticket") : "", body);
}

function slaPill(ticket: SlaAuditTicket): string {
  if (ticket.sla_status === "breached") return pill("Breached", TONE.breached);
  if (ticket.sla_status === "at_risk") return pill("At risk", TONE.atRisk);
  if (ticket.sla_measured) return pill("On track", TONE.met, false);
  return pill("No SLA", TONE.neutral, false);
}

function ownerLabel(ticket: SlaAuditTicket): string {
  if (ticket.awaiting_approval) return `<span style="color:${MUTED};">Awaiting approval</span>`;
  if (ticket.has_owner) return `<span style="color:${MUTED};">Assigned</span>`;
  return `<span style="color:${TONE.atRisk.accent}; font-weight:700;">Unowned</span>`;
}

function renderTicketRow(ticket: SlaAuditTicket, index: number): string {
  const reference = escapeHtml(ticket.ticket_reference ?? ticket.ticket_id.slice(0, 8));
  const company = escapeHtml(ticket.company_name ?? "No company on file");
  const status = escapeHtml(STATUS_LABELS[ticket.ticket_status] ?? ticket.ticket_status);
  const age = ticket.age_days == null ? "—" : `${ticket.age_days}d`;
  const priority = HIGH_PRIORITIES.has(ticket.priority)
    ? `<strong style="color:${TONE.breached.accent};">${escapeHtml(ticket.priority)}</strong>`
    : escapeHtml(ticket.priority);
  const bg = index % 2 === 1 ? ZEBRA : CARD;
  const cell = `padding:9px 8px; border-top:1px solid ${LINE}; font-family:${FONT}; font-size:12px; line-height:17px; color:${INK};`;

  return `
              <tr bgcolor="${bg}" style="background-color:${bg};">
                <td valign="top" class="tc" style="${cell} font-family:${MONO}; font-weight:700; white-space:nowrap;">${reference}</td>
                <td valign="top" class="tc" style="${cell}">${company}<div style="color:${MUTED}; font-size:11px; line-height:16px;">${status} · ${priority}</div></td>
                <td valign="top" class="tc" style="${cell}">${slaPill(ticket)}</td>
                <td valign="top" class="tc" style="${cell}">${ownerLabel(ticket)}</td>
                <td valign="top" align="right" class="tc" style="${cell} ${NUM} white-space:nowrap;">${age}</td>
              </tr>`;
}

function renderTickets(report: SlaAuditReport): string {
  if (report.tickets.length === 0) return "";
  const { rows, total } = sortedTickets(report);
  const meta = total > rows.length ? `Top ${rows.length} of ${total}` : plural(total, "ticket");
  const head = `padding:0 8px 8px; font-family:${FONT}; font-size:10px; line-height:14px; letter-spacing:1px; text-transform:uppercase; color:${MUTED}; font-weight:600;`;

  return card(
    "Active tickets",
    meta,
    `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <th align="left" class="tc" style="${head}">Ref</th>
                <th align="left" class="tc" style="${head}">Company</th>
                <th align="left" class="tc" style="${head}">SLA</th>
                <th align="left" class="tc" style="${head}">Owner</th>
                <th align="right" class="tc" style="${head}">Age</th>
              </tr>${rows.map(renderTicketRow).join("")}
            </table>`
  );
}

function renderCompanyRow(company: CompanySummary, max: number, index: number): string {
  const label = escapeHtml(company.company_name);
  const count = company.active_ticket_count;
  const width = Math.max(4, Math.round((count / max) * 100));
  const border = index === 0 ? "" : ` border-top:1px solid ${LINE};`;
  return `
              <tr>
                <td width="44%" style="padding:8px 0;${border} font-family:${FONT}; font-size:13px; line-height:18px; color:${INK};">${label}</td>
                <td style="padding:8px 12px;${border}">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td width="${width}%" bgcolor="${ACCENT}" style="background-color:${ACCENT}; height:6px; border-radius:3px; font-size:0; line-height:0;">&nbsp;</td>
                      <td bgcolor="${NEUTRAL_TINT}" style="background-color:${NEUTRAL_TINT}; height:6px; font-size:0; line-height:0;">&nbsp;</td>
                    </tr>
                  </table>
                </td>
                <td width="104" align="right" style="padding:8px 0;${border} font-family:${FONT}; font-size:12px; line-height:18px; color:${MUTED}; white-space:nowrap; ${NUM}">${count} active ticket${count === 1 ? "" : "s"}</td>
              </tr>`;
}

function renderCompanies(report: SlaAuditReport): string {
  if (report.companies.length === 0) {
    return card(
      "Companies",
      "",
      `
            <div style="font-family:${FONT}; font-size:13px; line-height:18px; color:${MUTED};">No companies represented in the current active ticket backlog.</div>`
    );
  }
  const max = Math.max(...report.companies.map((c) => c.active_ticket_count), 1);
  return card(
    "Companies",
    plural(report.company_count, "company", "companies"),
    `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${report.companies
              .map((company, index) => renderCompanyRow(company, max, index))
              .join("")}
            </table>`
  );
}

function safeDashboardUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\//i.test(url) ? url : null;
}

function renderButton(url: string | null): string {
  if (!url) return "";
  return `${spacer(20)}
  <tr>
    <td style="padding:0 24px;" class="px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td bgcolor="${NAVY}" style="background-color:${NAVY}; border-radius:6px;">
            <a href="${escapeHtml(url)}" style="display:inline-block; padding:12px 22px; font-family:${FONT}; font-size:14px; font-weight:600; color:#FFFFFF; text-decoration:none;">Open the helpdesk dashboard &rarr;</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderFooter(view: AuditEmailView): string {
  const small = `font-family:${FONT}; font-size:11px; line-height:17px; color:${MUTED};`;
  return `${spacer(28)}
  <tr>
    <td bgcolor="${FOOTER_BAND}" style="background-color:${FOOTER_BAND}; border-top:1px solid ${LINE}; padding:22px 32px 24px;" class="px">
      <div style="font-family:${FONT}; font-size:12px; line-height:18px; color:${INK}; font-weight:600;">${escapeHtml(SOURCE_LINE)}</div>
      <div style="${small} padding-top:4px; ${NUM}">Snapshot taken ${escapeHtml(view.snapshot)} · All times Europe/Zurich.</div>
      <div style="${small} padding-top:8px;">${escapeHtml(view.methodology)}</div>
      <div style="${small} padding-top:8px;">${escapeHtml(RECIPIENT_LINE)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px; border-top:1px solid #D5DBE3;">
        <tr>
          <td style="padding-top:14px;">
            <div style="font-family:${FONT}; font-size:12px; line-height:18px; color:${INK};">&copy; ${escapeHtml(view.year)} <span style="letter-spacing:1.5px; font-weight:700;">${BRAND}</span> &middot; ${LOCATION}</div>
            <div style="${small}">${escapeHtml(TAGLINE)}</div>
            <div style="${small} padding-top:6px;">${escapeHtml(NO_REPLY_LINE)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

export function getAuditEmailHtml(report: SlaAuditReport, options: AuditEmailOptions = {}): string {
  const view = buildView(report);
  const org = escapeHtml(view.org);
  // Hidden preheader: the line inbox previews show next to the subject.
  const preheader = escapeHtml(`${view.health.label}: ${view.verdict}`);

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Daily SLA brief — ${org}</title>
<style>
  @media only screen and (max-width:480px) {
    .outer { padding:12px 4px !important; }
    .px { padding-left:12px !important; padding-right:12px !important; }
    .px-kpi { padding-left:10px !important; padding-right:10px !important; }
    .kpi { display:inline-block !important; width:50% !important; box-sizing:border-box; }
    .stack { display:block !important; width:100% !important; }
    .stack-left { text-align:left !important; padding-top:12px !important; }
    .cp { padding-left:12px !important; padding-right:12px !important; }
    .tc { padding-left:4px !important; padding-right:4px !important; }
  }
  @media only screen and (max-width:360px) {
    .cp { padding-left:10px !important; padding-right:10px !important; }
    .tc { padding-left:3px !important; padding-right:3px !important; font-size:11px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:${CANVAS}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">${preheader}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="background-color:${CANVAS};">
  <tr>
    <td align="center" style="padding:24px 8px;" class="outer">
      <!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="max-width:640px; width:100%; background-color:${CANVAS}; border:1px solid ${LINE}; border-radius:10px; overflow:hidden;">
${renderHeader(view)}${renderStatusBanner(view)}${renderKpis(view)}${renderActions(view)}${renderAwaitingApproval(report)}${renderHighPriorityRisks(report)}${renderTickets(report)}${renderCompanies(report)}${renderButton(safeDashboardUrl(options.dashboardUrl))}${renderFooter(view)}
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Plain-text alternative
// ---------------------------------------------------------------------------

const RULE_HEAVY = "=".repeat(64);
const RULE_LIGHT = "-".repeat(64);

function textSection(title: string, meta: string, lines: string[]): string[] {
  return ["", `${title.toUpperCase()}${meta ? ` (${meta})` : ""}`, RULE_LIGHT, ...lines];
}

export function getAuditEmailText(report: SlaAuditReport, options: AuditEmailOptions = {}): string {
  const view = buildView(report);
  const out: string[] = [
    BRAND,
    `${PRODUCT} · Daily SLA brief`,
    `${view.org} · ${view.reportDate} · ${view.reportTime}`,
    RULE_HEAVY,
    "",
    view.health.label.toUpperCase(),
    view.verdict,
    "",
    "KEY FIGURES",
    RULE_LIGHT,
  ];

  const labelWidth = Math.max(...view.kpis.map((kpi) => kpi.label.length));
  const valueWidth = Math.max(...view.kpis.map((kpi) => kpi.value.length));
  for (const kpi of view.kpis) {
    out.push(`  ${kpi.label.padEnd(labelWidth)}  ${kpi.value.padStart(valueWidth)}  ${kpi.note}`);
  }
  out.push("", view.windowLine);

  out.push(
    ...textSection(
      "Today's actions",
      view.actions.length > 0 ? plural(view.actions.length, "action") : "",
      view.actions.length > 0
        ? view.actions.map((action, index) => `  ${index + 1}. ${action}`)
        : ["  No priority follow-ups required."]
    )
  );

  if (report.awaiting_approval.length > 0) {
    out.push(
      ...textSection(
        "Waiting for admin approval",
        plural(report.awaiting_approval_count, "ticket"),
        report.awaiting_approval.map((ticket) => {
          const reference = ticket.ticket_reference ?? ticket.ticket_id.slice(0, 8);
          const company = ticket.company_name ?? "No company on file";
          const age = ticket.age_days == null ? "—" : `${ticket.age_days}d`;
          const sla =
            ticket.sla_status === "breached" ? " · SLA breached" : ticket.sla_status === "at_risk" ? " · SLA at risk" : "";
          return `  ${reference}  ${company}${sla}  ${age}`;
        })
      )
    );
  }

  const riskLines =
    report.vip_risks.length > 0
      ? report.vip_risks.flatMap((ticket, index) => [
          ...(index === 0 ? [] : [""]),
          `  ${ticket.company_name ?? "Company not assigned"} / ${ticket.ticket_reference ?? ticket.ticket_id} · ${ticket.priority} · ${ticket.sla_status === "breached" ? "Breached" : "At risk"}`,
          `  ${ticket.ticket_title}`,
          `  Risk: ${ticket.risk_reason ?? "SLA risk detected."}`,
          `  Action: ${ticket.required_action ?? "Review required."}`,
          `  Due: ${describeDeadlines(ticket)}`,
        ])
      : ["  No high-priority SLA risks."];
  out.push(
    ...textSection(
      "High-priority SLA risks",
      report.vip_risk_count > 0 ? plural(report.vip_risk_count, "ticket") : "",
      riskLines
    )
  );

  if (report.tickets.length > 0) {
    const { rows, total } = sortedTickets(report);
    out.push(
      ...textSection(
        "Active tickets",
        total > rows.length ? `Top ${rows.length} of ${total}` : plural(total, "ticket"),
        rows.map((ticket) => {
          const reference = ticket.ticket_reference ?? ticket.ticket_id.slice(0, 8);
          const company = ticket.company_name ?? "No company on file";
          const status = STATUS_LABELS[ticket.ticket_status] ?? ticket.ticket_status;
          const sla =
            ticket.sla_status === "breached"
              ? "Breached"
              : ticket.sla_status === "at_risk"
                ? "At risk"
                : ticket.sla_measured
                  ? "On track"
                  : "No SLA";
          const owner = ticket.awaiting_approval ? "Awaiting approval" : ticket.has_owner ? "Assigned" : "Unowned";
          const age = ticket.age_days == null ? "—" : `${ticket.age_days}d`;
          return `  ${reference}  ${company} (${status} · ${ticket.priority})  SLA: ${sla}  Owner: ${owner}  Age: ${age}`;
        })
      )
    );
  }

  out.push(
    ...textSection(
      "Companies",
      report.companies.length > 0 ? plural(report.company_count, "company", "companies") : "",
      report.companies.length > 0
        ? report.companies.map(
            (company) =>
              `  ${company.company_name} — ${company.active_ticket_count} active ticket${company.active_ticket_count === 1 ? "" : "s"}`
          )
        : ["  No companies represented in the current active ticket backlog."]
    )
  );

  const dashboard = safeDashboardUrl(options.dashboardUrl);
  if (dashboard) out.push("", `Open the helpdesk dashboard: ${dashboard}`);

  out.push(
    "",
    RULE_HEAVY,
    SOURCE_LINE,
    `Snapshot taken ${view.snapshot} · All times Europe/Zurich.`,
    "",
    view.methodology,
    "",
    RECIPIENT_LINE,
    "",
    `© ${view.year} ${BRAND} · ${LOCATION}`,
    TAGLINE,
    NO_REPLY_LINE,
    ""
  );
  return out.join("\n");
}

export const auditTemplate = getAuditEmailHtml;
