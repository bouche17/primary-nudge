create table public.message_delivery_status (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  message_sid text not null,
  status text not null,
  phone_number text,
  source text,
  error_code text,
  error_message text
);
create index on public.message_delivery_status (created_at desc);
alter table public.message_delivery_status enable row level security;
grant all on public.message_delivery_status to service_role;

create table public.ops_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  alert_type text not null,
  affected_parents integer not null default 0,
  failure_count integer not null default 0,
  first_error text,
  likely_fix text,
  message text not null,
  channel text,
  delivered boolean not null default false,
  is_test boolean not null default false,
  resolved_at timestamptz
);
create index on public.ops_alerts (alert_type, created_at desc);
alter table public.ops_alerts enable row level security;
grant all on public.ops_alerts to service_role;
grant select, update on public.ops_alerts to authenticated;
create policy "Admins can view alerts" on public.ops_alerts for select to authenticated using (public.has_role(auth.uid(), 'admin'));
create policy "Admins can resolve alerts" on public.ops_alerts for update to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

create table public.failed_inbound (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  phone_number text not null,
  message_type text not null,
  content text,
  error text,
  status text not null default 'pending'
);
alter table public.failed_inbound enable row level security;
grant all on public.failed_inbound to service_role;