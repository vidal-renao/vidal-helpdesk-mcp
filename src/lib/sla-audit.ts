import { getDomainSchema, getPublicSchema } from "./supabase.js";

export type SlaStatus = "compliant" | "at_risk" | "breached";

/**
 * Per-target state, replicating `SlaTargetState` in ticket-system's
 * lib/sla-display.ts (what the ticket detail page shows), so the email and the
 * app never disagree about a ticket.
 */
export type SlaTargetState = "running" | "at_risk" | "overdue" | "met" | "missed";

/**
 * One-word verdict for the whole report, used for the email subject and
 * status banner. `action_required` = something in the queue has breached or a
 * high/critical ticket is at risk; `attention` = nothing breached, but tickets
 * are at risk, have no owner, wait for admin approval, or cannot be measured
 * against an SLA at all; `healthy` otherwise (including an empty backlog).
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
  /** First-response target; null when the ticket has no response deadline. */
  response_status: SlaTargetState | null;
  /** Resolution target; null when the ticket has no resolution deadline. */
  resolution_status: SlaTargetState | null;
  response_due_at: string | null;
  resolution_due_at: string | null;
  first_response_at: string | null;
  /** False when the ticket has neither an SLA deadline nor a breach flag. */
  sla_measured: boolean;
  has_owner: boolean;
  review_status: string | null;
  /** in_progress with review_status = "pending": the agent is done, an admin must approve. */
  awaiting_approval: boolean;
  age_days: number | null;
  /**
   * High-priority SLA risk: priority high/critical and sla_status != compliant.
   * The field name is kept for API compatibility; it is not a VIP-customer flag.
   */
  vip_risk: boolean;
  risk_reason: string | null;
  required_action: string | null;
  /** The deadline that drives sla_status (the failed or nearest open target). */
  due_at: string | null;
};

export type CompanySummary = {
  /**
   * @deprecated Stable grouping key only: the smallest requester profile id in
   * the company group. Null for the "Unassigned" bucket.
   */
  company_id: string | null;
  company_name: string;
  active_ticket_count: number;
};

export type SlaTargetTally = { measured: number; met: number };

export type SlaAuditReport = {
  /** Real evaluation time ("now"), not the dedupe period start. */
  generated_at: string;
  organization_id: string;
  organization_name: string | null;
  /** UTC calendar day used only for delivery dedupe. */
  reporting_period: { start: string; end: string };
  /**
   * SLA compliance of tickets resolved/closed in the rolling window (by
   * `resolved_at`): share of measured resolved tickets with no missed target.
   * `null` when the window holds no measured resolved ticket — never 0% or 100%.
   */
  compliance_percentage: number | null;
  compliance_window: {
    days: number;
    start: string;
    end: string;
    resolved_ticket_count: number;
    measured_ticket_count: number;
    compliant_ticket_count: number;
    response: SlaTargetTally;
    resolution: SlaTargetTally;
  };
  health: AuditHealth;
  active_ticket_count: number;
  sla_measured_ticket_count: number;
  sla_unmeasured_ticket_count: number;
  /** Active tickets with a missed/overdue target or a stored breach flag. */
  breached_ticket_count: number;
  at_risk_ticket_count: number;
  /** Active tickets with no agent, excluding those waiting for admin approval. */
  unowned_ticket_count: number;
  waiting_ticket_count: number;
  awaiting_approval_count: number;
  oldest_active_age_days: number | null;
  company_count: number;
  unassigned_ticket_count: number;
  /** Count of high-priority SLA risks (name kept for API compatibility). */
  vip_risk_count: number;
  companies: CompanySummary[];
  tickets: SlaAuditTicket[];
  /** High-priority SLA risks, most urgent first (name kept for API compatibility). */
  vip_risks: SlaAuditTicket[];
  awaiting_approval: SlaAuditTicket[];
  action_items: string[];
};

