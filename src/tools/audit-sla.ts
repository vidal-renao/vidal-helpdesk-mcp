import { z } from "zod";
import { executeComposioTool, parseComposioPayload } from "../lib/composio.js";
import { auditRunsTable, formatSupabaseError } from "../lib/audit-runs.js";
import { getSupabaseClient } from "../lib/supabase.js";
import { generateSolution } from "../lib/ai.js";
import { writeAuditLog } from "../lib/audit-log.js";
import { ticketMetadataEnabled } from "../lib/schema-capabilities.js";
import {
  getOrganizationVipConfig,
  decideVipPriority,
  computeSlaState,
  buildVipMetadata,
} from "../lib/vip.js";

export const auditSlaSchema = z.object({
  organizationId: z.string().uuid().optional().describe("Organization UUID to audit. Defaults to MCP_ORGANIZATION_ID."),
  riskWindowHours: z.number().min(0.5).max(24).default(4).describe("Hours ahead to treat standard tickets as at risk."),
  overdueThresholdHours: z.number().min(1).max(168).default(24).describe("Hours after which a standard open ticket is considered overdue."),
  escalationThresholdHours: z.number().min(1).max(336).default(48).describe("Hours after which an overdue standard ticket is escalated to the admin."),
  notifyEmail: z.boolean().default(true).describe("Send Gmail alert when findings exist."),
  createGithubIssue: z.boolean().default(false).describe("Create a GitHub issue for repeated technical patterns."),
  minRepeatedTicketsForIssue: z.number().int().min(2).max(25).default(3).describe("Minimum repeated tickets in a category before opening a GitHub issue."),
  dryRun: z.boolean().default(false).describe("Prepare the audit report without sending Gmail or GitHub actions."),
  includeRca: z.boolean().default(true).describe("Try to enrich overdue tickets with a possible technical root cause."),
  prepareWebhookPayloads: z.boolean().default(true).describe("Prepare webhook payloads for urgent or critical tickets when configured."),
});

type AuditSlaInput = z.infer<typeof auditSlaSchema>;

type AuditTicketRow = {
  id: string;
  organization_id: string;
  ticket_number: number;
  priority: string;
  status: string;
  assigned_to: string | null;
  created_at: string;
  ticket_age_hours: number | string;
  category_name: string | null;
};

