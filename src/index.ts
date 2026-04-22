// src/index.ts
// AI-Powered Helpdesk MCP Server — Swiss Standard Infrastructure
// Vidal Reñao · vidal-pro-portfolio.vercel.app

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// Herramientas Existentes (Estructura de archivos)
import { createTicketSchema, createTicket } from "./tools/create-ticket.js";
import { getTicketStatusSchema, getTicketStatus } from "./tools/get-ticket-status.js";
import { prioritizeIncidentSchema, prioritizeIncident } from "./tools/prioritize-incident.js";
import { suggestSolutionSchema, suggestSolution } from "./tools/suggest-solution.js";
import { generateReportSchema, generateReport } from "./tools/generate-report.js";

// ─── 1. CONFIGURACIÓN Y CLIENTE SUPABASE (Fixed Schema) ──────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Cliente centralizado apuntando al esquema 'helpdesk'
export const supabase: SupabaseClient = createClient(
  SUPABASE_URL, 
  SUPABASE_SERVICE_ROLE_KEY, 
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'helpdesk' }, // <-- Fix: Evita colisiones con el esquema 'public'
  }
);

// Validar variables de entorno críticas
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY'];
requiredEnv.forEach(env => {
  if (!process.env[env]) {
    console.error(`\x1b[31m%s\x1b[0m`, `❌ CRITICAL ERROR: Missing environment variable ${env}`);
    process.exit(1);
  }
});

// ─── 2. INICIALIZACIÓN DEL SERVIDOR ──────────────────────────────────────────

const server = new McpServer({
  name: "helpdesk-ai-mcp",
  version: "1.2.1",
});

// ─── 3. REGISTRO DE HERRAMIENTAS (Core) ───────────────────────────────────────

server.tool(
  "create_ticket",
  "Crea un nuevo ticket con triaje automático por IA",
  createTicketSchema.shape,
  async (input: any) => {
    const result = await createTicket(input);
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "get_ticket_status",
  "Consulta el estado y cumplimiento de SLA de un ticket",
  getTicketStatusSchema.shape,
  async (input: any) => {
    const result = await getTicketStatus(input);
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "prioritize_incident",
  "Re-evalúa la prioridad de un incidente usando el juicio de la IA",
  prioritizeIncidentSchema.shape,
  async (input: any) => {
    const result = await prioritizeIncident(input);
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "suggest_solution",
  "Genera una solución técnica paso a paso en varios idiomas",
  suggestSolutionSchema.shape,
  async (input: any) => {
    const result = await suggestSolution(input);
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "generate_report",
  "Genera un informe analítico de la infraestructura",
  generateReportSchema.shape,
  async (input: any) => {
    const result = await generateReport(input);
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ─── 4. HERRAMIENTAS DE LISTADO Y CONTEO (Inyectadas con Fix) ────────────────

server.tool(
  "list_tickets",
  "Lista tickets con filtros (status, priority, category) y paginación",
  {
    limit: z.number().default(10),
    status: z.string().optional(),
    priority: z.string().optional(),
    category: z.string().optional(),
  },
  async (input) => {
    let query = supabase
      .from("tickets")
      .select("id, title, status, priority, category, reporter_email, created_at")
      .order("created_at", { ascending: false })
      .limit(input.limit || 10);

    if (input.status) query = query.eq("status", input.status);
    if (input.priority) query = query.eq("priority", input.priority);
    if (input.category) query = query.eq("category", input.category);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: `❌ Supabase Error: ${error.message}` }] };
    
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "count_tickets",
  "Cuenta tickets totales o agrupados por status/priority/category",
  {
    group_by: z.enum(["status", "priority", "category", "none"]).default("none"),
  },
  async (input) => {
    if (input.group_by === "none") {
      const { count, error } = await supabase
        .from("tickets")
        .select("*", { count: "exact", head: true });
      
      if (error) return { content: [{ type: "text", text: `❌ Error: ${error.message}` }] };
      return { content: [{ type: "text", text: `Total tickets en esquema 'helpdesk': ${count}` }] };
    }

    const { data, error } = await supabase.from("tickets").select(input.group_by);
    if (error) return { content: [{ type: "text", text: `❌ Error: ${error.message}` }] };

    const counts = (data || []).reduce((acc: any, item: any) => {
      const key = item[input.group_by] || "unspecified";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return { content: [{ type: "text", text: JSON.stringify(counts, null, 2) }] };
  }
);

// ─── 5. EJECUCIÓN ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`\x1b[32m%s\x1b[0m`, "✅ Vidal Ecosystem MCP Server v1.2.1 (helpdesk schema) running");
}

main().catch((err) => {
  console.error("❌ Fatal error during server startup:", err);
  process.exit(1);
});