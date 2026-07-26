-- Read-only verification after the Phase 2 audit delivery migration.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'helpdesk' and table_name = 'audit_runs'
order by ordinal_position;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'helpdesk.audit_runs'::regclass
order by conname;

select indexname, indexdef
from pg_indexes
where schemaname = 'helpdesk' and tablename = 'audit_runs'
order by indexname;

select status, count(*) from helpdesk.audit_runs group by status order by status;
select count(*) as historical_rows from helpdesk.audit_runs;

select organization_id, report_type, reporting_period_start, recipient, count(*)
from helpdesk.audit_runs
group by 1, 2, 3, 4
having count(*) > 1;

select idempotency_key, count(*)
from helpdesk.audit_runs
where idempotency_key is not null
group by idempotency_key
having count(*) > 1;

-- Rollback precondition. Any returned row blocks schema rollback.
select id, status, provider_message_id
from helpdesk.audit_runs
where status in ('sending', 'delivery_unknown');
