// src/tools/prioritize-incident.ts
import { z } from "zod";
import { getSupabaseClient, resolveCategoryId } from "../lib/supabase.js";
import { triageTicket } from "../lib/ai.js";

export const prioritizeIncidentSchema = z.object({
  ticket_ref: z.string().describe('Ticket ref like "TK-1001" or UUID'),
  additional_context: z.string().optional().describe("New context that may change priority"),
});

export type PrioritizeIncidentInput = z.infer<typeof prioritizeIncidentSchema>;

export async function prioritizeIncident(input: PrioritizeIncidentInput): Promise<string> {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;

  let query = supabase.from("tickets").select("*").eq("organization_id", organizationId);
  const isUUID = /^[0-9a-f-]{36}$/.test(input.ticket_ref);
  if (isUUID) {
    query = query.eq("id", input.ticket_ref);
  } else {
    const num = parseInt(input.ticket_ref.replace(/^TK-?0*/i, ""), 10);
    query = query.eq("ticket_number", num);
  }

  const { data: ticket, error } = await query.single();
  if (error || !ticket) return JSON.stringify({ success: false, error: `Ticket ${input.ticket_ref} not found` });

  const previousPriority = ticket.priority;
  const ticketRef = `TK-${String(ticket.ticket_number).padStart(4, "0")}`;
  const enrichedDesc = input.additional_context
    ? `${ticket.description}\n\nAdditional context: ${input.additional_context}`
    : ticket.description;

  const triage = await triageTicket(ticket.title, enrichedDesc);
  const categoryId = await resolveCategoryId(supabase, organizationId, triage.suggested_category);
  const applyPriority = triage.confidence_score >= 60;

  await supabase.from("tickets").update({
    priority: applyPriority ? triage.suggested_priority : ticket.priority,
    category_id: categoryId ?? ticket.category_id,
    detected_language: triage.detected_language,
    contains_pii: triage.contains_pii,
    tags: triage.keywords.slice(0, 5),
  }).eq("id", ticket.id);

  await supabase.from("ai_analysis").upsert({
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
  }, { onConflict: "ticket_id" });

  const priorityChanged = applyPriority && previousPriority !== triage.suggested_priority;
  return JSON.stringify({
    success: true,
    ticket_ref: ticketRef,
    previous_priority: previousPriority,
    new_priority: applyPriority ? triage.suggested_priority : previousPriority,
    category: triage.suggested_category,
    confidence: triage.confidence_score,
    priority_changed: priorityChanged,
    sentiment: triage.sentiment,
    reasoning: triage.reasoning,
    message: priorityChanged
      ? `Priority updated: ${previousPriority} → ${triage.suggested_priority} (confidence: ${triage.confidence_score}%)`
      : `Priority confirmed: ${previousPriority} (confidence: ${triage.confidence_score}%)`,
  });
}
