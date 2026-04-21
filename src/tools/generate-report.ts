import { z } from "zod";
import { supabase } from "../lib/supabase.js";

export const generateReportSchema = z.object({
  days: z.number().default(7)
});

export async function generateReport(args: any) {
  try {
    const { data, error } = await supabase.from("tickets").select("status, priority");
    if (error) throw error;
    return `📊 Reporte: ${data?.length || 0} tickets procesados en el sistema.`;
  } catch (e: any) {
    return `❌ Error al generar reporte: ${e.message}`;
  }
}
