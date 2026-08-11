-- Run in the Supabase SQL Editor only after migration 105 succeeds. The test
-- edits, conflicts, deletes and restores a real rollback-only message.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_agent_id uuid;
  v_message_id uuid := gen_random_uuid();
  v_job_id uuid;
  v_created_at timestamptz;
  v_message conversation_messages;
  v_job_status text;
  v_recovery_count integer;
begin
  if to_regclass('public.conversation_message_recoveries') is null
     or to_regprocedure('public.edit_conversation_message(uuid,uuid,text,timestamp with time zone)') is null
     or to_regprocedure('public.delete_conversation_message_recoverably(uuid,uuid)') is null
     or to_regprocedure('public.restore_conversation_message(uuid,uuid)') is null
     or to_regprocedure('public.purge_expired_conversation_message_recoveries()') is null then
    raise exception 'FAIL: migration 105 objects are missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.conversation_message_recoveries'::regclass) then
    raise exception 'FAIL: deleted message recovery content has no RLS';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'conversation_message_recoveries'
      and policyname = 'authors_read_message_recoveries'
      and qual ilike '%expires_at%now()%'
  ) then
    raise exception 'FAIL: author-only recovery policy is missing';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.purge_expired_conversation_message_recoveries()',
    'EXECUTE'
  ) then
    raise exception 'FAIL: clients can purge deleted-message recovery content';
  end if;

  select human.profile_id, human.conversation_id, agent_participant.agent_id
  into v_profile_id, v_conversation_id, v_agent_id
  from conversation_participants human
  join conversation_participants agent_participant
    on agent_participant.conversation_id = human.conversation_id
   and agent_participant.agent_id is not null
  where human.profile_id is not null
  limit 1;
  if v_profile_id is null then
    raise exception 'FAIL: no human and agent conversation exists for the rollback test';
  end if;

  perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  insert into conversation_messages(
    id, conversation_id, author_profile_id, kind, body, metadata
  ) values (
    v_message_id,
    v_conversation_id,
    v_profile_id,
    'text',
    'Migration 105 original text',
    jsonb_build_object('background_task', true)
  ) returning created_at into v_created_at;

  insert into agent_conversation_jobs(
    conversation_id, triggering_message_id, agent_id
  ) values (
    v_conversation_id, v_message_id, v_agent_id
  ) returning id into v_job_id;

  v_message := edit_conversation_message(
    v_conversation_id,
    v_message_id,
    'Migration 105 edited text',
    v_created_at
  );
  if v_message.body <> 'Migration 105 edited text' or v_message.edited_at is null then
    raise exception 'FAIL: the owned message was not edited';
  end if;

  begin
    perform edit_conversation_message(
      v_conversation_id,
      v_message_id,
      'A stale-device overwrite',
      v_created_at
    );
    raise exception 'FAIL: a stale edit overwrote the canonical message';
  exception
    when others then
      if sqlerrm not like '%message changed on another device%' then
        raise;
      end if;
  end;

  v_message := delete_conversation_message_recoverably(v_conversation_id, v_message_id);
  select status into strict v_job_status from agent_conversation_jobs where id = v_job_id;
  select count(*) into v_recovery_count
  from conversation_message_recoveries
  where message_id = v_message_id
    and author_profile_id = v_profile_id
    and original_body = 'Migration 105 edited text'
    and expires_at > now();
  if v_message.deleted_at is null or v_message.body <> 'This message was deleted.' then
    raise exception 'FAIL: shared message content was not replaced by a tombstone';
  end if;
  if v_job_status <> 'cancelled' then
    raise exception 'FAIL: unfinished reply to the deleted message was not cancelled';
  end if;
  if v_recovery_count <> 1 then
    raise exception 'FAIL: exactly one private recoverable copy was not retained';
  end if;

  v_message := restore_conversation_message(v_conversation_id, v_message_id);
  select count(*) into v_recovery_count
  from conversation_message_recoveries where message_id = v_message_id;
  if v_message.deleted_at is not null or v_message.body <> 'Migration 105 edited text' then
    raise exception 'FAIL: the deleted message was not restored';
  end if;
  if v_recovery_count <> 0 then
    raise exception 'FAIL: private recovery content remained after restore';
  end if;
  select status into strict v_job_status from agent_conversation_jobs where id = v_job_id;
  if v_job_status <> 'cancelled' then
    raise exception 'FAIL: restore silently reactivated the cancelled agent reply';
  end if;

  raise exception using errcode = 'P5105', message = 'RESLU_VERIFY_105_PASS';
exception
  when sqlstate 'P5105' then
    if sqlerrm <> 'RESLU_VERIFY_105_PASS' then raise; end if;
    raise notice 'PASS: message edit conflict control and private recoverable delete are ready; all test changes rolled back';
end;
$verify$;
