-- Auditable inter-agent delegation for canonical RESLU conversations.
-- The calling agent remains the visible conversation owner; the specialist
-- receives an independent durable task and posts its result into the same
-- thread. This intentionally does not expose OpenClaw's generic session tools.

alter table agent_tasks
  add column if not exists delegated_by_agent_id uuid
    references conversation_agents(id) on delete set null,
  add column if not exists source_task_id uuid
    references agent_tasks(id) on delete set null;

create index if not exists agent_tasks_delegated_by_idx
  on agent_tasks(delegated_by_agent_id, created_at desc)
  where delegated_by_agent_id is not null;

create index if not exists agent_tasks_source_task_idx
  on agent_tasks(source_task_id, created_at)
  where source_task_id is not null;

create or replace function delegate_conversation_agent_task(
  p_conversation_id uuid,
  p_target_agent_slug text,
  p_client_delegation_id text,
  p_title text,
  p_objective text,
  p_model_tier text default 'standard',
  p_source_task_id uuid default null
)
returns agent_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller conversation_agents;
  v_target conversation_agents;
  v_existing agent_tasks;
  v_result agent_tasks;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_caller
  from conversation_agents agent
  where agent.auth_profile_id = auth.uid()
    and agent.active;

  if v_caller.id is null then
    raise exception 'authenticated RESLU agent required';
  end if;

  if not exists (
    select 1
    from conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.agent_id = v_caller.id
  ) then
    raise exception 'conversation not found';
  end if;

  select * into v_target
  from conversation_agents agent
  where agent.slug = lower(btrim(coalesce(p_target_agent_slug, '')))
    and agent.active;

  if v_target.id is null or v_target.slug not in ('aria', 'marco', 'stuart') then
    raise exception 'target RESLU agent not found';
  end if;
  if v_target.id = v_caller.id then
    raise exception 'an agent cannot delegate work to itself';
  end if;

  if p_client_delegation_id is null
    or char_length(btrim(p_client_delegation_id)) not between 1 and 160
    or p_client_delegation_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'invalid delegation id';
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 200 then
    raise exception 'invalid delegation title';
  end if;
  if p_objective is null or char_length(btrim(p_objective)) not between 1 and 20000 then
    raise exception 'invalid delegation objective';
  end if;
  if p_model_tier not in ('fast', 'standard', 'strong') then
    raise exception 'invalid model tier';
  end if;

  if p_source_task_id is not null then
    if not exists (
      select 1
      from agent_tasks source
      where source.id = p_source_task_id
        and source.conversation_id = p_conversation_id
        and source.owner_agent_id = v_caller.id
        and source.status = 'running'
    ) then
      raise exception 'active source task not found';
    end if;
    if (
      select count(*)
      from agent_tasks child
      where child.source_task_id = p_source_task_id
        and child.status not in ('failed', 'cancelled')
    ) >= 3 then
      raise exception 'source task delegation limit reached';
    end if;
  end if;

  -- Serialise retries for this canonical conversation/idempotency key.
  perform pg_advisory_xact_lock(hashtextextended(
    p_conversation_id::text || ':' || p_client_delegation_id,
    0
  ));

  select * into v_existing
  from agent_tasks task
  where task.conversation_id = p_conversation_id
    and task.client_task_id = p_client_delegation_id;

  if v_existing.id is not null then
    if v_existing.owner_agent_id <> v_target.id
      or v_existing.delegated_by_agent_id is distinct from v_caller.id
      or v_existing.source_task_id is distinct from p_source_task_id
      or v_existing.title <> btrim(p_title)
      or v_existing.objective <> btrim(p_objective)
      or v_existing.model_tier <> p_model_tier then
      raise exception 'delegation idempotency key conflict';
    end if;
    return v_existing;
  end if;

  insert into agent_tasks (
    conversation_id,
    requested_by,
    owner_agent_id,
    delegated_by_agent_id,
    source_task_id,
    client_task_id,
    title,
    objective,
    requested_via,
    model_tier
  ) values (
    p_conversation_id,
    auth.uid(),
    v_target.id,
    v_caller.id,
    p_source_task_id,
    btrim(p_client_delegation_id),
    btrim(p_title),
    btrim(p_objective),
    'system',
    p_model_tier
  )
  returning * into v_result;

  insert into agent_task_events(task_id, event_type, label, detail, metadata)
  values (
    v_result.id,
    'queued',
    format('%s delegated to %s', v_caller.display_name, v_target.display_name),
    v_result.title,
    jsonb_build_object(
      'delegated_by_agent_slug', v_caller.slug,
      'owner_agent_slug', v_target.slug,
      'source_task_id', p_source_task_id
    )
  );

  return v_result;
end;
$$;

revoke all on function delegate_conversation_agent_task(uuid, text, text, text, text, text, uuid)
  from public, anon;
grant execute on function delegate_conversation_agent_task(uuid, text, text, text, text, text, uuid)
  to authenticated;

comment on column agent_tasks.delegated_by_agent_id is
  'Agent that delegated this durable task. The owner_agent_id is the specialist doing the work.';
comment on column agent_tasks.source_task_id is
  'Optional parent durable task. Used to bound and audit specialist delegation chains.';
comment on function delegate_conversation_agent_task(uuid, text, text, text, text, text, uuid) is
  'Agent-authenticated, idempotent delegation into a specialist OpenClaw task that returns to the same conversation.';

notify pgrst, 'reload schema';