export type SlaAuditOptions = {
  /** Rolling window for resolved-ticket compliance. Defaults to RESOLVED_WINDOW_DAYS. */
  resolvedWindowDays?: number;
};

const ACTIVE_STATUSES = ["open", "in_progress", "pending_customer", "pending_third_party"];
const FINISHED_STATUSES = ["resolved", "closed"];
const WAITING_STATUSES = new Set(["pending_customer", "pending_third_party"]);
const HIGH_PRIORITIES = new Set(["high", "critical"]);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Default rolling window for "SLA compliance (resolved in last N days)". */
export const RESOLVED_WINDOW_DAYS = 7;

/**
 * At-risk rule, replicated from ticket-system lib/sla-display.ts: an open
 * target is at risk when at most one hour, or at most 25% of its window
 * (created_at → due), remains.
 */
const AT_RISK_ABSOLUTE_MS = HOUR_MS;
const AT_RISK_FRACTION = 0.25;

const ACTIVE_COLUMNS =
  "id, ticket_number, title, status, priority, review_status, sla_breached, sla_response_breached, sla_resolution_breached, resolution_due_at, response_due_at, sla_resolution_due, sla_first_response_due, first_response_at, first_agent_response_at, created_by, assigned_to, created_at";

const RESOLVED_COLUMNS =
  "id, status, created_at, resolved_at, closed_at, first_response_at, first_agent_response_at, resolution_due_at, response_due_at, sla_resolution_due, sla_first_response_due";

type TicketRow = {
  id: string;
  ticket_number: number | null;
  title: string;
  status: string;
  priority: string;
  review_status: string | null;
  sla_breached: boolean | null;
  sla_response_breached: boolean | null;
  sla_resolution_breached: boolean | null;
  resolution_due_at: string | null;
  response_due_at: string | null;
  sla_resolution_due: string | null;
  sla_first_response_due: string | null;
  first_response_at: string | null;
  first_agent_response_at: string | null;
  created_by: string | null;
  assigned_to: string | null;
  created_at: string | null;
};

type ResolvedTicketRow = {
  id: string;
  status: string;
  created_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  first_response_at: string | null;
  first_agent_response_at: string | null;
  resolution_due_at: string | null;
  response_due_at: string | null;
  sla_resolution_due: string | null;
  sla_first_response_due: string | null;
};

type CustomerInfoRow = {
  id: string;
  company_name: string | null;
};

