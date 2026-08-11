-- Run in the Supabase SQL Editor after migration 108. It creates one
-- rollback-only group, exercises admin naming/membership/leave boundaries and
-- agent-work cancellation, then removes every test change by rollback.

do $verify$
declare
  v_admin_id uuid;
  v_member_id uuid;
  v_agent_id uuid;
  v_agent_profile_id uuid;
  v_agent_slug text;
  v_conversation_id uuid := gen_random_uuid();
  v_source_message_id uuid := gen_random_uuid();
  v_job_id uuid;
  v_task_id uuid;
  v_notification_id uuid;
  v_rename_action_id uuid := gen_random_uuid();
  v_add_action_id uuid := gen_random_uuid();
  v_add_noop_action_id uuid := gen_random_uuid();
  v_add_agent_profile_action_id uuid := gen_random_uuid();
  v_demote_action_id uuid := gen_random_uuid();
  v_promote_action_id uuid := gen_random_uuid();
  v_remove_action_id uuid := gen_random_uuid();
  v_leave_action_id uuid := gen_random_uuid();
  v_added integer;
  v_count integer;
  v_last_admin_rejected boolean := false;
  v_reused_action_rejected boolean := false;
  v_agent_profile_rejected boolean := false;
  v_status text;
begin
  if to_regprocedure('public.rename_conversation_group(uuid,text,uuid)') is null
     or to_regprocedure('public.add_conversation_group_participants(uuid,uuid[],text[],uuid)') is null
     or to_regprocedure('public.set_conversation_group_admin(uuid,uuid,boolean,uuid)') is null
     or to_regprocedure('public.remove_conversation_group_participant(uuid,uuid,text,uuid)') is null
     or to_regprocedure('public.leave_conversation_group(uuid,uuid)') is null then
    raise exception 'FAIL: migration 108 group-management functions are missing';
  end if;
  if to_regclass('public.conversation_group_actions') is null
     or not exists (
       select 1 from pg_class relation
       where relation.oid = 'public.conversation_group_actions'::regclass
         and relation.relrowsecurity
     ) then
    raise exception 'FAIL: exactly-once group action audit is missing or not private';
  end if;
  if has_table_privilege('authenticated', 'public.conversation_group_actions', 'SELECT')
     or has_table_privilege('authenticated', 'public.conversation_group_actions', 'INSERT')
     or has_table_privilege('authenticated', 'public.conversation_group_actions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.conversation_group_actions', 'DELETE') then
    raise exception 'FAIL: clients retain direct access to the private group action audit';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'conversation_participants'
      and column_name = 'participant_role'
  ) then
    raise exception 'FAIL: participant admin role is missing';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and (
        (tablename = 'conversations' and policyname = 'members_update_conversations')
        or (tablename = 'conversation_participants' and policyname = 'creators_add_participants')
      )
  ) then
    raise exception 'FAIL: broad direct group writes still bypass the admin RPC boundary';
  end if;
  if has_table_privilege('authenticated', 'public.conversations', 'UPDATE')
     or has_table_privilege('authenticated', 'public.conversation_participants', 'INSERT')
     or has_table_privilege('authenticated', 'public.conversation_participants', 'DELETE') then
    raise exception 'FAIL: authenticated clients retain direct shared-group write privileges';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.rename_conversation_group(uuid,text,uuid)',
    'EXECUTE'
  ) then
    raise exception 'FAIL: health cannot probe the group-management capability';
  end if;

  select profile.id into v_admin_id
  from profiles profile
  where not exists (
    select 1 from conversation_agents agent where agent.auth_profile_id = profile.id
  )
  order by profile.created_at nulls last, profile.id
  limit 1;
  select profile.id into v_member_id
  from profiles profile
  where profile.id <> v_admin_id
    and not exists (
      select 1 from conversation_agents agent where agent.auth_profile_id = profile.id
    )
  order by profile.created_at nulls last, profile.id
  limit 1;
  select agent.id, agent.auth_profile_id, agent.slug
  into v_agent_id, v_agent_profile_id, v_agent_slug
  from conversation_agents agent
  where agent.active
    and agent.auth_profile_id is not null
    and agent.slug in ('aria', 'marco')
  order by agent.slug
  limit 1;
  if v_admin_id is null or v_member_id is null or v_agent_id is null then
    raise exception 'FAIL: two human profiles and one active agent are required for the rollback test';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  insert into conversations(id, kind, title, created_by)
  values (v_conversation_id, 'group', 'Migration 108 test group', v_admin_id);
  insert into conversation_participants(conversation_id, profile_id)
  values (v_conversation_id, v_admin_id), (v_conversation_id, v_member_id);

  select count(*) into v_count
  from conversation_participants participant
  where participant.conversation_id = v_conversation_id
    and participant.profile_id = v_admin_id
    and participant.participant_role = 'admin';
  if v_count <> 1 then
    raise exception 'FAIL: the group creator was not assigned the admin role';
  end if;

  if rename_conversation_group(v_conversation_id, 'Migration 108 renamed group', v_rename_action_id) <> 'Migration 108 renamed group' then
    raise exception 'FAIL: the admin could not rename the group';
  end if;
  if rename_conversation_group(v_conversation_id, 'Migration 108 renamed group', v_rename_action_id) <> 'Migration 108 renamed group' then
    raise exception 'FAIL: a rename retry did not return its original result';
  end if;
  select count(*) into v_count
  from conversation_messages message
  where message.conversation_id = v_conversation_id
    and message.kind = 'system'
    and message.metadata->>'group_action' = 'rename';
  if v_count <> 1 then raise exception 'FAIL: a rename retry duplicated canonical history'; end if;
  begin
    perform rename_conversation_group(v_conversation_id, 'Different retry payload', v_rename_action_id);
  exception
    when others then
      if sqlerrm not like '%already used for a different request%' then raise; end if;
      v_reused_action_rejected := true;
  end;
  if not v_reused_action_rejected then
    raise exception 'FAIL: a reused client action id accepted a different request';
  end if;
  select add_conversation_group_participants(
    v_conversation_id, array[]::uuid[], array[v_agent_slug], v_add_action_id
  ) into v_added;
  if v_added <> 1 then raise exception 'FAIL: the agent was not added once'; end if;
  select add_conversation_group_participants(
    v_conversation_id, array[]::uuid[], array[v_agent_slug], v_add_action_id
  ) into v_added;
  if v_added <> 1 then raise exception 'FAIL: an add retry did not return its original result'; end if;
  select add_conversation_group_participants(
    v_conversation_id, array[]::uuid[], array[v_agent_slug], v_add_noop_action_id
  ) into v_added;
  if v_added <> 0 then raise exception 'FAIL: a new add action duplicated an existing participant'; end if;
  begin
    perform add_conversation_group_participants(
      v_conversation_id,
      array[v_agent_profile_id],
      array[]::text[],
      v_add_agent_profile_action_id
    );
  exception
    when others then
      if sqlerrm not like '%participants are unavailable%' then raise; end if;
      v_agent_profile_rejected := true;
  end;
  if not v_agent_profile_rejected then
    raise exception 'FAIL: an agent authentication profile was accepted as a human participant';
  end if;

  begin
    perform set_conversation_group_admin(v_conversation_id, v_admin_id, false, v_demote_action_id);
  exception
    when others then
      if sqlerrm not like '%keep at least one admin%' then raise; end if;
      v_last_admin_rejected := true;
  end;
  if not v_last_admin_rejected then
    raise exception 'FAIL: the only group admin could demote themselves';
  end if;
  if not set_conversation_group_admin(v_conversation_id, v_member_id, true, v_promote_action_id) then
    raise exception 'FAIL: another human member was not promoted';
  end if;

  insert into conversation_messages(
    id, conversation_id, author_profile_id, kind, body, metadata
  ) values (
    v_source_message_id,
    v_conversation_id,
    v_admin_id,
    'text',
    'Migration 108 unfinished agent work',
    jsonb_build_object('background_task', true)
  );
  insert into agent_conversation_jobs(
    conversation_id, triggering_message_id, agent_id
  ) values (
    v_conversation_id, v_source_message_id, v_agent_id
  ) returning id into v_job_id;
  insert into agent_tasks(
    conversation_id,
    requested_by,
    owner_agent_id,
    source_message_id,
    client_task_id,
    title,
    objective,
    status
  ) values (
    v_conversation_id,
    v_admin_id,
    v_agent_id,
    v_source_message_id,
    'migration-108-' || gen_random_uuid()::text,
    'Migration 108 task',
    'This rollback-only task must be cancelled when its agent leaves the group.',
    'queued'
  ) returning id into v_task_id;

  if not remove_conversation_group_participant(v_conversation_id, null, v_agent_slug, v_remove_action_id) then
    raise exception 'FAIL: the admin could not remove the agent';
  end if;
  if not remove_conversation_group_participant(v_conversation_id, null, v_agent_slug, v_remove_action_id) then
    raise exception 'FAIL: a remove retry failed after access had already ended';
  end if;
  select status into strict v_status from agent_conversation_jobs where id = v_job_id;
  if v_status <> 'cancelled' then
    raise exception 'FAIL: removed agent conversational work kept running';
  end if;
  select status into strict v_status from agent_tasks where id = v_task_id;
  if v_status <> 'cancelled' then
    raise exception 'FAIL: removed agent background work kept running';
  end if;
  select count(*) into v_count
  from conversation_participants participant
  where participant.conversation_id = v_conversation_id
    and participant.agent_id = v_agent_id;
  if v_count <> 0 then raise exception 'FAIL: removed agent retained group access'; end if;

  insert into notifications(user_id, kind, title, body, link_href)
  values (
    v_admin_id,
    'conversation_message:' || v_conversation_id::text,
    'Migration 108 private preview',
    'This preview must be retired when the recipient leaves.',
    '/messages?conversation=' || v_conversation_id::text
  ) returning id into v_notification_id;

  if not leave_conversation_group(v_conversation_id, v_leave_action_id) then
    raise exception 'FAIL: the admin could not leave after assigning a successor';
  end if;
  if not leave_conversation_group(v_conversation_id, v_leave_action_id) then
    raise exception 'FAIL: a leave retry failed after access had already ended';
  end if;
  select count(*) into v_count
  from conversation_participants participant
  where participant.conversation_id = v_conversation_id
    and participant.profile_id = v_admin_id;
  if v_count <> 0 then raise exception 'FAIL: leaving did not revoke group access'; end if;
  select count(*) into v_count from notifications where id = v_notification_id;
  if v_count <> 0 then raise exception 'FAIL: a former member retained a private notification preview'; end if;
  select count(*) into v_count
  from conversation_participants participant
  where participant.conversation_id = v_conversation_id
    and participant.profile_id = v_member_id
    and participant.participant_role = 'admin';
  if v_count <> 1 then raise exception 'FAIL: the group did not retain a human admin'; end if;
  select count(*) into v_count
  from conversation_messages message
  where message.conversation_id = v_conversation_id
    and message.kind = 'system'
    and message.metadata ? 'group_action';
  if v_count < 5 then
    raise exception 'FAIL: group changes did not leave truthful canonical system history';
  end if;
  select count(*) into v_count
  from conversation_group_actions action
  where action.conversation_id = v_conversation_id
    and action.actor_profile_id = v_admin_id;
  if v_count <> 6 then
    raise exception 'FAIL: successful group actions were not recorded exactly once';
  end if;

  raise exception using errcode = 'P5108', message = 'RESLU_VERIFY_108_PASS';
exception
  when sqlstate 'P5108' then
    if sqlerrm <> 'RESLU_VERIFY_108_PASS' then raise; end if;
    raise notice 'PASS: group naming, admins, membership, leave and removed-agent cancellation are bounded and auditable; all test changes rolled back';
end;
$verify$;
