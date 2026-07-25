-- Applied remotely and recorded as version 20260721221843. Do not reapply.
-- This repo has no migration runner; this file exists as a durable, reviewable record of the
-- schema change, matching what src/lib/audit-runs.ts now expects.
--
-- Context: helpdesk.audit_runs already existed with 274 historical rows (last written
-- 2026-05-22), but src/lib/audit-runs.ts had been reading/writing SUPABASE_SCHEMA (which is
-- "public" in production) instead of the literal "helpdesk" schema this table actually lives
-- in. Every dedupe check and persistence write since 2026-05-22 silently failed against a
-- nonexistent public.audit_runs, so the daily SLA audit's duplicate-suppression never ran.
-- Combined with an hourly (not daily) GitHub Actions schedule, this produced up to 9 duplicate
-- emails in a single day (2026-07-21). See ARCHITECTURE.md "Idempotency design" and
-- DECISIONS.md ADR-009/ADR-010.
--
-- This migration extends the existing table with a stable per-day idempotency key instead of
-- creating a redundant new table, preserving all 274 historical rows untouched.

alter table helpdesk.audit_runs
  add column report_type text not null default 'sla_daily_audit',
  add column reporting_period_start timestamptz,
  add column reporting_period_end timestamptz,
  add column recipient text,
  add column status text not null default 'sent',
  add column provider_message_id text,
  add column error text,
  add column updated_at timestamptz not null default now();

alter table helpdesk.audit_runs
  add constraint audit_runs_status_check check (status in ('pending', 'sent', 'failed'));

-- Backfill legacy rows with their own precise created_at as the period boundary so each remains
-- naturally unique under the constraint below (new rows use day-truncated boundaries instead,
-- which never collides with a historical microsecond-precision value).
update helpdesk.audit_runs
set reporting_period_start = created_at,
    reporting_period_end = created_at,
    recipient = 'htcpacoxo31@gmail.com'
where reporting_period_start is null;

alter table helpdesk.audit_runs
  alter column reporting_period_start set not null,
  alter column reporting_period_end set not null,
  alter column recipient set not null;

alter table helpdesk.audit_runs
  add constraint audit_runs_period_idempotency_key
  unique (organization_id, report_type, reporting_period_start, recipient);

comment on table helpdesk.audit_runs is 'Stores SLA audit executions for deduplication and historical tracking. Idempotency key: (organization_id, report_type, reporting_period_start, recipient).';
