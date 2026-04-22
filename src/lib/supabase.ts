import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// Validación preventiva: Si falta una tecla, el servidor avisa con claridad
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("❌ Error de Infraestructura: Faltan variables de entorno en el .env");
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Cliente centralizado para el ecosistema Helpdesk.
 * Forzamos el esquema 'helpdesk' para garantizar cumplimiento DSG y aislamiento de datos.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  db: {
    schema: 'helpdesk',
  },
});