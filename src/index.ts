// src/index.ts
// HelpdeskAI MCP Server — Entry Point
// Vidal Reñao · vidal-pro-portfolio.vercel.app

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createTicketSchema, createTicket } from "./tools/create-ticket.js";
import { getTicketStatusSchema, getTicketStatus } from "./tools/get-ticket-status.js";
import { prioritizeIncidentSchema, prioritizeIncident } from "./tools/prioritize-incident.js";
import { suggestSolutionSchema, suggestSolution } from "./tools/suggest-solution.js";
import { generateReportSchema, generateReport } from "./tools/generate-report.js";

// ─── Server Definition ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "helpdesk-ai-mcp",
  version: "1.0.0",
});

// ─── Tool: create_ticket ─────────────────────────────────────────────────────

server.tool(
  "create_ticket",
  "Create a new IT support ticket with automatic AI triage. " +
    "Claude classifies priority (P1–P4), assigns category, and sets SLA deadline.",
  createTicketSchema.shape,
  async (input) => {
    const result = await createTicket(input as any);
    return { content: [{ type: "text", text: result }] };
  }
);

// ─── Tool: get_ticket_status ─────────────────────────────────────────────────

server.tool(
  "get_ticket_status",
  "Retrieve full details and current status of a ticket by ID. " +
    "Includes SLA countdown and breach detection.",
  getTicketStatusSchema.shape,
  async (input) => {
    const result = await getTicketStatus(input as any);
    return { content: [{ type: "text", text: result }] };
  }
);

// ─── Tool: prioritize_incident ───────────────────────────────────────────────

server.tool(
  "prioritize_incident",
  "Re-evaluate and update the priority of an existing ticket using AI. " +
    "Optionally provide additional context for better classification.",
  prioritizeIncidentSchema.shape,
  async (input) => {
    const result = await prioritizeIncident(input as any);
    return { content: [{ type: "text", text: result }] };
  }
);

// ─── Tool: suggest_solution ──────────────────────────────────────────────────

server.tool(
  "suggest_solution",
  "Generate a step-by-step AI solution for an open IT ticket. " +
    "Supports responses in English, German (DE), and Spanish (ES).",
  suggestSolutionSchema.shape,
  async (input) => {
    const result = await suggestSolution(input as any);
    return { content: [{ type: "text", text: result }] };
  }
);

// ─── Tool: generate_report ───────────────────────────────────────────────────

server.tool(
  "generate_report",
  "Generate an IT helpdesk summary report for today, the last 7 days, or last 30 days. " +
    "Includes ticket counts, priority breakdown, resolution time, and top categories.",
  generateReportSchema.shape,
  async (input) => {
    const result = await generateReport(input as any);
    return { content: [{ type: "text", text: result }] };
  }
);

// ─── Start Server ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ HelpdeskAI MCP Server running via stdio");
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
