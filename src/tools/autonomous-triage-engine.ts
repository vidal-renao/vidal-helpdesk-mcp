import { z } from "zod";
import { getSupabaseClient, resolveCategoryId } from "../lib/supabase.js";
import { triageTicket, generateSolution } from "../lib/ai.js";
import { executeComposioTool } from "../lib/composio.js";
import { ticketMetadataEnabled } from "../lib/schema-capabilities.js";
import {
  getOrganizationVipConfig,
  decideVipPriority,
  buildVipMetadata,
} from "../lib/vip.js";
import { writeAuditLog } from "../lib/audit-log.js";

export const autonomousTriageEngineSchema = z.object({
  ticket_ref: z.string().describe('Ticket ref like "TK-1001" or UUID'),
  additional_context: z.string().optional().describe("Additional operator context to include in the analysis."),
  persistInternalNote: z.boolean().default(true).describe("Store the generated suggestion as an internal note."),
  includeRepoLookup: z.boolean().default(true).describe("Use GitHub context lookup to enrich the technical suggestion."),
});

type AutonomousTriageEngineInput = z.infer<typeof autonomousTriageEngineSchema>;

type TicketRow = {
  id: string;
  ticket_number: number;
  organization_id: string;
  category_id: string | null;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  status: string;
  detected_language: string | null;
  assigned_to: string | null;
  metadata: Record<string, unknown> | null;
};

export async function autonomousTriageEngine(
  input: AutonomousTriageEngineInput
): Promise<string> {
  const supabase = getSupabaseClient();
  const ticket = await resolveTicket(input.ticket_ref);
  const organizationVip = await getOrganizationVipConfig(supabase, ticket.organization_id);
  const requesterEmail = readRequesterEmail(ticket.metadata);
  const vipDecision = decideVipPriority({
    organizationVip,
    requesterEmail,
    currentPriority: ticket.priority,
  });

  const enrichedDescription = input.additional_context
    ? `${ticket.description}\n\nOperational context:\n${input.additional_context}`
    : ticket.description;

  const triage = await triageTicket(ticket.title, enrichedDescription);
  const categoryId = await resolveCategoryId(
    supabase,
    ticket.organization_id,
    triage.suggested_category
  );
  const repoContext = input.includeRepoLookup
    ? await lookupRepositoryContext(ticket.title, triage.suggested_category)
    : [];
  const solution = await generateSolution(
    ticket.title,
    enrichedDescription,
    vipDecision.priority,
    triage.suggested_category,
    normalizeLanguage(triage.detected_language)
  );
  const technicalProposal = buildTechnicalProposal({
    ticketRef: formatTicketRef(ticket.ticket_number),
    triage,
    solution,
    repoContext,
    vipDecision,
  });

  const nextPriority =
    vipDecision.isVip || triage.confidence_score >= 60 ? vipDecision.priority : ticket.priority;

  const updatePayload: Record<string, unknown> = {
    priority: nextPriority,
    category_id: categoryId ?? ticket.category_id,
    detected_language: triage.detected_language,
    contains_pii: triage.contains_pii,
    tags: triage.keywords.slice(0, 5),
  };
  if (ticketMetadataEnabled()) {
    updatePayload.metadata = {
      ...(ticket.metadata ?? {}),
      autonomous_triage: {
        last_run_at: new Date().toISOString(),
        vip: vipDecision.isVip,
        vip_reason: vipDecision.reason,
        repo_context_count: repoContext.length,
      },
      ...buildVipMetadata({
        isVip: vipDecision.isVip,
        reason: vipDecision.reason,
        priorityLabel: vipDecision.priorityLabel,
        requesterEmail,
      }),
    };
  }

  await supabase
    .from("tickets")
    .update(updatePayload)
    .eq("id", ticket.id);

  await supabase.from("ai_analysis").upsert(
    {
      ticket_id: ticket.id,
      suggested_category: triage.suggested_category,
      suggested_priority: vipDecision.priority,
      confidence_score: triage.confidence_score,
      summary: triage.summary,
      sentiment: triage.sentiment,
      keywords: triage.keywords,
      detected_language: triage.detected_language,
      contains_pii_detected: triage.contains_pii,
      smart_response: triage.smart_response,
      estimated_resolution_hours: triage.estimated_resolution_hours,
      reasoning: triage.reasoning,
      model_used: triage.model_used,
      input_tokens: triage.input_tokens,
      output_tokens: triage.output_tokens,
      processing_time_ms: triage.processing_time_ms,
      raw_response: {
        ...triage,
        vip_priority_label: vipDecision.priorityLabel,
        repo_context: repoContext,
      },
    },
    { onConflict: "ticket_id" }
  );

  if (input.persistInternalNote) {
    await supabase.from("ticket_comments").insert({
      ticket_id: ticket.id,
      author_id: process.env.MCP_AGENT_ID!,
      content: technicalProposal,
      is_internal: true,
      is_ai_generated: true,
    });
  }

  writeAuditLog("INFO", "Autonomous triage executed", {
    ticketId: ticket.id,
    vip: vipDecision.isVip,
    priority: nextPriority,
    repoContextCount: repoContext.length,
  });

  return JSON.stringify(
    {
      success: true,
      ticket_ref: formatTicketRef(ticket.ticket_number),
      ticket_id: ticket.id,
      sentiment: triage.sentiment,
      detected_language: triage.detected_language,
      suggested_category: triage.suggested_category,
      applied_priority: nextPriority,
      priority_label: vipDecision.priorityLabel,
      vip: vipDecision.isVip,
      vip_reason: vipDecision.reason,
      repo_context_count: repoContext.length,
      internal_note_saved: input.persistInternalNote,
      technical_proposal: technicalProposal,
    },
    null,
    2
  );
}