type TicketDetails = {
  id: string;
  ticket_number: number;
  title: string;
  description: string;
  priority: string;
  status: string;
  detected_language: string | null;
  category_id: string | null;
  category_name: string | null;
  assigned_to: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

type EnrichedAuditTicket = {
  id: string;
  ref: string;
  title: string;
  priority: string;
  priority_label: string;
  status: string;
  sla_status: "at_risk" | "overdue";
  created_at: string;
  ticket_age_hours: number;
  category_name: string | null;
  suggested_response: string;
  possible_root_cause: string | null;
  external_context: string[];
  escalation_applied: boolean;
  webhook_payload: Record<string, unknown> | null;
  vip: boolean;
  vip_reason: string | null;
  assigned_to: string | null;
};

type AuditRunRecord = {
  fingerprint: string;
  findings_count: number;
};

export async function auditSlaTickets(input: AuditSlaInput): Promise<string> {
  const organizationId = sanitizeUuid(
    input.organizationId ?? process.env.MCP_ORGANIZATION_ID,
    "organizationId"
  );
  const supabase = getSupabaseClient();
  const organizationVip = await getOrganizationVipConfig(supabase, organizationId);
  const organizationLabel =
    organizationVip.organizationSlug || organizationVip.organizationName || organizationId;

  writeAuditLog("INFO", "Starting SLA audit", {
    organizationId,
    organizationLabel,
    vip: organizationVip.isVip,
    riskWindowHours: input.riskWindowHours,
    overdueThresholdHours: input.overdueThresholdHours,
    escalationThresholdHours: input.escalationThresholdHours,
    dryRun: input.dryRun,
  });

  const rows = await runAuditQuery(
    buildAuditQuery(organizationId, Math.min(input.riskWindowHours, Number(process.env.VIP_RISK_WINDOW_HOURS ?? 0.5)))
  );

  const enrichmentResults = await Promise.allSettled(
    rows.map((row) =>
      enrichTicket({
        row,
        organizationId,
        riskWindowHours: input.riskWindowHours,
        overdueThresholdHours: input.overdueThresholdHours,
        escalationThresholdHours: input.escalationThresholdHours,
        includeRca: input.includeRca,
        prepareWebhookPayloads: input.prepareWebhookPayloads,
        dryRun: input.dryRun,
        organizationVip,
      })
    )
  );

  const enrichedTickets = enrichmentResults.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    writeAuditLog("ERROR", "Skipping ticket after enrichment failure", {
      ticketId: rows[index]?.id,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    return [];
  }).filter(isEnrichedAuditTicket);

  const overdue = enrichedTickets.filter((ticket) => ticket.sla_status === "overdue");
  const atRisk = enrichedTickets.filter((ticket) => ticket.sla_status === "at_risk");
  const vipFindings = enrichedTickets.filter((ticket) => ticket.vip);
  const overallSeverity = deriveOverallSeverity(enrichedTickets);
  const fingerprint = buildFingerprint(enrichedTickets, overallSeverity);
  const previousRun = await loadLastAuditRun(organizationId);
  const changedSinceLastRun = previousRun?.fingerprint !== fingerprint;
  const vipAlwaysNotify = process.env.AUDIT_VIP_ALWAYS_NOTIFY !== "false";
  const hasVipFindings = vipFindings.length > 0;
  const shouldNotifyBasedOnChange =
    changedSinceLastRun ||
    process.env.AUDIT_ALWAYS_NOTIFY === "true" ||
    (vipAlwaysNotify && hasVipFindings);
  const shouldCreateGithubIssueBasedOnChange =
    changedSinceLastRun ||
    process.env.AUDIT_ALWAYS_NOTIFY === "true" ||
    process.env.AUDIT_VIP_ALWAYS_CREATE_GITHUB_ISSUE === "true";
  const shouldNotify = enrichedTickets.length > 0 && input.notifyEmail && !input.dryRun && shouldNotifyBasedOnChange;
  const shouldCreateIssue =
    enrichedTickets.length > 0 && input.createGithubIssue && !input.dryRun && shouldCreateGithubIssueBasedOnChange;
  const shouldPrepareWebhookPayloads =
    input.prepareWebhookPayloads && Boolean(process.env.AUDIT_SLACK_WEBHOOK_URL);

  let emailResult: string | null = null;
  if (shouldNotify) {
    emailResult = await sendAuditEmail({
      organizationLabel,
      overallSeverity,
      riskWindowHours: input.riskWindowHours,
      overdueThresholdHours: input.overdueThresholdHours,
      overdue,
      atRisk,
      vipFindings,
    });
  } else if (enrichedTickets.length > 0 && !shouldNotifyBasedOnChange) {
    emailResult = "suppressed: no change since previous audit run";
  }

  let githubResult: string | null = null;
  if (shouldCreateIssue) {
    githubResult = await maybeCreateGithubIssue({
      organizationLabel,
      overallSeverity,
      rows: enrichedTickets,
      minRepeatedTicketsForIssue: input.minRepeatedTicketsForIssue,
    });
  } else if (enrichedTickets.length > 0 && !shouldCreateGithubIssueBasedOnChange) {
    githubResult = "suppressed: no change since previous audit run";
  }

  const webhookPayloads = shouldPrepareWebhookPayloads
    ? (enrichedTickets
        .map((ticket) => ticket.webhook_payload)
        .filter(Boolean) as Record<string, unknown>[])
    : [];

  if (!input.dryRun) {
    await persistAuditRun({
      organizationId,
      fingerprint,
      overallSeverity,
      findingsCount: enrichedTickets.length,
      payload: {
        summary: `${organizationLabel}: ${overdue.length} overdue, ${atRisk.length} at risk`,
        vip_findings: vipFindings.length,
        email: emailResult,
        github: githubResult,
      },
    });
  }

  const response = {
    success: true,
    organizationId,
    organizationLabel,
    overallSeverity,
    changed_since_last_run: changedSinceLastRun,
    queriedWith: {
      tool: process.env.COMPOSIO_SUPABASE_TOOL ?? "SUPABASE_BETA_RUN_SQL_QUERY",
      riskWindowHours: input.riskWindowHours,
      overdueThresholdHours: input.overdueThresholdHours,
      escalationThresholdHours: input.escalationThresholdHours,
      includeRca: input.includeRca,
      prepareWebhookPayloads: input.prepareWebhookPayloads,
      vipResponseHours: organizationVip.immediateResponseHours,
      vipEscalationHours: organizationVip.immediateEscalationHours,
    },
    counts: {
      total: enrichedTickets.length,
      overdue: overdue.length,
      at_risk: atRisk.length,
      vip: vipFindings.length,
      urgent_or_critical: enrichedTickets.filter((ticket) => ticket.priority === "high" || ticket.priority === "critical").length,
      escalated: enrichedTickets.filter((ticket) => ticket.escalation_applied).length,
    },
    notifications: {
      email: emailResult,
      github: githubResult,
      webhook_payloads_prepared: webhookPayloads.length,
    },
    summary: `${organizationLabel}: ${overdue.length} overdue, ${atRisk.length} at risk`,
    tickets: enrichedTickets,
  };

  writeAuditLog("INFO", "Completed SLA audit", {
    organizationId,
    total: enrichedTickets.length,
    overdue: overdue.length,
    atRisk: atRisk.length,
    vip: vipFindings.length,
    overallSeverity,
  });

  return JSON.stringify(response, null, 2);
}

async function enrichTicket(input: {
  row: AuditTicketRow;
  organizationId: string;
  riskWindowHours: number;
  overdueThresholdHours: number;
  escalationThresholdHours: number;
  includeRca: boolean;
  prepareWebhookPayloads: boolean;
  dryRun: boolean;
  organizationVip: Awaited<ReturnType<typeof getOrganizationVipConfig>>;
}): Promise<EnrichedAuditTicket | null> {
  const details = await getTicketDetails(input.row.id, input.organizationId);
  const requesterEmail = readRequesterEmail(details.metadata);
  const vipDecision = decideVipPriority({
    organizationVip: input.organizationVip,
    requesterEmail,
    currentPriority: normalizePriority(details.priority),
  });
  const ageHours = Number(input.row.ticket_age_hours);
  const slaState = computeSlaState({
    ageHours,
    assignedTo: details.assigned_to,
    isVip: vipDecision.isVip,
    normalRiskHours: input.riskWindowHours,
    normalOverdueHours: input.overdueThresholdHours,
  });

  if (slaState === "on_time") return null;

  const [rca, noteResult] = await Promise.all([
    input.includeRca && slaState === "overdue"
      ? detectPossibleRootCause(details)
      : Promise.resolve({ summary: null, evidence: [] }),
    generateAndStoreSuggestedResponse(details, input.dryRun, vipDecision),
  ]);

  const shouldEscalate =
    vipDecision.isVip && !details.assigned_to && ageHours >= input.organizationVip.immediateEscalationHours
      ? true
      : slaState === "overdue" && ageHours >= input.escalationThresholdHours;

  let escalationApplied = false;
  if (shouldEscalate && !input.dryRun) {
    escalationApplied = await escalateTicket(details.id, {
      vip: vipDecision.isVip,
      reason: vipDecision.reason,
      priorityLabel: vipDecision.priorityLabel,
      metadata: details.metadata,
    });
  }

  const webhookPayload =
    input.prepareWebhookPayloads &&
    vipDecision.isVip &&
    process.env.AUDIT_SLACK_WEBHOOK_URL
      ? buildWebhookPayload(details, slaState, ageHours, vipDecision, rca.summary)
      : null;

  return {
    id: details.id,
    ref: formatTicketRef(details.ticket_number),
    title: details.title,
    priority: vipDecision.isVip ? "critical" : details.priority,
    priority_label: vipDecision.priorityLabel,
    status: details.status,
    sla_status: slaState,
    created_at: details.created_at,
    ticket_age_hours: ageHours,
    category_name: details.category_name,
    suggested_response: noteResult.suggestedResponse,
    possible_root_cause: rca.summary,
    external_context: rca.evidence,
    escalation_applied: escalationApplied,
    webhook_payload: webhookPayload,
    vip: vipDecision.isVip,
    vip_reason: vipDecision.reason,
    assigned_to: details.assigned_to,
  };
}

async function getTicketDetails(ticketId: string, organizationId: string): Promise<TicketDetails> {
  const supabase = getSupabaseClient();
  const selectClause = ticketMetadataEnabled()
    ? "id, ticket_number, title, description, priority, status, detected_language, category_id, assigned_to, created_at, metadata"
    : "id, ticket_number, title, description, priority, status, detected_language, category_id, assigned_to, created_at";
  const { data, error }: { data: any; error: any } = await supabase
    .from("tickets")
    .select(selectClause)
    .eq("organization_id", organizationId)
    .eq("id", ticketId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to fetch ticket details for ${ticketId}`);
  }

  let categoryName: string | null = null;
  if (data.category_id) {
    const { data: category } = await supabase
      .from("categories")
      .select("name")
      .eq("id", data.category_id)
      .maybeSingle();
    categoryName = category?.name ?? null;
  }

  return {
    id: data.id,
    ticket_number: data.ticket_number,
    title: data.title,
    description: data.description ?? "",
    priority: data.priority,
    status: data.status,
    detected_language: data.detected_language ?? null,
    category_id: data.category_id,
    category_name: categoryName,
    assigned_to: data.assigned_to,
    created_at: data.created_at,
    metadata: ticketMetadataEnabled() ? parseMetadata((data as { metadata?: unknown }).metadata as Record<string, unknown> | string | null | undefined) : null,
  };
}

async function detectPossibleRootCause(details: TicketDetails): Promise<{
  summary: string | null;
  evidence: string[];
}> {
  const githubSearchTool =
    process.env.COMPOSIO_GITHUB_SEARCH_TOOL ?? "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS";
  const connectedAccountId = process.env.COMPOSIO_GITHUB_CONNECTED_ACCOUNT_ID ?? "";
  const queries = [
    `${details.title} ${details.category_name ?? ""}`.trim(),
    `${details.description.slice(0, 120)} ${details.category_name ?? ""}`.trim(),
  ].filter(Boolean);
  const evidence: string[] = [];

  for (const query of queries.slice(0, 2)) {
    try {
      const result = await executeComposioTool({
        toolSlug: githubSearchTool,
        arguments: { query },
        connectedAccountId,
        retries: 2,
      });
      const serialized = JSON.stringify(result);
      if (serialized) evidence.push(serialized.slice(0, 400));
    } catch (error) {
      writeAuditLog("WARN", "GitHub RCA lookup failed", {
        ticketId: details.id,
        query,
        error: String(error),
      });
    }
  }

  if (evidence.length > 0) {
    return {
      summary: `Possible repeated technical pattern detected via GitHub context for "${details.title}".`,
      evidence,
    };
  }

  if (details.category_name) {
    return {
      summary: `Potential root cause appears related to ${details.category_name.toLowerCase()} based on ticket content and age.`,
      evidence,
    };
  }

  return { summary: null, evidence };
}

async function generateAndStoreSuggestedResponse(
  details: TicketDetails,
  dryRun: boolean,
  vipDecision: ReturnType<typeof decideVipPriority>
): Promise<{ suggestedResponse: string }> {
  const solution = await generateSolution(
    details.title,
    details.description,
    vipDecision.priority,
    details.category_name ?? "Other",
    normalizeLanguage(details.detected_language)
  );

  const lines = [
    `AI technical suggestion for ${formatTicketRef(details.ticket_number)}`,
    "",
    `Priority label: ${vipDecision.priorityLabel}`,
    `VIP handling: ${vipDecision.isVip ? `yes (${vipDecision.reason ?? "policy matched"})` : "no"}`,
    "",
    solution.solution,
    "",
    "Recommended steps:",
    ...solution.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `Confidence: ${solution.confidence}`,
  ];
  const suggestedResponse = lines.join("\n");

  if (!dryRun) {
    await saveInternalNote(details.id, suggestedResponse);
  }

  return { suggestedResponse };
}

async function saveInternalNote(ticketId: string, content: string) {
  const supabaseRef = deriveSupabaseRef();
  const toolSlug = process.env.COMPOSIO_SUPABASE_TOOL ?? "SUPABASE_BETA_RUN_SQL_QUERY";
  const connectedAccountId = process.env.COMPOSIO_SUPABASE_CONNECTED_ACCOUNT_ID ?? "";
  const tableName = process.env.AUDIT_INTERNAL_NOTES_TABLE?.trim() || "ticket_comments";
  const agentId = process.env.MCP_AGENT_ID!;
  const sql =
    tableName === "internal_notes"
      ? `INSERT INTO internal_notes (ticket_id, author_id, content, note_type, created_at)
         VALUES ('${ticketId}', '${agentId}', ${toSqlString(content)}, 'ai_suggestion', NOW());`
      : `INSERT INTO ticket_comments (ticket_id, author_id, content, is_internal, is_ai_generated, created_at)
         VALUES ('${ticketId}', '${agentId}', ${toSqlString(content)}, TRUE, TRUE, NOW());`;

  await executeComposioTool({
    toolSlug,
    arguments: { ref: supabaseRef, query: sql },
    connectedAccountId,
    retries: 2,
  });
}

async function escalateTicket(
  ticketId: string,
  input: {
    vip: boolean;
    reason: string | null;
    priorityLabel: string;
    metadata: Record<string, unknown> | null;
  }
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const adminId = process.env.MCP_AGENT_ID!;
  const updatePayload: Record<string, unknown> = {
    priority: "critical",
    assigned_to: adminId,
  };
  if (ticketMetadataEnabled()) {
    updatePayload.metadata = {
      ...(input.metadata ?? {}),
      ...buildVipMetadata({
        isVip: input.vip,
        reason: input.reason,
        priorityLabel: input.priorityLabel as "emergency" | "low" | "medium" | "high" | "critical",
      }),
      autonomous_escalation: {
        at: new Date().toISOString(),
        assigned_to: adminId,
      },
    };
  }
  const { error } = await supabase
    .from("tickets")
    .update(updatePayload)
    .eq("id", ticketId);

  if (error) {
    writeAuditLog("ERROR", "Failed to escalate ticket", {
      ticketId,
      error: error.message,
    });
    return false;
  }

  await supabase.from("ticket_comments").insert({
    ticket_id: ticketId,
    author_id: adminId,
    content:
      input.vip
        ? "**VIP autonomous escalation applied**\n\nTicket exceeded the 1h VIP response window without assignment and was escalated to the MCP admin owner."
        : "**Autonomous escalation applied**\n\nTicket exceeded the standard overdue threshold and was escalated to the MCP admin owner.",
    is_internal: true,
    is_ai_generated: true,
  });

  return true;
}

async function sendAuditEmail(input: {
  organizationLabel: string;
  overallSeverity: "info" | "warning" | "critical";
  riskWindowHours: number;
  overdueThresholdHours: number;
  overdue: EnrichedAuditTicket[];
  atRisk: EnrichedAuditTicket[];
  vipFindings: EnrichedAuditTicket[];
}): Promise<string> {
  const to = process.env.AUDIT_EMAIL_TO;
  if (!to) return "skipped: AUDIT_EMAIL_TO not configured";

  const connectedAccountId = process.env.COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID ?? "";
  const subject = input.vipFindings.length > 0
    ? `[VIP-URGENT] ${input.organizationLabel} - ${input.vipFindings.length} VIP findings`
    : `${process.env.AUDIT_EMAIL_SUBJECT_PREFIX?.trim() || "[VIDAL Helpdesk Audit]"} ${input.organizationLabel} - ${input.overdue.length} overdue / ${input.atRisk.length} at risk`;

  await executeComposioTool({
    toolSlug: process.env.COMPOSIO_GMAIL_TOOL ?? "GMAIL_SEND_EMAIL",
    arguments: {
      recipient_email: to,
      subject,
      body: buildEmailBody(input),
      is_html: false,
    },
    connectedAccountId,
    retries: 3,
  });

  return `sent to ${to}`;
}

async function maybeCreateGithubIssue(input: {
  organizationLabel: string;
  overallSeverity: "info" | "warning" | "critical";
  rows: EnrichedAuditTicket[];
  minRepeatedTicketsForIssue: number;
}): Promise<string> {
  const repository = process.env.AUDIT_GITHUB_REPOSITORY;
  if (!repository) return "skipped: AUDIT_GITHUB_REPOSITORY not configured";

  const repeated = Object.entries(groupByCategory(input.rows))
    .filter(([, count]) => count >= input.minRepeatedTicketsForIssue)
    .sort((a, b) => b[1] - a[1]);
  const vipRows = input.rows.filter((row) => row.vip);

  if (repeated.length === 0 && vipRows.length === 0) {
    return "skipped: no repeated technical pattern or VIP findings";
  }

  const [owner, repo] = repository.split("/");
  const labels = vipRows.length > 0
    ? ["internal-audit", "sla", "high-priority"]
    : ["internal-audit", "sla"];

  const body = [
    `Organization: ${input.organizationLabel}`,
    `Overall severity: ${input.overallSeverity}`,
    "",
    "VIP findings:",
    ...(vipRows.length > 0
      ? vipRows.map((row) => `- ${row.ref} | ${row.sla_status} | ${row.priority_label}`)
      : ["- none"]),
    "",
    "Repeated categories:",
    ...(repeated.length > 0
      ? repeated.map(([category, count]) => `- ${category}: ${count}`)
      : ["- none"]),
    "",
    "No requester PII or ticket descriptions included.",
  ].join("\n");

  await executeComposioTool({
    toolSlug: process.env.COMPOSIO_GITHUB_CREATE_ISSUE_TOOL ?? "GITHUB_CREATE_AN_ISSUE",
    arguments: {
      owner,
      repo,
      title: vipRows.length > 0
        ? `VIP Internal Issue: ${input.organizationLabel} requires urgent attention`
        : `Internal Issue: SLA findings for ${input.organizationLabel}`,
      body,
      labels,
    },
    connectedAccountId: process.env.COMPOSIO_GITHUB_CONNECTED_ACCOUNT_ID ?? "",
    retries: 3,
  });

  return `created in ${repository}`;
}

function buildEmailBody(input: {
  organizationLabel: string;
  overallSeverity: "info" | "warning" | "critical";
  riskWindowHours: number;
  overdueThresholdHours: number;
  overdue: EnrichedAuditTicket[];
  atRisk: EnrichedAuditTicket[];
  vipFindings: EnrichedAuditTicket[];
}): string {
  const lines = [
    "Automated SLA audit summary",
    `Organization: ${input.organizationLabel}`,
    `Generated at (UTC): ${new Date().toISOString()}`,
    `At-risk threshold: ${input.riskWindowHours}h open`,
    `Overdue threshold: ${input.overdueThresholdHours}h open`,
    `Overall severity: ${input.overallSeverity}`,
    "",
    "Executive summary:",
    `- Overdue: ${input.overdue.length}`,
    `- At risk: ${input.atRisk.length}`,
    `- VIP findings: ${input.vipFindings.length}`,
    `- Total findings: ${input.overdue.length + input.atRisk.length}`,
  ];

  if (input.vipFindings.length > 0) {
    lines.push("", "VIP findings:");
    for (const row of input.vipFindings) {
      lines.push(formatTicketLine(row));
    }
  }

  if (input.overdue.length > 0) {
    lines.push("", "Overdue tickets:");
    for (const row of input.overdue) {
      lines.push(formatTicketLine(row));
      if (row.possible_root_cause) {
        lines.push(`  Possible technical cause detected: ${row.possible_root_cause}`);
      }
    }
  }

  if (input.atRisk.length > 0) {
    lines.push("", "At-risk tickets:");
    for (const row of input.atRisk) {
      lines.push(formatTicketLine(row));
    }
  }

  lines.push("");
  lines.push("No requester names, descriptions, emails, or message content included.");
  lines.push("Generated by vidal-helpdesk-mcp SLA auditor.");
  return lines.join("\n");
}

async function loadLastAuditRun(organizationId: string): Promise<AuditRunRecord | null> {
  const { data, error } = await auditRunsTable()
    .select("fingerprint, findings_count")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    writeAuditLog("WARN", "audit_runs table unavailable or unreadable", {
      organizationId,
      error: formatSupabaseError(error),
    });
    return null;
  }

  return data ?? null;
}

async function persistAuditRun(input: {
  organizationId: string;
  fingerprint: string;
  overallSeverity: string;
  findingsCount: number;
  payload: Record<string, unknown>;
}) {
  const { error } = await auditRunsTable().insert({
    organization_id: input.organizationId,
    fingerprint: input.fingerprint,
    overall_severity: input.overallSeverity,
    findings_count: input.findingsCount,
    payload: input.payload,
  });

  if (error) {
    writeAuditLog("WARN", "Unable to persist audit run", {
      organizationId: input.organizationId,
      error: formatSupabaseError(error),
    });
  }
}

async function runAuditQuery(sql: string): Promise<AuditTicketRow[]> {
  const result = await executeComposioTool({
    toolSlug: process.env.COMPOSIO_SUPABASE_TOOL ?? "SUPABASE_BETA_RUN_SQL_QUERY",
    arguments: { ref: deriveSupabaseRef(), query: sql },
    connectedAccountId: process.env.COMPOSIO_SUPABASE_CONNECTED_ACCOUNT_ID ?? "",
    retries: 3,
  });
  return extractRows(result);
}

function buildAuditQuery(organizationId: string, minimumHours: number): string {
  return `
WITH scoped AS (
  SELECT
    t.id,
    t.organization_id,
    t.ticket_number,
    t.priority,
    t.status,
    t.assigned_to,
    t.created_at,
    ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600.0, 2) AS ticket_age_hours,
    COALESCE(c.name, 'Unclassified') AS category_name
  FROM tickets t
  LEFT JOIN categories c ON c.id = t.category_id
  WHERE t.organization_id = '${organizationId}'
    AND t.status = 'open'
    AND t.created_at <= NOW() - INTERVAL '${minimumHours} hours'
)
SELECT
  id,
  organization_id,
  ticket_number,
  priority,
  status,
  assigned_to,
  created_at,
  ticket_age_hours,
  category_name
FROM scoped
ORDER BY created_at ASC;
  `.trim();
}

function extractRows(payload: unknown): AuditTicketRow[] {
  const parsed = parseComposioPayload<Record<string, unknown> | AuditTicketRow[]>(payload);
  if (Array.isArray(parsed)) return parsed as AuditTicketRow[];
  if (!parsed || typeof parsed !== "object") return [];
  const candidates = [parsed.rows, parsed.data, parsed.result, parsed.results, parsed.records];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as AuditTicketRow[];
    if (typeof candidate === "string") {
      const nested = parseComposioPayload(candidate);
      if (Array.isArray(nested)) return nested as AuditTicketRow[];
    }
  }
  return [];
}

function parseMetadata(
  metadata: Record<string, unknown> | string | null | undefined
): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return metadata;
}

function deriveSupabaseRef(): string {
  const ref = process.env.SUPABASE_URL?.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co/i)?.[1];
  if (!ref) throw new Error("Could not derive Supabase project ref from SUPABASE_URL");
  return ref;
}

function readRequesterEmail(metadata: Record<string, unknown> | null): string | null {
  const value = metadata?.requester_email;
  return typeof value === "string" && value.includes("@") ? value.trim().toLowerCase() : null;
}

function buildWebhookPayload(
  details: TicketDetails,
  slaStatus: "at_risk" | "overdue",
  ageHours: number,
  vipDecision: ReturnType<typeof decideVipPriority>,
  possibleRootCause: string | null
): Record<string, unknown> {
  return {
    channel: "incident-escalation",
    severity: vipDecision.isVip ? "critical" : slaStatus === "overdue" ? "warning" : "info",
    ticket_ref: formatTicketRef(details.ticket_number),
    title: details.title,
    priority_label: vipDecision.priorityLabel,
    sla_status: slaStatus,
    age_hours: ageHours,
    vip: vipDecision.isVip,
    vip_reason: vipDecision.reason,
    possible_root_cause: possibleRootCause,
  };
}

function deriveOverallSeverity(rows: EnrichedAuditTicket[]): "info" | "warning" | "critical" {
  if (rows.some((row) => row.vip || row.ticket_age_hours >= Number(process.env.AUDIT_ESCALATION_THRESHOLD_HOURS ?? 48))) {
    return "critical";
  }
  if (rows.some((row) => row.sla_status === "overdue")) {
    return "warning";
  }
  return "info";
}

function buildFingerprint(
  rows: EnrichedAuditTicket[],
  severity: "info" | "warning" | "critical"
): string {
  return [
    severity,
    ...rows
      .map((row) => `${row.ref}:${row.sla_status}:${row.priority_label}:${row.vip ? "vip" : "std"}:${row.assigned_to ?? "unassigned"}`)
      .sort(),
  ].join("|");
}

function groupByCategory(rows: Array<{ category_name: string | null }>): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.category_name?.trim() || "Unclassified";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function formatTicketLine(row: EnrichedAuditTicket): string {
  const vipTag = row.vip ? " | vip=yes" : "";
  return `- ${row.ref} | ${row.sla_status} | ${row.priority_label} | ${row.status} | age=${row.ticket_age_hours.toFixed(2)}h | category=${row.category_name ?? "Unclassified"}${vipTag}`;
}

function formatTicketRef(ticketNumber: number): string {
  return `TK-${String(ticketNumber).padStart(4, "0")}`;
}

function normalizeLanguage(value: string | null): "de" | "en" | "es" | "fr" | "it" {
  return value === "de" || value === "en" || value === "es" || value === "fr" || value === "it"
    ? value
    : "en";
}

function normalizePriority(value: string): "low" | "medium" | "high" | "critical" {
  return value === "low" || value === "medium" || value === "high" || value === "critical"
    ? value
    : "medium";
}

function isEnrichedAuditTicket(
  ticket: EnrichedAuditTicket | null
): ticket is EnrichedAuditTicket {
  return ticket !== null;
}

function sanitizeUuid(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(trimmed)) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}

function toSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
