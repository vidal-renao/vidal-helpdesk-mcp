// src/tools/get-ticket-status.ts
// Consulta detallada de estado y métricas de SLA — v1.2.1

import { z } from "zod";
import { supabase } from "../lib/supabase.js";

// ─── Esquema de Validación ──────────────────────────────────────────────────
export const getTicketStatusSchema = z.object({
  id: z
    .string()
    .uuid()
    .describe("ID único del ticket (UUID v4)")
});

export type GetTicketStatusInput = z.infer<typeof getTicketStatusSchema>;

// ─── Handler de la Herramienta ───────────────────────────────────────────────
export async function getTicketStatus(args: GetTicketStatusInput) {
  try {
    // Consulta directa al esquema 'helpdesk'
    const { data: ticket, error } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', args.id)
      .single();

    if (error || !ticket) {
      throw new Error(`Ticket con ID ${args.id} no encontrado en la infraestructura.`);
    }

    // 1. Lógica de Negocio: Cálculo de SLA en tiempo real
    const deadline = new Date(ticket.sla_deadline);
    const now = new Date();
    const diffMs = deadline.getTime() - now.getTime();
    
    const diffHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60));
    const diffMins = Math.floor((Math.abs(diffMs) % (1000 * 60 * 60)) / (1000 * 60));

    const isBreached = diffMs < 0;
    const slaStatus = isBreached 
      ? `🚨 BREACHED (Excedido hace ${diffHours}h ${diffMins}m)`
      : `⏳ DENTRO DE SLA (Restan ${diffHours}h ${diffMins}m)`;

    // 2. Formateo de Salida MCP (Native Experience)
    return {
      content: [
        {
          type: "text",
          text: `🎫 **Reporte de Estado: ${ticket.title}**\n` +
                `--------------------------------------------------\n` +
                `- **ID:** ${ticket.id}\n` +
                `- **Estado:** ${ticket.status.toUpperCase()}\n` +
                `- **Prioridad:** ${ticket.priority}\n` +
                `- **Categoría:** ${ticket.category}\n` +
                `- **Asignado a:** ${ticket.assignee_id || "Sin asignar"}\n` +
                `--------------------------------------------------\n` +
                `- **SLA Status:** ${slaStatus}\n` +
                `- **Deadline:** ${deadline.toLocaleString()}\n` +
                `--------------------------------------------------\n` +
                `🧠 **Resumen IA:** ${ticket.ai_summary || "No disponible"}`
        }
      ]
    };

  } catch (e: any) {
    return {
      content: [
        { 
          type: "text", 
          text: `❌ Error al consultar el ticket: ${e.message}` 
        }
      ]
    };
  }
}