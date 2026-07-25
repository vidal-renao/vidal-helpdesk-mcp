-- Additive hardening for audit delivery. Not applied remotely by this repository.
-- PostgreSQL ALTER TABLE takes an ACCESS EXCLUSIVE lock. Schedule this migration
-- while the Audit workflow is disabled and keep the transaction short.
begin;

alter table helpdesk.audit_runs
  add column if not exists idempotency_key text,
  add column if not exists payload_hash text,
  add column if not exists payload_snapshot jsonb,
  add column if not exists last_error_code text,
  add column if not exists last_error_message text,
  add column if not exists delivery_attempted_at timestamptz,
  add column if not exists provider_confirmed_at timestamptz,
  add column if not exists state_changed_at timestamptz not null default now(),
  drop constraint if exists audit_runs_status_check,
  add constraint audit_runs_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'delivery_unknown'));

-- NULL historical keys do not conflict. New keys are stable per audit_run id.
create unique index if not exists audit_runs_idempotency_key_unique
  on helpdesk.audit_runs (idempotency_key)
  where idempotency_key is not null;

commit;

-- Verification is maintained in docs/sql/audit-runs-verification.sql.
--
-- Conditional manual rollback:
-- 1. Stop all audit writers.
-- 2. Refuse rollback while sending/delivery_unknown rows exist.
-- 3. Preserve provider evidence externally before dropping any column.
-- 4. Only then, in one transaction, drop the new index/columns and replace the
--    check constraint. Never restore the old constraint over incompatible rows.
