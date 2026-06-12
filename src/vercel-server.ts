// src/vercel-server.ts
// MCP Server via HTTP/SSE — deployable on Vercel
// Compatible with ticket-system isolated helpdesk schema v2

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { IncomingMessage, ServerResponse } from "http";

import { createTicketSchema, createTicket } from "./tools/create-ticket.js";
import { getTicketStatusSchema, getTicketStatus } from "./tools/get-ticket-status.js";
import { listTicketsSchema, listTickets } from "./tools/list-tickets.js";
import { prioritizeIncidentSchema, prioritizeIncident } from "./tools/prioritize-incident.js";
import { suggestSolutionSchema, suggestSolution } from "./tools/suggest-solution.js";
import { updateTicketStatusSchema, updateTicketStatus } from "./tools/update-ticket-status.js";
import { generateReportSchema, generateReport } from "./tools/generate-report.js";
import { enforceCors } from "./lib/cors.js";
import { createValidatedToolHandler } from "./lib/mcp-tool-handler.js";
import { SUPABASE_SCHEMA } from "./lib/supabase.js";

function createMcpServer() {
  const server = new McpServer({
    name: "vidal-helpdesk-mcp",
    version: "2.0.0",
  });

  server.tool(
    "create_ticket",
    "Create IT support ticket with AI triage. Priority: low/medium/high/critical. Returns TK-XXXX ref.",
    createTicketSchema.shape,
    createValidatedToolHandler(createTicketSchema, createTicket)
  );

  server.tool(
    "get_ticket_status",
    'Get ticket details by ref (e.g. "TK-1001") or UUID. Includes SLA, AI analysis, sentiment.',
    getTicketStatusSchema.shape,
    createValidatedToolHandler(getTicketStatusSchema, getTicketStatus)
  );

  server.tool(
    "list_tickets",
    "List tickets with optional filters by status and priority.",
    listTicketsSchema.shape,
    createValidatedToolHandler(listTicketsSchema, listTickets)
  );

  server.tool(
    "prioritize_incident",
    "Re-run AI triage with new context. Updates priority and ai_analysis if confidence >= 60%.",
    prioritizeIncidentSchema.shape,
    createValidatedToolHandler(prioritizeIncidentSchema, prioritizeIncident)
  );

  server.tool(
    "suggest_solution",
    "Generate step-by-step solution in DE/EN/ES/FR/IT. Saves as internal comment.",
    suggestSolutionSchema.shape,
    createValidatedToolHandler(suggestSolutionSchema, suggestSolution)
  );

  server.tool(
    "update_ticket_status",
    "Update ticket status with optional internal comment.",
    updateTicketStatusSchema.shape,
    createValidatedToolHandler(updateTicketStatusSchema, updateTicketStatus)
  );

  server.tool(
    "generate_report",
    "Generate helpdesk report for today/week/month. SLA compliance, priorities, avg resolution.",
    generateReportSchema.shape,
    createValidatedToolHandler(generateReportSchema, generateReport)
  );

  return server;
}

const sessions = new Map<string, SSEServerTransport>();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/sse" || url.pathname === "/messages") {
    const methods = url.pathname === "/sse" ? ["GET", "OPTIONS"] : ["POST", "OPTIONS"];
    try {
      const cors = enforceCors(req, res, methods);
      if (!cors.allowed || cors.preflight) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "CORS configuration error";
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: "vidal-helpdesk-mcp",
        version: "2.0.0",
        status: "running",
        tools: 7,
        schema: SUPABASE_SCHEMA,
        org: process.env.MCP_ORGANIZATION_ID ?? "not set",
      })
    );
    return;
  }

  if (url.pathname === "/sse" && req.method === "GET") {
    const transport = new SSEServerTransport("/messages", res);
    const server = createMcpServer();
    const sessionId = transport.sessionId;
    sessions.set(sessionId, transport);

    res.on("close", () => {
      sessions.delete(sessionId);
    });

    await server.connect(transport);
    return;
  }

  if (url.pathname === "/messages" && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId" }));
      return;
    }

    const transport = sessions.get(sessionId);
    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}
