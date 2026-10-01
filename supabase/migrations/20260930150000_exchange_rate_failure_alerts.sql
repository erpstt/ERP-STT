create table if not exists public.exchange_rate_update_incidents (
  incident_id bigint generated always as identity primary key,
  country_code text not null,
  currency_pair text not null,
  effective_date date not null,
  error_message text not null,
  attempt_count integer not null default 1 check (attempt_count > 0),
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  notified_at timestamptz,
  last_notification_error text,
  resolved_at timestamptz,
  unique (country_code, currency_pair, effective_date)
);

create index if not exists exchange_rate_update_incidents_pending_idx
  on public.exchange_rate_update_incidents(last_failed_at)
  where notified_at is null and resolved_at is null;

alter table public.exchange_rate_update_incidents enable row level security;
revoke all on public.exchange_rate_update_incidents from anon, authenticated;
grant select, insert, update on public.exchange_rate_update_incidents to service_role;
grant usage, select on sequence public.exchange_rate_update_incidents_incident_id_seq to service_role;

