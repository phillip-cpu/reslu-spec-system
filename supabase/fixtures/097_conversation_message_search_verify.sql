-- Run in the Supabase SQL Editor only after migration 097 succeeds.
-- This single atomic statement proves membership-scoped literal search and
-- the performance index, then rolls every test change back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_literal_message_id uuid;
  v_decoy_message_id uuid;
  v_literal_body text := 'RESLU-097-' || gen_random_uuid()::text || '%';
  v_decoy_body text;
  v_matched_ids uuid[];
begin
  if to_regprocedure('public.search_conversation_messages(uuid,text,integer)') is null then
    raise exception 'FAIL: migration 097 search function is missing';
  end if;
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'conversation_messages_body_trgm_idx'
      and indexdef ilike '%using gin%'
      and indexdef ilike '%gin_trgm_ops%'
  ) then
    raise exception 'FAIL: trigram search index is missing';
  end if;
  if has_function_privilege(
    'anon',
    'public.search_conversation_messages(uuid,text,integer)',
    'EXECUTE'
  ) then
    raise exception 'FAIL: anon can execute conversation search';
  end if;

  select participant.profile_id, participant.conversation_id
  into v_profile_id, v_conversation_id
  from conversation_participants participant
  where participant.profile_id is not null
  limit 1;

  if v_profile_id is null or v_conversation_id is null then
    raise exception 'FAIL: no human conversation participant exists for the rollback test';
  end if;

  v_decoy_body := replace(v_literal_body, '%', '0');

  -- The deliberate success exception rolls back this inner subtransaction.
  -- Genuine failures escape and roll back the entire statement.
  begin
    insert into conversation_messages (
      conversation_id,
      author_profile_id,
      kind,
      body
    ) values (
      v_conversation_id,
      v_profile_id,
      'system',
      v_literal_body
    )
    returning id into v_literal_message_id;

    insert into conversation_messages (
      conversation_id,
      author_profile_id,
      kind,
      body
    ) values (
      v_conversation_id,
      v_profile_id,
      'system',
      v_decoy_body
    )
    returning id into v_decoy_message_id;

    perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);

    select array_agg(message.id) into v_matched_ids
    from search_conversation_messages(v_conversation_id, v_literal_body, 50) message;

    if coalesce(cardinality(v_matched_ids), 0) <> 1
       or v_matched_ids[1] <> v_literal_message_id
       or v_matched_ids[1] = v_decoy_message_id then
      raise exception 'FAIL: wildcard characters were not searched literally: %', v_matched_ids;
    end if;

    begin
      perform *
      from search_conversation_messages(v_conversation_id, v_literal_body, null);
      raise exception 'FAIL: a null result limit bypassed the search bound';
    exception
      when others then
        if sqlerrm = 'FAIL: a null result limit bypassed the search bound' then
          raise;
        end if;
        if sqlerrm not ilike '%search limit must be between 1 and 50%' then
          raise exception 'FAIL: unexpected null search-limit error: %', sqlerrm;
        end if;
    end;

    raise exception using
      errcode = 'P5097',
      message = 'RESLU_VERIFY_097_PASS';
  exception
    when sqlstate 'P5097' then
      if sqlerrm <> 'RESLU_VERIFY_097_PASS' then
        raise;
      end if;
      raise notice 'PASS: canonical message search is private, literal, bounded and indexed; all test changes rolled back';
  end;
end;
$verify$;
