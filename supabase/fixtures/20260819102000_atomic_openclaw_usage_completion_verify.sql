begin;

do $$
declare
  actor_id uuid;
  owner_id uuid;
  specialist_id uuid;
  conversation_id uuid;
  triggering_message_id uuid;
  job_id uuid;
  response_message_id uuid;
  stored_usage jsonb;
  usage_sample constant jsonb := '{
    "schema_version": 1,
    "provider": "openai",
    "model": "gpt-5.6-terra",
    "input_tokens": 100,
    "output_tokens": 5,
    "cache_read_tokens": 20,
    "cache_write_tokens": 0,
    "total_tokens": 125,
    "cost_usd": 0.001
  }'::jsonb;
begin
  select id into actor_id from public.profiles order by created_at limit 1;
  select id into owner_id from public.conversation_agents where slug = 'aria';
  select id into specialist_id from public.conversation_agents where slug = 'marco';
  if actor_id is null or owner_id is null or specialist_id is null then
    raise exception 'FAIL: acceptance identities are missing';
  end if;

  insert into public.conversations (kind, title, created_by)
  values ('direct', 'Atomic usage verifier', actor_id)
  returning id into conversation_id;

  insert into public.conversation_messages (conversation_id, author_profile_id, body)
  values (conversation_id, actor_id, 'Ask for bounded specialist advice.')
  returning id into triggering_message_id;

  insert into public.agent_conversation_jobs (
    conversation_id, triggering_message_id, agent_id, status, claimed_at
  ) values (
    conversation_id, triggering_message_id, specialist_id, 'processing', now()
  ) returning id into job_id;

  insert into public.conversation_agent_consultations (
    conversation_id, requested_by, owner_agent_id, specialist_agent_id,
    triggering_message_id, specialist_job_id, realtime_tool_call_id,
    status, claimed_at
  ) values (
    conversation_id, actor_id, owner_id, specialist_id,
    triggering_message_id, job_id, 'atomic-usage-verifier',
    'processing', now()
  );

  response_message_id := public.complete_conversation_agent_consultation(
    job_id,
    'Bounded specialist advice.',
    usage_sample
  );

  select openclaw_usage into stored_usage
  from public.agent_conversation_jobs
  where id = job_id and status = 'done';

  if response_message_id is null or stored_usage is distinct from usage_sample then
    raise exception 'FAIL: canonical consultation and usage were not completed atomically';
  end if;
end;
$$;

select 'PASS — specialist completion retains OpenClaw usage atomically' as result;

rollback;
