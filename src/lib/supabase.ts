import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("❌ Error de Infraestructura: Faltan variables de entorno en el .env");
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Cliente centralizado para el ecosistema Helpdesk.
 * Definimos el esquema 'helpdesk' como el esquema por defecto para evitar errores de tipado.
 */
export const supabase = createClient(
  SUPABASE_URL, 
  SUPABASE_SERVICE_ROLE_KEY, 
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    // Al usar 'as any' o definir el esquema aquí, TypeScript 
    // entiende que el esquema de base no es 'public'.
    db: {
      schema: 'helpdesk' as any, 
    },
  }
);