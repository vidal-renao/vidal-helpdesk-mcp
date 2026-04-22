// src/tools/prioritize-incident.ts
// Re-evaluación de prioridad mediante IA — v1.2.1

import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { classifyPriority } from "../lib/ai.js";

// ─── Esquema de Validación ──────────────────────────────────────────────────
export const prioritizeIncidentSchema = z.object({
  id: z
    .string()
    .uuid()
    .describe("ID único del ticket a re-evaluar"),
  new_description: z
    .string()
    .optional()
    .describe("Información adicional o actualización del contexto del problema")
});

export type PrioritizeIncidentInput = z.infer<typeof prioritizeIncidentSchema>;

// ─── Handler de la Herramienta ───────────────────────────────────────────────
export async function prioritizeIncident(args: PrioritizeIncidentInput) {
  try {
    // 1. Recuperar el ticket actual del esquema 'helpdesk'
    const { data: ticket, error: fetchError } = await supabase
      .from('tickets')
      .select('title, description, priority')
      .eq('id', args.id)
      .single();

    if (fetchError || !ticket) {
      throw new Error(`Ticket #${args.id} no encontrado para re-evaluación.`);
    }

    // 2. Ejecutar triaje de IA con el nuevo contexto
    // Combinamos la descripción original con la nueva información
    const fullContext = args.new_description 
      ? `Original: ${ticket.description}\nUpdate: ${args.new_description}`
      : ticket.description;

    const analysis = await classifyPriority(ticket.title, fullContext);

    // 3. Actualizar si la prioridad ha cambiado o para refrescar el resumen
    const { error: updateError } = await supabase
      .from('tickets')
      .update({ 
        priority: analysis.priority,
        ai_summary: `AI Re-evaluation: ${analysis.reasoning}`,
        updated_at: new Date().toISOString()
      })
      .eq('id', args.id);

    if (updateError) throw updateError;

    // 4. Feedback Estructurado
    const changeMsg = ticket.priority !== analysis.priority
      ? `📈 Prioridad cambiada de ${ticket.priority} a ${analysis.priority}`
      : `✅ Prioridad mantenida en ${analysis.priority}`;

    return {
      content: [
        {
          type: "text",
          text: `🧠 **Análisis de Impacto Finalizado**\n` +
                `--------------------------------------------------\n` +
                `${changeMsg}\n` +
                `- **Categoría Detectada:** ${analysis.category}\n` +
                `- **Justificación:** ${analysis.reasoning}\n` +
                `--------------------------------------------------\n` +
                `*El SLA y los tiempos de respuesta han sido ajustados automáticamente.*`
        }
      ]
    };

  } catch (e: any) {
    return {
      content: [
        { 
          type: "text", 
          text: `❌ Error en el proceso de re-priorización: ${e.message}` 
        }
      ]
    };
  }
}