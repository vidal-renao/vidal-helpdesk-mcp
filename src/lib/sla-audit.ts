import { getDomainSchema, getPublicSchema } from "./supabase.js";

export type SlaStatus = "compliant" | "at_risk" | "breached";

/**
 * One-word verdict for the whole report, used for the email subject and
 * status banner. `action_required` = something has breached or a high/critical
 * ticket is at risk; `attention` = nothing breached, but tickets are at risk,
 * have no owner, or cannot be measured against an SLA at all; `healthy`
 * otherwise (including an empty backlog).
 */
export type AuditHealth = "action_required" | "attention" | "healthy";

export type SlaAuditTicket = {
  ticket_id: string;
  ticket_reference: string | null;
  ticket_title: string;
  ticket_status: string;
  priority: string;
  customer_profile_id: string | null;
  /** @deprecated Use customer_profile_id. This is not a companies-table id. */
  company_id: string | null;
  company_name: string | null;
  company_assignment_status: "assigned" | "unassigned";
  project_id: null;
  project_name: null;
  sla_status: SlaStatus;
  /** False when the ticket has neither an SLA deadline nor a breach flag. */
  sla_measured: boolean;
  has_owner: boolean;
  age_days: number | null;
  vip_risk: boolean;
  risk_reason: string | null;
  required_action: string | null;
  due_at: string | null;
};

export type CompanySummary = {
  company_id: string | null;
  company_name: string;
  active_ticket_count: number;
};

export type SlaAuditReport = {
  generated_at: string;
  organization_id: string;
  organization_name: string | null;
  reporting_period: { start: string; end: string };
  /**
   * Compliant share of the tickets that can actually be measured against an
   * SLA. `null` when no active ticket has an SLA deadline or breach flag --
   * reporting 100% in that case would claim compliance nobody measured.
   */
  compliance_percentage: number | null;
  health: AuditHealth;
  active_ticket_count: number;
  sla_measured_ticket_count: number;
  sla_unmeasured_ticket_count: number;
  breached_ticket_count: number;
  at_risk_ticket_count: number;
  unowned_ticket_count: number;
  waiting_ticket_count: number;
  oldest_active_age_days: number | null;
  company_count: number;
  unassigned_ticket_count: number;
  vip_risk_count: number;
  companies: CompanySummary[];
  tickets: SlaAuditTicket[];
  vip_risks: SlaAuditTicket[];
  action_items: string[];
};

const ACTIVE_STATUSES = ["open", "in_progress", "pending_customer", "pending_third_party"];
const WAITING_STATUSES = new Set(["pending_customer", "pending_third_party"]);
const VIP_PRIORITIES = new Set(["high", "critical"]);
const DAY_MS = 86_400_000;

/**
 * A ticket is "at_risk" once its resolution SLA is due within this window and
 * hasn't breached yet. There is no per-priority SLA-policy data configured in
 * this deployment today (`sla_policies` has zero active rows), so this is a
 * single, documented, deployment-wide threshold rather than a value derived
 * from configured policy data — see DOMAIN.md.
 */
const AT_RISK_WINDOW_MS = 4 * 60 * 60_000;

type TicketRow = {
  id: string;
  ticket_number: number | null;
  title: string;
  status: string;
  priority: string;
  sla_breached: boolean | null;
  sla_response_breached: boolean | null;
  sla_resolution_breached: boolean | null;
  resolution_due_at: string | null;
  response_due_at: string | null;
  sla_resolution_due: string | null;
  sla_first_response_due: string | null;
  created_by: string | null;
  assigned_to: string | null;
  created_at: string | null;
};

type CustomerInfoRow = {
  id: string;
  company_name: string;
};

