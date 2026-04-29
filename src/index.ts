// src/index.ts
// HelpdeskAI MCP Server — 100% compatible with ticket-system schema
// isolated helpdesk schema · priority: low/medium/high/critical · ai_analysis table
// Vidal Reñao · Basel, Switzerland 🇨🇭 · vidal-pro-portfolio.vercel.app

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createTicketSchema, createTicket } from "./tools/create-ticket.js";
import { getTicketStatusSchema, getTicketStatus } from "./tools/get-ticket-status.js";
import { listTicketsSchema, listTickets } from "./tools/list-tickets.js";
import { prioritizeIncidentSchema, prioritizeIncident } from "./tools/prioritize-incident.js";
import { suggestSolutionSchema, suggestSolution } from "./tools/suggest-solution.js";
import { updateTicketStatusSchema, updateTicketStatus } from "./tools/update-ticket-status.js";
import { generateReportSchema, generateReport } from "./tools/generate-report.js";

function validateEnv() {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ANTHROPIC_API_KEY",
    "MCP_ORGANIZATION_ID",
    "MCP_AGENT_ID",
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`CRITICAL: Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const server = new McpServer({
  name: "vidal-helpdesk-mcp",
  version: "2.0.0",
});

server.tool(
  "create_ticket",
  "Create an IT support ticket with full AI triage (Claude Sonnet). Priority: low/medium/high/critical. Saves to tickets + ai_analysis table. Returns TK-XXXX ref.",
  createTicketSchema.shape,
  async (input: any) => ({ content: [{ type: "text" as const, text: await createTicket(input) }] })
);

server.tool(
  "get_ticket_status",
  'Get full details of a ticket by ref (e.g. "TK-1001") or UUID. Includes SLA countdown, AI analysis, sentiment, category.',
  getTicketStatusSchema.shape,
  async (input: any) => ({ content: [{ type: "text" as const, text: await getTicketStatus(input) }] })
);

server.tool(
  "list_tickets",
  "List tickets with optional filters by status and priority. Returns up to 50 tickets with AI summary.",
  listTicketsSchema.shape,
  async (input: any) => ({ content: [{ type: "text" as const, text: await listTickets(input) }] })
);

server.tool(
  "prioritize_incident",
  "Re-run AI triage on an existing ticket with optional new context. Updates priority and upserts ai_analysis if confidence >= 60%.",
  prioritizeIncidentSchema.shape,
  async (input: any) => ({ content: [{ type: "text" as const, text: await prioritizeIncident(input) }] })
);

server.tool(
  "suggest_solution",
  "Generate step-by-step IT solution in DE/EN/ES/FR/IT. Saves as internal comment in ticket_comments. Updates status to in_progress.",
  suggestSolutionSchema.shape,
  async (input: any) => ({ content: [{ type: "text" as const, text: await suggestSolution(input) }] })
);

server.tool(
  "update_ticket_status",
  "Update ticket status: open/in_progress/pending_customer/pending_third_party/resolved/closed. Optional internal comment. Auto-sets resolved_at/closed_at.",
  updateTicketStatusSchema.shape,
  async (input: any) => ({ content: [{ type: "text" as const, text: await updateTicketStatus(input) }] })
);

server.tool(
  "generate_report",
  "Generate real helpdesk report from Supabase for today/week/month. SLA compliance, priority breakdown, avg resolution, top categories.",
  generateReportSchema.shape,
  async (input: any) => ({ content: [{ type: "text" as const, text: await generateReport(input) }] })
);

async function main() {
  validateEnv();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`vidal-helpdesk-mcp v2.0.0 running — org: ${process.env.MCP_ORGANIZATION_ID}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
