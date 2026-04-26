// src/tools/generate-report.ts
import { z } from "zod";
import { getSupabaseClient } from "../lib/supabase.js";
import type { Ticket, TicketPriority } from "../types/index.js";

export const generateReportSchema = z.object({
  period: z.enum(["today","week","month"]).default("week").describe("Time period"),
  format: z.enum(["json","text"]).default("text").describe("Output format"),
});

export type GenerateReportInput = z.infer<typeof generateReportSchema>;

export async function generateReport(input: GenerateReportInput): Promise<string> {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;

  const now = new Date();
  const from = new Date();
  if (input.period === "today") from.setHours(0,0,0,0);
  else if (input.period === "week") from.setDate(now.getDate() - 7);
  else from.setMonth(now.getMonth() - 1);

  const { data: tickets, error } = await supabase
    .from("tickets")
    .select("*, categories(name)")
    .eq("organization_id", organizationId)
    .gte("created_at", from.toISOString())
    .returns<(Ticket & { categories: { name: string } | null })[]>();

  if (error) throw new Error(`Supabase error: ${error.message}`);

  const all = tickets ?? [];
  const resolved = all.filter(t => t.status === "resolved" || t.status === "closed");
  const open = all.filter(t => t.status === "open");
  const inProgress = all.filter(t => t.status === "in_progress");
  const slaBreach = all.filter(t => t.sla_breached);

  const byPriority: Record<TicketPriority, number> = { critical:0, high:0, medium:0, low:0 };
  all.forEach(t => byPriority[t.priority]++);

  const resolvedWithTime = resolved.filter(t => t.resolved_at);
  const avgResolutionHours = resolvedWithTime.length > 0
    ? resolvedWithTime.reduce((sum, t) => sum + (new Date(t.resolved_at!).getTime() - new Date(t.created_at).getTime()) / 3600000, 0) / resolvedWithTime.length
    : 0;

  const catMap: Record<string, number> = {};
  all.forEach(t => { const cat = (t as any).categories?.name ?? "Other"; catMap[cat] = (catMap[cat] ?? 0) + 1; });
  const topCategories = Object.entries(catMap).sort((a,b) => b[1]-a[1]).slice(0,5).map(([category,count]) => ({ category, count }));

  const slaComplianceRate = all.length > 0 ? Math.round(((all.length - slaBreach.length) / all.length) * 100) : 100;

  const report = {
    period: input.period,
    from: from.toLocaleDateString("de-CH"),
    to: now.toLocaleDateString("de-CH"),
    total: all.length,
    resolved: resolved.length,
    open: open.length,
    in_progress: inProgress.length,
    sla_breached: slaBreach.length,
    sla_compliance_rate: slaComplianceRate,
    by_priority: byPriority,
    avg_resolution_hours: Math.round(avgResolutionHours * 10) / 10,
    top_categories: topCategories,
  };

  if (input.format === "json") return JSON.stringify({ success: true, report });

  const periodLabel = { today:"Today", week:"Last 7 days", month:"Last 30 days" }[input.period];
  const lines = [
    `HELPDESK AI REPORT — ${periodLabel.toUpperCase()}`,
    `Period: ${report.from} → ${report.to}`,
    ``,
    `TICKETS`,
    `  Total:          ${report.total}`,
    `  Resolved:       ${report.resolved}`,
    `  In Progress:    ${report.in_progress}`,
    `  Open:           ${report.open}`,
    `  SLA Breached:   ${report.sla_breached}`,
    `  SLA Compliance: ${report.sla_compliance_rate}%`,
    ``,
    `BY PRIORITY`,
    `  Critical: ${byPriority.critical}`,
    `  High:     ${byPriority.high}`,
    `  Medium:   ${byPriority.medium}`,
    `  Low:      ${byPriority.low}`,
    ``,
    `PERFORMANCE`,
    `  Avg resolution: ${report.avg_resolution_hours}h`,
    ``,
    `TOP CATEGORIES`,
    ...topCategories.map(c => `  ${c.category}: ${c.count}`),
  ];
  return JSON.stringify({ success: true, report_text: lines.join("\n"), report });
}
