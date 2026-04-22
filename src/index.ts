// src/index.ts
// AI-Powered Helpdesk MCP Server — Swiss Standard Infrastructure
// Vidal Reñao · vidal-pro-portfolio.vercel.app

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// Herramientas Existentes
import { createTicketSchema, createTicket } from "./tools/create-ticket.js";
import { getTicketStatusSchema, getTicketStatus } from "./tools/get-ticket-status.js";
import { prioritizeIncidentSchema, prioritizeIncident } from "./tools/prioritize-incident.js";
import { suggestSolutionSchema, suggestSolution } from "./tools/suggest-solution.js";
import { generateReportSchema, generateReport } from "./tools/generate-report.js";

// ─── 1. CONFIGURACIÓN Y CLIENTE SUPABASE ─────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// FIX: Usamos 'as any' para evitar que TS bloquee el uso del esquema 'helpdesk'
export const supabase = createClient(
  SUPABASE_URL, 
  SUPABASE_SERVICE_ROLE_KEY, 
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'helpdesk' as any }, 
  }
);

// Validar variables de entorno
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY'];
requiredEnv.forEach(env => {
  if (!process.env[env]) {
    console.error(`❌ CRITICAL ERROR: Missing environment variable ${env}`);
    process.exit(1);
  }
});

// ─── 2. INICIALIZACIÓN DEL SERVIDOR ──────────────────────────────────────────

// FIX: Añadimos 'export' para que vercel-server.ts pueda importarlo
export const server = new McpServer({
  name: "helpdesk-ai-mcp",
  version: "1.2.1",
});

// ─── 3. REGISTRO DE HERRAMIENTAS (Core) ───────────────────────────────────────

// NOTA: MCP espera que 'text' sea estrictamente un string.
// Si tus herramientas devuelven objetos, usamos JSON.stringify().

server.tool(
  "create_ticket",
  "Crea un nuevo ticket con triaje automático por IA",
  createTicketSchema.shape,
  async (input: any) => {
    const result = await createTicket(input);
    const textOutput = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: "text" as const, text: textOutput }] };
  }
);

server.tool(
  "get_ticket_status",
  "Consulta el estado y cumplimiento de SLA de un ticket",
  getTicketStatusSchema.shape,
  async (input: any) => {
    const result = await getTicketStatus(input);
    const textOutput = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: "text" as const, text: textOutput }] };
  }
);

server.tool(
  "prioritize_incident",
  "Re-evalúa la prioridad de un incidente usando el juicio de la IA",
  prioritizeIncidentSchema.shape,
  async (input: any) => {
    const result = await prioritizeIncident(input);
    const textOutput = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: "text" as const, text: textOutput }] };
  }
);

server.tool(
  "suggest_solution",
  "Genera una solución técnica paso a paso en varios idiomas",
  suggestSolutionSchema.shape,
  async (input: any) => {
    const result = await suggestSolution(input);
    const textOutput = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: "text" as const, text: textOutput }] };
  }
);

server.tool(
  "generate_report",
  "Genera un informe analítico de la infraestructura",
  generateReportSchema.shape,
  async (input: any) => {
    const result = await generateReport(input);
    const textOutput = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: "text" as const, text: textOutput }] };
  }
);

// ─── 4. HERRAMIENTAS DE LISTADO Y CONTEO ────────────────────────────────────

server.tool(
  "list_tickets",
  "Lista tickets con filtros y paginación",
  {
    limit: z.number().default(10),
    status: z.string().optional(),
    priority: z.string().optional(),
    category: z.string().optional(),
  },
  async (input) => {
    let query = supabase
      .from("tickets")
      .select("id, title, status, priority, category, requester_name, created_at")
      .order("created_at", { ascending: false })
      .limit(input.limit || 10);

    if (input.status) query = query.eq("status", input.status);
    if (input.priority) query = query.eq("priority", input.priority);
    if (input.category) query = query.eq("category", input.category);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text" as const, text: `❌ Error: ${error.message}` }] };
    
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "count_tickets",
  "Cuenta tickets totales o agrupados",
  {
    group_by: z.enum(["status", "priority", "category", "none"]).default("none"),
  },
  async (input) => {
    if (input.group_by === "none") {
      const { count, error } = await supabase
        .from("tickets")
        .select("*", { count: "exact", head: true });
      
      if (error) return { content: [{ type: "text" as const, text: `❌ Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: `Total tickets: ${count}` }] };
    }

    const { data, error } = await supabase.from("tickets").select(input.group_by);
    if (error) return { content: [{ type: "text" as const, text: `❌ Error: ${error.message}` }] };

    const counts = (data || []).reduce((acc: any, item: any) => {
      const key = item[input.group_by as string] || "unspecified";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return { content: [{ type: "text" as const, text: JSON.stringify(counts, null, 2) }] };
  }
);

// ─── 5. EJECUCIÓN ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});