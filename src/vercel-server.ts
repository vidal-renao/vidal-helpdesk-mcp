// src/vercel-server.ts
// MCP Server via HTTP/SSE — deployable on Vercel
// Compatible with ticket-system public schema v2

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Resend } from "resend";
import type { IncomingMessage, ServerResponse } from "http";

import { getAuditEmailHtml } from "./lib/audit-template.js";
import { getSupabaseClient } from "./lib/supabase.js";
import { createTicketSchema, createTicket } from "./tools/create-ticket.js";
import { getTicketStatusSchema, getTicketStatus } from "./tools/get-ticket-status.js";
import { listTicketsSchema, listTickets } from "./tools/list-tickets.js";
import { prioritizeIncidentSchema, prioritizeIncident } from "./tools/prioritize-incident.js";
import { suggestSolutionSchema, suggestSolution } from "./tools/suggest-solution.js";
import { updateTicketStatusSchema, updateTicketStatus } from "./tools/update-ticket-status.js";
import { generateReportSchema, generateReport } from "./tools/generate-report.js";

function createMcpServer() {
  const server = new McpServer({
    name: "vidal-helpdesk-mcp",
    version: "2.0.0",
  });

  server.tool("create_ticket",
    "Create IT support ticket with AI triage. Priority: low/medium/high/critical. Returns TK-XXXX ref.",
    createTicketSchema.shape,
    async (input: any) => ({ content: [{ type: "text" as const, text: await createTicket(input) }] })
  );

  server.tool("get_ticket_status",
    'Get ticket details by ref (e.g. "TK-1001") or UUID. Includes SLA, AI analysis, sentiment.',
    getTicketStatusSchema.shape,
    async (input: any) => ({ content: [{ type: "text" as const, text: await getTicketStatus(input) }] })
  );

  server.tool("list_tickets",
    "List tickets with optional filters by status and priority.",
    listTicketsSchema.shape,
    async (input: any) => ({ content: [{ type: "text" as const, text: await listTickets(input) }] })
  );

  server.tool("prioritize_incident",
    "Re-run AI triage with new context. Updates priority and ai_analysis if confidence >= 60%.",
    prioritizeIncidentSchema.shape,
    async (input: any) => ({ content: [{ type: "text" as const, text: await prioritizeIncident(input) }] })
  );

  server.tool("suggest_solution",
    "Generate step-by-step solution in DE/EN/ES/FR/IT. Saves as internal comment.",
    suggestSolutionSchema.shape,
    async (input: any) => ({ content: [{ type: "text" as const, text: await suggestSolution(input) }] })
  );

  server.tool("update_ticket_status",
    "Update ticket status with optional internal comment.",
    updateTicketStatusSchema.shape,
    async (input: any) => ({ content: [{ type: "text" as const, text: await updateTicketStatus(input) }] })
  );

  server.tool("generate_report",
    "Generate helpdesk report for today/week/month. SLA compliance, priorities, avg resolution.",
    generateReportSchema.shape,
    async (input: any) => ({ content: [{ type: "text" as const, text: await generateReport(input) }] })
  );

  return server;
}

// Session store for SSE connections
const sessions = new Map<string, SSEServerTransport>();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  console.log(">>> [AUDIT] Petición recibida en el servidor");
  console.log(">>> [AUDIT] Header Auth:", req.headers.authorization ? "Presente" : "Faltante");

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/cron/audit" && req.method === "POST") {
    if (!isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const payload = await buildAuditCronPayload();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
      return;
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown audit error",
          stack: error instanceof Error ? error.stack : null,
        })
      );
      return;
    }
  }

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "vidal-helpdesk-mcp",
      version: "2.0.0",
      status: "running",
      tools: 7,
      schema: "public",
      org: process.env.MCP_ORGANIZATION_ID ?? "not set",
    }));
    return;
  }

  // SSE endpoint — client connects here
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

  // Messages endpoint — client posts here
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

async function buildAuditCronPayload() {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID!;
  const activeStatuses = ["open", "in_progress", "pending_customer", "pending_third_party"];

  const [
    { count: totalTickets, error: totalTicketsError },
    { count: compliantTickets, error: compliantTicketsError },
    { count: vipBreaches, error: vipBreachesError },
    { data: organization, error: organizationError },
  ] =
    await Promise.all([
      supabase
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("status", activeStatuses),
      supabase
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("status", activeStatuses)
        .eq("sla_breached", false),
      supabase
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("status", activeStatuses)
        .in("priority", ["high", "critical"]),
      supabase
        .from("organizations")
        .select("name, slug")
        .eq("id", organizationId)
        .maybeSingle(),
    ]);

  if (totalTicketsError) {
    throw new Error(`Supabase total tickets query failed: ${totalTicketsError.message}`);
  }

  if (compliantTicketsError) {
    throw new Error(`Supabase compliant tickets query failed: ${compliantTicketsError.message}`);
  }

  if (vipBreachesError) {
    throw new Error(`Supabase VIP breaches query failed: ${vipBreachesError.message}`);
  }

  if (organizationError) {
    throw new Error(`Supabase organization query failed: ${organizationError.message}`);
  }

  const total = totalTickets ?? 0;
  const compliant = compliantTickets ?? 0;
  const vip = vipBreaches ?? 0;
  const compliance = total > 0 ? Number(((compliant / total) * 100).toFixed(2)) : 100;
  const html = getAuditEmailHtml({
    compliance,
    totalTickets: total,
    vipBreaches: vip,
  });
  const recipient = "htcpacoxo31@gmail.com".trim().toLowerCase();
  const subject = `🚨 Vidal Audit: ${compliance}% SLA Compliance - ${new Date().toLocaleDateString()}`;

  let emailSent = false;
  let emailError: string | null = null;
  let emailErrorDetail: unknown = null;
  let emailData: unknown = null;

  try {
    const resendApiKey = process.env.RESEND_API_KEY?.trim();
    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const resend = new Resend(resendApiKey);
    const from = process.env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev";

    console.log(`Intentando enviar auditoría a: ${recipient} desde: ${from}`);

    const { data, error } = await resend.emails.send({
      from,
      to: recipient,
      subject,
      html,
    });

    emailData = data;

    if (error) {
      console.error("Detalle error Resend:", error);
      emailError = error.message;
      emailErrorDetail = error;
    } else {
      emailSent = true;
    }
  } catch (error) {
    emailError = error instanceof Error ? error.message : "Unknown email error";
    emailErrorDetail = error;
    console.error("Detalle error Resend:", error);
  }

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    organizationId,
    organizationName: organization?.name ?? null,
    organizationSlug: organization?.slug ?? null,
    recipient,
    stats: {
      compliance,
      totalTickets: total,
      vipBreaches: vip,
    },
    html,
    emailSent,
    emailError,
    emailErrorDetail,
    emailData,
  };
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.AUDIT_CRON_SECRET?.trim();
  if (!expected) return true;
  const authHeader = req.headers.authorization ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return bearer === expected;
}
