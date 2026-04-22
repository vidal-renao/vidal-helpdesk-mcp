import { z } from "zod";
import { supabase } from "../lib/supabase.js";

// ─── Esquema de Validación ──────────────────────────────────────────────────
export const countTicketsSchema = z.object({
  group_by: z
    .enum(["status", "priority", "category", "none"])
    .default("none")
    .describe("Agrupar conteo por campo (none = total global)"),
  status: z
    .enum(["open", "in_progress", "pending", "resolved", "closed"])
    .optional()
    .describe("Pre-filtrar por estado antes de contar"),
  since_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Contar sólo tickets creados en los últimos N días"),
});

export type CountTicketsInput = z.infer<typeof countTicketsSchema>;

// ─── Handler de la Herramienta ───────────────────────────────────────────────
export async function countTickets(input: CountTicketsInput) {
  const { group_by, status, since_days } = input;
  
  // 1. Preparar filtro temporal
  let sinceIso: string | null = null;
  if (since_days) {
    const d = new Date();
    d.setDate(d.getDate() - since_days);
    sinceIso = d.toISOString();
  }

  try {
    // CASO A: Conteo Global (Optimizado para Performance)
    if (group_by === "none") {
      let query = supabase
        .from("tickets")
        .select("*", { count: "exact", head: true });

      if (status) query = query.eq("status", status);
      if (sinceIso) query = query.gte("created_at", sinceIso);

      const { count, error } = await query;
      if (error) throw error;

      return {
        content: [{ 
          type: "text", 
          text: `📊 Total tickets en 'helpdesk': ${count ?? 0}${status ? ` (Estado: ${status})` : ""}` 
        }]
      };
    }

    // CASO B: Conteo Agrupado
    let query = supabase.from("tickets").select(group_by);
    if (status) query = query.eq("status", status);
    if (sinceIso) query = query.gte("created_at", sinceIso);

    const { data, error } = await query;
    if (error) throw error;

    // Agregación en memoria (SME Standard para eficiencia de tokens)
    const stats: Record<string, number> = (data || []).reduce((acc: any, item: any) => {
      const key = item[group_by] || "unspecified";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return {
      content: [{ 
        type: "text", 
        text: `📈 Estadísticas de tickets por ${group_by}:\n${JSON.stringify(stats, null, 2)}` 
      }]
    };

  } catch (e: any) {
    return {
      content: [{ type: "text", text: `❌ Error en el conteo de infraestructura: ${e.message}` }]
    };
  }
}