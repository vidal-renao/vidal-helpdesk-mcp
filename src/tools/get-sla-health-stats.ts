import { z } from "zod";
import { getSupabaseClient } from "../lib/supabase.js";

export const getSlaHealthStatsSchema = z.object({
  organizationId: z.string().uuid().optional().describe("Organization UUID to inspect. Defaults to MCP_ORGANIZATION_ID."),
});

export type GetSlaHealthStatsInput = z.infer<typeof getSlaHealthStatsSchema>;

export async function getSlaHealthStats(
  input: GetSlaHealthStatsInput
): Promise<string> {
  const supabase = getSupabaseClient();
  const organizationId = input.organizationId ?? process.env.MCP_ORGANIZATION_ID!;

  const { data: tickets, error } = await supabase
    .from("tickets")
    .select("id, category_id, status, priority, created_at, resolved_at, category:categories(name)")
    .eq("organization_id", organizationId);

  if (error) throw new Error(`Failed to load SLA health stats: ${error.message}`);

  const rows = (tickets ?? []) as Array<{
    id: string;
    category_id: string | null;
    status: string;
    priority: string;
    created_at: string;
    resolved_at: string | null;
    category?: { name?: string | null } | null;
  }>;

  const total = rows.length;
  const resolved = rows.filter((ticket) => Boolean(ticket.resolved_at));
  const mttrHours =
    resolved.length > 0
      ? Number(
          (
            resolved.reduce((sum, ticket) => {
              return (
                sum +
                (new Date(ticket.resolved_at!).getTime() -
                  new Date(ticket.created_at).getTime()) /
                  3_600_000
              );
            }, 0) / resolved.length
          ).toFixed(2)
        )
      : 0;

  const byCategory = rows.reduce<
    Record<string, { total: number; resolved: number; open: number }>
  >((acc, ticket) => {
    const key = ticket.category?.name?.trim() || "Unclassified";
    if (!acc[key]) acc[key] = { total: 0, resolved: 0, open: 0 };
    acc[key].total += 1;
    if (ticket.status === "resolved" || ticket.status === "closed") {
      acc[key].resolved += 1;
    } else {
      acc[key].open += 1;
    }
    return acc;
  }, {});

  const categoryStats = Object.entries(byCategory)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([category, stats]) => ({
      category,
      total: stats.total,
      resolved: stats.resolved,
      open: stats.open,
      compliance_percent:
        stats.total > 0 ? Number(((stats.resolved / stats.total) * 100).toFixed(2)) : 0,
    }));

  const priorityBreakdown = rows.reduce<Record<string, number>>((acc, ticket) => {
    acc[ticket.priority] = (acc[ticket.priority] ?? 0) + 1;
    return acc;
  }, {});

  return JSON.stringify(
    {
      success: true,
      organizationId,
      overview: {
        total_tickets: total,
        open_tickets: rows.filter((ticket) => !ticket.resolved_at).length,
        resolved_tickets: resolved.length,
        estimated_mttr_hours: mttrHours,
      },
      priority_breakdown: priorityBreakdown,
      category_stats: categoryStats,
    },
    null,
    2
  );
}