export async function buildSlaAuditReport(
  organizationId: string,
  now: Date = new Date(),
  period: { start: Date; end: Date },
  options: SlaAuditOptions = {}
): Promise<SlaAuditReport> {
  const domainSchema = getDomainSchema();
  const publicSchema = getPublicSchema();
  const windowDays = options.resolvedWindowDays ?? RESOLVED_WINDOW_DAYS;
  const windowStart = new Date(now.getTime() - windowDays * DAY_MS);

  const [
    { data: ticketRows, error: ticketsError },
    { data: resolvedRows, error: resolvedError },
    { data: organization, error: organizationError },
  ] = await Promise.all([
    domainSchema
      .from("hd_tickets")
      .select(ACTIVE_COLUMNS)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .in("status", ACTIVE_STATUSES)
      .returns<TicketRow[]>(),
    domainSchema
      .from("hd_tickets")
      .select(RESOLVED_COLUMNS)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .in("status", FINISHED_STATUSES)
      .gte("resolved_at", windowStart.toISOString())
      .returns<ResolvedTicketRow[]>(),
    publicSchema.from("organizations").select("name").eq("id", organizationId).maybeSingle<{ name: string | null }>(),
  ]);

  if (ticketsError) {
    throw new Error(`Supabase tickets query failed: ${ticketsError.message}`);
  }
  if (resolvedError) {
    throw new Error(`Supabase resolved tickets query failed: ${resolvedError.message}`);
  }
  if (organizationError) {
    throw new Error(`Supabase organization query failed: ${organizationError.message}`);
  }

  const tickets = ticketRows ?? [];

  // `tickets.created_by` has no formal foreign key to `profiles` in this schema
  // (application-level relationship only — see DOMAIN.md), so this is a single
  // batched lookup keyed on the distinct set of requester ids, not a per-ticket
  // query. Total query count is two tickets queries, one organization query,
  // plus ceil(min(distinct requester ids, 1000) / 100) customer queries.
  const requesterIds = Array.from(new Set(tickets.map((t) => t.created_by).filter((id): id is string => Boolean(id))));
  const companyByProfileId = await resolveCustomerInfo(domainSchema, requesterIds);

  const normalized = tickets.map((ticket) => normalizeTicket(ticket, companyByProfileId, now));
  const windowSummary = summarizeResolvedWindow(resolvedRows ?? [], now, windowStart, windowDays);

  const measured = normalized.filter((t) => t.sla_measured);
  const breachedCount = normalized.filter((t) => t.sla_status === "breached").length;
  const atRiskCount = normalized.filter((t) => t.sla_status === "at_risk").length;
  const awaitingApproval = normalized.filter((t) => t.awaiting_approval).sort(compareTickets);
  const unownedCount = normalized.filter((t) => !t.has_owner && !t.awaiting_approval).length;
  const ages = normalized.map((t) => t.age_days).filter((age): age is number => age != null);

  const companies = buildCompanySummaries(normalized);
  const unassignedTicketCount = companies.find((c) => c.company_id === null)?.active_ticket_count ?? 0;
  const realCompanyCount = companies.filter((c) => c.company_id !== null).length;

  const vipRisks = normalized.filter((t) => t.vip_risk).sort(compareVipUrgency);

  const sortedTickets = [...normalized].sort(compareTickets);
  const unmeasuredCount = normalized.length - measured.length;
  const health: AuditHealth =
    breachedCount > 0 || vipRisks.length > 0
      ? "action_required"
      : atRiskCount > 0 || unownedCount > 0 || unmeasuredCount > 0 || awaitingApproval.length > 0
        ? "attention"
        : "healthy";

  return {
    generated_at: now.toISOString(),
    organization_id: organizationId,
    organization_name: organization?.name ?? null,
    reporting_period: { start: period.start.toISOString(), end: period.end.toISOString() },
    compliance_percentage: windowSummary.compliancePercentage,
    compliance_window: windowSummary.window,
    health,
    active_ticket_count: normalized.length,
    sla_measured_ticket_count: measured.length,
    sla_unmeasured_ticket_count: unmeasuredCount,
    breached_ticket_count: breachedCount,
    at_risk_ticket_count: atRiskCount,
    unowned_ticket_count: unownedCount,
    waiting_ticket_count: normalized.filter((t) => WAITING_STATUSES.has(t.ticket_status)).length,
    awaiting_approval_count: awaitingApproval.length,
    oldest_active_age_days: ages.length > 0 ? Math.max(...ages) : null,
    company_count: realCompanyCount,
    unassigned_ticket_count: unassignedTicketCount,
    vip_risk_count: vipRisks.length,
    companies,
    tickets: sortedTickets,
    vip_risks: vipRisks,
    awaiting_approval: awaitingApproval,
    action_items: vipRisks.map(formatActionItem),
  };
}

// ---------------------------------------------------------------------------
// SLA evaluation (replicates ticket-system lib/sla.ts assessSla and
// lib/sla-display.ts deriveSlaDisplay; this repo must not import across repos)
// ---------------------------------------------------------------------------

function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** State of a still-open target at `now` (sla-display openTarget). */
export function openTargetState(dueAt: string, startedAt: string | null, now: Date): SlaTargetState {
  const due = toTime(dueAt);
  if (due === null) return "running";
  const remaining = due - now.getTime();
  if (remaining < 0) return "overdue";
  const start = toTime(startedAt);
  const window = start === null ? 0 : due - start;
  const atRisk = remaining <= AT_RISK_ABSOLUTE_MS || (window > 0 && remaining / window <= AT_RISK_FRACTION);
  return atRisk ? "at_risk" : "running";
}