async function resolveTicket(ticketRef: string): Promise<TicketRow> {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;
  const selectClause = ticketMetadataEnabled()
    ? "id, ticket_number, organization_id, category_id, title, description, priority, status, detected_language, assigned_to, metadata"
    : "id, ticket_number, organization_id, category_id, title, description, priority, status, detected_language, assigned_to";

  let query = supabase
    .from("tickets")
    .select(selectClause)
    .eq("organization_id", organizationId);

  if (/^[0-9a-f-]{36}$/i.test(ticketRef)) {
    query = query.eq("id", ticketRef);
  } else {
    const numericRef = parseInt(ticketRef.replace(/^TK-?0*/i, ""), 10);
    query = query.eq("ticket_number", numericRef);
  }

  const { data, error } = await query.single<TicketRow>();
  if (error || !data) {
    throw new Error(`Ticket ${ticketRef} not found`);
  }
  return {
    ...data,
    metadata: ticketMetadataEnabled()
      ? ((data as { metadata?: Record<string, unknown> | null }).metadata ?? null)
      : null,
  };
}

async function lookupRepositoryContext(
  title: string,
  category: string
): Promise<string[]> {
  const toolSlug =
    process.env.COMPOSIO_GITHUB_CODE_SEARCH_TOOL ??
    process.env.COMPOSIO_GITHUB_SEARCH_TOOL ??
    "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS";
  const connectedAccountId = process.env.COMPOSIO_GITHUB_CONNECTED_ACCOUNT_ID ?? "";
  const query = `${title} ${category}`.trim();

  try {
    const result = await executeComposioTool({
      toolSlug,
      arguments: { query },
      connectedAccountId,
      retries: 2,
    });
    const serialized = JSON.stringify(result);
    return serialized ? [serialized.slice(0, 600)] : [];
  } catch (error) {
    writeAuditLog("WARN", "Repository context lookup failed", {
      toolSlug,
      error: String(error),
    });
    return [];
  }
}

function buildTechnicalProposal(input: {
  ticketRef: string;
  triage: Awaited<ReturnType<typeof triageTicket>>;
  solution: Awaited<ReturnType<typeof generateSolution>>;
  repoContext: string[];
  vipDecision: ReturnType<typeof decideVipPriority>;
}): string {
  const lines = [
    `Autonomous triage for ${input.ticketRef}`,
    "",
    `Category: ${input.triage.suggested_category}`,
    `Sentiment: ${input.triage.sentiment}`,
    `Detected language: ${input.triage.detected_language}`,
    `Applied priority: ${input.vipDecision.priorityLabel}`,
    `VIP: ${input.vipDecision.isVip ? `yes (${input.vipDecision.reason ?? "policy matched"})` : "no"}`,
    "",
    `Summary: ${input.triage.summary}`,
    "",
    `Suggested technical response: ${input.solution.solution}`,
    "",
    "Recommended steps:",
    ...input.solution.steps.map((step, index) => `${index + 1}. ${step}`),
  ];

  if (input.repoContext.length > 0) {
    lines.push("", "Repository context:", ...input.repoContext.map((entry) => `- ${entry}`));
  }

  lines.push("", `Confidence: ${input.solution.confidence}`);
  return lines.join("\n");
}

function normalizeLanguage(value: string | null): "de" | "en" | "es" | "fr" | "it" {
  return value === "de" || value === "en" || value === "es" || value === "fr" || value === "it"
    ? value
    : "en";
}

function formatTicketRef(ticketNumber: number): string {
  return `TK-${String(ticketNumber).padStart(4, "0")}`;
}

function readRequesterEmail(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata.requester_email;
  return typeof value === "string" && value.includes("@") ? value.trim().toLowerCase() : null;
}
