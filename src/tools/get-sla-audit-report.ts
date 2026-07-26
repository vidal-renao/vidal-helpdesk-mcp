// src/tools/get-sla-audit-report.ts
import { z } from "zod";

import { getUtcDayPeriod } from "../lib/audit-runs.js";
import { buildSlaAuditReport } from "../lib/sla-audit.js";

export const getSlaAuditReportSchema = z.object({});

export type GetSlaAuditReportInput = z.infer<typeof getSlaAuditReportSchema>;

/**
 * Read-only. Snapshot of currently active tickets for MCP_ORGANIZATION_ID,
 * enriched with the requester's company (via tickets.created_by -> profiles
 * -> customers_info) and SLA risk detail. Ticket-to-project association does
 * not exist in this schema (see DOMAIN.md) — project_id/project_name are
 * always null, not omitted.
 */
export async function getSlaAuditReport(_input: GetSlaAuditReportInput): Promise<string> {
  const organizationId = process.env.MCP_ORGANIZATION_ID;
  if (!organizationId) throw new Error("Missing MCP_ORGANIZATION_ID");

  const report = await buildSlaAuditReport(organizationId, new Date(), getUtcDayPeriod());
  return JSON.stringify({ success: true, report });
}
