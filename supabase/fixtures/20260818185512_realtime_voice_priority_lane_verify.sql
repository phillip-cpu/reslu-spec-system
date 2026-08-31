-- Run after 20260818185512_realtime_voice_priority_lane.sql. This verifier
-- proves the voice and standard workers claim disjoint rows atomically and
-- rolls every synthetic message/job back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_agent_id uuid;
  v_agent_slug text;
  v_voice_message_id uuid := gen_random_uuid();
  v_text_message_id uuid := gen_random_uuid();
  v_voice_job agent_conversation_jobs;
  v_text_job agent_conversation_jobs;
  v_claimed_voice agent_conversation_jobs;
  v_claimed_text agent_conversation_jobs;
begin
  if to_regprocedure('public.claim_agent_realtime_voice_job(text)') is null then
    raise exception 'FAIL: Realtime voice claim function is missing';
  end if;
  if has_function_privilege('anon', 'public.claim_agent_realtime_voice_job(text)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_agent_realtime_voice_job(text)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_agent_realtime_voice_job(text)', 'execute') then
    raise exception 'FAIL: voice claim privileges are not service-only';
  end if;

  select human.profile_id, human.conversation_id, agent.id, agent.slug
  into v_profile_id, v_conversation_id, v_agent_id, v_agent_slug
  from conversation_participants human
  join conversation_participants agent_participant
    on agent_participant.conversation_id = human.conversation_id
   and agent_participant.agent_id is not null
  join conversation_agents agent on agent.id = agent_participant.agent_id
  where human.profile_id is not null
  order by human.joined_at
  limit 1;
  if v_profile_id is null then
    raise exception 'FAIL: no human/agent conversation exists for the rollback verifier';
  end if;

  insert into conversation_messages(
    id, conversation_id, author_profile_id, body, metadata, created_at
  ) values (
    v_voice_message_id,
    v_conversation_id,
    v_profile_id,
    'Synthetic voice lane verifier',
    jsonb_build_object('source', 'voice', 'transport', 'openai_realtime_webrtc'),
    now() - interval '100 years'
  ), (
    v_text_message_id,
    v_conversation_id,
    v_profile_id,
    'Synthetic standard lane verifier',
    '{}'::jsonb,
    now() - interval '100 years' + interval '1 second'
  );

  select * into v_voice_job
  from agent_conversation_jobs
  where triggering_message_id = v_voice_message_id and agent_id = v_agent_id;
  select * into v_text_job
  from agent_conversation_jobs
  where triggering_message_id = v_text_message_id and agent_id = v_agent_id;
  if v_voice_job.id is null or v_text_job.id is null then
    raise exception 'FAIL: synthetic queue rows were not created';
  end if;
  update agent_conversation_jobs
  set created_at = case
    when id = v_voice_job.id then now() - interval '100 years'
    else now() - interval '100 years' + interval '1 second'
  end
  where id in (v_voice_job.id, v_text_job.id);

  select * into v_claimed_voice from claim_agent_realtime_voice_job(v_agent_slug);
  select * into v_claimed_text from claim_agent_conversation_job(v_agent_slug);
  if v_claimed_voice.id <> v_voice_job.id
     or v_claimed_text.id <> v_text_job.id
     or v_claimed_voice.id = v_claimed_text.id then
    raise exception 'FAIL: voice and standard claims were not disjoint';
  end if;

  raise exception using errcode = 'P5121', message = 'RESLU_VOICE_PRIORITY_VERIFY_PASS';
exception
  when sqlstate 'P5121' then
    if sqlerrm <> 'RESLU_VOICE_PRIORITY_VERIFY_PASS' then raise; end if;
    raise notice 'PASS: Realtime voice and standard chat claims are atomic, disjoint and service-only; all test changes rolled back';
end;
$verify$;
