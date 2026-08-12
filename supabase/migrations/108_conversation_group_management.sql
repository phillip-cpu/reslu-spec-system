-- Shared group-chat administration. Existing direct conversations remain
-- immutable; group name and membership changes go through explicit admin RPCs
-- and append truthful system records to the canonical timeline.

alter table conversation_participants
  add column if not exists participant_role text not null default 'member';

alter table conversation_participants
  drop constraint if exists conversation_participants_role_check;
alter table conversation_participants
  add constraint conversation_participants_role_check check (
    participant_role in ('member', 'admin')
    and (participant_role = 'member' or profile_id is not null)
  );

update conversation_participants participant
set participant_role = 'admin'
from conversations conversation
where conversation.id = participant.conversation_id
  and participant.profile_id = conversation.created_by
  and participant.participant_role <> 'admin';

create or replace function assign_conversation_creator_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.profile_id is not null and exists (
    select 1 from conversations conversation
    where conversation.id = new.conversation_id
      and conversation.created_by = new.profile_id
  ) then
    new.participant_role := 'admin';
  elsif new.agent_id is not null then
    new.participant_role := 'member';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_conversation_creator_admin on conversation_participants;
create trigger trg_assign_conversation_creator_admin
  before insert or update of conversation_id, profile_id, agent_id
  on conversation_participants
  for each row execute function assign_conversation_creator_admin();

create or replace function is_conversation_admin(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.profile_id = auth.uid()
      and participant.participant_role = 'admin'
  );
$$;

create table if not exists conversation_group_actions (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  actor_profile_id uuid not null references profiles(id) on delete cascade,
  client_action_id uuid not null,
  action           text not null check (action in ('rename', 'add', 'role', 'remove', 'leave')),
  request          jsonb not null check (jsonb_typeof(request) = 'object'),
  result           jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at       timestamptz not null default now(),
  unique (actor_profile_id, client_action_id)
);

alter table conversation_group_actions enable row level security;
revoke all on table conversation_group_actions from public, anon, authenticated;

create or replace function existing_conversation_group_action(
  p_conversation_id uuid,
  p_client_action_id uuid,
  p_action text,
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  action_row conversation_group_actions%rowtype;
begin
  if auth.uid() is null or p_client_action_id is null then
    raise exception 'client group action id is required';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(auth.uid()::text || ':group-action:' || p_client_action_id::text, 0)
  );
  select audit.* into action_row
  from conversation_group_actions audit
  where audit.actor_profile_id = auth.uid()
    and audit.client_action_id = p_client_action_id;
  if not found then return null; end if;
  if action_row.conversation_id <> p_conversation_id
    or action_row.action <> p_action
    or action_row.request <> p_request then
    raise exception 'client group action id was already used for a different request';
  end if;
  return action_row.result;
end;
$$;

