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

/**
 * There is deliberately no getHelpdeskSchema() helper any more.
 *
 * PostgREST on this project exposes only (public, omnisciencia, aura_core), so
 * anything routed through .schema("helpdesk") fails at runtime with PGRST106
 * "Invalid schema" while typechecking and unit-testing perfectly. That is
 * exactly how the daily audit silently delivered nothing for three days
 * (ADR-017). audit_runs is now reached through public.audit_runs, a
 * service_role-only view over the same table added in
 * supabase/migrations/20260728120000_audit_runs_public_view.sql.
 */
export function getAuditRunsTable() {
  return getPublicSchema().from("audit_runs");
}

export function getDomainSchema() {
  // Same failure class as ADR-017, one step removed: if SUPABASE_SCHEMA is ever
  // set to anything but "public", this used to hand back an unexposed schema and
  // every domain query would fail with PGRST106 one call later, far from the
  // cause. That configuration is already 100% broken, so refusing it outright is
  // strictly better than discovering it through a stream of opaque query errors.
  if (SUPABASE_SCHEMA !== "public") {
    throw new Error(
      `SUPABASE_SCHEMA is "${SUPABASE_SCHEMA}", which PostgREST does not expose on this project ` +
        `(exposed: public, omnisciencia, aura_core). Domain queries would fail with PGRST106. ` +
        `Expose the schema in the Supabase API settings or reach it through a view in public.`
    );
  }
  return getSupabaseSchema("public");
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
