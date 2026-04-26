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

  const triage = await triageTicket(input.title, input.description);
  const categoryId = await resolveCategoryId(supabase, organizationId, triage.suggested_category);
  const applyAIPriority = triage.confidence_score >= 60;

  const { data: ticket, error } = await supabase
    .from("tickets")
    .insert({
      organization_id: organizationId,
      created_by: agentId,
      category_id: categoryId,
      title: input.title,
      description: input.description,
      detected_language: triage.detected_language,
      status: "open",
      priority: applyAIPriority ? triage.suggested_priority : "medium",
      source: input.source,
      tags: triage.keywords.slice(0, 5),
      contains_pii: triage.contains_pii,
      metadata: { requester_name: input.requester_name, mcp_created: true },
    })
    .select()
    .single<Ticket>();

  if (error || !ticket) throw new Error(`Failed to create ticket: ${error?.message}`);

  await supabase.from("ai_analysis").insert({
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
    raw_response: triage as any,
  });

  const ticketRef = `TK-${String(ticket.ticket_number).padStart(4, "0")}`;
  return JSON.stringify({
    success: true,
    ticket_ref: ticketRef,
    ticket_id: ticket.id,
    priority: ticket.priority,
    category: triage.suggested_category,
    confidence: triage.confidence_score,
    sentiment: triage.sentiment,
    detected_language: triage.detected_language,
    sla_first_response_due: ticket.sla_first_response_due,
    ai_summary: triage.summary,
    smart_response: triage.smart_response,
    message: `Ticket ${ticketRef} created. Priority: ${ticket.priority} (confidence: ${triage.confidence_score}%)`,
  });
}
