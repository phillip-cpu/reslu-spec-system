-- Run after migration 110. This rollback-only fixture proves private literal
-- filename search across uploaded and forwarded attachments without leaving
-- messages, rows or indexes created by the fixture itself.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid := gen_random_uuid();
  v_upload_message_id uuid := gen_random_uuid();
  v_forward_message_id uuid := gen_random_uuid();
  v_staged_message_id uuid := gen_random_uuid();
  v_deleted_message_id uuid := gen_random_uuid();
  v_upload_attachment_id uuid := gen_random_uuid();
  v_query text := 'RESLU-110-' || gen_random_uuid()::text || '%';
  v_decoy text;
  v_ids uuid[];
begin
  if to_regprocedure('public.search_conversation_messages(uuid,text,integer)') is null then
    raise exception 'FAIL: conversation search function is missing';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'conversation_attachments_filename_trgm_idx'
      and indexdef ilike '%gin_trgm_ops%'
  ) or not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'conversation_forwarded_attachments_filename_trgm_idx'
      and indexdef ilike '%gin_trgm_ops%'
  ) then
    raise exception 'FAIL: attachment filename trigram indexes are missing';
  end if;
  if has_function_privilege('anon', 'public.search_conversation_messages(uuid,text,integer)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute conversation search';
  end if;

  select profile.id into v_profile_id
  from profiles profile
  where not exists (
    select 1 from conversation_agents agent where agent.auth_profile_id = profile.id
  )
  order by profile.created_at nulls last, profile.id
  limit 1;
  if v_profile_id is null then raise exception 'FAIL: one human profile is required'; end if;

  v_decoy := replace(v_query, '%', '0');
  insert into conversations(id, kind, title, created_by)
  values (v_conversation_id, 'group', 'Migration 110 search test', v_profile_id);
  insert into conversation_participants(conversation_id, profile_id)
  values (v_conversation_id, v_profile_id);
  insert into conversation_messages(id, conversation_id, author_profile_id, kind, body, deleted_at)
  values
    (v_upload_message_id, v_conversation_id, v_profile_id, 'text', 'Uploaded file', null),
    (v_forward_message_id, v_conversation_id, v_profile_id, 'text', 'Forwarded file', null),
    (v_staged_message_id, v_conversation_id, v_profile_id, 'text', 'Unready file', null),
    (v_deleted_message_id, v_conversation_id, v_profile_id, 'text', 'Deleted file', now());

  insert into conversation_attachments(
    id, conversation_id, message_id, uploaded_by, storage_path,
    filename, mime_type, byte_size, status, metadata, ready_at
  ) values
    (
      v_upload_attachment_id, v_conversation_id, v_upload_message_id, v_profile_id,
      'migration-110/' || v_upload_attachment_id::text || '.pdf',
      v_query || '-client-brief.pdf', 'application/pdf', 4096, 'ready', '{}'::jsonb, now()
    ),
    (
      gen_random_uuid(), v_conversation_id, v_staged_message_id, v_profile_id,
      'migration-110/' || gen_random_uuid()::text || '.pdf',
      v_query || '-staged.pdf', 'application/pdf', 4096, 'uploading', '{}'::jsonb, null
    ),
    (
      gen_random_uuid(), v_conversation_id, v_deleted_message_id, v_profile_id,
      'migration-110/' || gen_random_uuid()::text || '.pdf',
      v_query || '-deleted.pdf', 'application/pdf', 4096, 'ready', '{}'::jsonb, now()
    ),
    (
      gen_random_uuid(), v_conversation_id, v_upload_message_id, v_profile_id,
      'migration-110/' || gen_random_uuid()::text || '.pdf',
      v_decoy || '-decoy.pdf', 'application/pdf', 4096, 'ready', '{}'::jsonb, now()
    );

  insert into conversation_forwarded_attachments(
    conversation_id, message_id, source_attachment_id, forwarded_by,
    storage_path, filename, mime_type, byte_size, metadata
  ) values (
    v_conversation_id, v_forward_message_id, v_upload_attachment_id, v_profile_id,
    'migration-110/' || v_upload_attachment_id::text || '.pdf',
    v_query || '-forwarded.pdf', 'application/pdf', 4096, '{}'::jsonb
  );

  perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select array_agg(message.id order by message.id) into v_ids
  from search_conversation_messages(v_conversation_id, v_query, 50) message;
  if coalesce(cardinality(v_ids), 0) <> 2
     or not (v_upload_message_id = any(v_ids))
     or not (v_forward_message_id = any(v_ids))
     or v_staged_message_id = any(v_ids)
     or v_deleted_message_id = any(v_ids) then
    raise exception 'FAIL: ready private file search returned the wrong messages: %', v_ids;
  end if;

  raise exception using errcode = 'P5110', message = 'RESLU_VERIFY_110_PASS';
exception
  when sqlstate 'P5110' then
    if sqlerrm <> 'RESLU_VERIFY_110_PASS' then raise; end if;
    raise notice 'PASS: message and ready private-file search is literal, bounded, indexed and member-scoped; all test changes rolled back';
end;
$verify$;
