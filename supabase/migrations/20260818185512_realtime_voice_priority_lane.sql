-- Keep active Realtime calls out of the ordinary typed-chat queue. Voice turns
-- already use call-scoped OpenClaw sessions, so a dedicated serial worker per
-- agent can process them without racing the canonical typed-chat session.

create index if not exists agent_conversation_jobs_agent_active_idx
  on agent_conversation_jobs(agent_id, created_at, id)
  where status in ('pending', 'processing');

create or replace function claim_agent_realtime_voice_job(p_agent_slug text)
returns setof agent_conversation_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update agent_conversation_jobs j
  set status = 'processing', claimed_at = now()
  where j.id = (
    select candidate.id
    from agent_conversation_jobs candidate
    join conversation_agents a on a.id = candidate.agent_id
    join conversation_messages message on message.id = candidate.triggering_message_id
    where a.slug = p_agent_slug
      and (
        candidate.status = 'pending'
        or (
          candidate.status = 'processing'
          and candidate.claimed_at < now() - interval '15 minutes'
        )
      )
      and message.metadata ->> 'source' = 'voice'
      and message.metadata ->> 'transport' = 'openai_realtime_webrtc'
    order by candidate.created_at, candidate.id
    for update of candidate skip locked
    limit 1
  )
  returning j.*;
end;
$$;

-- The legacy claim name remains the standard chat lane. Excluding Realtime
-- rows is what makes the two workers disjoint and prevents duplicate claims.
create or replace function claim_agent_conversation_job(p_agent_slug text)
returns setof agent_conversation_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update agent_conversation_jobs j
  set status = 'processing', claimed_at = now()
  where j.id = (
    select candidate.id
    from agent_conversation_jobs candidate
    join conversation_agents a on a.id = candidate.agent_id
    join conversation_messages message on message.id = candidate.triggering_message_id
    where a.slug = p_agent_slug
      and (
        candidate.status = 'pending'
        or (
          candidate.status = 'processing'
          and candidate.claimed_at < now() - interval '15 minutes'
        )
      )
      and not (
        message.metadata ->> 'source' = 'voice'
        and message.metadata ->> 'transport' = 'openai_realtime_webrtc'
      )
    order by candidate.created_at, candidate.id
    for update of candidate skip locked
    limit 1
  )
  returning j.*;
end;
$$;

revoke all on function claim_agent_realtime_voice_job(text)
  from public, anon, authenticated;
grant execute on function claim_agent_realtime_voice_job(text)
  to service_role;

revoke all on function claim_agent_conversation_job(text)
  from public, anon, authenticated;
grant execute on function claim_agent_conversation_job(text)
  to service_role;

comment on function claim_agent_realtime_voice_job(text) is
  'Service-only atomic Realtime voice claim. Disjoint from the standard conversation worker lane.';
