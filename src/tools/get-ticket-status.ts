// src/tools/get-ticket-status.ts
import { z } from "zod";
import { getSupabaseClient } from "../lib/supabase.js";

export const getTicketStatusSchema = z.object({
  ticket_ref: z.string().describe('Ticket ref like "TK-1001" or UUID'),
});

export type GetTicketStatusInput = z.infer<typeof getTicketStatusSchema>;

export async function getTicketStatus(input: GetTicketStatusInput): Promise<string> {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;

  let query = supabase
    .from("tickets")
    .select(`*, categories(id,name,slug,color), ai_analysis(suggested_priority,confidence_score,summary,sentiment,smart_response,reasoning,contains_pii_detected,estimated_resolution_hours,model_used,processing_time_ms)`)
    .eq("organization_id", organizationId);

  const isUUID = /^[0-9a-f-]{36}$/.test(input.ticket_ref);
  if (isUUID) {
    query = query.eq("id", input.ticket_ref);
  } else {
    const num = parseInt(input.ticket_ref.replace(/^TK-?0*/i, ""), 10);
    if (isNaN(num)) return JSON.stringify({ success: false, error: `Invalid ref: ${input.ticket_ref}` });
    query = query.eq("ticket_number", num);
  }

  const { data, error } = await query.single();
  if (error || !data) return JSON.stringify({ success: false, error: `Ticket ${input.ticket_ref} not found` });

  const now = new Date();
  const slaResp = data.sla_first_response_due ? new Date(data.sla_first_response_due) : null;
  const slaResol = data.sla_resolution_due ? new Date(data.sla_resolution_due) : null;
  const ticketRef = `TK-${String(data.ticket_number).padStart(4, "0")}`;

  return JSON.stringify({
    success: true,
    ticket: {
      ref: ticketRef,
      id: data.id,
      title: data.title,
      status: data.status,
      priority: data.priority,
      category: data.categories?.name ?? null,
      detected_language: data.detected_language,
      sla_breached: data.sla_breached,
      sla_first_response_due: data.sla_first_response_due,
      sla_resolution_due: data.sla_resolution_due,
      minutes_to_response_sla: slaResp ? Math.round((slaResp.getTime() - now.getTime()) / 60000) : null,
      minutes_to_resolution_sla: slaResol ? Math.round((slaResol.getTime() - now.getTime()) / 60000) : null,
      contains_pii: data.contains_pii,
      created_at: data.created_at,
      resolved_at: data.resolved_at,
    },
    ai_analysis: data.ai_analysis ? {
      suggested_priority: data.ai_analysis.suggested_priority,
      confidence: data.ai_analysis.confidence_score,
      summary: data.ai_analysis.summary,
      sentiment: data.ai_analysis.sentiment,
      smart_response: data.ai_analysis.smart_response,
      reasoning: data.ai_analysis.reasoning,
      estimated_hours: data.ai_analysis.estimated_resolution_hours,
      model: data.ai_analysis.model_used,
    } : null,
  });
}
