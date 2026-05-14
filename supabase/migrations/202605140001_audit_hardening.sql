-- Audit hardening baseline for Fit Leads HR.
-- Safe to run against an existing project: all schema changes are additive.

create table if not exists settings (
  id text primary key default 'singleton',
  qualification_rules jsonb not null default '{"requireNoWebsite": true, "requirePhone": true}'::jsonb,
  custom_terms text[] not null default array[]::text[]
);

insert into settings (id)
values ('singleton')
on conflict (id) do nothing;

alter table leads
  add column if not exists qualified_override boolean;

create table if not exists scrape_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  source text not null check (source in ('google', 'instagram')),
  params jsonb not null default '{}',
  counts jsonb not null default '{}',
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  error_message text
);

create table if not exists scrape_run_leads (
  run_id uuid not null references scrape_runs(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  primary key (run_id, lead_id)
);

create index if not exists scrape_run_leads_run_id_idx
  on scrape_run_leads(run_id);

create index if not exists scrape_run_leads_lead_id_idx
  on scrape_run_leads(lead_id);

create index if not exists leads_instagram_followers_idx
  on leads(instagram_followers);

create index if not exists leads_instagram_handle_idx
  on leads(instagram_handle);

create index if not exists leads_qualified_priority_created_idx
  on leads(qualified, priority desc, created_at desc);
