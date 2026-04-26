// src/lib/supabase.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export async function resolveCategoryId(
  supabase: SupabaseClient,
  organizationId: string,
  categoryName: string
): Promise<string | null> {
  const slug = categoryName.toLowerCase();
  const { data } = await supabase
    .from("categories")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .eq("is_active", true)
    .single();
  return data?.id ?? null;
}
