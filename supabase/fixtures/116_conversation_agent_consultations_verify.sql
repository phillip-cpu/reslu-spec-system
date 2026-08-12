-- Run only after migration 116. This verifier proves one owner, one active
-- specialist, idempotent queueing, owner-authored completion and member-only
-- visibility, then rolls every test row back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_owner_id uuid;
  v_owner_slug text;
  v_specialist_id uuid;
  v_specialist_slug text;
  v_call_id uuid := gen_random_uuid();
  v_tool_call_id text := 'verify_116_' || replace(gen_random_uuid()::text, '-', '_');
  v_first record;
  v_retry record;
  v_response_id uuid;
  v_response_retry_id uuid;
  v_conflict_rejected boolean := false;
  v_direct_write_rejected boolean := false;
begin
  if to_regprocedure('public.start_conversation_agent_consultation(uuid,text,text,uuid,text,text,text)') is null
     or to_regprocedure('public.complete_conversation_agent_consultation(uuid,text)') is null then
    raise exception 'FAIL: migration 116 consultation functions are missing';
  end if;

  select human.profile_id, conversation.id, owner.id, owner.slug
  into v_profile_id, v_conversation_id, v_owner_id, v_owner_slug
  from conversations conversation
  join conversation_participants human
    on human.conversation_id = conversation.id and human.profile_id is not null
  join conversation_participants owner_participant
    on owner_participant.conversation_id = conversation.id and owner_participant.agent_id is not null
  join conversation_agents owner on owner.id = owner_participant.agent_id and owner.active
  where conversation.kind = 'direct'
    and (select count(*) from conversation_participants participant where participant.conversation_id = conversation.id) = 2
  limit 1;
  if v_profile_id is null then
    raise exception 'FAIL: no direct human/agent conversation exists for the rollback test';
  end if;

  select id, slug into v_specialist_id, v_specialist_slug
  from conversation_agents
  where active and id <> v_owner_id
  order by slug
  limit 1;
  if v_specialist_id is null then
    raise exception 'FAIL: a second active RESLU specialist is required';
  end if;
  if exists (
    select 1 from conversation_participants
    where conversation_id = v_conversation_id and agent_id = v_specialist_id
  ) then
    raise exception 'FAIL: specialist unexpectedly belongs to the direct owner conversation';
  end if;

  perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;

  insert into conversation_calls(id, conversation_id, started_by, status, presentation)
  values (v_call_id, v_conversation_id, v_profile_id, 'active', 'office');

  select * into v_first
  from start_conversation_agent_consultation(
    v_conversation_id, v_owner_slug, v_specialist_slug, v_call_id,
    v_tool_call_id, 'verify_response_116', 'Please ask the other specialist for a second opinion.'
  );
  select * into v_retry
  from start_conversation_agent_consultation(
    v_conversation_id, v_owner_slug, v_specialist_slug, v_call_id,
    v_tool_call_id, 'verify_response_116', 'Please ask the other specialist for a second opinion.'
  );

  if v_first.consultation_id is distinct from v_retry.consultation_id
     or v_first.message_id is distinct from v_retry.message_id
     or v_first.job_id is distinct from v_retry.job_id then
    raise exception 'FAIL: retry created duplicate consultation work';
  end if;
  if (select count(*) from conversation_agent_consultations where conversation_id = v_conversation_id and realtime_tool_call_id = v_tool_call_id) <> 1
     or (select count(*) from agent_conversation_jobs where triggering_message_id = v_first.message_id and agent_id = v_specialist_id) <> 1 then
    raise exception 'FAIL: consultation did not queue exactly one specialist job';
  end if;
  if exists (
    select 1 from conversation_participants
    where conversation_id = v_conversation_id and agent_id = v_specialist_id
  ) then
    raise exception 'FAIL: specialist was silently added to the direct conversation';
  end if;

  begin
    perform start_conversation_agent_consultation(
      v_conversation_id, v_owner_slug, v_specialist_slug, v_call_id,
      v_tool_call_id, 'verify_response_116', 'A different request must not reuse the same tool id.'
    );
  exception when others then
    if position('idempotency key conflict' in sqlerrm) > 0 then
      v_conflict_rejected := true;
    else
      raise;
    end if;
  end;
  if not v_conflict_rejected then
    raise exception 'FAIL: mismatched retry reused a specialist consultation id';
  end if;

  begin
    insert into conversation_agent_consultations(
      conversation_id, requested_by, owner_agent_id, specialist_agent_id,
      triggering_message_id, specialist_job_id, source_call_id,
      realtime_tool_call_id
    ) values (
      v_conversation_id, v_profile_id, v_owner_id, v_specialist_id,
      v_first.message_id, v_first.job_id, v_call_id, 'forbidden_direct_write'
    );
  exception when insufficient_privilege then
    v_direct_write_rejected := true;
  end;
  if not v_direct_write_rejected then
    raise exception 'FAIL: authenticated client directly mutated consultation audit rows';
  end if;

  reset role;
  update agent_conversation_jobs
  set status = 'processing', claimed_at = now()
  where id = v_first.job_id;

  v_response_id := complete_conversation_agent_consultation(
    v_first.job_id, 'The specialist advice returned once through the owning agent.'
  );
  v_response_retry_id := complete_conversation_agent_consultation(
    v_first.job_id, 'The specialist advice returned once through the owning agent.'
  );
  if v_response_id is distinct from v_response_retry_id then
    raise exception 'FAIL: completion retry created a duplicate owner response';
  end if;
  if not exists (
    select 1 from conversation_messages response
    where response.id = v_response_id
      and response.author_agent_id = v_owner_id
      and response.author_agent_id <> v_specialist_id
      and response.metadata->>'source' = 'agent_consultation'
      and response.metadata->>'consulted_agent_slug' = v_specialist_slug
      and response.metadata->>'job_id' = v_first.job_id::text
  ) then
    raise exception 'FAIL: specialist answer was not visibly owned and correctly attributed';
  end if;
  if (select count(*) from conversation_messages where metadata->>'job_id' = v_first.job_id::text) <> 1 then
    raise exception 'FAIL: specialist completion created duplicate canonical answers';
  end if;
  if not exists (
    select 1 from conversation_agent_consultations consultation
    join agent_conversation_jobs job on job.id = consultation.specialist_job_id
    where consultation.id = v_first.consultation_id
      and consultation.status = 'done'
      and consultation.response_message_id = v_response_id
      and job.status = 'done'
  ) then
    raise exception 'FAIL: consultation and specialist job did not complete together';
  end if;

  raise exception using errcode = 'P5116', message = 'RESLU_VERIFY_116_PASS';
exception
  when sqlstate 'P5116' then
    if sqlerrm <> 'RESLU_VERIFY_116_PASS' then raise; end if;
    raise notice 'PASS: agent specialist consultation is owner-scoped, idempotent, auditable and exactly once; all test changes rolled back';
end;
$verify$;
