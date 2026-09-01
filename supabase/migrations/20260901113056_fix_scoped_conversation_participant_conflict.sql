-- The project-join migration used a named partial-index inference target.
-- Because this function returns a column also named conversation_id,
-- PL/pgSQL treats that target as an
-- ambiguous reference at runtime. A targetless ON CONFLICT remains
-- idempotent for this single participant insert and avoids the collision.

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
  normalized_purpose text := lower(btrim(coalesce(p_purpose_key, ''));
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
    if p_scope_kind = 'project' then
      insert into conversation_participants(
        conversation_id,
        profile_id,
        participant_role
      )
      values (found_conversation_id, actor_id, 'member')
      on conflict do nothing;
    elsif not is_conversation_member(found_conversation_id) then
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

comment on function get_or_create_scoped_conversation(text, uuid, text, text, text, uuid) is
  'Atomically creates a scoped conversation; existing project scopes join the authenticated staff member, while lead scopes remain participant-restricted.';

notify pgrst, 'reload schema';