function finishedTargetState(dueAt: string, completedAt: string | null): SlaTargetState {
  const due = toTime(dueAt);
  const done = toTime(completedAt);
  return due !== null && done !== null && done > due ? "missed" : "met";
}

function isFailed(state: SlaTargetState | null): boolean {
  return state === "overdue" || state === "missed";
}

type ResolvedAssessment = { responseMeasured: boolean; responseBreached: boolean; resolutionMeasured: boolean; resolutionBreached: boolean };

/** assessSla from ticket-system lib/sla.ts, for a resolved/closed ticket. */
export function assessResolvedTicket(ticket: ResolvedTicketRow, now: Date): ResolvedAssessment {
  const firstResponseAt = ticket.first_agent_response_at ?? ticket.first_response_at ?? null;
  const responseDue = ticket.response_due_at ?? ticket.sla_first_response_due ?? null;
  const resolutionDue = ticket.resolution_due_at ?? ticket.sla_resolution_due ?? null;
  const isResolved = ticket.status === "resolved" || ticket.status === "closed";
  const resolvedAt = ticket.resolved_at ?? null;

  const responseBreached = Boolean(
    responseDue &&
      (!firstResponseAt
        ? now.getTime() > new Date(responseDue).getTime()
        : new Date(firstResponseAt).getTime() > new Date(responseDue).getTime())
  );
  const resolutionBreached = Boolean(
    resolutionDue &&
      (!isResolved
        ? now.getTime() > new Date(resolutionDue).getTime()
        : resolvedAt
          ? new Date(resolvedAt).getTime() > new Date(resolutionDue).getTime()
          : false)
  );

  return {
    responseMeasured: Boolean(responseDue),
    responseBreached,
    resolutionMeasured: Boolean(resolutionDue),
    resolutionBreached,
  };
}

function summarizeResolvedWindow(rows: ResolvedTicketRow[], now: Date, windowStart: Date, days: number) {
  const response: SlaTargetTally = { measured: 0, met: 0 };
  const resolution: SlaTargetTally = { measured: 0, met: 0 };
  let measuredTickets = 0;
  let compliantTickets = 0;

  for (const row of rows) {
    const a = assessResolvedTicket(row, now);
    if (a.responseMeasured) {
      response.measured += 1;
      if (!a.responseBreached) response.met += 1;
    }
    if (a.resolutionMeasured) {
      resolution.measured += 1;
      if (!a.resolutionBreached) resolution.met += 1;
    }
    if (a.responseMeasured || a.resolutionMeasured) {
      measuredTickets += 1;
      if (!a.responseBreached && !a.resolutionBreached) compliantTickets += 1;
    }
  }

  return {
    compliancePercentage: measuredTickets > 0 ? Number(((compliantTickets / measuredTickets) * 100).toFixed(2)) : null,
    window: {
      days,
      start: windowStart.toISOString(),
      end: now.toISOString(),
      resolved_ticket_count: rows.length,
      measured_ticket_count: measuredTickets,
      compliant_ticket_count: compliantTickets,
      response,
      resolution,
    },
  };
}

