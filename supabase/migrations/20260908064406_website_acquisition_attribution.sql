-- Apply before deploying the matching intake handler. Additive only: existing
-- leads, attribution, RLS and permissions remain unchanged. Do not backfill guesses.
alter table public.leads
  add column if not exists gbraid text,
  add column if not exists wbraid text,
  add column if not exists utm_term text,
  add column if not exists attribution_landing_page text,
  add column if not exists attribution_captured_at timestamptz,
  add column if not exists rooms text[] not null default '{}';
comment on column public.leads.attribution_captured_at is
  'Client-recorded acquisition touch time, not lead receipt time or verified consent.';
comment on column public.leads.rooms is
  'Website visitor-selected spaces; not a qualification or contract scope.';
