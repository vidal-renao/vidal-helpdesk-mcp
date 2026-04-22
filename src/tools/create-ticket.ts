// src/tools/create-ticket.ts
// Creación de tickets con triaje automático por IA — v1.2.1

import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { classifyPriority, getSLADeadline } from "../lib/ai.js";

// ─── Esquema de Validación (Interfaz de la IA) ──────────────────────────────
export const createTicketSchema = z.object({
  title: z
    .string()
    .min(5)
    .describe("Título descriptivo de la incidencia"),
  description: z
    .string()
    .min(10)
    .describe("Detalles técnicos del problema"),
  requesterName: z
    .string()
    .describe("Nombre completo del usuario"),
  requesterEmail: z
    .string()
    .email()
    .describe("Email corporativo del solicitante"),
  language: z
    .enum(["en", "de", "es"])
    .default("en")
    .describe("Idioma de la comunicación")
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

// ─── Handler de la Herramienta ───────────────────────────────────────────────
export async function createTicket(args: CreateTicketInput) {
  try {
    // 1. Triaje Automático mediante IA (lib/ai.js)
    // El sistema analiza el sentimiento y la urgencia antes de tocar la DB
    const { priority, category, reasoning } = await classifyPriority(args.title, args.description);
    const sla = getSLADeadline(priority);

    // 2. Inserción en el esquema 'helpdesk'
    // IMPORTANTE: Mapeo explícito de camelCase a snake_case
    const { data, error } = await supabase
      .from("tickets")
      .insert([
        {
          title: args.title,
          description: args.description,
          requester_name: args.requesterName,   // Mapeo correcto
          requester_email: args.requesterEmail, // Mapeo correcto
          language: args.language,
          priority: priority,                   // P1, P2, P3, P4
          category: category,
          sla_deadline: sla.toISOString(),
          ai_summary: reasoning,                // Explicación de la IA
          status: "open"                        // Estado inicial por defecto
        }
      ])
      .select()
      .single();

    if (error) throw error;

    return {
      content: [
        {
          type: "text",
          text: `✅ Ticket #${data.id} creado con éxito.\n\n` +
                `🧠 **Triaje IA:** [${priority}] - ${category}\n` +
                `⏳ **SLA Deadline:** ${sla.toLocaleString()}\n` +
                `📝 **Razonamiento:** ${reasoning}`
        }
      ]
    };

  } catch (e: any) {
    return {
      content: [
        { 
          type: "text", 
          text: `❌ Error crítico al crear el ticket: ${e.message}` 
        }
      ]
    };
  }
}