function normalizeTicket(ticket: TicketRow, companyByProfileId: Map<string, string>, now: Date): SlaAuditTicket {
  const companyName = ticket.created_by ? companyByProfileId.get(ticket.created_by) ?? null : null;
  // resolution_due_at/response_due_at are the canonical columns ticket-system
  // writes today (lib/sla.ts); the sla_* pair is the legacy mirror.
  const responseDue = ticket.response_due_at ?? ticket.sla_first_response_due ?? null;
  const resolutionDue = ticket.resolution_due_at ?? ticket.sla_resolution_due ?? null;
  const firstResponseAt = ticket.first_agent_response_at ?? ticket.first_response_at ?? null;

  let responseStatus: SlaTargetState | null = null;
  if (responseDue) {
    if (firstResponseAt) {
      responseStatus = finishedTargetState(responseDue, firstResponseAt);
    } else {
      // No first response yet: judged live against `now`, so a ticket past its
      // response deadline counts as breached even before ticket-system has
      // written sla_response_breached.
      responseStatus = openTargetState(responseDue, ticket.created_at, now);
      if (ticket.sla_response_breached && responseStatus !== "overdue") responseStatus = "overdue";
    }
  }
  const resolutionStatus: SlaTargetState | null = resolutionDue
    ? openTargetState(resolutionDue, ticket.created_at, now)
    : null;

  const flagged = Boolean(ticket.sla_breached || ticket.sla_response_breached || ticket.sla_resolution_breached);
  const breached = isFailed(responseStatus) || isFailed(resolutionStatus) || flagged;
  const atRisk = !breached && (responseStatus === "at_risk" || resolutionStatus === "at_risk");
  const slaStatus: SlaStatus = breached ? "breached" : atRisk ? "at_risk" : "compliant";

  const createdMs = toTime(ticket.created_at);
  const hasOwner = Boolean(ticket.assigned_to);
  const awaitingApproval = ticket.status === "in_progress" && ticket.review_status === "pending";
  const targets = { responseDue, resolutionDue, responseStatus, resolutionStatus, firstResponseAt };

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
    response_status: responseStatus,
    resolution_status: resolutionStatus,
    response_due_at: responseDue,
    resolution_due_at: resolutionDue,
    first_response_at: firstResponseAt,
    sla_measured: responseDue != null || resolutionDue != null || flagged,
    has_owner: hasOwner,
    review_status: ticket.review_status ?? null,
    awaiting_approval: awaitingApproval,
    age_days: createdMs !== null ? Math.max(0, Math.floor((now.getTime() - createdMs) / DAY_MS)) : null,
    vip_risk: HIGH_PRIORITIES.has(ticket.priority) && slaStatus !== "compliant",
    risk_reason: slaStatus === "compliant" ? null : buildRiskReason(targets, ticket, now),
    required_action:
      slaStatus === "compliant" ? null : buildRequiredAction(slaStatus, targets, hasOwner, awaitingApproval),
    due_at: selectDueAt(targets),
  };
}

type Targets = {
  responseDue: string | null;
  resolutionDue: string | null;
  responseStatus: SlaTargetState | null;
  resolutionStatus: SlaTargetState | null;
  firstResponseAt: string | null;
};

function selectDueAt(t: Targets): string | null {
  if (t.responseDue && isFailed(t.responseStatus)) return t.responseDue;
  if (t.resolutionDue && isFailed(t.resolutionStatus)) return t.resolutionDue;
  const open = [
    t.responseStatus === "at_risk" || t.responseStatus === "running" ? t.responseDue : null,
    t.resolutionStatus === "at_risk" || t.resolutionStatus === "running" ? t.resolutionDue : null,
  ].filter((due): due is string => due !== null);
  if (open.length > 0) return open.sort((a, b) => (toTime(a) ?? 0) - (toTime(b) ?? 0))[0];
  return t.resolutionDue ?? t.responseDue ?? null;
}

