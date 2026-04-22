// src/tools/suggest-solution.ts
// Resolución técnica asistida por IA — v1.2.1

import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { generateSolution } from "../lib/ai.js";

// ─── Esquema de Validación ──────────────────────────────────────────────────
export const suggestSolutionSchema = z.object({
  ticketId: z
    .string()
    .uuid()
    .describe("ID del ticket para el cual generar la solución")
});

export type SuggestSolutionInput = z.infer<typeof suggestSolutionSchema>;

// ─── Handler de la Herramienta ───────────────────────────────────────────────
export async function suggestSolution(args: SuggestSolutionInput) {
  try {
    // 1. Obtener contexto completo del ticket en 'helpdesk'
    const { data: ticket, error } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', args.ticketId)
      .single();

    if (error || !ticket) {
      throw new Error(`Ticket #${args.ticketId} no localizado en la infraestructura.`);
    }

    // 2. Invocar motor de razonamiento (lib/ai.js)
    // Pasamos el ticket completo para que la IA tenga contexto de categoría y lenguaje
    const sol = await generateSolution(ticket, ticket.language);

    // 3. Persistir la solución sugerida en la DB para auditoría
    await supabase
      .from('tickets')
      .update({ ai_solution: sol.solution })
      .eq('id', args.id);

    // 4. Formateo de Salida Ejecutiva
    const stepsFormatted = sol.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n');

    return {
      content: [
        {
          type: "text",
          text: `💡 **Propuesta de Resolución IA (Confianza: ${sol.confidence.toUpperCase()})**\n` +
                `--------------------------------------------------\n` +
                `🎯 **Solución:** ${sol.solution}\n\n` +
                `🛠️ **Pasos Recomendados:**\n${stepsFormatted}\n\n` +
                `--------------------------------------------------\n` +
                `⚠️ **Escalado Sugerido:** ${sol.escalate ? "SÍ (Requiere intervención senior)" : "NO (Nivel 1)"}`
        }
      ]
    };

  } catch (e: any) {
    return {
      content: [{ type: "text", text: `❌ Error al generar la solución: ${e.message}` }]
    };
  }
}