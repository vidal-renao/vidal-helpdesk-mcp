// src/tools/generate-report.ts
// Reporte ejecutivo de salud de soporte — v1.2.1

import { z } from "zod";
import { supabase } from "../lib/supabase.js";

// ─── Esquema de Validación ──────────────────────────────────────────────────
export const generateReportSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .default(7)
    .describe("Ventana de tiempo para el reporte (días)")
});

export type GenerateReportInput = z.infer<typeof generateReportSchema>;

// ─── Handler de la Herramienta ───────────────────────────────────────────────
export async function generateReport(args: GenerateReportInput) {
  try {
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.setDate(dateLimit.getDate() - args.days));

    // Consulta agregada sobre el esquema 'helpdesk'
    const { data, error } = await supabase
      .from("tickets")
      .select("status, priority, category, sla_deadline")
      .gte("created_at", dateLimit.toISOString());

    if (error) throw error;
    if (!data || data.length === 0) {
      return { content: [{ type: "text", text: `📊 No se detectó actividad en los últimos ${args.days} días.` }] };
    }

    // 1. Cálculos de métricas
    const total = data.length;
    const stats = data.reduce((acc: any, t) => {
      acc.priority[t.priority] = (acc.priority[t.priority] || 0) + 1;
      acc.status[t.status] = (acc.status[t.status] || 0) + 1;
      
      const isBreached = t.sla_deadline && new Date(t.sla_deadline) < new Date();
      if (isBreached) acc.sla_breaches++;
      
      return acc;
    }, { priority: {}, status: {}, sla_breaches: 0 });

    const healthScore = stats.sla_breaches / total > 0.2 ? "🔴 CRÍTICO" : "✅ SALUDABLE";

    // 2. Salida Ejecutiva
    return {
      content: [
        {
          type: "text",
          text: `📈 **Infrastructure Health Report - Vidal Ecosystem**\n` +
                `--------------------------------------------------\n` +
                `- **Periodo Analizado:** últimos ${args.days} días\n` +
                `- **Estado Global:** ${healthScore}\n` +
                `- **Total Incidentes:** ${total}\n` +
                `- **Incumplimientos SLA:** ${stats.sla_breaches}\n` +
                `--------------------------------------------------\n` +
                `📌 **Distribución de Prioridades:**\n${JSON.stringify(stats.priority, null, 2)}\n\n` +
                `📌 **Distribución de Estados:**\n${JSON.stringify(stats.status, null, 2)}`
        }
      ]
    };

  } catch (e: any) {
    return {
      content: [{ type: "text", text: `❌ Error al generar reporte ejecutivo: ${e.message}` }]
    };
  }
}