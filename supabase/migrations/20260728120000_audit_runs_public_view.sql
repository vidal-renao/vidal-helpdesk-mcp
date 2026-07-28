-- ============================================================================
-- Phase 4A.16 root-cause fix: make helpdesk.audit_runs reachable from PostgREST.
--
-- INCIDENT
-- --------
-- Since the delivery state machine shipped (commit 17bf9a0, deployed
-- 2026-07-26 21:12 UTC) NOT A SINGLE daily SLA email has been delivered, while
-- every GitHub Actions run still reported success. Verified end to end:
--
--   $ curl "$SUPABASE_URL/rest/v1/audit_runs?select=id" -H "Accept-Profile: helpdesk"
--   {"code":"PGRST106","message":"Invalid schema: helpdesk",
--    "hint":"Only the following schemas are exposed: public, omnisciencia, aura_core"}
--
-- src/lib/audit-runs.ts reaches the table with supabase-js .schema("helpdesk"),
-- but this Supabase project's PostgREST only exposes
-- (pgrst.db_schemas = "public, omnisciencia, aura_core"). Every claim insert
-- therefore failed with PGRST106; claimAuditRunSlot only special-cases 23505,
-- so it returned claim_failed, AuditService returned a successful-looking
-- no-op, and the endpoint answered HTTP 200. No row was ever written and
-- Resend was never called.
--
-- WHY A VIEW AND NOT AN EXPOSED SCHEMA
-- ------------------------------------
-- Adding "helpdesk" to pgrst.db_schemas would be an instance-wide change to a
-- Supabase project shared with several unrelated products (omnisciencia,
-- aura_core, lumen_invoice, cuadrante), it lives outside git, and -- because
-- anon/authenticated still hold blanket DML grants on helpdesk.audit_runs
-- (see the hardening block below) -- it would newly expose an audit table to
-- the public API surface. A narrow, additive, service_role-only view in the
-- already-exposed public schema fixes the defect without touching shared
-- infrastructure. The table itself, its 274 historical rows, its constraints
-- and its idempotency guarantees are left exactly as they are.
--
-- ROLLBACK
-- --------
--   DROP VIEW IF EXISTS public.audit_runs;
--   -- (optional, restores the pre-existing over-broad grants)
--   GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--     ON helpdesk.audit_runs TO anon, authenticated;
--   NOTIFY pgrst, 'reload schema';
-- Dropping the view makes the audit endpoint fail closed again (claim_failed);
-- it can never cause a duplicate or an unintended send.
-- ============================================================================

begin;

-- security_invoker keeps the caller's own privileges and the base table's RLS
-- in force. Without it the view would execute as its owner and would silently
-- bypass RLS for anybody able to read it.
create or replace view public.audit_runs
  with (security_invoker = true)
  as select * from helpdesk.audit_runs;

comment on view public.audit_runs is
  'PostgREST-reachable projection of helpdesk.audit_runs (the helpdesk schema is not in pgrst.db_schemas). service_role only; see supabase/migrations/20260728120000_audit_runs_public_view.sql.';

-- Supabase default privileges grant new public-schema objects to anon and
-- authenticated. The audit ledger must never be readable or writable from a
-- browser, so revoke first and grant back only what the MCP server needs.
revoke all on public.audit_runs from public, anon, authenticated;
grant select, insert, update on public.audit_runs to service_role;

-- Pre-existing hardening gap, unrelated to the outage but directly adjacent to
-- it: anon and authenticated hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE on the
-- underlying audit table. That is currently unreachable only because the
-- helpdesk schema is not exposed -- i.e. security by obscurity. Nothing except
-- the MCP server (service_role) has ever legitimately touched this table.
revoke all on helpdesk.audit_runs from anon, authenticated;

-- PostgREST caches the schema. Supabase ships a DDL event trigger that issues
-- this automatically; doing it explicitly makes the migration self-contained.
notify pgrst, 'reload schema';

commit;
