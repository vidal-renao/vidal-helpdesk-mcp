import type { PostgrestError } from "@supabase/supabase-js";

import { getSupabaseClient, SUPABASE_SCHEMA } from "./supabase.js";

export type AuditRunInsert = {
  organization_id: string;
  fingerprint: string;
  overall_severity: string;
  findings_count: number;
  payload: Record<string, unknown>;
};

export function auditRunsTable() {
  return getSupabaseClient().schema(SUPABASE_SCHEMA).from("audit_runs");
}

export function formatSupabaseError(error: PostgrestError | null | undefined) {
  if (!error) return null;
  return {
    message: error.message,
    code: error.code ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
    schema: SUPABASE_SCHEMA,
  };
}

export function buildAuditFingerprint(parts: Array<string | number | boolean | null | undefined>) {
  return parts
    .map((part) => (part == null ? "null" : String(part).trim()))
    .join("|");
}