/** Positive duration, e.g. "45m", "3h", "2d 4h". Callers choose past/future wording. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

function buildRiskReason(t: Targets, ticket: TicketRow, now: Date): string {
  const nowMs = now.getTime();
  const parts: string[] = [];
  const responseDueMs = toTime(t.responseDue);
  const resolutionDueMs = toTime(t.resolutionDue);
  const firstResponseMs = toTime(t.firstResponseAt);

  if (t.responseStatus === "overdue") {
    parts.push(
      responseDueMs !== null && nowMs > responseDueMs
        ? `First response overdue by ${formatDuration(nowMs - responseDueMs)}`
        : "First response marked breached in the helpdesk"
    );
  } else if (t.responseStatus === "missed" && responseDueMs !== null && firstResponseMs !== null) {
    parts.push(`First response was ${formatDuration(firstResponseMs - responseDueMs)} late`);
  } else if (t.responseStatus === "at_risk" && responseDueMs !== null) {
    parts.push(`First response due in ${formatDuration(responseDueMs - nowMs)}`);
  }

  if (t.resolutionStatus === "overdue" && resolutionDueMs !== null) {
    parts.push(`Resolution overdue by ${formatDuration(nowMs - resolutionDueMs)}`);
  } else if ((t.resolutionStatus === "at_risk" || t.resolutionStatus === "running") && resolutionDueMs !== null) {
    // A running resolution is only worth mentioning next to another problem.
    if (t.resolutionStatus === "at_risk" || parts.length > 0) {
      parts.push(`Resolution due in ${formatDuration(resolutionDueMs - nowMs)}`);
    }
  }

  const computedFailure = isFailed(t.responseStatus) || isFailed(t.resolutionStatus);
  if (!computedFailure) {
    const flags = [
      ticket.sla_resolution_breached ? "resolution" : null,
      ticket.sla_response_breached && t.responseStatus !== "overdue" ? "response" : null,
    ].filter(Boolean);
    if (flags.length > 0) {
      parts.unshift(`Marked SLA breached (${flags.join(" and ")}) in the helpdesk`);
    } else if (ticket.sla_breached) {
      parts.unshift("Marked SLA breached in the helpdesk");
    }
  }

  return parts.length > 0 ? `${parts.join("; ")}.` : "SLA risk detected.";
}

function buildRequiredAction(status: SlaStatus, t: Targets, hasOwner: boolean, awaitingApproval: boolean): string {
  if (awaitingApproval) {
    return status === "breached"
      ? "Admin approval pending — approve or reject today."
      : "Admin approval pending — approve or reject before the SLA window closes.";
  }
  if (status === "breached") {
    if (t.responseStatus === "overdue") {
      return hasOwner ? "Send the first response now and escalate." : "Assign an owner and send the first response now.";
    }
    return "Escalate immediately and notify the account owner.";
  }
  return hasOwner
    ? "Prioritise — act before the SLA window closes."
    : "Assign an owner and respond before the SLA window closes.";
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

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
      const name = row.company_name?.trim();
      if (allowed.has(row.id) && name) result.set(row.id, name);
    }
  }
  return result;
}

/** Grouping key for a company name: NFC, trimmed, collapsed whitespace, case-insensitive. */
export function normalizeCompanyName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function buildCompanySummaries(tickets: SlaAuditTicket[]): CompanySummary[] {
  const groups = new Map<string, { ids: Set<string>; names: Map<string, string>; count: number }>();
  let unassigned = 0;

  for (const ticket of tickets) {
    // Only tickets whose requester has a customers_info company are grouped.
    // Requesters without a company fall back to the single "Unassigned" bucket.
    if (!ticket.company_name || !ticket.customer_profile_id) {
      unassigned += 1;
      continue;
    }
    const key = normalizeCompanyName(ticket.company_name);
    const group = groups.get(key) ?? { ids: new Set<string>(), names: new Map<string, string>(), count: 0 };
    group.ids.add(ticket.customer_profile_id);
    group.names.set(ticket.customer_profile_id, ticket.company_name.normalize("NFC").trim().replace(/\s+/g, " "));
    group.count += 1;
    groups.set(key, group);
  }

  const real = Array.from(groups.values())
    .map((group) => {
      const firstId = Array.from(group.ids).sort(compareCodePoints)[0];
      return { company_id: firstId, company_name: group.names.get(firstId) ?? "", active_ticket_count: group.count };
    })
    .sort(
      (a, b) =>
        compareCodePoints(normalizeCompanyName(a.company_name), normalizeCompanyName(b.company_name)) ||
        compareCodePoints(a.company_id, b.company_id)
    );

  return unassigned > 0 ? [...real, { company_id: null, company_name: "Unassigned", active_ticket_count: unassigned }] : real;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

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
