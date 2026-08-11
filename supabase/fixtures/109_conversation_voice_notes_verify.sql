-- Run after migration 109. This rollback-only fixture proves bounded voice
-- metadata and forwarding compatibility without writing any Storage object.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid := gen_random_uuid();
  v_message_id uuid := gen_random_uuid();
  v_attachment_id uuid := gen_random_uuid();
  v_invalid_rejected boolean := false;
  v_fraction_rejected boolean := false;
  v_count integer;
begin
  if to_regprocedure('public.valid_conversation_voice_note_metadata(text,jsonb)') is null then
    raise exception 'FAIL: migration 109 voice-note metadata validator is missing';
  end if;
  if not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.conversation_attachments'::regclass
      and constraint_row.conname = 'conversation_attachments_voice_note_metadata_check'
      and constraint_row.contype = 'c'
  ) or not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.conversation_forwarded_attachments'::regclass
      and constraint_row.conname = 'conversation_forwarded_attachments_voice_note_metadata_check'
      and constraint_row.contype = 'c'
  ) then
    raise exception 'FAIL: voice-note constraints are missing';
  end if;
  if has_function_privilege('authenticated', 'public.valid_conversation_voice_note_metadata(text,jsonb)', 'EXECUTE') then
    raise exception 'FAIL: clients can call the internal voice-note validator directly';
  end if;

  select profile.id into v_profile_id
  from profiles profile
  where not exists (
    select 1 from conversation_agents agent where agent.auth_profile_id = profile.id
  )
  order by profile.created_at nulls last, profile.id
  limit 1;
  if v_profile_id is null then raise exception 'FAIL: one human profile is required'; end if;

  insert into conversations(id, kind, title, created_by)
  values (v_conversation_id, 'group', 'Migration 109 voice-note test', v_profile_id);
  insert into conversation_participants(conversation_id, profile_id)
  values (v_conversation_id, v_profile_id);
  insert into conversation_messages(id, conversation_id, author_profile_id, kind, body, metadata)
  values (
    v_message_id,
    v_conversation_id,
    v_profile_id,
    'text',
    'Voice note · 0:12',
    jsonb_build_object('source', 'voice_note')
  );
  insert into conversation_attachments(
    id, conversation_id, message_id, uploaded_by, storage_path,
    filename, mime_type, byte_size, status, metadata, ready_at
  ) values (
    v_attachment_id,
    v_conversation_id,
    v_message_id,
    v_profile_id,
    'migration-109/' || v_attachment_id::text || '.webm',
    'Voice note.webm',
    'audio/webm',
    4096,
    'ready',
    jsonb_build_object('voice_note', true, 'duration_ms', 12000),
    now()
  );
  insert into conversation_forwarded_attachments(
    conversation_id, message_id, source_attachment_id, forwarded_by,
    storage_path, filename, mime_type, byte_size, metadata
  ) values (
    v_conversation_id,
    v_message_id,
    v_attachment_id,
    v_profile_id,
    'migration-109/' || v_attachment_id::text || '.webm',
    'Voice note.webm',
    'audio/webm',
    4096,
    jsonb_build_object('voice_note', true, 'duration_ms', 12000, 'forwarded', true)
  );

  begin
    insert into conversation_attachments(
      conversation_id, uploaded_by, storage_path, filename, mime_type, byte_size, metadata
    ) values (
      v_conversation_id,
      v_profile_id,
      'migration-109/invalid-' || gen_random_uuid()::text || '.m4a',
      'Invalid voice note.m4a',
      'audio/mp4',
      1024,
      jsonb_build_object('voice_note', true, 'duration_ms', 300001)
    );
  exception when check_violation then
    v_invalid_rejected := true;
  end;
  if not v_invalid_rejected then
    raise exception 'FAIL: an overlong voice note bypassed the metadata constraint';
  end if;

  begin
    insert into conversation_attachments(
      conversation_id, uploaded_by, storage_path, filename, mime_type, byte_size, metadata
    ) values (
      v_conversation_id,
      v_profile_id,
      'migration-109/fraction-' || gen_random_uuid()::text || '.webm',
      'Invalid fractional voice note.webm',
      'audio/webm',
      1024,
      jsonb_build_object('voice_note', true, 'duration_ms', 12000.5)
    );
  exception when check_violation then
    v_fraction_rejected := true;
  end;
  if not v_fraction_rejected then
    raise exception 'FAIL: a fractional duration bypassed the integer metadata contract';
  end if;

  select count(*) into v_count
  from conversation_attachments attachment
  where attachment.id = v_attachment_id
    and attachment.mime_type = 'audio/webm'
    and attachment.metadata->>'voice_note' = 'true'
    and (attachment.metadata->>'duration_ms')::integer = 12000;
  if v_count <> 1 then raise exception 'FAIL: canonical voice-note attachment was not retained'; end if;
  select count(*) into v_count
  from conversation_forwarded_attachments attachment
  where attachment.source_attachment_id = v_attachment_id
    and attachment.mime_type = 'audio/webm';
  if v_count <> 1 then raise exception 'FAIL: a forwarded voice note lost its private attachment snapshot'; end if;

  raise exception using errcode = 'P5109', message = 'RESLU_VERIFY_109_PASS';
exception
  when sqlstate 'P5109' then
    if sqlerrm <> 'RESLU_VERIFY_109_PASS' then raise; end if;
    raise notice 'PASS: voice notes are bounded, private and forwarding-compatible; all test changes rolled back';
end;
$verify$;
