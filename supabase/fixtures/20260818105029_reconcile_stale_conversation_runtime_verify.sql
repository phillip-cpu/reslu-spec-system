-- Run after migration 20260818105029. Every synthetic row rolls back.

begin;

create temporary table reslu_runtime_recovery_test (
  profile_id uuid not null,
  conversation_id uuid not null,
  agent_id uuid not null,
  cancelled_task_id uuid not null default gen_random_uuid(),
  failed_task_id uuid not null default gen_random_uuid(),
  fresh_task_id uuid not null default gen_random_uuid(),
  stale_call_id uuid not null default gen_random_uuid(),
  consult_job_id uuid
) on commit drop;

insert into reslu_runtime_recovery_test(profile_id, conversation_id, agent_id)
select human.profile_id, conversation.id, agent_participant.agent_id
from conversations conversation
join conversation_participants human
  on human.conversation_id = conversation.id and human.profile_id is not null
join conversation_participants agent_participant
  on agent_participant.conversation_id = conversation.id and agent_participant.agent_id is not null
where conversation.kind = 'direct'
limit 1;

do $$
begin
  if to_regprocedure('public.reconcile_stale_conversation_runtime()') is null then
    raise exception 'FAIL: runtime recovery function is missing';
  end if;
  if has_function_privilege('authenticated', 'public.reconcile_stale_conversation_runtime()', 'EXECUTE')
     or has_function_privilege('anon', 'public.reconcile_stale_conversation_runtime()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.reconcile_stale_conversation_runtime()', 'EXECUTE') then
    raise exception 'FAIL: runtime recovery privileges are incorrect';
  end if;
  if to_regclass('public.conversation_calls_one_active_per_starter') is null then
    raise exception 'FAIL: one-active-call index is missing';
  end if;
  if not exists (select 1 from reslu_runtime_recovery_test) then
    raise exception 'FAIL: no direct human/agent conversation exists for rollback verification';
  end if;
end;
$$;

insert into agent_tasks(
  id, conversation_id, requested_by, owner_agent_id, client_task_id,
  title, objective, status, claimed_at, cancellation_requested_at,
  progress_updated_at, approval_state
)
select cancelled_task_id, conversation_id, profile_id, agent_id,
  'watchdog-cancel-' || cancelled_task_id::text,
  'Cancelled stale task', 'Rollback-only cancellation recovery', 'running',
  now() - interval '2 hours', now() - interval '10 minutes',
  now() - interval '2 hours', 'none'
from reslu_runtime_recovery_test
union all
select failed_task_id, conversation_id, profile_id, agent_id,
  'watchdog-fail-' || failed_task_id::text,
  'Failed stale task', 'Rollback-only failure recovery', 'running',
  now() - interval '2 hours', null,
  now() - interval '2 hours', 'none'
from reslu_runtime_recovery_test
union all
select fresh_task_id, conversation_id, profile_id, agent_id,
  'watchdog-fresh-' || fresh_task_id::text,
  'Fresh running task', 'Must remain running', 'running',
  now() - interval '2 hours', null,
  now() - interval '5 minutes', 'none'
from reslu_runtime_recovery_test;

insert into conversation_calls(
  id, conversation_id, started_by, status, presentation, started_at, client_call_id
)
select stale_call_id, conversation_id, profile_id, 'active', 'office',
  now() - interval '5 hours', gen_random_uuid()
from reslu_runtime_recovery_test;

with source_message as (
  insert into conversation_messages(
    conversation_id, author_profile_id, kind, body, metadata
  )
  select
    conversation_id,
    profile_id,
    'text',
    'Rollback-only stale call consult',
    jsonb_build_object('realtime_call_id', stale_call_id)
  from reslu_runtime_recovery_test
  returning id, conversation_id
), created_job as (
  insert into agent_conversation_jobs(conversation_id, triggering_message_id, agent_id, status)
  select source_message.conversation_id, source_message.id, test.agent_id, 'processing'
  from source_message
  cross join reslu_runtime_recovery_test test
  returning id
)
update reslu_runtime_recovery_test
set consult_job_id = created_job.id
from created_job;

do $$
declare
  test reslu_runtime_recovery_test%rowtype;
  first_run record;
  second_run record;
  cancelled_status text;
  failed_status text;
  failed_error text;
  fresh_status text;
  call_status text;
  call_reason text;
  job_status text;
  cancelled_events integer;
  failed_events integer;
  call_records integer;
begin
  select * into strict test from reslu_runtime_recovery_test;
  select * into strict first_run from reconcile_stale_conversation_runtime();

  select status into strict cancelled_status from agent_tasks where id = test.cancelled_task_id;
  select status, error into strict failed_status, failed_error from agent_tasks where id = test.failed_task_id;
  select status into strict fresh_status from agent_tasks where id = test.fresh_task_id;
  select status, metadata->>'active_call_recovery_reason'
    into strict call_status, call_reason
  from conversation_calls where id = test.stale_call_id;
  select status into strict job_status from agent_conversation_jobs where id = test.consult_job_id;
  select count(*) into cancelled_events from agent_task_events
    where task_id = test.cancelled_task_id and event_type = 'cancelled'
      and metadata @> '{"recovery":true}'::jsonb;
  select count(*) into failed_events from agent_task_events
    where task_id = test.failed_task_id and event_type = 'failed'
      and metadata @> '{"recovery":true}'::jsonb;
  select count(*) into call_records from conversation_messages
    where kind = 'call_record' and metadata->>'call_id' = test.stale_call_id::text;

  if first_run.cancelled_tasks <> 1 or cancelled_status <> 'cancelled' or cancelled_events <> 1 then
    raise exception 'FAIL: cancellation-requested task was not terminally cancelled once';
  end if;
  if first_run.failed_tasks <> 1 or failed_status <> 'failed' or failed_events <> 1
     or failed_error not like 'Worker stopped before task completion.%' then
    raise exception 'FAIL: abandoned task was not terminally failed with a safe retry explanation';
  end if;
  if fresh_status <> 'running' then
    raise exception 'FAIL: a recently progressing task was interrupted';
  end if;
  if first_run.dropped_calls <> 1 or call_status <> 'dropped'
     or call_reason <> 'stale_active_watchdog' or job_status <> 'cancelled'
     or call_records <> 1 then
    raise exception 'FAIL: stale call recovery did not drop the call, cancel late output and write one record';
  end if;

  select * into strict second_run from reconcile_stale_conversation_runtime();
  if second_run.cancelled_tasks <> 0 or second_run.failed_tasks <> 0
     or second_run.dropped_calls <> 0 or second_run.cancelled_jobs <> 0
     or second_run.call_records <> 0 then
    raise exception 'FAIL: runtime recovery is not idempotent';
  end if;
end;
$$;

select 'PASS — stale tasks/calls recover terminally without replaying work; fresh progress is preserved' as result;

rollback;
