import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
export const getTicketStatusSchema = z.object({ ticketId: z.string() });
export async function getTicketStatus(args: any) { const { data, error } = await supabase.from('tickets').select('*').eq('id', args.ticketId).single(); return error ? 'No encontrado' : JSON.stringify(data, null, 2); }
