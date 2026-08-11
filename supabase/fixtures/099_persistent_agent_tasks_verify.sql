-- Run in the Supabase SQL Editor only after migration 099 succeeds.
-- This one statement proves durable claim, approval, RLS and event behavior,
-- then rolls every test change back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_agent_id uuid;
  v_agent_slug text;
  v_task_id uuid := gen_random_uuid();
  v_artifact_id uuid := gen_random_uuid();
  v_task agent_tasks;
  v_event_count integer;
begin
  if to_regclass('public.agent_tasks') is null
     or to_regclass('public.agent_task_events') is null
     or to_regclass('public.agent_task_artifacts') is null then
    raise exception 'FAIL: migration 099 tables are missing';
  end if;
  if to_regprocedure('public.claim_agent_task(text)') is null
     or to_regprocedure('public.cancel_agent_task(uuid,uuid)') is null
     or to_regprocedure('public.decide_agent_task_artifact(uuid,uuid,uuid,boolean,text)') is null then
    raise exception 'FAIL: migration 099 task functions are missing';
  end if;
  if has_function_privilege('authenticated', 'public.claim_agent_task(text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated clients can claim background work';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.agent_tasks'::regclass) then
    raise exception 'FAIL: agent_tasks RLS is disabled';
  end if;

  select participant.profile_id, participant.conversation_id, agent.id, agent.slug
  into v_profile_id, v_conversation_id, v_agent_id, v_agent_slug
  from conversation_participants participant
  join conversation_participants agent_participant
    on agent_participant.conversation_id = participant.conversation_id
   and agent_participant.agent_id is not null
  join conversation_agents agent on agent.id = agent_participant.agent_id
  where participant.profile_id is not null
  limit 1;

  if v_profile_id is null then
    raise exception 'FAIL: no human and agent conversation exists for the rollback test';
  end if;

  begin
    perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);

    insert into agent_tasks(
      id, conversation_id, requested_by, owner_agent_id, client_task_id,
      title, objective, requested_via, model_tier, created_at
    ) values (
      v_task_id, v_conversation_id, v_profile_id, v_agent_id,
      'verify-099-' || v_task_id::text,
      'Verify durable task', 'Rollback-only verification task', 'voice', 'strong',
      '1900-01-01 00:00:00+00'
    );

    select count(*) into v_event_count
    from agent_task_events where task_id = v_task_id and event_type = 'created';
    if v_event_count <> 1 then
      raise exception 'FAIL: task creation did not append exactly one event';
    end if;

    select * into strict v_task
    from claim_agent_task(v_agent_slug)
    where id = v_task_id;
    if v_task.status <> 'running' or v_task.claimed_at is null then
      raise exception 'FAIL: task was not durably claimed';
    end if;

    update agent_tasks
    set status = 'awaiting_approval', approval_state = 'pending'
    where id = v_task_id;
    insert into agent_task_artifacts(id, task_id, artifact_key, kind, title, content)
    values (
      v_artifact_id, v_task_id, 'primary', 'email_draft', 'Verification draft',
      '{"to":"test@example.com","subject":"Verification","body":"Draft only"}'::jsonb
    );

    select * into strict v_task
    from decide_agent_task_artifact(v_conversation_id, v_task_id, v_artifact_id, true, 'Approved in rollback test');
    if v_task.status <> 'queued' or v_task.approval_state <> 'approved' then
      raise exception 'FAIL: approval did not explicitly requeue the task';
    end if;

    raise exception using errcode = 'P5099', message = 'RESLU_VERIFY_099_PASS';
  exception
    when sqlstate 'P5099' then
      if sqlerrm <> 'RESLU_VERIFY_099_PASS' then raise; end if;
      raise notice 'PASS: durable tasks, events, model tier and explicit approval are ready; all test changes rolled back';
  end;
end;
$verify$;
