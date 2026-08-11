-- Run in the Supabase SQL Editor only after migration 098 succeeds.
-- This single atomic statement proves quoted replies are same-conversation
-- and idempotent, while the pre-098 five-argument call remains compatible.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_target_message_id uuid;
  v_reply_message_id uuid;
  v_legacy_message_id uuid;
  v_decoy_conversation_id uuid;
  v_decoy_target_id uuid;
  v_reply_client_id uuid := gen_random_uuid();
  v_legacy_client_id uuid := gen_random_uuid();
  v_cross_client_id uuid := gen_random_uuid();
  v_retry_id uuid;
  v_canonical_reply record;
  v_canonical_legacy record;
begin
  if to_regprocedure(
    'public.create_conversation_message_idempotent(uuid,text,jsonb,uuid,uuid[],uuid)'
  ) is null then
    raise exception 'FAIL: migration 098 reply-aware send function is missing';
  end if;
  if to_regprocedure(
    'public.create_conversation_message_idempotent(uuid,text,jsonb,uuid,uuid[])'
  ) is not null then
    raise exception 'FAIL: ambiguous five-argument overload still exists';
  end if;
  if has_function_privilege(
    'anon',
    'public.create_conversation_message_idempotent(uuid,text,jsonb,uuid,uuid[],uuid)',
    'EXECUTE'
  ) then
    raise exception 'FAIL: anon can execute canonical message sends';
  end if;

  select participant.profile_id, participant.conversation_id
  into v_profile_id, v_conversation_id
  from conversation_participants participant
  where participant.profile_id is not null
  limit 1;

  if v_profile_id is null or v_conversation_id is null then
    raise exception 'FAIL: no human conversation participant exists for the rollback test';
  end if;

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
      'RESLU migration 098 quoted target'
    )
    returning id into v_target_message_id;

    perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);

    select message.id into strict v_reply_message_id
    from create_conversation_message_idempotent(
      v_conversation_id,
      'Reply with exact target',
      '{"source":"text"}'::jsonb,
      v_reply_client_id,
      array[]::uuid[],
      v_target_message_id
    ) message;

    -- The old application omits p_reply_to_id. Its five-argument call must
    -- stay operational during a database-first deployment.
    select message.id into strict v_legacy_message_id
    from create_conversation_message_idempotent(
      v_conversation_id,
      'Legacy five-argument send',
      '{"source":"text"}'::jsonb,
      v_legacy_client_id,
      array[]::uuid[]
    ) message;

    select * into strict v_canonical_reply
    from conversation_messages
    where id = v_reply_message_id;

    select * into strict v_canonical_legacy
    from conversation_messages
    where id = v_legacy_message_id;

    if v_canonical_reply.reply_to_id <> v_target_message_id then
      raise exception 'FAIL: canonical reply target was not preserved';
    end if;
    if v_canonical_legacy.reply_to_id is not null then
      raise exception 'FAIL: legacy send unexpectedly gained a reply target';
    end if;

    -- A target from another conversation must never be accepted.
    insert into conversations (kind, title, created_by)
    values ('direct', 'RESLU migration 098 rollback decoy', v_profile_id)
    returning id into v_decoy_conversation_id;

    insert into conversation_messages (
      conversation_id,
      author_profile_id,
      kind,
      body
    ) values (
      v_decoy_conversation_id,
      v_profile_id,
      'system',
      'RESLU migration 098 cross-conversation target'
    )
    returning id into v_decoy_target_id;

    begin
      perform create_conversation_message_idempotent(
        v_conversation_id,
        'Cross-conversation reply must fail',
        '{"source":"text"}'::jsonb,
        v_cross_client_id,
        array[]::uuid[],
        v_decoy_target_id
      );
      raise exception 'FAIL: a cross-conversation reply target was accepted';
    exception
      when others then
        if sqlerrm = 'FAIL: a cross-conversation reply target was accepted' then
          raise;
        end if;
        if sqlerrm not ilike '%reply target is unavailable%' then
          raise exception 'FAIL: unexpected cross-conversation target error: %', sqlerrm;
        end if;
    end;

    -- An exactly-once retry must still return the canonical reply if its target
    -- is deleted after the original send.
    update conversation_messages
    set deleted_at = now()
    where id = v_target_message_id;

    select message.id into strict v_retry_id
    from create_conversation_message_idempotent(
      v_conversation_id,
      'Reply with exact target',
      '{"source":"text"}'::jsonb,
      v_reply_client_id,
      array[]::uuid[],
      v_target_message_id
    ) message;

    if v_retry_id <> v_reply_message_id then
      raise exception 'FAIL: retry did not return the canonical reply after its target was later deleted';
    end if;

    begin
      perform create_conversation_message_idempotent(
        v_conversation_id,
        'Reply with exact target',
        '{"source":"text"}'::jsonb,
        v_reply_client_id,
        array[]::uuid[],
        null
      );
      raise exception 'FAIL: one client send id changed its reply target';
    exception
      when others then
        if sqlerrm = 'FAIL: one client send id changed its reply target' then
          raise;
        end if;
        if sqlerrm not ilike '%client message id was already used for different content%' then
          raise exception 'FAIL: unexpected reply idempotency error: %', sqlerrm;
        end if;
    end;

    raise exception using
      errcode = 'P5098',
      message = 'RESLU_VERIFY_098_PASS';
  exception
    when sqlstate 'P5098' then
      if sqlerrm <> 'RESLU_VERIFY_098_PASS' then
        raise;
      end if;
      raise notice 'PASS: quoted replies are canonical, same-conversation, idempotent and rollout-compatible; all test changes rolled back';
  end;
end;
$verify$;
