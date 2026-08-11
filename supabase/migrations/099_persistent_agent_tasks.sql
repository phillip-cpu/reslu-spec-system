-- Durable background work for Aria and Marco. A call turn may create a task,
-- but ending or interrupting the call never cancels it. Tasks have their own
-- explicit cancellation and approval boundaries.

create table if not exists agent_tasks (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references conversations(id) on delete cascade,
  requested_by          uuid not null references profiles(id) on delete restrict,
  owner_agent_id        uuid not null references conversation_agents(id) on delete restrict,
  source_message_id     uuid references conversation_messages(id) on delete set null,
  source_call_id        uuid references conversation_calls(id) on delete set null,
  client_task_id        text not null check (char_length(client_task_id) between 1 and 160),
  title                 text not null check (char_length(title) between 1 and 200),
  objective             text not null check (char_length(objective) between 1 and 20000),
  requested_via         text not null default 'text' check (requested_via in ('text','voice','system')),
  status                text not null default 'queued' check (
                          status in ('queued','running','awaiting_approval','completed','failed','cancelled')
                        ),
  model_tier            text not null default 'standard' check (model_tier in ('fast','standard','strong')),
  model_name            text,
  approval_state        text not null default 'none' check (
                          approval_state in ('none','pending','approved','rejected')
                        ),
  approval_note         text check (approval_note is null or char_length(approval_note) <= 2000),
  result_summary        text check (result_summary is null or char_length(result_summary) <= 4000),
  error                 text check (error is null or char_length(error) <= 4000),
  cancellation_requested_at timestamptz,
  claimed_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (conversation_id, client_task_id)
);

create index if not exists agent_tasks_conversation_created_idx
  on agent_tasks(conversation_id, created_at desc);
create index if not exists agent_tasks_queue_idx
  on agent_tasks(owner_agent_id, created_at)
  where status = 'queued' and cancellation_requested_at is null;

drop trigger if exists trg_agent_tasks_updated_at on agent_tasks;
create trigger trg_agent_tasks_updated_at
  before update on agent_tasks
  for each row execute function set_updated_at();

create table if not exists agent_task_events (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references agent_tasks(id) on delete cascade,
  event_type  text not null check (
                event_type in (
                  'created','queued','started','progress','artifact','approval_required',
                  'approved','rejected','completed','failed','cancelled'
                )
              ),
  label       text not null check (char_length(label) between 1 and 240),
  detail      text check (detail is null or char_length(detail) <= 4000),
  metadata    jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at  timestamptz not null default now()
);

create index if not exists agent_task_events_task_created_idx
  on agent_task_events(task_id, created_at, id);

create or replace function record_agent_task_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into agent_task_events(task_id, event_type, label, detail, metadata)
  values (
    new.id,
    'created',
    'Task created',
    new.title,
    jsonb_build_object('requested_via', new.requested_via, 'model_tier', new.model_tier)
  );
  return new;
end;
$$;

drop trigger if exists trg_agent_task_created on agent_tasks;
create trigger trg_agent_task_created
  after insert on agent_tasks
  for each row execute function record_agent_task_created();

