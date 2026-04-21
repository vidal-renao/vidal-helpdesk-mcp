import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
export const prioritizeIncidentSchema = z.object({ ticketId: z.string(), priority: z.enum(['P1', 'P2', 'P3', 'P4']) });
export async function prioritizeIncident(args: any) { await supabase.from('tickets').update({ priority: args.priority }).eq('id', args.ticketId); return 'Prioridad actualizada'; }
