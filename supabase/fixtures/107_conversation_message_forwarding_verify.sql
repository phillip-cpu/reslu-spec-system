-- Run in the Supabase SQL Editor only after migrations 105, 106 and 107.
-- It proves exactly-once forwarding, private attachment sharing, direct-agent
-- enqueue and forward-again continuity, then rolls every test row back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_source_message_id uuid := gen_random_uuid();
  v_source_attachment_id uuid := gen_random_uuid();
  v_client_forward_id uuid := gen_random_uuid();
  v_second_client_forward_id uuid := gen_random_uuid();
  v_forwarded_message_id uuid;
  v_forwarded_again_message_id uuid;
  v_existing boolean;
  v_count integer;
  v_mismatch_rejected boolean := false;
  v_revoked_retry_rejected boolean := false;
  v_participant conversation_participants%rowtype;
begin
  if to_regclass('public.conversation_forwarded_attachments') is null
     or to_regclass('public.conversation_message_forwards') is null
     or to_regprocedure('public.forward_conversation_message(uuid,uuid,uuid[],uuid)') is null then
    raise exception 'FAIL: migration 107 forwarding objects are missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.conversation_forwarded_attachments'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.conversation_message_forwards'::regclass) then
    raise exception 'FAIL: forwarding attachment or audit RLS is disabled';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('conversation_forwarded_attachments', 'conversation_message_forwards')
      and cmd <> 'SELECT'
  ) then
    raise exception 'FAIL: clients can bypass the forwarding RPC write boundary';
  end if;
  if has_table_privilege('authenticated', 'public.conversation_forwarded_attachments', 'INSERT')
     or has_table_privilege('authenticated', 'public.conversation_message_forwards', 'INSERT') then
    raise exception 'FAIL: authenticated clients can directly create forwarding rows';
  end if;
  if has_column_privilege(
    'authenticated',
    'public.conversation_forwarded_attachments',
    'storage_path',
    'SELECT'
  ) then
    raise exception 'FAIL: target members can read the original private storage path';
  end if;

  select human.profile_id, human.conversation_id
  into v_profile_id, v_conversation_id
  from conversation_participants human
  where human.profile_id is not null
    and (
      select count(*) from conversation_participants member
      where member.conversation_id = human.conversation_id
    ) = 2
    and (
      select count(*) from conversation_participants agent_member
      where agent_member.conversation_id = human.conversation_id
        and agent_member.agent_id is not null
    ) = 1
  limit 1;
  if v_profile_id is null then
    raise exception 'FAIL: no direct human-agent conversation exists for the rollback test';
  end if;

  perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  insert into conversation_messages(
    id, conversation_id, author_profile_id, kind, body, metadata
  ) values (
    v_source_message_id,
    v_conversation_id,
    v_profile_id,
    'text',
    'Migration 107 private file forward test',
    jsonb_build_object('background_task', true)
  );

  insert into conversation_attachments(
    id,
    conversation_id,
    message_id,
    uploaded_by,
    storage_path,
    filename,
    mime_type,
    byte_size,
    status,
    ready_at
  ) values (
    v_source_attachment_id,
    v_conversation_id,
    v_source_message_id,
    v_profile_id,
    'conversation-forward-verifier/' || v_source_attachment_id::text || '.pdf',
    'forward-verifier.pdf',
    'application/pdf',
    128,
    'ready',
    now()
  );

  select result.forwarded_message_id, result.existing
  into strict v_forwarded_message_id, v_existing
  from forward_conversation_message(
    v_conversation_id,
    v_source_message_id,
    array[v_conversation_id],
    v_client_forward_id
  ) result;
  if v_existing then
    raise exception 'FAIL: the first forward was incorrectly reported as existing';
  end if;

  select result.existing
  into strict v_existing
  from forward_conversation_message(
    v_conversation_id,
    v_source_message_id,
    array[v_conversation_id],
    v_client_forward_id
  ) result;
  if not v_existing then
    raise exception 'FAIL: retry did not return the canonical existing forward';
  end if;

  delete from conversation_participants participant
  where participant.conversation_id = v_conversation_id
    and participant.profile_id = v_profile_id
  returning participant.* into strict v_participant;
  begin
    perform *
    from forward_conversation_message(
      v_conversation_id,
      v_source_message_id,
      array[v_conversation_id],
      v_client_forward_id
    );
  exception
    when others then
      if sqlerrm not like '%source message not found%' then raise; end if;
      v_revoked_retry_rejected := true;
  end;
  insert into conversation_participants
  select (v_participant).*;
  if not v_revoked_retry_rejected then
    raise exception 'FAIL: exactly-once retry bypassed current conversation membership';
  end if;

  select count(*) into v_count
  from conversation_message_forwards audit
  where audit.forwarded_by = v_profile_id
    and audit.client_forward_id = v_client_forward_id
    and audit.forwarded_message_id = v_forwarded_message_id;
  if v_count <> 1 then
    raise exception 'FAIL: retry created duplicate forward audit rows';
  end if;
  select count(*) into v_count
  from conversation_messages message
  where message.id = v_forwarded_message_id
    and message.author_profile_id = v_profile_id
    and message.body = 'Migration 107 private file forward test'
    and message.metadata->>'source' = 'forward'
    and message.metadata->>'forwarded' = 'true';
  if v_count <> 1 then
    raise exception 'FAIL: the canonical forwarded message or provenance is incorrect';
  end if;
  select count(*) into v_count
  from conversation_forwarded_attachments attachment
  where attachment.message_id = v_forwarded_message_id
    and attachment.source_attachment_id = v_source_attachment_id
    and attachment.storage_path = 'conversation-forward-verifier/' || v_source_attachment_id::text || '.pdf';
  if v_count <> 1 then
    raise exception 'FAIL: private attachment was not shared as one bounded snapshot';
  end if;
  select count(*) into v_count
  from agent_conversation_jobs job
  where job.triggering_message_id = v_forwarded_message_id;
  if v_count <> 1 then
    raise exception 'FAIL: the direct-agent destination was not enqueued exactly once';
  end if;

  begin
    perform *
    from forward_conversation_message(
      v_conversation_id,
      gen_random_uuid(),
      array[v_conversation_id],
      v_client_forward_id
    );
  exception
    when others then
      if sqlerrm not like '%already used for a different request%' then raise; end if;
      v_mismatch_rejected := true;
  end;
  if not v_mismatch_rejected then
    raise exception 'FAIL: a reused client forward id accepted different content';
  end if;

  select result.forwarded_message_id
  into strict v_forwarded_again_message_id
  from forward_conversation_message(
    v_conversation_id,
    v_forwarded_message_id,
    array[v_conversation_id],
    v_second_client_forward_id
  ) result;
  select count(*) into v_count
  from conversation_forwarded_attachments attachment
  where attachment.message_id = v_forwarded_again_message_id
    and attachment.source_forwarded_attachment_id is not null
    and attachment.storage_path = 'conversation-forward-verifier/' || v_source_attachment_id::text || '.pdf';
  if v_count <> 1 then
    raise exception 'FAIL: forwarding an already-forwarded private attachment lost continuity';
  end if;

  update conversation_messages
  set body = 'This message was deleted.', deleted_at = now()
  where id = v_source_message_id;
  select count(*) into v_count
  from conversation_messages message
  join conversation_forwarded_attachments attachment on attachment.message_id = message.id
  where message.id = v_forwarded_message_id
    and message.deleted_at is null
    and attachment.storage_path = 'conversation-forward-verifier/' || v_source_attachment_id::text || '.pdf';
  if v_count <> 1 then
    raise exception 'FAIL: deleting the source broke the independent forwarded copy';
  end if;

  raise exception using errcode = 'P5107', message = 'RESLU_VERIFY_107_PASS';
exception
  when sqlstate 'P5107' then
    if sqlerrm <> 'RESLU_VERIFY_107_PASS' then raise; end if;
    raise notice 'PASS: message forwarding is exactly-once, current-member scoped, private-file safe, repeatable and direct-agent aware; all test changes rolled back';
end;
$verify$;