export async function buildSlaAuditReport(
  organizationId: string,
  now: Date = new Date(),
  period: { start: Date; end: Date }
): Promise<SlaAuditReport> {
  const domainSchema = getDomainSchema();
  const publicSchema = getPublicSchema();

  const [{ data: ticketRows, error: ticketsError }, { data: organization, error: organizationError }] =
    await Promise.all([
      domainSchema
        .from("hd_tickets")
        .select(
          "id, ticket_number, title, status, priority, sla_breached, sla_response_breached, sla_resolution_breached, resolution_due_at, response_due_at, sla_resolution_due, sla_first_response_due, created_by, assigned_to, created_at"
        )
        .eq("organization_id", organizationId)
        .is("deleted_at", null)
        .in("status", ACTIVE_STATUSES)
        .returns<TicketRow[]>(),
      publicSchema.from("organizations").select("name").eq("id", organizationId).maybeSingle<{ name: string | null }>(),
    ]);

  if (ticketsError) {
    throw new Error(`Supabase tickets query failed: ${ticketsError.message}`);
  }
  if (organizationError) {
    throw new Error(`Supabase organization query failed: ${organizationError.message}`);
  }

  const tickets = ticketRows ?? [];

  // `tickets.created_by` has no formal foreign key to `profiles` in this schema
  // (application-level relationship only — see DOMAIN.md), so this is a single
  // batched lookup keyed on the distinct set of requester ids, not a per-ticket
  // query. Total query count is one tickets query, one organization query,
  // plus ceil(min(distinct requester ids, 1000) / 100) customer queries.
  const requesterIds = Array.from(new Set(tickets.map((t) => t.created_by).filter((id): id is string => Boolean(id))));
  const companyByProfileId = await resolveCustomerInfo(domainSchema, requesterIds);

  const normalized = tickets.map((ticket) => normalizeTicket(ticket, companyByProfileId, now));

  const measured = normalized.filter((t) => t.sla_measured);
  const compliantCount = measured.filter((t) => t.sla_status === "compliant").length;
  const compliancePercentage =
    measured.length > 0
      ? Number(((compliantCount / measured.length) * 100).toFixed(2))
      : normalized.length > 0
        ? null
        : 100;
  const breachedCount = normalized.filter((t) => t.sla_status === "breached").length;
  const atRiskCount = normalized.filter((t) => t.sla_status === "at_risk").length;
  const unownedCount = normalized.filter((t) => !t.has_owner).length;
  const ages = normalized.map((t) => t.age_days).filter((age): age is number => age != null);

  const companies = buildCompanySummaries(normalized);
  const unassignedTicketCount = companies.find((c) => c.company_id === null)?.active_ticket_count ?? 0;
  const realCompanyCount = companies.filter((c) => c.company_id !== null).length;

  const vipRisks = normalized
    .filter((t) => t.vip_risk)
    .sort(compareVipUrgency);

  const sortedTickets = [...normalized].sort(compareTickets);
  const unmeasuredCount = normalized.length - measured.length;
  const health: AuditHealth =
    breachedCount > 0 || vipRisks.length > 0
      ? "action_required"
      : atRiskCount > 0 || unownedCount > 0 || unmeasuredCount > 0
        ? "attention"
        : "healthy";

  return {
    generated_at: now.toISOString(),
    organization_id: organizationId,
    organization_name: organization?.name ?? null,
    reporting_period: { start: period.start.toISOString(), end: period.end.toISOString() },
    compliance_percentage: compliancePercentage,
    health,
    active_ticket_count: normalized.length,
    sla_measured_ticket_count: measured.length,
    sla_unmeasured_ticket_count: unmeasuredCount,
    breached_ticket_count: breachedCount,
    at_risk_ticket_count: atRiskCount,
    unowned_ticket_count: unownedCount,
    waiting_ticket_count: normalized.filter((t) => WAITING_STATUSES.has(t.ticket_status)).length,
    oldest_active_age_days: ages.length > 0 ? Math.max(...ages) : null,
    company_count: realCompanyCount,
    unassigned_ticket_count: unassignedTicketCount,
    vip_risk_count: vipRisks.length,
    companies,
    tickets: sortedTickets,
    vip_risks: vipRisks,
    action_items: vipRisks.map(formatActionItem),
  };
}

function normalizeTicket(ticket: TicketRow, companyByProfileId: Map<string, string>, now: Date): SlaAuditTicket {
  const companyName = ticket.created_by ? companyByProfileId.get(ticket.created_by) ?? null : null;
  // resolution_due_at/response_due_at are the canonical columns ticket-system
  // writes today (lib/sla.ts); the sla_* pair is the legacy mirror.
  const dueAt =
    ticket.resolution_due_at ??
    ticket.sla_resolution_due ??
    ticket.response_due_at ??
    ticket.sla_first_response_due ??
    null;
  const slaStatus = resolveSlaStatus(ticket, dueAt, now);
  const createdMs = ticket.created_at ? new Date(ticket.created_at).getTime() : Number.NaN;
  const isVipPriority = VIP_PRIORITIES.has(ticket.priority);
  const vipRisk = isVipPriority && slaStatus !== "compliant";

  return {
    ticket_id: ticket.id,
    ticket_reference: ticket.ticket_number != null ? `TK-${String(ticket.ticket_number).padStart(4, "0")}` : null,
    ticket_title: ticket.title,
    ticket_status: ticket.status,
    priority: ticket.priority,
    customer_profile_id: ticket.created_by,
    company_id: ticket.created_by && companyName ? ticket.created_by : null,
    company_name: companyName,
    company_assignment_status: companyName ? "assigned" : "unassigned",
    project_id: null,
    project_name: null,
    sla_status: slaStatus,
    sla_measured: dueAt != null || isBreachFlagged(ticket),
    has_owner: Boolean(ticket.assigned_to),
    age_days: Number.isFinite(createdMs) ? Math.max(0, Math.floor((now.getTime() - createdMs) / DAY_MS)) : null,
    vip_risk: vipRisk,
    risk_reason: slaStatus === "compliant" ? null : buildRiskReason(slaStatus, dueAt, now),
    required_action: slaStatus === "compliant" ? null : buildRequiredAction(slaStatus),
    due_at: dueAt,
  };
}

