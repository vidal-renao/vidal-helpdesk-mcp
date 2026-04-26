// src/tools/update-ticket-status.ts
import { z } from "zod";
import { getSupabaseClient } from "../lib/supabase.js";

export const updateTicketStatusSchema = z.object({
  ticket_ref: z.string().describe('Ticket ref like "TK-1001" or UUID'),
  status: z.enum(["open","in_progress","pending_customer","pending_third_party","resolved","closed"]).describe("New status"),
  comment: z.string().optional().describe("Optional internal note"),
});

export type UpdateTicketStatusInput = z.infer<typeof updateTicketStatusSchema>;

export async function updateTicketStatus(input: UpdateTicketStatusInput): Promise<string> {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;
  const agentId = process.env.MCP_AGENT_ID!;

  let query = supabase
    .from("tickets")
    .select("id,ticket_number,status,priority,title")
    .eq("organization_id", organizationId);

  const isUUID = /^[0-9a-f-]{36}$/.test(input.ticket_ref);
  if (isUUID) {
    query = query.eq("id", input.ticket_ref);
  } else {
    const num = parseInt(input.ticket_ref.replace(/^TK-?0*/i, ""), 10);
    query = query.eq("ticket_number", num);
  }

  const { data: ticket, error } = await query.single();
  if (error || !ticket) return JSON.stringify({ success: false, error: `Ticket ${input.ticket_ref} not found` });

  const ticketRef = `TK-${String(ticket.ticket_number).padStart(4, "0")}`;
  const previousStatus = ticket.status;
  const updatePayload: Record<string, any> = { status: input.status };
  if (input.status === "resolved") updatePayload.resolved_at = new Date().toISOString();
  if (input.status === "closed") updatePayload.closed_at = new Date().toISOString();

  const { error: updateError } = await supabase.from("tickets").update(updatePayload).eq("id", ticket.id);
  if (updateError) throw new Error(`Failed to update: ${updateError.message}`);

  let commentId: string | null = null;
  if (input.comment && agentId) {
    const { data: comment } = await supabase
      .from("ticket_comments")
      .insert({
        ticket_id: ticket.id,
        author_id: agentId,
        content: `**Status: ${previousStatus} → ${input.status}**\n\n${input.comment}`,
        is_internal: true,
        is_ai_generated: false,
      })
      .select("id")
      .single();
    commentId = comment?.id ?? null;
  }

  return JSON.stringify({
    success: true,
    ticket_ref: ticketRef,
    previous_status: previousStatus,
    new_status: input.status,
    comment_added: commentId !== null,
    message: `Ticket ${ticketRef}: ${previousStatus} → ${input.status}`,
  });
}
