-- Auditable owner-agent consultation of the other active RESLU specialist.
-- The visible conversation agent remains the author/owner; the specialist
-- job supplies advice through the existing OpenClaw bridge and never becomes
-- an implicit participant in a direct conversation.

create table if not exists conversation_agent_consultations (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references conversations(id) on delete cascade,
  requested_by          uuid not null references profiles(id) on delete cascade,
  owner_agent_id        uuid not null references conversation_agents(id) on delete restrict,
  specialist_agent_id   uuid not null references conversation_agents(id) on delete restrict,
  triggering_message_id uuid not null unique references conversation_messages(id) on delete cascade,
  specialist_job_id     uuid not null unique references agent_conversation_jobs(id) on delete cascade,
  response_message_id   uuid unique references conversation_messages(id) on delete set null,
  source_call_id        uuid references conversation_calls(id) on delete set null,
  realtime_tool_call_id text not null check (realtime_tool_call_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  status                text not null default 'pending'
                          check (status in ('pending','processing','done','failed','cancelled')),
  claimed_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  check (owner_agent_id <> specialist_agent_id),
  unique (conversation_id, realtime_tool_call_id)
);

create index if not exists conversation_agent_consultations_thread_idx
  on conversation_agent_consultations(conversation_id, created_at desc);

alter table conversation_agent_consultations enable row level security;

drop policy if exists "members_read_agent_consultations" on conversation_agent_consultations;
create policy "members_read_agent_consultations"
  on conversation_agent_consultations for select to authenticated
  using (is_conversation_member(conversation_id));

create or replace function sync_conversation_agent_consultation_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update conversation_agent_consultations
  set
    status = new.status,
    claimed_at = new.claimed_at,
    completed_at = new.completed_at
  where specialist_job_id = new.id;
  return new;
end;
$$;

drop trigger if exists trg_sync_conversation_agent_consultation_status on agent_conversation_jobs;
create trigger trg_sync_conversation_agent_consultation_status
  after update of status, claimed_at, completed_at on agent_conversation_jobs
  for each row execute function sync_conversation_agent_consultation_status();

create or replace function start_conversation_agent_consultation(
  p_conversation_id uuid,
  p_owner_agent_slug text,
  p_specialist_agent_slug text,
  p_source_call_id uuid,
  p_tool_call_id text,
  p_response_id text,
  p_query text
)
returns table (
  consultation_id uuid,
  message_id uuid,
  job_id uuid,
  consultation_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  owner_row conversation_agents%rowtype;
  specialist_row conversation_agents%rowtype;
  existing_row conversation_agent_consultations%rowtype;
  existing_message conversation_messages%rowtype;
  created_message conversation_messages%rowtype;
  created_job agent_conversation_jobs%rowtype;
begin
  if actor_id is null or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  if p_query is null or char_length(btrim(p_query)) not between 1 and 20000 then
    raise exception 'invalid specialist consultation query';
  end if;
  if p_tool_call_id is null or p_tool_call_id !~ '^[A-Za-z0-9_-]{1,160}$' then
    raise exception 'invalid realtime tool call id';
  end if;
  if p_response_id is not null and p_response_id !~ '^[A-Za-z0-9_-]{1,160}$' then
    raise exception 'invalid realtime response id';
  end if;

  select agent.* into owner_row
  from conversation_agents agent
  join conversation_participants participant on participant.agent_id = agent.id
  where participant.conversation_id = p_conversation_id
    and agent.slug = p_owner_agent_slug
    and agent.active
  limit 1;
  if owner_row.id is null then raise exception 'owner agent not found'; end if;

  select agent.* into specialist_row
  from conversation_agents agent
  where agent.slug = p_specialist_agent_slug and agent.active
  limit 1;
  if specialist_row.id is null or specialist_row.id = owner_row.id then
    raise exception 'specialist agent not found';
  end if;

  if not exists (
    select 1 from conversation_calls call
    where call.id = p_source_call_id
      and call.conversation_id = p_conversation_id
      and call.started_by = actor_id
      and call.status = 'active'
  ) then
    raise exception 'active voice call not found';
  end if;

  -- Serialize concurrent repeats of one provider tool call before the
  -- read/insert boundary. A racing delivery therefore observes and returns
  -- the first canonical consultation instead of surfacing a unique error.
  perform pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':' || p_tool_call_id, 0)
  );

  select consultation.* into existing_row
  from conversation_agent_consultations consultation
  where consultation.conversation_id = p_conversation_id
    and consultation.realtime_tool_call_id = p_tool_call_id;
  if existing_row.id is not null then
    select * into existing_message from conversation_messages where id = existing_row.triggering_message_id;
    if existing_row.requested_by <> actor_id
      or existing_row.owner_agent_id <> owner_row.id
      or existing_row.specialist_agent_id <> specialist_row.id
      or existing_row.source_call_id is distinct from p_source_call_id
      or existing_message.body <> btrim(p_query)
      or existing_message.metadata->>'realtime_response_id' is distinct from p_response_id
    then
      raise exception 'specialist consultation idempotency key conflict';
    end if;
    return query select existing_row.id, existing_row.triggering_message_id,
      existing_row.specialist_job_id, existing_row.status;
    return;
  end if;

  -- A completed new specialist request supersedes only unfinished advisory
  -- work from this owner in the same call. It cannot undo side effects, and
  -- specialist consultations are instructed not to create any.
  update agent_conversation_jobs job
  set status = 'cancelled', completed_at = now()
  where job.id in (
    select consultation.specialist_job_id
    from conversation_agent_consultations consultation
    where consultation.conversation_id = p_conversation_id
      and consultation.source_call_id = p_source_call_id
      and consultation.owner_agent_id = owner_row.id
      and consultation.status in ('pending','processing')
  ) and job.status in ('pending','processing');

  insert into conversation_messages (
    conversation_id, author_profile_id, body, metadata
  ) values (
    p_conversation_id,
    actor_id,
    btrim(p_query),
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'voice',
      'transport', 'openai_realtime_webrtc',
      'realtime_call_id', p_source_call_id,
      'realtime_tool_call_id', p_tool_call_id,
      'realtime_response_id', p_response_id,
      'consultation_kind', 'agent_specialist',
      'owner_agent_slug', owner_row.slug,
      'consulted_agent_slug', specialist_row.slug,
      'target_agent_slugs', jsonb_build_array(specialist_row.slug)
    ))
  ) returning * into created_message;

  insert into agent_conversation_jobs (
    conversation_id, triggering_message_id, agent_id
  ) values (
    p_conversation_id, created_message.id, specialist_row.id
  )
  on conflict (triggering_message_id, agent_id) do update
    set conversation_id = excluded.conversation_id
  returning * into created_job;

  insert into conversation_agent_consultations (
    conversation_id, requested_by, owner_agent_id, specialist_agent_id,
    triggering_message_id, specialist_job_id, source_call_id,
    realtime_tool_call_id, status, claimed_at, completed_at
  ) values (
    p_conversation_id, actor_id, owner_row.id, specialist_row.id,
    created_message.id, created_job.id, p_source_call_id,
    p_tool_call_id, created_job.status, created_job.claimed_at, created_job.completed_at
  ) returning * into existing_row;

  return query select existing_row.id, created_message.id, created_job.id, existing_row.status;
