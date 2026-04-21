-- Crear el esquema aislado para el subproyecto
CREATE SCHEMA IF NOT EXISTS helpdesk;

-- Configurar la extensión en el esquema público (requerido por Postgres)
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;

-- supabase/schema.sql
-- HelpdeskAI MCP Server â€” Database Schema
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- â”€â”€â”€ Tickets Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

create table if not exists helpdesk.tickets (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  description       text not null,
  priority          text not null check (priority in ('P1', 'P2', 'P3', 'P4')),
  status            text not null default 'open'
                    check (status in ('open', 'triage', 'in_progress', 'resolved', 'closed')),
  category          text not null default 'other',
  assignee_id       uuid references auth.users(id) on delete set null,
  requester_name    text not null,
  requester_email   text not null,
  language          text not null default 'en' check (language in ('en', 'de', 'es')),
  ai_summary        text,
  ai_solution       text,
  sla_deadline      timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- â”€â”€â”€ Indexes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

create index if not exists idx_tickets_status    on helpdesk.tickets(status);
create index if not exists idx_tickets_priority  on helpdesk.tickets(priority);
create index if not exists idx_tickets_created   on helpdesk.tickets(created_at desc);
create index if not exists idx_tickets_email     on helpdesk.tickets(requester_email);

-- â”€â”€â”€ Auto-update updated_at â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tickets_updated_at
  before update on helpdesk.tickets
  for each row execute function update_updated_at();

-- â”€â”€â”€ Auto-set resolved_at when status â†’ resolved â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

create or replace function set_resolved_at()
returns trigger as $$
begin
  if new.status = 'resolved' and old.status != 'resolved' then
    new.resolved_at = now();
  end if;
  return new;
end;
$$ language plpgsql;

create trigger tickets_resolved_at
  before update on helpdesk.tickets
  for each row execute function set_resolved_at();

-- â”€â”€â”€ RLS (Row Level Security) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Using service role key bypasses RLS â€” safe for MCP server usage

alter table helpdesk.tickets enable row level security;

-- Allow service role full access (MCP server uses service role key)
create policy "Service role full access"
  on helpdesk.tickets for all
  using (true)
  with check (true);

-- â”€â”€â”€ Sample seed data (optional) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

insert into helpdesk.tickets (title, description, priority, status, category, requester_name, requester_email, language)
values
  ('Cannot connect to VPN from home office', 
   'Since this morning I am unable to connect to the company VPN. Error: authentication failed. I have not changed my password.', 
   'P2', 'open', 'network', 'Anna MÃ¼ller', 'anna.mueller@company.ch', 'de'),
  ('Printer on 3rd floor not working', 
   'The HP LaserJet on the 3rd floor shows paper jam error but there is no paper stuck inside.', 
   'P4', 'open', 'hardware', 'Thomas Keller', 'thomas.keller@company.ch', 'en'),
  ('Outlook keeps crashing on startup', 
   'Microsoft Outlook crashes immediately after opening. Tried restarting. Windows 11, Office 365.', 
   'P3', 'in_progress', 'software', 'Marie Dubois', 'marie.dubois@company.ch', 'en');

