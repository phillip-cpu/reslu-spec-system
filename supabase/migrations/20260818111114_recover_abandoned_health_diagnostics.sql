-- Recover diagnostic requests claimed by a Mac runner that was killed or
-- trapped in an external command. Claims are terminal after ten minutes: the
-- system never repeats a repair automatically because the first attempt may
-- already have changed local state.

alter table public.health_diagnostics
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_attempts integer not null default 0;

alter table public.health_diagnostics
  drop constraint if exists health_diagnostics_claim_attempts_check;

alter table public.health_diagnostics
  add constraint health_diagnostics_claim_attempts_check
  check (claim_attempts >= 0 and claim_attempts <= 10);

update public.health_diagnostics
set
  status = 'failed',
  claimed_at = coalesce(claimed_at, requested_at),
  completed_at = coalesce(completed_at, now()),
  report = coalesce(
    nullif(report, ''),
    'The diagnostics runner stopped before reporting a result. Run diagnostics again if it is still needed.'
  )
where status = 'running'
  and coalesce(claimed_at, requested_at) < now() - interval '10 minutes';

create or replace function public.claim_pending_health_diagnostics(
  p_limit integer default 5
)
returns setof public.health_diagnostics
language sql
security invoker
set search_path = ''
as $$
  with recovered as (
    update public.health_diagnostics
    set
      status = 'failed',
      completed_at = now(),
      report = coalesce(
        nullif(report, ''),
        'The diagnostics runner stopped before reporting a result. Run diagnostics again if it is still needed.'
      )
    where status = 'running'
      and coalesce(claimed_at, requested_at) < now() - interval '10 minutes'
    returning id
  ), candidates as (
    select diagnostic.id
    from public.health_diagnostics diagnostic
    where diagnostic.status = 'pending'
    order by diagnostic.requested_at asc
    limit greatest(1, least(coalesce(p_limit, 5), 10))
    for update skip locked
  ), claimed as (
    update public.health_diagnostics diagnostic
    set
      status = 'running',
      claimed_at = now(),
      claim_attempts = diagnostic.claim_attempts + 1
    from candidates
    where diagnostic.id = candidates.id
    returning diagnostic.*
  )
  select claimed.*
  from claimed
  order by claimed.requested_at asc;
$$;

revoke all on function public.claim_pending_health_diagnostics(integer)
  from public, anon, authenticated;
grant execute on function public.claim_pending_health_diagnostics(integer)
  to service_role;

comment on function public.claim_pending_health_diagnostics(integer) is
  'Service-only atomic diagnostic claim. Terminally fails abandoned claims after ten minutes and never retries or replays a repair automatically.';
