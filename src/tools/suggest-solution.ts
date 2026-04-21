import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { generateSolution } from '../lib/ai.js';
export const suggestSolutionSchema = z.object({ ticketId: z.string() });
export async function suggestSolution(args: any) { const { data: ticket } = await supabase.from('tickets').select('*').eq('id', args.ticketId).single(); if(!ticket) return 'Ticket no encontrado'; const sol = await generateSolution(ticket, ticket.language); return JSON.stringify(sol, null, 2); }