end;
$$;

revoke all on function start_conversation_agent_consultation(uuid,text,text,uuid,text,text,text)
  from public, anon;
grant execute on function start_conversation_agent_consultation(uuid,text,text,uuid,text,text,text)
  to authenticated;

create or replace function complete_conversation_agent_consultation(
  p_job_id uuid,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  consultation_row conversation_agent_consultations%rowtype;
  owner_slug text;
  specialist_slug text;
  created_message_id uuid;
begin
  if p_body is null or char_length(btrim(p_body)) not between 1 and 20000 then
    raise exception 'invalid specialist consultation response';
  end if;

  select consultation.*
  into consultation_row
  from conversation_agent_consultations consultation
  where consultation.specialist_job_id = p_job_id
  for update of consultation;

  if consultation_row.id is null then raise exception 'specialist consultation not found'; end if;
  select slug into owner_slug from conversation_agents where id = consultation_row.owner_agent_id;
  select slug into specialist_slug from conversation_agents where id = consultation_row.specialist_agent_id;
  if consultation_row.status = 'done' and consultation_row.response_message_id is not null then
    return consultation_row.response_message_id;
  end if;
  if consultation_row.status <> 'processing' or not exists (
    select 1 from agent_conversation_jobs job
    where job.id = p_job_id and job.status = 'processing'
  ) then
    raise exception 'specialist consultation is no longer processing';
  end if;

  insert into conversation_messages (
    conversation_id, author_agent_id, body, metadata
  ) values (
    consultation_row.conversation_id,
    consultation_row.owner_agent_id,
    btrim(p_body),
    jsonb_build_object(
      'source', 'agent_consultation',
      'consultation_id', consultation_row.id,
      'job_id', p_job_id,
      'owner_agent_slug', owner_slug,
      'consulted_agent_slug', specialist_slug
    )
  ) returning id into created_message_id;

  update agent_conversation_jobs
  set status = 'done', completed_at = now(), error = null
  where id = p_job_id and status = 'processing';
  if not found then raise exception 'specialist consultation completion raced cancellation'; end if;

  update conversation_agent_consultations
  set status = 'done', response_message_id = created_message_id, completed_at = now()
  where id = consultation_row.id;

  return created_message_id;
end;
$$;

revoke all on function complete_conversation_agent_consultation(uuid,text)
  from public, anon, authenticated;
grant execute on function complete_conversation_agent_consultation(uuid,text)
  to service_role;

comment on table conversation_agent_consultations is
  'Auditable one-owner/one-specialist advisory turns. The specialist uses the existing OpenClaw runtime; the owner remains the visible conversational author.';
comment on function start_conversation_agent_consultation(uuid,text,text,uuid,text,text,text) is
  'Atomically validates an active owner call, records one idempotent human request and queues exactly one other active RESLU specialist.';
comment on function complete_conversation_agent_consultation(uuid,text) is
  'Atomically records one owner-authored, specialist-attributed response and completes its specialist job. Service role only.';

notify pgrst, 'reload schema';
