// src/lib/supabase.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";

type AnySchemaSupabaseClient = SupabaseClient<any, any, any>;
type SupabaseSchemaName = "helpdesk" | "public";

let client: AnySchemaSupabaseClient | null = null;
export const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA?.trim() || "public";

export function getSupabaseClient(): AnySchemaSupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: SUPABASE_SCHEMA },
  });
  return client;
}

export function getSupabaseSchema(schema: SupabaseSchemaName) {
  return getSupabaseClient().schema(schema);
}

export function getHelpdeskSchema() {
  return getSupabaseSchema("helpdesk");
}

/**
 * audit_runs physically lives in the helpdesk schema, but this project's
 * PostgREST only exposes (public, omnisciencia, aura_core). Reaching it with
 * .schema("helpdesk") fails with PGRST106 "Invalid schema", which the claim
 * logic could only report as an opaque claim_failed -- the Phase 4A.16 outage.
 * public.audit_runs is a service_role-only view over the same table, added in
 * supabase/migrations/20260728120000_audit_runs_public_view.sql.
 */
export function getAuditRunsTable() {
  return getPublicSchema().from("audit_runs");
}

export function getDomainSchema() {
  const schema = SUPABASE_SCHEMA === "public" ? "public" : "helpdesk";
  return getSupabaseSchema(schema);
}

export function getPublicSchema() {
  return getSupabaseSchema("public");
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
