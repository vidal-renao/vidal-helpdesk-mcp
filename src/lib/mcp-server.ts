import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTicketSchema, createTicket } from "../tools/create-ticket.js";
import { getTicketStatusSchema, getTicketStatus } from "../tools/get-ticket-status.js";
import { listTicketsSchema, listTickets } from "../tools/list-tickets.js";
import { prioritizeIncidentSchema, prioritizeIncident } from "../tools/prioritize-incident.js";
import { suggestSolutionSchema, suggestSolution } from "../tools/suggest-solution.js";
import { updateTicketStatusSchema, updateTicketStatus } from "../tools/update-ticket-status.js";
import { generateReportSchema, generateReport } from "../tools/generate-report.js";
import { getSlaAuditReportSchema, getSlaAuditReport } from "../tools/get-sla-audit-report.js";
import { createValidatedToolHandler } from "./mcp-tool-handler.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "vidal-helpdesk-mcp", version: "2.0.0" });
  server.tool("create_ticket", "Create IT support ticket with AI triage.", createTicketSchema.shape, createValidatedToolHandler(createTicketSchema, createTicket));
  server.tool("get_ticket_status", "Get ticket details by reference or UUID.", getTicketStatusSchema.shape, createValidatedToolHandler(getTicketStatusSchema, getTicketStatus));
  server.tool("list_tickets", "List tickets with optional status and priority filters.", listTicketsSchema.shape, createValidatedToolHandler(listTicketsSchema, listTickets));
  server.tool("prioritize_incident", "Re-run AI triage and conditionally update priority.", prioritizeIncidentSchema.shape, createValidatedToolHandler(prioritizeIncidentSchema, prioritizeIncident));
  server.tool("suggest_solution", "Generate multilingual support guidance.", suggestSolutionSchema.shape, createValidatedToolHandler(suggestSolutionSchema, suggestSolution));
  server.tool("update_ticket_status", "Update ticket status with an optional internal comment.", updateTicketStatusSchema.shape, createValidatedToolHandler(updateTicketStatusSchema, updateTicketStatus));
  server.tool("generate_report", "Generate a helpdesk report.", generateReportSchema.shape, createValidatedToolHandler(generateReportSchema, generateReport));
  server.tool("get_sla_audit_report", "Return the read-only SLA audit snapshot.", getSlaAuditReportSchema.shape, createValidatedToolHandler(getSlaAuditReportSchema, getSlaAuditReport));
  return server;
}
