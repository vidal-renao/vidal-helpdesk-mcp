import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Conexión configurada para el subproyecto Helpdesk
export const supabase = createClient(supabaseUrl, supabaseKey, {
  db: {
    schema: 'helpdesk'
  }
});
