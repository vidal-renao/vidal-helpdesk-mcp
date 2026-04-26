// src/tools/suggest-solution.ts
import { z } from "zod";
import { getSupabaseClient } from "../lib/supabase.js";
import { generateSolution } from "../lib/ai.js";
import type { Language } from "../types/index.js";

export const suggestSolutionSchema = z.object({
  ticket_ref: z.string().describe('Ticket ref like "TK-1001" or UUID'),
  language: z.enum(["de","en","es","fr","it"]).optional().describe("Override language"),
  save_as_comment: z.boolean().default(true).describe("Save solution as internal comment"),
});

export type SuggestSolutionInput = z.infer<typeof suggestSolutionSchema>;

export async function suggestSolution(input: SuggestSolutionInput): Promise<string> {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;
  const agentId = process.env.MCP_AGENT_ID!;

  let query = supabase
    .from("tickets")
    .select("*, ai_analysis(suggested_category,sentiment,smart_response)")
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
  const lang: Language = input.language ?? (ticket.detected_language as Language) ?? "en";
  const category = ticket.ai_analysis?.suggested_category ?? "Other";

  const solution = await generateSolution(ticket.title, ticket.description, ticket.priority, category, lang);

  let commentId: string | null = null;
  if (input.save_as_comment && agentId) {
    const content = [
      `**AI Solution (${lang.toUpperCase()}) — ${ticketRef}**`,
      ``,
      solution.solution,
      ``,
      `**Steps:**`,
      ...solution.steps.map((s: string, i: number) => `${i + 1}. ${s}`),
      ``,
      `*Confidence: ${solution.confidence} | Escalate: ${solution.escalate ? "Yes" : "No"} | HelpdeskAI MCP*`,
    ].join("\n");

    const { data: comment } = await supabase
      .from("ticket_comments")
      .insert({ ticket_id: ticket.id, author_id: agentId, content, is_internal: true, is_ai_generated: true })
      .select("id")
      .single();
    commentId = comment?.id ?? null;

    if (ticket.status === "open" && !solution.escalate) {
      await supabase.from("tickets").update({ status: "in_progress" }).eq("id", ticket.id);
    }
  }

  return JSON.stringify({
    success: true,
    ticket_ref: ticketRef,
    priority: ticket.priority,
    language: lang,
    solution: solution.solution,
    confidence: solution.confidence,
    steps: solution.steps,
    escalate: solution.escalate,
    saved_as_comment: commentId !== null,
    message: solution.escalate
      ? `Ticket ${ticketRef} requires escalation.`
      : `Solution saved as internal comment on ${ticketRef}.`,
  });
}
