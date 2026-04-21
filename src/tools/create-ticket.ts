import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { classifyPriority, getSLADeadline } from "../lib/ai.js";

export const createTicketSchema = z.object({
  title: z.string(),
  description: z.string(),
  requesterName: z.string(),
  requesterEmail: z.string().email(),
  language: z.enum(["en", "de", "es"]).default("en")
});

export async function createTicket(args: any) {
  try {
    const { priority, category, reasoning } = await classifyPriority(args.title, args.description);
    const sla = getSLADeadline(priority);
    const { data, error } = await supabase
      .from("tickets")
      .insert([{ ...args, priority, category, sla_deadline: sla.toISOString(), ai_summary: reasoning }])
      .select()
      .single();

    if (error) throw error;
    return `✅ Ticket ${data.id} creado con éxito [Prioridad: ${priority}]`;
  } catch (e: any) {
    return `❌ Error al crear ticket: ${e.message}`;
  }
}
