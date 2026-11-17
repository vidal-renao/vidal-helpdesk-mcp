// src/tools/create-ticket.ts
import { z } from "zod";
import { getSupabaseClient, resolveCategoryId } from "../lib/supabase.js";
import { triageTicket } from "../lib/ai.js";
import type { Ticket } from "../types/index.js";

export const createTicketSchema = z.object({
  title: z.string().min(5).max(200).describe("Short title of the IT issue"),
  description: z.string().min(10).max(2000).describe("Detailed description"),
  requester_name: z.string().min(2).describe("Full name of the requester"),
  language: z.enum(["de","en","es","fr","it"]).default("en").describe("Language hint"),
  source: z.enum(["portal","email","api","phone"]).default("api").describe("Submission source"),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export async function createTicket(input: CreateTicketInput): Promise<string> {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID;
  const agentId = process.env.MCP_AGENT_ID;
  if (!organizationId || !agentId) throw new Error("Missing MCP_ORGANIZATION_ID or MCP_AGENT_ID");

  // REQ-F1-09: a failing AI provider must not block ticket intake. The ticket is
  // created untriaged (same as the web app) and flagged for later triage.
  let triage: Awaited<ReturnType<typeof triageTicket>> | null = null;
  try {
    triage = await triageTicket(input.title, input.description);
  } catch (triageError) {
    // Error class only: the provider message can echo the prompt (ticket content) or key hints.
    console.error("[create_ticket] ai triage unavailable", {
      error_class: triageError instanceof Error ? triageError.constructor.name : typeof triageError,
    });
  }

  const categoryId = triage ? await resolveCategoryId(supabase, organizationId, triage.suggested_category) : null;
  const applyAIPriority = triage !== null && triage.confidence_score >= 60;

  const { data: ticket, error } = await supabase
    .from("hd_tickets")
    .insert({
      organization_id: organizationId,
      created_by: agentId,
      category_id: categoryId,
      title: input.title,
      description: input.description,
      detected_language: triage ? triage.detected_language : input.language,
      status: "open",
      priority: triage && applyAIPriority ? triage.suggested_priority : "medium",
      source: input.source,
      contains_pii: triage ? triage.contains_pii : false,
      metadata: triage
        ? { requester_name: input.requester_name, mcp_created: true }
        : { requester_name: input.requester_name, mcp_created: true, triage_status: "unavailable" },
    })
    .select()
    .single<Ticket>();

  if (error || !ticket) {
    // Database text stays in the server log; the MCP client only gets a generic error.
    console.error("[create_ticket] insert failed", { code: (error as { code?: string } | null)?.code ?? null });
    throw new Error("Failed to create ticket");
  }

  const ticketRef = `TK-${String(ticket.ticket_number).padStart(4, "0")}`;

  if (!triage) {
    return JSON.stringify({
      success: true,
      ticket_ref: ticketRef,
      ticket_id: ticket.id,
      priority: ticket.priority,
      ai_triage: "unavailable",
      detected_language: input.language,
      sla_first_response_due: ticket.sla_first_response_due,
      analysis_saved: false,
      message: `Ticket ${ticketRef} created with default priority ${ticket.priority}. AI triage was unavailable: no category, summary or suggested response was generated, and the ticket needs manual triage.`,
    });
  }

  const { error: analysisError } = await supabase.from("hd_ai_analysis").insert({
    ticket_id: ticket.id,
    suggested_category: triage.suggested_category,
    suggested_priority: triage.suggested_priority,
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
  });
  if (analysisError) {
    console.error("[create_ticket] ai analysis insert failed", {
      ticket_id: ticket.id,
      code: (analysisError as { code?: string }).code ?? null,
    });
  }

  return JSON.stringify({
    success: true,
    ticket_ref: ticketRef,
    ticket_id: ticket.id,
    priority: ticket.priority,
    ai_triage: "completed",
    category: triage.suggested_category,
    confidence: triage.confidence_score,
    sentiment: triage.sentiment,
    detected_language: triage.detected_language,
    sla_first_response_due: ticket.sla_first_response_due,
    ai_summary: triage.summary,
    smart_response: triage.smart_response,
    analysis_saved: !analysisError,
    message: `Ticket ${ticketRef} created. Priority: ${ticket.priority} (confidence: ${triage.confidence_score}%)`,
  });
}