create table if not exists agent_task_artifacts (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references agent_tasks(id) on delete cascade,
  artifact_key text not null check (char_length(artifact_key) between 1 and 120),
  kind         text not null check (kind in ('text','email_draft','report','file','record_change')),
  title        text not null check (char_length(title) between 1 and 240),
  content      jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  status       text not null default 'draft' check (status in ('draft','approved','rejected','published')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (task_id, artifact_key)
);

drop trigger if exists trg_agent_task_artifacts_updated_at on agent_task_artifacts;
create trigger trg_agent_task_artifacts_updated_at
  before update on agent_task_artifacts
  for each row execute function set_updated_at();

alter table agent_tasks enable row level security;
alter table agent_task_events enable row level security;
alter table agent_task_artifacts enable row level security;

drop policy if exists "members_read_agent_tasks" on agent_tasks;
create policy "members_read_agent_tasks" on agent_tasks
  for select to authenticated
  using (is_conversation_member(conversation_id));

drop policy if exists "members_create_agent_tasks" on agent_tasks;
create policy "members_create_agent_tasks" on agent_tasks
  for insert to authenticated
  with check (
    requested_by = auth.uid()
    and is_conversation_member(conversation_id)
    and exists (
      select 1 from conversation_participants participant
      where participant.conversation_id = agent_tasks.conversation_id
        and participant.agent_id = agent_tasks.owner_agent_id
    )
    and (
      source_message_id is null
      or exists (
        select 1 from conversation_messages message
        where message.id = agent_tasks.source_message_id
          and message.conversation_id = agent_tasks.conversation_id
      )
    )
    and (
      source_call_id is null
      or exists (
        select 1 from conversation_calls call_record
        where call_record.id = agent_tasks.source_call_id
          and call_record.conversation_id = agent_tasks.conversation_id
      )
    )
  );

drop policy if exists "members_read_agent_task_events" on agent_task_events;
create policy "members_read_agent_task_events" on agent_task_events
  for select to authenticated
  using (
    exists (
      select 1 from agent_tasks task
      where task.id = agent_task_events.task_id
        and is_conversation_member(task.conversation_id)
    )
  );

drop policy if exists "members_read_agent_task_artifacts" on agent_task_artifacts;
create policy "members_read_agent_task_artifacts" on agent_task_artifacts
  for select to authenticated
  using (
    exists (
      select 1 from agent_tasks task
      where task.id = agent_task_artifacts.task_id
        and is_conversation_member(task.conversation_id)
    )
  );

create or replace function claim_agent_task(p_agent_slug text)
returns setof agent_tasks
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update agent_tasks task
  set status = 'running', claimed_at = now(), error = null
  where task.id = (
    select candidate.id
    from agent_tasks candidate
    join conversation_agents agent on agent.id = candidate.owner_agent_id
    where agent.slug = p_agent_slug
      and candidate.status = 'queued'
      and candidate.cancellation_requested_at is null
    order by candidate.created_at
    for update skip locked
    limit 1
  )
  returning task.*;
end;
$$;

revoke all on function claim_agent_task(text) from public, anon, authenticated;
grant execute on function claim_agent_task(text) to service_role;

create or replace function cancel_agent_task(p_conversation_id uuid, p_task_id uuid)
returns agent_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  result agent_tasks;
begin
  if auth.uid() is null or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  update agent_tasks task
  set
    cancellation_requested_at = coalesce(task.cancellation_requested_at, now()),
    status = case when task.status in ('queued','awaiting_approval') then 'cancelled' else task.status end,
    completed_at = case when task.status in ('queued','awaiting_approval') then now() else task.completed_at end
  where task.id = p_task_id
    and task.conversation_id = p_conversation_id
    and task.status not in ('completed','failed','cancelled')
  returning * into result;

  if not found then
    select * into result from agent_tasks task
    where task.id = p_task_id and task.conversation_id = p_conversation_id;
  end if;
  if result.id is null then raise exception 'task not found'; end if;
  return result;
end;
$$;

revoke all on function cancel_agent_task(uuid, uuid) from public, anon;
grant execute on function cancel_agent_task(uuid, uuid) to authenticated;

create or replace function decide_agent_task_artifact(
  p_conversation_id uuid,
  p_task_id uuid,
  p_artifact_id uuid,
  p_approved boolean,
  p_note text default null
)
returns agent_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  result agent_tasks;
begin
  if auth.uid() is null or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  if p_note is not null and char_length(p_note) > 2000 then raise exception 'approval note is too long'; end if;
  if not exists (
    select 1 from agent_task_artifacts artifact
    where artifact.id = p_artifact_id and artifact.task_id = p_task_id and artifact.status = 'draft'
  ) then raise exception 'draft artifact not found'; end if;

  update agent_task_artifacts
  set status = case when p_approved then 'approved' else 'rejected' end
  where id = p_artifact_id and task_id = p_task_id;

  update agent_tasks task
  set
    approval_state = case when p_approved then 'approved' else 'rejected' end,
    approval_note = nullif(btrim(coalesce(p_note, '')), ''),
    status = case when p_approved then 'queued' else 'cancelled' end,
    completed_at = case when p_approved then null else now() end
  where task.id = p_task_id
    and task.conversation_id = p_conversation_id
    and task.status = 'awaiting_approval'
  returning * into result;

  if result.id is null then raise exception 'task is not awaiting approval'; end if;
  insert into agent_task_events(task_id, event_type, label, detail)
  values (
    result.id,
    case when p_approved then 'approved' else 'rejected' end,
    case when p_approved then 'Draft approved' else 'Draft rejected' end,
    result.approval_note
  );
  return result;
end;
$$;

revoke all on function decide_agent_task_artifact(uuid, uuid, uuid, boolean, text) from public, anon;
grant execute on function decide_agent_task_artifact(uuid, uuid, uuid, boolean, text) to authenticated;

comment on table agent_tasks is
  'Durable Aria/Marco work. Realtime speech interruption never changes these rows; only explicit task cancellation does.';
comment on table agent_task_events is
  'Truthful observable progress. Never store private model reasoning or chain-of-thought here.';
comment on table agent_task_artifacts is
  'User-visible drafts and results. Draft status never implies an external message or record change was executed.';

-- A background-task request is still a canonical human message, but it is
-- consumed by agent_tasks rather than the cancellable conversational queue.
create or replace function enqueue_conversation_agents_for_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  participant_count integer;
  agent_count integer;
begin
  if new.author_profile_id is null
    or new.kind <> 'text'
    or new.metadata->>'background_task' = 'true' then
    return new;
  end if;

  select count(*), count(*) filter (where agent_id is not null)
  into participant_count, agent_count
  from conversation_participants
  where conversation_id = new.conversation_id;

  insert into agent_conversation_jobs (conversation_id, triggering_message_id, agent_id)
  select new.conversation_id, new.id, participant.agent_id
  from conversation_participants participant
  join conversation_agents agent on agent.id = participant.agent_id and agent.active
  where participant.conversation_id = new.conversation_id
    and participant.agent_id is not null
    and (
      (participant_count = 2 and agent_count = 1)
      or agent.slug in (
        select jsonb_array_elements_text(coalesce(new.metadata->'target_agent_slugs', '[]'::jsonb))
      )
    )
  on conflict (triggering_message_id, agent_id) do nothing;
  return new;
end;
$$;

notify pgrst, 'reload schema';
