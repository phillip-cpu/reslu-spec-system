-- Preserve the full estimate cost while forecasting only unpaid supplier cash.
-- Existing rows remain taxable AUD estimates; foreign/GST-free behaviour is
-- opt-in so this migration cannot silently change other projects.

alter table public.cost_lines
  add column if not exists gst_treatment text not null default 'exclusive';

alter table public.cost_lines
  drop constraint if exists cost_lines_gst_treatment_check;
alter table public.cost_lines
  add constraint cost_lines_gst_treatment_check
  check (gst_treatment in ('exclusive', 'inclusive', 'gst_free', 'not_applicable'));

alter table public.cost_lines
  add column if not exists source_currency text;
alter table public.cost_lines
  add column if not exists source_forecast_total_minor bigint;
alter table public.cost_lines
  add column if not exists forecast_fx_rate numeric(18,8);

alter table public.cost_lines
  drop constraint if exists cost_lines_source_currency_check;
alter table public.cost_lines
  add constraint cost_lines_source_currency_check
  check (source_currency is null or source_currency ~ '^[A-Z]{3}$');

alter table public.cost_lines
  drop constraint if exists cost_lines_source_forecast_total_minor_check;
alter table public.cost_lines
  add constraint cost_lines_source_forecast_total_minor_check
  check (source_forecast_total_minor is null or source_forecast_total_minor >= 0);

alter table public.cost_lines
  drop constraint if exists cost_lines_forecast_fx_rate_check;
alter table public.cost_lines
  add constraint cost_lines_forecast_fx_rate_check
  check (forecast_fx_rate is null or forecast_fx_rate > 0);

comment on column public.cost_lines.gst_treatment is
  'Cash tax treatment. Existing rows default to exclusive (estimate is ex GST); foreign GST-free rows opt in explicitly.';
comment on column public.cost_lines.source_currency is
  'Optional ISO 4217 source currency for a supplier obligation, e.g. USD.';
comment on column public.cost_lines.source_forecast_total_minor is
  'Confirmed supplier obligation in source-currency minor units used for cash forecasting. The AUD estimate remains the full budget, so uncertain outstanding items are not silently treated as due.';
comment on column public.cost_lines.forecast_fx_rate is
  'Planning-only AUD per source-currency unit used for unpaid future cash. Never treated as a settled payment rate.';

create table if not exists public.cost_line_source_payments (
  id uuid primary key default gen_random_uuid(),
  cost_line_id uuid not null references public.cost_lines(id) on delete cascade,
  source_amount_minor bigint not null check (source_amount_minor > 0),
  paid_on date,
  settled_aud_minor bigint check (settled_aud_minor is null or settled_aud_minor >= 0),
  evidence_reference text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cost_line_source_payments_line
  on public.cost_line_source_payments(cost_line_id, paid_on);

drop trigger if exists trg_cost_line_source_payments_updated_at
  on public.cost_line_source_payments;
create trigger trg_cost_line_source_payments_updated_at
  before update on public.cost_line_source_payments
  for each row execute function public.set_updated_at();

alter table public.cost_line_source_payments enable row level security;
revoke all on public.cost_line_source_payments from anon;
grant select, insert, update, delete on public.cost_line_source_payments to authenticated;

drop policy if exists "team_read" on public.cost_line_source_payments;
create policy "team_read" on public.cost_line_source_payments
  for select to authenticated using (true);

drop policy if exists "admin_insert" on public.cost_line_source_payments;
create policy "admin_insert" on public.cost_line_source_payments
  for insert to authenticated
  with check (exists (
    select 1 from public.profiles
    where profiles.id = auth.uid() and profiles.role = 'admin'
  ));

drop policy if exists "admin_update" on public.cost_line_source_payments;
create policy "admin_update" on public.cost_line_source_payments
  for update to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = auth.uid() and profiles.role = 'admin'
  ))
  with check (exists (
    select 1 from public.profiles
    where profiles.id = auth.uid() and profiles.role = 'admin'
  ));

drop policy if exists "admin_delete" on public.cost_line_source_payments;
create policy "admin_delete" on public.cost_line_source_payments
  for delete to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = auth.uid() and profiles.role = 'admin'
  ));

comment on table public.cost_line_source_payments is
  'Evidence-backed supplier payments in source currency. paid_on and settled_aud_minor remain null until the actual evidence is known.';

notify pgrst, 'reload schema';