async function resolveCustomerInfo(
  domainSchema: ReturnType<typeof getDomainSchema>,
  requesterIds: string[]
): Promise<Map<string, string>> {
  const uniqueIds = Array.from(new Set(requesterIds)).slice(0, 1000);
  const allowed = new Set(uniqueIds);
  const result = new Map<string, string>();
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const batch = uniqueIds.slice(offset, offset + 100);
    if (batch.length === 0) continue;
    const { data, error } = await domainSchema
      .from("hd_customers_info")
      .select("id, company_name")
      .in("id", batch)
      .returns<CustomerInfoRow[]>();
    if (error) throw new Error(`Supabase customers_info query failed: ${error.message}`);
    for (const row of data ?? []) {
      if (allowed.has(row.id)) result.set(row.id, row.company_name);
    }
  }
  return result;
}

function isBreachFlagged(ticket: TicketRow): boolean {
  return Boolean(ticket.sla_breached || ticket.sla_response_breached || ticket.sla_resolution_breached);
}

function resolveSlaStatus(ticket: TicketRow, dueAt: string | null, now: Date): SlaStatus {
  if (isBreachFlagged(ticket)) {
    return "breached";
  }

  if (dueAt) {
    const msUntilDue = new Date(dueAt).getTime() - now.getTime();
    if (msUntilDue <= 0) {
      return "breached";
    }
    if (msUntilDue <= AT_RISK_WINDOW_MS) {
      return "at_risk";
    }
  }

  return "compliant";
}

function buildRiskReason(status: SlaStatus, dueAt: string | null, now: Date): string {
  if (status === "breached") {
    return dueAt
      ? `SLA resolution was due ${formatRelativeHours(new Date(dueAt).getTime() - now.getTime())} and has not been resolved.`
      : "SLA has been marked breached.";
  }

  const hoursLeft = dueAt ? Math.max(0, Math.round((new Date(dueAt).getTime() - now.getTime()) / 3_600_000)) : null;
  return hoursLeft != null
    ? `Resolution due within ${hoursLeft}h — approaching SLA breach.`
    : "Approaching SLA breach.";
}

function buildRequiredAction(status: SlaStatus): string {
  return status === "breached"
    ? "Escalate immediately and notify the account owner."
    : "Assign an owner and respond before the SLA window closes.";
}

function formatRelativeHours(msDelta: number): string {
  const hours = Math.round(Math.abs(msDelta) / 3_600_000);
  return `${hours}h ago`;
}

function formatActionItem(ticket: SlaAuditTicket): string {
  const company = ticket.company_name ?? "Company not assigned";
  return `${ticket.ticket_reference ?? ticket.ticket_id} (${company}) — ${ticket.required_action ?? "Review required."}`;
}

function ticketNumberOf(ticket: SlaAuditTicket): number {
  const match = ticket.ticket_reference?.match(/(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareVipUrgency(a: SlaAuditTicket, b: SlaAuditTicket): number {
  const severityRank = (t: SlaAuditTicket) => (t.sla_status === "breached" ? 0 : 1);
  const severityDiff = severityRank(a) - severityRank(b);
  if (severityDiff !== 0) return severityDiff;

  const aDue = a.due_at ? new Date(a.due_at).getTime() : Number.MAX_SAFE_INTEGER;
  const bDue = b.due_at ? new Date(b.due_at).getTime() : Number.MAX_SAFE_INTEGER;
  if (aDue !== bDue) return aDue - bDue;

  return compareTickets(a, b);
}

function compareTickets(a: SlaAuditTicket, b: SlaAuditTicket): number {
  const numberDiff = ticketNumberOf(a) - ticketNumberOf(b);
  return numberDiff !== 0 ? numberDiff : compareCodePoints(a.ticket_id, b.ticket_id);
}

function compareCodePoints(a: string, b: string): number {
  const left = a.normalize("NFC");
  const right = b.normalize("NFC");
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildCompanySummaries(tickets: SlaAuditTicket[]): CompanySummary[] {
  const counts = new Map<string, { company_id: string | null; company_name: string; count: number }>();

  for (const ticket of tickets) {
    const key = ticket.company_id ?? "__unassigned__";
    const label = ticket.company_name ?? "Unassigned";
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { company_id: ticket.company_id, company_name: label, count: 1 });
    }
  }

  const real = Array.from(counts.values())
    .filter((c) => c.company_id !== null)
    .sort((a, b) => compareCodePoints(a.company_name, b.company_name) || compareCodePoints(a.company_id ?? "", b.company_id ?? ""))
    .map((c) => ({ company_id: c.company_id, company_name: c.company_name, active_ticket_count: c.count }));

  const unassigned = counts.get("__unassigned__");

  return unassigned
    ? [...real, { company_id: null, company_name: "Unassigned", active_ticket_count: unassigned.count }]
    : real;
}
