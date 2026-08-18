begin;

do $$
begin
  if to_regprocedure('public.claim_pending_health_diagnostics(integer)') is null then
    raise exception 'FAIL: diagnostic claim function is missing';
  end if;
  if has_function_privilege('authenticated', 'public.claim_pending_health_diagnostics(integer)', 'execute') then
    raise exception 'FAIL: authenticated clients can claim diagnostics directly';
  end if;
  if not has_function_privilege('service_role', 'public.claim_pending_health_diagnostics(integer)', 'execute') then
    raise exception 'FAIL: service role cannot claim diagnostics';
  end if;
end;
$$;

create temporary table reslu_health_diagnostic_test_ids (
  kind text primary key,
  id uuid not null
) on commit drop;

with inserted as (
  insert into public.health_diagnostics (status, requested_at, claimed_at, claim_attempts)
  values ('running', now() - interval '20 minutes', now() - interval '20 minutes', 1)
  returning id
)
insert into reslu_health_diagnostic_test_ids (kind, id)
select 'stale', id from inserted;

select * from public.claim_pending_health_diagnostics(5);

do $$
declare
  stale_row public.health_diagnostics%rowtype;
begin
  select diagnostic.* into stale_row
  from public.health_diagnostics diagnostic
  join reslu_health_diagnostic_test_ids ids on ids.id = diagnostic.id
  where ids.kind = 'stale';
  if stale_row.status <> 'failed' or stale_row.completed_at is null or stale_row.report is null then
    raise exception 'FAIL: abandoned diagnostic was not terminally failed';
  end if;

end;
$$;

with inserted as (
  insert into public.health_diagnostics (status, requested_at, claimed_at, claim_attempts)
  values ('running', now() - interval '20 minutes', now() - interval '2 minutes', 1)
  returning id
)
insert into reslu_health_diagnostic_test_ids (kind, id)
select 'fresh', id from inserted;

select * from public.claim_pending_health_diagnostics(5);

do $$
declare
  fresh_row public.health_diagnostics%rowtype;
begin
  select diagnostic.* into fresh_row
  from public.health_diagnostics diagnostic
  join reslu_health_diagnostic_test_ids ids on ids.id = diagnostic.id
  where ids.kind = 'fresh';
  if fresh_row.status <> 'running' or fresh_row.completed_at is not null then
    raise exception 'FAIL: fresh diagnostic claim was disturbed';
  end if;
end;
$$;

update public.health_diagnostics
set status = 'failed', completed_at = now(), report = 'fixture transition'
where id = (select id from reslu_health_diagnostic_test_ids where kind = 'fresh');

with inserted as (
  insert into public.health_diagnostics (status, requested_at, claimed_at, claim_attempts)
  values ('pending', now() - interval '1 minute', null, 0)
  returning id
)
insert into reslu_health_diagnostic_test_ids (kind, id)
select 'pending', id from inserted;

create temporary table reslu_health_diagnostic_claimed on commit drop as
select * from public.claim_pending_health_diagnostics(5);

do $$
declare
  pending_row public.health_diagnostics%rowtype;
begin
  select diagnostic.* into pending_row
  from public.health_diagnostics diagnostic
  join reslu_health_diagnostic_test_ids ids on ids.id = diagnostic.id
  where ids.kind = 'pending';
  if pending_row.status <> 'running' or pending_row.claimed_at is null or pending_row.claim_attempts <> 1 then
    raise exception 'FAIL: pending diagnostic was not claimed with lease metadata';
  end if;
  if not exists (select 1 from reslu_health_diagnostic_claimed where id = pending_row.id) then
    raise exception 'FAIL: claimed diagnostic was not returned to the runner';
  end if;
  if exists (select 1 from public.claim_pending_health_diagnostics(5)) then
    raise exception 'FAIL: an immediate second poll reclaimed work';
  end if;
end;
$$;

select 'PASS — diagnostic claims are atomic, bounded and terminally recover abandoned runners' as result;

rollback;