create or replace function record_conversation_group_action(
  p_conversation_id uuid,
  p_client_action_id uuid,
  p_action text,
  p_request jsonb,
  p_result jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into conversation_group_actions(
    conversation_id,
    actor_profile_id,
    client_action_id,
    action,
    request,
    result
  ) values (
    p_conversation_id,
    auth.uid(),
    p_client_action_id,
    p_action,
    p_request,
    p_result
  );
end;
$$;

create or replace function append_conversation_group_system_message(
  p_conversation_id uuid,
  p_body text,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
    or char_length(btrim(coalesce(p_body, ''))) not between 1 and 20000
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid group history record';
  end if;
  insert into conversation_messages(
    conversation_id,
    author_profile_id,
    kind,
    body,
    metadata
  ) values (
    p_conversation_id,
    auth.uid(),
    'system',
    btrim(p_body),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

create or replace function rename_conversation_group(
  p_conversation_id uuid,
  p_title text,
  p_client_action_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_title text := btrim(coalesce(p_title, ''));
  actor_name text;
  action_request jsonb;
  prior_result jsonb;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if char_length(normalized_title) not between 1 and 200 then
    raise exception 'group name must be between 1 and 200 characters';
  end if;
  action_request := jsonb_build_object('title', normalized_title);
  prior_result := existing_conversation_group_action(
    p_conversation_id, p_client_action_id, 'rename', action_request
  );
  if prior_result is not null then return prior_result->>'title'; end if;
  if not is_conversation_admin(p_conversation_id) then
    raise exception 'group admin required';
  end if;

  perform 1 from conversations conversation
  where conversation.id = p_conversation_id and conversation.kind = 'group'
  for update;
  if not found then raise exception 'group conversation not found'; end if;

  update conversations conversation
  set title = normalized_title
  where conversation.id = p_conversation_id;
  select coalesce(profile.full_name, 'A group admin') into actor_name
  from profiles profile where profile.id = auth.uid();
  perform append_conversation_group_system_message(
    p_conversation_id,
    actor_name || ' renamed the group to “' || normalized_title || '”.',
    jsonb_build_object('group_action', 'rename')
  );
  perform record_conversation_group_action(
    p_conversation_id,
    p_client_action_id,
    'rename',
    action_request,
    jsonb_build_object('title', normalized_title)
  );
  return normalized_title;
end;
$$;

create or replace function add_conversation_group_participants(
  p_conversation_id uuid,
  p_profile_ids uuid[],
  p_agent_slugs text[],
  p_client_action_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_profile_ids uuid[] := coalesce(p_profile_ids, array[]::uuid[]);
  requested_agent_slugs text[] := coalesce(p_agent_slugs, array[]::text[]);
  requested_agent_ids uuid[];
  requested_count integer;
  valid_count integer;
  current_count integer;
  new_count integer;
  added_profiles integer := 0;
  added_agents integer := 0;
  actor_name text;
  action_request jsonb;
  prior_result jsonb;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  requested_count := cardinality(requested_profile_ids) + cardinality(requested_agent_slugs);
  if requested_count not between 1 and 50
    or cardinality(requested_profile_ids) > 49
    or cardinality(requested_agent_slugs) > 2
    or array_position(requested_profile_ids, null) is not null
    or array_position(requested_agent_slugs, null) is not null
    or cardinality(requested_profile_ids) <> (
      select count(distinct value) from unnest(requested_profile_ids) value
    )
    or cardinality(requested_agent_slugs) <> (
      select count(distinct value) from unnest(requested_agent_slugs) value
    ) then
    raise exception 'participants must be unique and valid';
  end if;
  if exists (
    select 1 from unnest(requested_agent_slugs) slug
    where slug not in ('aria', 'marco')
  ) then
    raise exception 'conversation agents are invalid';
  end if;
  action_request := jsonb_build_object(
    'profile_ids', to_jsonb((select coalesce(array_agg(value order by value), array[]::uuid[]) from unnest(requested_profile_ids) value)),
    'agent_slugs', to_jsonb((select coalesce(array_agg(value order by value), array[]::text[]) from unnest(requested_agent_slugs) value))
  );
  prior_result := existing_conversation_group_action(
    p_conversation_id, p_client_action_id, 'add', action_request
  );
  if prior_result is not null then return (prior_result->>'added')::integer; end if;
  if not is_conversation_admin(p_conversation_id) then
    raise exception 'group admin required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':group-management', 0)
  );
  perform 1 from conversations conversation
  where conversation.id = p_conversation_id and conversation.kind = 'group'
  for update;
  if not found then raise exception 'group conversation not found'; end if;

  select count(*) into valid_count
  from profiles profile
  where profile.id = any(requested_profile_ids)
    and not exists (
      select 1
      from conversation_agents agent
      where agent.auth_profile_id = profile.id
    );
  if valid_count <> cardinality(requested_profile_ids) then
    raise exception 'one or more participants are unavailable';
  end if;
  select coalesce(array_agg(agent.id order by agent.slug), array[]::uuid[])
  into requested_agent_ids
  from conversation_agents agent
  where agent.slug = any(requested_agent_slugs) and agent.active;
  if cardinality(requested_agent_ids) <> cardinality(requested_agent_slugs) then
    raise exception 'one or more participants are unavailable';
  end if;

  select count(*) into current_count
  from conversation_participants participant
  where participant.conversation_id = p_conversation_id;
  select count(*) into new_count
  from (
    select profile_id::text as participant_key
    from unnest(requested_profile_ids) profile_id
    where not exists (
      select 1 from conversation_participants participant
      where participant.conversation_id = p_conversation_id
        and participant.profile_id = profile_id
    )
    union all
    select agent_id::text as participant_key
    from unnest(requested_agent_ids) agent_id
    where not exists (
      select 1 from conversation_participants participant
      where participant.conversation_id = p_conversation_id
        and participant.agent_id = agent_id
    )
  ) additions;
  if current_count + new_count > 50 then
    raise exception 'a conversation can have no more than 50 participants';
  end if;

  insert into conversation_participants(
    conversation_id, profile_id, agent_id, participant_role
  )
  select p_conversation_id, profile_id, null::uuid, 'member'
  from unnest(requested_profile_ids) profile_id
  on conflict (conversation_id, profile_id) where profile_id is not null do nothing;
  get diagnostics added_profiles = row_count;

  insert into conversation_participants(
    conversation_id, profile_id, agent_id, participant_role
  )
  select p_conversation_id, null::uuid, agent_id, 'member'
  from unnest(requested_agent_ids) agent_id
  on conflict (conversation_id, agent_id) where agent_id is not null do nothing;
  get diagnostics added_agents = row_count;

  if added_profiles + added_agents > 0 then
    select coalesce(profile.full_name, 'A group admin') into actor_name
    from profiles profile where profile.id = auth.uid();
    perform append_conversation_group_system_message(
      p_conversation_id,
      actor_name || ' added ' || (added_profiles + added_agents)::text
        || case when added_profiles + added_agents = 1 then ' participant.' else ' participants.' end,
      jsonb_build_object(
        'group_action', 'add_participants',
        'requested_profile_ids', to_jsonb(requested_profile_ids),
        'requested_agent_slugs', to_jsonb(requested_agent_slugs)
      )
    );
  end if;
  perform record_conversation_group_action(
    p_conversation_id,
    p_client_action_id,
    'add',
    action_request,
    jsonb_build_object('added', added_profiles + added_agents)
  );
  return added_profiles + added_agents;
end;
$$;

create or replace function set_conversation_group_admin(
  p_conversation_id uuid,
  p_profile_id uuid,
  p_admin boolean,
  p_client_action_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_role text;
  target_name text;
  actor_name text;
  admin_count integer;
  action_request jsonb;
  prior_result jsonb;
begin
  if auth.uid() is null or p_profile_id is null or p_admin is null then
    raise exception 'unauthorized';
  end if;
  action_request := jsonb_build_object('profile_id', p_profile_id, 'admin', p_admin);
  prior_result := existing_conversation_group_action(
    p_conversation_id, p_client_action_id, 'role', action_request
  );
  if prior_result is not null then return (prior_result->>'admin')::boolean; end if;
  if not is_conversation_admin(p_conversation_id) then
    raise exception 'group admin required';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':group-management', 0)
  );
  perform 1 from conversations conversation
  where conversation.id = p_conversation_id and conversation.kind = 'group'
  for update;
  if not found then raise exception 'group conversation not found'; end if;

  select participant.participant_role, profile.full_name
  into current_role, target_name
  from conversation_participants participant
  join profiles profile on profile.id = participant.profile_id
  where participant.conversation_id = p_conversation_id
    and participant.profile_id = p_profile_id
  for update of participant;
  if not found then raise exception 'group participant not found'; end if;
  if (current_role = 'admin') = p_admin then
    perform record_conversation_group_action(
      p_conversation_id, p_client_action_id, 'role', action_request,
      jsonb_build_object('admin', p_admin)
    );
    return p_admin;
  end if;

  if not p_admin then
    select count(*) into admin_count
    from conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.profile_id is not null
      and participant.participant_role = 'admin';
    if admin_count <= 1 then raise exception 'a group must keep at least one admin'; end if;
  end if;

  update conversation_participants participant
  set participant_role = case when p_admin then 'admin' else 'member' end
  where participant.conversation_id = p_conversation_id
    and participant.profile_id = p_profile_id;
  select coalesce(profile.full_name, 'A group admin') into actor_name
  from profiles profile where profile.id = auth.uid();
  perform append_conversation_group_system_message(
    p_conversation_id,
    target_name || case when p_admin then ' is now a group admin.' else ' is no longer a group admin.' end,
    jsonb_build_object(
      'group_action', case when p_admin then 'promote_admin' else 'demote_admin' end,
      'target_profile_id', p_profile_id,
      'changed_by', actor_name
    )
  );
  perform record_conversation_group_action(
    p_conversation_id,
    p_client_action_id,
    'role',
    action_request,
    jsonb_build_object('admin', p_admin)
  );
  return p_admin;
end;
$$;

create or replace function remove_conversation_group_participant(
  p_conversation_id uuid,
  p_profile_id uuid default null,
  p_agent_slug text default null,
  p_client_action_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_agent_id uuid;
  target_name text;
  target_role text;
  actor_name text;
  admin_count integer;
  action_request jsonb;
  prior_result jsonb;
begin
  if auth.uid() is null or num_nonnulls(p_profile_id, p_agent_slug) <> 1 then
    raise exception 'choose one participant to remove';
  end if;
  action_request := jsonb_build_object('profile_id', p_profile_id, 'agent_slug', p_agent_slug);
  prior_result := existing_conversation_group_action(
    p_conversation_id, p_client_action_id, 'remove', action_request
  );
  if prior_result is not null then return true; end if;
  if not is_conversation_admin(p_conversation_id) then
    raise exception 'group admin required';
  end if;
  if p_profile_id = auth.uid() then
    raise exception 'use leave group for your own membership';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':group-management', 0)
  );
  perform 1 from conversations conversation
  where conversation.id = p_conversation_id and conversation.kind = 'group'
  for update;
  if not found then raise exception 'group conversation not found'; end if;

  if p_profile_id is not null then
    select participant.participant_role, profile.full_name
    into target_role, target_name
    from conversation_participants participant
    join profiles profile on profile.id = participant.profile_id
    where participant.conversation_id = p_conversation_id
      and participant.profile_id = p_profile_id
    for update of participant;
    if not found then raise exception 'group participant not found'; end if;
    if target_role = 'admin' then
      select count(*) into admin_count
      from conversation_participants participant
      where participant.conversation_id = p_conversation_id
        and participant.profile_id is not null
        and participant.participant_role = 'admin';
      if admin_count <= 1 then raise exception 'a group must keep at least one admin'; end if;
    end if;
    delete from conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.profile_id = p_profile_id;
    delete from notifications notification
    where notification.user_id = p_profile_id
      and notification.kind = 'conversation_message:' || p_conversation_id::text;
  else
    select participant.agent_id, agent.display_name
    into target_agent_id, target_name
    from conversation_participants participant
    join conversation_agents agent on agent.id = participant.agent_id
    where participant.conversation_id = p_conversation_id
      and agent.slug = p_agent_slug
    for update of participant;
    if not found then raise exception 'group participant not found'; end if;

    update agent_conversation_jobs job
    set status = 'cancelled', completed_at = now(), error = 'Agent removed from conversation'
    where job.conversation_id = p_conversation_id
      and job.agent_id = target_agent_id
      and job.status in ('pending', 'processing');

    with stopped as (
      update agent_tasks task
      set
        cancellation_requested_at = coalesce(task.cancellation_requested_at, now()),
        status = case when task.status in ('queued', 'awaiting_approval') then 'cancelled' else task.status end,
        completed_at = case when task.status in ('queued', 'awaiting_approval') then now() else task.completed_at end
      where task.conversation_id = p_conversation_id
        and task.owner_agent_id = target_agent_id
        and task.status in ('queued', 'running', 'awaiting_approval')
      returning task.id, task.status
    )
    insert into agent_task_events(task_id, event_type, label, detail, metadata)
    select
      stopped.id,
      case when stopped.status = 'cancelled' then 'cancelled' else 'progress' end,
      case when stopped.status = 'cancelled' then 'Task cancelled' else 'Cancellation requested' end,
      'The assigned agent was removed from this conversation.',
      jsonb_build_object('reason', 'agent_removed')
    from stopped;

    delete from conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.agent_id = target_agent_id;
  end if;

  select coalesce(profile.full_name, 'A group admin') into actor_name
  from profiles profile where profile.id = auth.uid();
  perform append_conversation_group_system_message(
    p_conversation_id,
    actor_name || ' removed ' || target_name || ' from the group.',
    jsonb_build_object(
      'group_action', 'remove_participant',
      'target_profile_id', p_profile_id,
      'target_agent_slug', p_agent_slug
    )
  );
  perform record_conversation_group_action(
    p_conversation_id,
    p_client_action_id,
    'remove',
    action_request,
    jsonb_build_object('removed', true)
  );
  return true;
end;
$$;

create or replace function leave_conversation_group(
  p_conversation_id uuid,
  p_client_action_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_role text;
  actor_name text;
  other_human_count integer;
  other_admin_count integer;
  promoted_profile_id uuid;
  promoted_name text;
  action_request jsonb := '{}'::jsonb;
  prior_result jsonb;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  prior_result := existing_conversation_group_action(
    p_conversation_id, p_client_action_id, 'leave', action_request
  );
  if prior_result is not null then return true; end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':group-management', 0)
  );
  perform 1 from conversations conversation
  where conversation.id = p_conversation_id and conversation.kind = 'group'
  for update;
  if not found then raise exception 'group conversation not found'; end if;

  select participant.participant_role, profile.full_name
  into current_role, actor_name
  from conversation_participants participant
  join profiles profile on profile.id = participant.profile_id
  where participant.conversation_id = p_conversation_id
    and participant.profile_id = auth.uid()
  for update of participant;
  if not found then raise exception 'group conversation not found'; end if;

  select count(*) into other_human_count
  from conversation_participants participant
  where participant.conversation_id = p_conversation_id
    and participant.profile_id is not null
    and participant.profile_id <> auth.uid();
  if other_human_count = 0 then
    raise exception 'the only human member cannot leave; archive the conversation instead';
  end if;

  if current_role = 'admin' then
    select count(*) into other_admin_count
    from conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.profile_id is not null
      and participant.profile_id <> auth.uid()
      and participant.participant_role = 'admin';
    if other_admin_count = 0 then
      select participant.profile_id, profile.full_name
      into promoted_profile_id, promoted_name
      from conversation_participants participant
      join profiles profile on profile.id = participant.profile_id
      where participant.conversation_id = p_conversation_id
        and participant.profile_id is not null
        and participant.profile_id <> auth.uid()
      order by participant.joined_at, participant.profile_id
      limit 1
      for update of participant;
      update conversation_participants participant
      set participant_role = 'admin'
      where participant.conversation_id = p_conversation_id
        and participant.profile_id = promoted_profile_id;
      perform append_conversation_group_system_message(
        p_conversation_id,
        promoted_name || ' is now a group admin.',
        jsonb_build_object(
          'group_action', 'promote_admin',
          'target_profile_id', promoted_profile_id,
          'reason', 'last_admin_left'
        )
      );
    end if;
  end if;

  perform append_conversation_group_system_message(
    p_conversation_id,
    actor_name || ' left the group.',
    jsonb_build_object('group_action', 'leave', 'target_profile_id', auth.uid())
  );
  delete from conversation_participants participant
  where participant.conversation_id = p_conversation_id
    and participant.profile_id = auth.uid();

  delete from notifications notification
  where notification.user_id = auth.uid()
    and notification.kind = 'conversation_message:' || p_conversation_id::text;
  perform record_conversation_group_action(
    p_conversation_id,
    p_client_action_id,
    'leave',
    action_request,
    jsonb_build_object('left', true)
  );
  return true;
end;
$$;

-- Group state is shared and consequential. Remove the old broad direct-write
-- policies; trusted creation and the RPCs above retain their definer rights.
drop policy if exists "members_update_conversations" on conversations;
drop policy if exists "creators_add_participants" on conversation_participants;
revoke update on table conversations from authenticated;
revoke insert, update, delete on table conversation_participants from authenticated;

revoke all on function assign_conversation_creator_admin() from public, anon, authenticated;
revoke all on function is_conversation_admin(uuid) from public, anon, authenticated;
revoke all on function existing_conversation_group_action(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function record_conversation_group_action(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function append_conversation_group_system_message(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function rename_conversation_group(uuid, text, uuid) from public, anon;
revoke all on function add_conversation_group_participants(uuid, uuid[], text[], uuid) from public, anon;
revoke all on function set_conversation_group_admin(uuid, uuid, boolean, uuid) from public, anon;
revoke all on function remove_conversation_group_participant(uuid, uuid, text, uuid) from public, anon;
revoke all on function leave_conversation_group(uuid, uuid) from public, anon;
grant execute on function rename_conversation_group(uuid, text, uuid) to authenticated;
grant execute on function add_conversation_group_participants(uuid, uuid[], text[], uuid) to authenticated;
grant execute on function set_conversation_group_admin(uuid, uuid, boolean, uuid) to authenticated;
grant execute on function remove_conversation_group_participant(uuid, uuid, text, uuid) to authenticated;
grant execute on function leave_conversation_group(uuid, uuid) to authenticated;

comment on column conversation_participants.participant_role is
  'Shared group role. Only human admins may change group name, participants or other admins.';
comment on function leave_conversation_group(uuid, uuid) is
  'Leaves a group atomically, promotes a successor when needed and retires unfinished private push delivery.';

notify pgrst, 'reload schema';
