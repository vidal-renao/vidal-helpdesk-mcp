// src/tools/list-tickets.ts
import { z } from "zod";
import { getSupabaseClient } from "../lib/supabase.js";

export const listTicketsSchema = z.object({
  limit: z.number().min(1).max(50).default(10).describe("Number of tickets to return"),
  status: z.enum(["open","in_progress","pending_customer","pending_third_party","resolved","closed"]).optional().describe("Filter by status"),
  priority: z.enum(["low","medium","high","critical"]).optional().describe("Filter by priority"),
});

export type ListTicketsInput = z.infer<typeof listTicketsSchema>;

type ListTicketRow = {
  id: string;
  ticket_number: number;
  title: string;
  status: string;
  priority: string;
  detected_language: string | null;
  sla_breached: boolean;
  contains_pii: boolean;
  created_at: string;
  categories: { name: string } | Array<{ name: string }> | null;
  ai_analysis:
    | { sentiment: string | null; confidence_score: number | null; summary: string | null }
    | Array<{ sentiment: string | null; confidence_score: number | null; summary: string | null }>
    | null;
};

export async function listTickets(input: ListTicketsInput): Promise<string> {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;

  let query = supabase
    .from("tickets")
    .select(`id,ticket_number,title,status,priority,source,detected_language,sla_breached,contains_pii,created_at,categories(name),ai_analysis(sentiment,confidence_score,summary)`)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(input.limit);

  if (input.status) query = query.eq("status", input.status);
  if (input.priority) query = query.eq("priority", input.priority);

  const { data, error } = await query;
  if (error) throw new Error(`Supabase error: ${error.message}`);

  const rows = (data ?? []) as ListTicketRow[];
  const tickets = rows.map((t) => ({
    ref: `TK-${String(t.ticket_number).padStart(4, "0")}`,
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    category: firstRelation(t.categories)?.name ?? null,
    language: t.detected_language,
    sla_breached: t.sla_breached,
    contains_pii: t.contains_pii,
    sentiment: firstRelation(t.ai_analysis)?.sentiment ?? null,
    ai_confidence: firstRelation(t.ai_analysis)?.confidence_score ?? null,
    ai_summary: firstRelation(t.ai_analysis)?.summary ?? null,
    created_at: t.created_at,
  }));

  return JSON.stringify({ success: true, count: tickets.length, tickets });
}

function firstRelation<T>(relation: T | T[] | null): T | null {
  if (Array.isArray(relation)) {
    return relation[0] ?? null;
  }

  return relation;
}
