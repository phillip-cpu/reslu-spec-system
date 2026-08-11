-- Run in the Supabase SQL Editor only after migration 111 succeeds.
-- The nested exception rolls every test row and state change back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_agent_id uuid;
  v_task_id uuid := gen_random_uuid();
  v_task agent_tasks;
  v_event_count integer;
  v_artifact_id uuid;
begin
  if to_regprocedure('public.retry_failed_agent_task(uuid,uuid)') is null then
    raise exception 'FAIL: migration 111 retry function is missing';
  end if;
  if not has_function_privilege('authenticated', 'public.retry_failed_agent_task(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.retry_failed_agent_task(uuid,uuid)', 'EXECUTE') then
    raise exception 'FAIL: retry function privileges are incorrect';
  end if;

  select participant.profile_id, participant.conversation_id, agent.id
  into v_profile_id, v_conversation_id, v_agent_id
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
      title, objective, status, model_tier, claimed_at, completed_at, error,
      gateway_run_id, progress_label, progress_updated_at
    ) values (
      v_task_id, v_conversation_id, v_profile_id, v_agent_id,
      'verify-111-' || v_task_id::text,
      'Verify safe task retry', 'Rollback-only failed task', 'failed', 'strong',
      now() - interval '2 minutes', now() - interval '1 minute', 'Synthetic failure',
      'verify-run-' || v_task_id::text, 'Using RESLU tools', now()
    );

    select * into strict v_task
    from retry_failed_agent_task(v_conversation_id, v_task_id);

    if v_task.id <> v_task_id
       or v_task.status <> 'queued'
       or v_task.retry_count <> 1
       or v_task.claimed_at is not null
       or v_task.completed_at is not null
       or v_task.result_summary is not null
       or v_task.model_name is not null
       or v_task.error is not null
       or v_task.progress_label is not null
       or v_task.progress_updated_at is not null
       or v_task.gateway_run_id is not null then
      raise exception 'FAIL: retry did not safely requeue the same canonical task';
    end if;

    select count(*) into v_event_count
    from agent_task_events
    where task_id = v_task_id
      and event_type = 'queued'
      and label = 'Task queued again'
      and metadata @> '{"recovery":true}'::jsonb;
    if v_event_count <> 1 then
      raise exception 'FAIL: retry did not append exactly one recovery event';
    end if;

    update agent_tasks
    set status = 'failed', approval_state = 'pending', error = 'Synthetic pending approval failure'
    where id = v_task_id;

    begin
      perform retry_failed_agent_task(v_conversation_id, v_task_id);
      raise exception 'FAIL: task with pending approval was allowed to retry';
    exception
      when others then
        if sqlerrm <> 'task with pending approval cannot be retried' then raise; end if;
    end;

    update agent_tasks
    set status = 'failed', approval_state = 'approved', error = 'Synthetic approved failure'
    where id = v_task_id;

    begin
      perform retry_failed_agent_task(v_conversation_id, v_task_id);
      raise exception 'FAIL: approved task was allowed to retry';
    exception
      when others then
        if sqlerrm <> 'approved task cannot be retried automatically' then raise; end if;
    end;

    update agent_tasks
    set status = 'failed', approval_state = 'none', error = 'Synthetic approved artifact failure'
    where id = v_task_id;
    insert into agent_task_artifacts(task_id, artifact_key, kind, title, content, status)
    values (
      v_task_id,
      'verify-approved-artifact',
      'record_change',
      'Synthetic approved artifact',
      '{}'::jsonb,
      'approved'
    ) returning id into v_artifact_id;

    begin
      perform retry_failed_agent_task(v_conversation_id, v_task_id);
      raise exception 'FAIL: task with an approved artifact was allowed to retry';
    exception
      when others then
        if sqlerrm <> 'approved task cannot be retried automatically' then raise; end if;
    end;
    delete from agent_task_artifacts where id = v_artifact_id;

    update agent_tasks
    set status = 'failed', approval_state = 'none', retry_count = 3, error = 'Synthetic retry exhaustion'
    where id = v_task_id;

    begin
      perform retry_failed_agent_task(v_conversation_id, v_task_id);
      raise exception 'FAIL: exhausted task was allowed to retry';
    exception
      when others then
        if sqlerrm <> 'task retry limit reached' then raise; end if;
    end;

    raise exception using errcode = 'P5099', message = 'RESLU_VERIFY_111_PASS';
  exception
    when sqlstate 'P5099' then
      if sqlerrm <> 'RESLU_VERIFY_111_PASS' then raise; end if;
      raise notice 'PASS: failed unapproved tasks use bounded distinct attempts; approved actions cannot be replayed; all test changes rolled back';
  end;
end;
$verify$;
