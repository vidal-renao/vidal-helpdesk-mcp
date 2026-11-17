// src/tools/update-ticket-status.ts
import { z } from "zod";
import { getSupabaseClient } from "../lib/supabase.js";

const TICKET_NUMBER_REF = /^TK-?(\d{1,7})$/i;
const UUID_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_STATUS_COMMENT_LENGTH = 2000;

export const updateTicketStatusSchema = z.object({
  ticket_ref: z
    .string()
    .trim()
    .refine((ref) => TICKET_NUMBER_REF.test(ref) || UUID_REF.test(ref), {
      message: 'ticket_ref must look like "TK-1001" or be a ticket UUID',
    })
    .describe('Ticket ref like "TK-1001" or UUID'),
  status: z.enum(["open","in_progress","pending_customer","pending_third_party","resolved","closed"]).describe("New status"),
  comment: z.string().max(MAX_STATUS_COMMENT_LENGTH).optional().describe("Optional internal note (max 2000 characters)"),
});

export type UpdateTicketStatusInput = z.infer<typeof updateTicketStatusSchema>;

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export async function updateTicketStatus(input: UpdateTicketStatusInput): Promise<string> {
  const ref = input.ticket_ref.trim();
  const numberMatch = TICKET_NUMBER_REF.exec(ref);
  // Defence in depth: the schema already rejects these, but a direct caller must never reach the DB with NaN.
  if (!numberMatch && !UUID_REF.test(ref)) {
    return JSON.stringify({ success: false, error: "Invalid ticket reference" });
  }

  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;
  const agentId = process.env.MCP_AGENT_ID || null;

  let query = supabase
    .from("hd_tickets")
    .select("id,ticket_number,status,priority,title")
    .eq("organization_id", organizationId)
    .is("deleted_at", null);

  query = numberMatch ? query.eq("ticket_number", parseInt(numberMatch[1], 10)) : query.eq("id", ref.toLowerCase());

  const { data: ticket, error } = await query.single();
  if (error || !ticket) return JSON.stringify({ success: false, error: `Ticket ${ref} not found` });

  const ticketRef = `TK-${String(ticket.ticket_number).padStart(4, "0")}`;
  const previousStatus = ticket.status;
  const updatePayload: { status: UpdateTicketStatusInput["status"]; resolved_at?: string; closed_at?: string } = {
    status: input.status,
  };
  if (input.status === "resolved") updatePayload.resolved_at = new Date().toISOString();
  if (input.status === "closed") updatePayload.closed_at = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("hd_tickets")
    .update(updatePayload)
    .eq("id", ticket.id)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  if (updateError) {
    // Database text stays in the server log (code only); the MCP client gets a generic error.
    console.error("[update_ticket_status] update failed", { ticket_id: ticket.id, code: errorCode(updateError) });
    throw new Error("Failed to update ticket status");
  }

  // REQ-F1-06: audit event for MCP writes. Table owned by ticket-system
  // (migration 20261117 admin_audit_logs). Never blocks or hides the status change.
  let auditLogged = false;
  try {
    const { error: auditError } = await supabase.from("hd_admin_audit_logs").insert({
      organization_id: organizationId,
      actor_id: agentId,
      actor_type: "mcp",
      action: "ticket.status_changed",
      target_type: "ticket",
      target_id: ticket.id,
      outcome: "success",
      details: { from: previousStatus, to: input.status, ticket_number: ticket.ticket_number },
    });
    if (auditError) {
      console.error("[update_ticket_status] audit log failed", { ticket_id: ticket.id, code: errorCode(auditError) });
    } else {
      auditLogged = true;
    }
  } catch (auditException) {
    console.error("[update_ticket_status] audit log failed", { ticket_id: ticket.id, code: errorCode(auditException) });
  }

  let commentId: string | null = null;
  if (input.comment && agentId) {
    const { data: comment } = await supabase
      .from("hd_ticket_comments")
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
    audit_logged: auditLogged,
    message: `Ticket ${ticketRef}: ${previousStatus} → ${input.status}`,
  });
}
