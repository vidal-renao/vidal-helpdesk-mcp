-- Additive hardening for audit delivery. Not applied remotely by this repository.
alter table helpdesk.audit_runs
  drop constraint if exists audit_runs_status_check;

alter table helpdesk.audit_runs
  add constraint audit_runs_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'delivery_unknown')),
  add column if not exists idempotency_key text,
  add column if not exists payload_hash text,
  add column if not exists payload_snapshot jsonb,
  add column if not exists last_error_code text,
  add column if not exists last_error_message text,
  add column if not exists delivery_attempted_at timestamptz,
  add column if not exists provider_confirmed_at timestamptz,
  add column if not exists state_changed_at timestamptz not null default now();

-- Verification:
-- select status, count(*) from helpdesk.audit_runs group by status order by status;
-- select count(*) from helpdesk.audit_runs where status = 'sent';
-- select organization_id, report_type, reporting_period_start, recipient, count(*)
-- from helpdesk.audit_runs group by 1,2,3,4 having count(*) > 1;
--
-- Manual rollback: first reconcile all sending/delivery_unknown rows, then drop
-- the new columns and restore the former pending/sent/failed check constraint.
-- Existing sent rows and all historical rows remain valid.
