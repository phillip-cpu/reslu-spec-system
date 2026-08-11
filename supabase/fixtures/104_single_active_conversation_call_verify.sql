-- Run in the Supabase SQL Editor only after migration 104 succeeds.
-- It proves that starting a new call drops the previous canonical call,
-- cancels only its unfinished conversational consult and leaves durable work
-- running. Every test row is rolled back.

begin;

create temporary table reslu_single_active_call_test (
  profile_id uuid not null,
  conversation_id uuid not null,
  agent_id uuid not null,
  first_client_call_id uuid not null,
  second_client_call_id uuid not null,
  first_call_id uuid,
  second_call_id uuid,
  retried_call_id uuid,
  consult_job_id uuid,
  durable_task_id uuid
) on commit drop;

insert into reslu_single_active_call_test (
  profile_id,
  conversation_id,
  agent_id,
  first_client_call_id,
  second_client_call_id
)
select
  human.profile_id,
  conversation.id,
  agent_participant.agent_id,
  gen_random_uuid(),
  gen_random_uuid()
from conversations conversation
join conversation_participants human
  on human.conversation_id = conversation.id
 and human.profile_id is not null
join conversation_participants agent_participant
  on agent_participant.conversation_id = conversation.id
 and agent_participant.agent_id is not null
where conversation.kind = 'direct'
limit 1;

do $$
begin
  if to_regprocedure(
    'public.create_conversation_call_idempotent(uuid,text,uuid)'
  ) is null then
    raise exception 'FAIL: migration 104 call function is missing';
  end if;
  if to_regclass(
    'public.conversation_calls_one_active_per_starter'
  ) is null then
    raise exception 'FAIL: migration 104 active-call index is missing';
  end if;
  if not exists (select 1 from reslu_single_active_call_test) then
    raise exception 'FAIL: no direct staff-to-agent conversation exists for the rollback test';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  (select profile_id::text from reslu_single_active_call_test),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  test reslu_single_active_call_test%rowtype;
  created conversation_calls;
  source_message_id uuid;
  v_consult_job_id uuid;
  v_durable_task_id uuid;
begin
  select * into strict test from reslu_single_active_call_test;

  created := create_conversation_call_idempotent(
    test.conversation_id,
    'office',
    test.first_client_call_id
  );
  update reslu_single_active_call_test set first_call_id = created.id;

  insert into conversation_messages(
    conversation_id,
    author_profile_id,
    kind,
    body,
    metadata
  ) values (
    test.conversation_id,
    test.profile_id,
    'text',
    'Migration 104 cancellable consult',
    jsonb_build_object(
      'background_task', true,
      'realtime_call_id', created.id
    )
  ) returning id into source_message_id;

  insert into agent_conversation_jobs(
    conversation_id,
    triggering_message_id,
    agent_id
  ) values (
    test.conversation_id,
    source_message_id,
    test.agent_id
  ) returning id into v_consult_job_id;

  insert into agent_tasks(
    conversation_id,
    requested_by,
    owner_agent_id,
    source_message_id,
    source_call_id,
    client_task_id,
    title,
    objective,
    requested_via,
    model_tier
  ) values (
    test.conversation_id,
    test.profile_id,
    test.agent_id,
    source_message_id,
    created.id,
    'verify-104-' || gen_random_uuid()::text,
    'Migration 104 durable task',
    'Remain queued after the source call is superseded.',
    'voice',
    'strong'
  ) returning id into v_durable_task_id;

  update reslu_single_active_call_test
  set consult_job_id = v_consult_job_id,
      durable_task_id = v_durable_task_id;

  created := create_conversation_call_idempotent(
    test.conversation_id,
    'driving',
    test.second_client_call_id
  );
  update reslu_single_active_call_test set second_call_id = created.id;

  created := create_conversation_call_idempotent(
    test.conversation_id,
    'driving',
    test.second_client_call_id
  );
  update reslu_single_active_call_test set retried_call_id = created.id;
end;
$$;

do $$
declare
  test reslu_single_active_call_test%rowtype;
  first_call conversation_calls;
  second_call conversation_calls;
  consult_status text;
  durable_status text;
  active_count integer;
  dropped_record_count integer;
begin
  select * into strict test from reslu_single_active_call_test;
  select * into strict first_call from conversation_calls where id = test.first_call_id;
  select * into strict second_call from conversation_calls where id = test.second_call_id;
  select status into strict consult_status from agent_conversation_jobs where id = test.consult_job_id;
  select status into strict durable_status from agent_tasks where id = test.durable_task_id;

  select count(*) into active_count
  from conversation_calls
  where started_by = test.profile_id and status = 'active';

  select count(*) into dropped_record_count
  from conversation_messages
  where kind = 'call_record'
    and metadata->>'call_id' = test.first_call_id::text
    and metadata->>'reason' = 'superseded_by_new_call';

  if test.second_call_id is null or test.retried_call_id <> test.second_call_id then
    raise exception 'FAIL: retry did not return the same second call';
  end if;
  if first_call.status <> 'dropped' or first_call.ended_at is null then
    raise exception 'FAIL: the first active call was not truthfully dropped and ended';
  end if;
  if first_call.metadata->>'active_call_recovery_reason' <> 'superseded_by_new_call' then
    raise exception 'FAIL: the first call has no supersession reason';
  end if;
  if second_call.status <> 'active' or active_count <> 1 then
    raise exception 'FAIL: exactly one newest active call was not retained';
  end if;
  if dropped_record_count <> 1 then
    raise exception 'FAIL: the dropped call did not create exactly one canonical call record';
  end if;
  if consult_status <> 'cancelled' then
    raise exception 'FAIL: unfinished conversational output was not cancelled';
  end if;
  if durable_status <> 'queued' then
    raise exception 'FAIL: durable background work was incorrectly cancelled';
  end if;
end;
$$;

select
  'PASS — migration 104 allows one active call, cancels late consult output and preserves durable tasks' as result,
  first_call_id,
  second_call_id,
  durable_task_id
from reslu_single_active_call_test;

rollback;
