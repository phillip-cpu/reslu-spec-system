-- Repair migration 108's admin-state transition. A demotion is checked before
-- any no-op return, and no-op states are expressed explicitly rather than by a
-- compact boolean equality that incorrectly short-circuited production.

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

  if p_admin = false and current_role = 'admin' then
    select count(*) into admin_count
    from conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.profile_id is not null
      and participant.participant_role = 'admin';
    if admin_count <= 1 then raise exception 'a group must keep at least one admin'; end if;
  end if;

  if (p_admin = true and current_role = 'admin')
     or (p_admin = false and current_role = 'member') then
    perform record_conversation_group_action(
      p_conversation_id, p_client_action_id, 'role', action_request,
      jsonb_build_object('admin', p_admin)
    );
    return p_admin;
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

revoke all on function set_conversation_group_admin(uuid, uuid, boolean, uuid)
  from public, anon;
grant execute on function set_conversation_group_admin(uuid, uuid, boolean, uuid)
  to authenticated;

notify pgrst, 'reload schema';
