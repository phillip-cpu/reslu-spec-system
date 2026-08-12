-- Project and lead workspaces are durable context boundaries around the
-- existing canonical conversation store. Voice, files, tasks and messages
-- continue to use conversation_id; this table supplies the business scope.

create table conversation_contexts (
  conversation_id       uuid primary key references conversations(id) on delete cascade,
  scope_kind             text not null check (scope_kind in ('project', 'lead')),
  project_id             uuid references projects(id) on delete restrict,
  lead_id                uuid references leads(id) on delete restrict,
  purpose_key            text not null default 'general'
                         check (char_length(purpose_key) between 1 and 80),
  scope_label_snapshot   text not null check (char_length(scope_label_snapshot) between 1 and 240),
  summary                jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  summary_updated_at     timestamptz,
  created_by             uuid not null references profiles(id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (
    (scope_kind = 'project' and project_id is not null and lead_id is null)
    or (scope_kind = 'lead' and lead_id is not null and project_id is null)
  )
);

create unique index conversation_contexts_project_purpose_unique
  on conversation_contexts(project_id, purpose_key)
  where project_id is not null;
create unique index conversation_contexts_lead_purpose_unique
  on conversation_contexts(lead_id, purpose_key)
  where lead_id is not null;
create index conversation_contexts_project_lookup
  on conversation_contexts(project_id, updated_at desc)
  where project_id is not null;
create index conversation_contexts_lead_lookup
  on conversation_contexts(lead_id, updated_at desc)
  where lead_id is not null;

alter table conversation_contexts enable row level security;

create policy "members_read_conversation_contexts" on conversation_contexts
  for select to authenticated
  using ((select is_conversation_member(conversation_id)));

-- Context rows are created only by the guarded atomic RPC below. Keeping
-- direct mutations away from browser roles prevents a conversation from
-- being silently moved to a different client or project.
revoke insert, update, delete on conversation_contexts from anon, authenticated;
grant select on conversation_contexts to authenticated;
grant all on conversation_contexts to service_role;

drop trigger if exists trg_conversation_contexts_updated_at on conversation_contexts;
create trigger trg_conversation_contexts_updated_at
  before update on conversation_contexts
  for each row execute function set_updated_at();

create or replace function get_or_create_scoped_conversation(
  p_scope_kind text,
  p_scope_id uuid,
  p_purpose_key text,
  p_title text,
  p_agent_slug text,
  p_client_conversation_id uuid
)
returns table(conversation_id uuid, existing boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  normalized_purpose text := lower(btrim(coalesce(p_purpose_key, '')));
  normalized_title text := nullif(btrim(coalesce(p_title, '')), '');
  label_snapshot text;
  agent_row conversation_agents;
  found_conversation_id uuid;
begin
  if actor_id is null then raise exception 'unauthorized'; end if;
  if p_scope_kind not in ('project', 'lead') or p_scope_id is null then
    raise exception 'conversation scope is invalid';
  end if;
  if normalized_purpose !~ '^[a-z0-9][a-z0-9_-]{0,79}$' then
    raise exception 'conversation purpose is invalid';
  end if;
  if normalized_title is not null and char_length(normalized_title) > 200 then
    raise exception 'conversation title is too long';
  end if;
  if p_client_conversation_id is null then
    raise exception 'client conversation id is required';
  end if;

  if p_scope_kind = 'project' then
    select project.name into label_snapshot
    from projects project
    where project.id = p_scope_id and project.deleted_at is null;
  else
    select coalesce(nullif(btrim(lead.surname_project), ''), nullif(btrim(lead.first_name), ''), 'Lead')
    into label_snapshot
    from leads lead
    where lead.id = p_scope_id and lead.deleted_at is null;
  end if;
  if label_snapshot is null then raise exception 'conversation scope not found'; end if;

  select * into agent_row
  from conversation_agents agent
  where agent.slug = p_agent_slug and agent.active;
  if not found then raise exception 'conversation agent is unavailable'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'scoped-conversation:' || p_scope_kind || ':' || p_scope_id::text || ':' || normalized_purpose,
    0
  ));

  select context.conversation_id into found_conversation_id
  from conversation_contexts context
  where context.scope_kind = p_scope_kind
    and context.purpose_key = normalized_purpose
    and (
      (p_scope_kind = 'project' and context.project_id = p_scope_id)
      or (p_scope_kind = 'lead' and context.lead_id = p_scope_id)
    );
  if found then
    if not is_conversation_member(found_conversation_id) then
      raise exception 'conversation scope already exists';
    end if;
    return query select found_conversation_id, true;
    return;
  end if;

  insert into conversations(kind, title, created_by, client_conversation_id)
  values ('group', coalesce(normalized_title, label_snapshot || ' · General'), actor_id, p_client_conversation_id)
  returning id into found_conversation_id;

  insert into conversation_participants(conversation_id, profile_id, participant_role)
  values (found_conversation_id, actor_id, 'admin');
  insert into conversation_participants(conversation_id, agent_id, participant_role)
  values (found_conversation_id, agent_row.id, 'member');

  insert into conversation_contexts(
    conversation_id, scope_kind, project_id, lead_id, purpose_key,
    scope_label_snapshot, created_by
  ) values (
    found_conversation_id,
    p_scope_kind,
    case when p_scope_kind = 'project' then p_scope_id end,
    case when p_scope_kind = 'lead' then p_scope_id end,
    normalized_purpose,
    label_snapshot,
    actor_id
  );

  return query select found_conversation_id, false;
end;
$$;

revoke all on function get_or_create_scoped_conversation(text, uuid, text, text, text, uuid)
  from public, anon;
grant execute on function get_or_create_scoped_conversation(text, uuid, text, text, text, uuid)
  to authenticated;

alter table agent_tasks
  add column project_id uuid references projects(id) on delete restrict,
  add column lead_id uuid references leads(id) on delete restrict;

create index agent_tasks_project_created_idx
  on agent_tasks(project_id, created_at desc) where project_id is not null;
create index agent_tasks_lead_created_idx
  on agent_tasks(lead_id, created_at desc) where lead_id is not null;

create or replace function inherit_agent_task_conversation_scope()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  context_row conversation_contexts;
begin
  select * into context_row
  from conversation_contexts context
  where context.conversation_id = new.conversation_id;
  if found then
    new.project_id := context_row.project_id;
    new.lead_id := context_row.lead_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_agent_tasks_inherit_conversation_scope on agent_tasks;
create trigger trg_agent_tasks_inherit_conversation_scope
  before insert on agent_tasks
  for each row execute function inherit_agent_task_conversation_scope();

comment on table conversation_contexts is
  'Durable project/lead boundary for one canonical RESLU conversation. Project facts and files are retrieved by scope; raw project history is never copied into every turn.';
comment on column conversation_contexts.summary is
  'Bounded rolling context checkpoint: confirmed facts, decisions, commitments and unresolved matters with source references.';

notify pgrst, 'reload schema';
