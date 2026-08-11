-- Run in the Supabase SQL Editor only after migration 096 succeeds.
-- This single atomic statement proves mute, pin and archive are private
-- per-participant preferences, then rolls every test change back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_participant record;
  v_inbox record;
begin
  if to_regprocedure('public.update_conversation_preferences(uuid,boolean,boolean,boolean)') is null then
    raise exception 'FAIL: migration 096 preference function is missing';
  end if;
  if has_function_privilege(
    'anon',
    'public.update_conversation_preferences(uuid,boolean,boolean,boolean)',
    'EXECUTE'
  ) then
    raise exception 'FAIL: anon can execute the preference function';
  end if;

  select participant.profile_id, participant.conversation_id
  into v_profile_id, v_conversation_id
  from conversation_participants participant
  where participant.profile_id is not null
  limit 1;

  if v_profile_id is null or v_conversation_id is null then
    raise exception 'FAIL: no human conversation participant exists for the rollback test';
  end if;

  -- The deliberate success exception at the bottom rolls back this inner
  -- subtransaction. Any genuine failure escapes and rolls back the entire
  -- statement, so no preference or authentication test state can be retained.
  begin
    perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);

    perform *
    from update_conversation_preferences(
      v_conversation_id,
      true,
      false,
      true
    );

    select * into strict v_participant
    from conversation_participants participant
    where participant.conversation_id = v_conversation_id
      and participant.profile_id = v_profile_id;

    select * into strict v_inbox
    from get_conversation_inbox() inbox
    where inbox.conversation_id = v_conversation_id;

    if v_participant.notifications_muted is not true
       or v_participant.pinned_at is null
       or v_participant.archived_at is not null then
      raise exception 'FAIL: mute and pin did not update only the participant inbox row';
    end if;
    if v_inbox.notifications_muted is not true
       or v_inbox.pinned_at is null
       or v_inbox.archived_at is not null then
      raise exception 'FAIL: the inbox RPC did not expose the preference state';
    end if;

    perform *
    from update_conversation_preferences(
      v_conversation_id,
      null,
      true,
      null
    );

    select * into strict v_participant
    from conversation_participants participant
    where participant.conversation_id = v_conversation_id
      and participant.profile_id = v_profile_id;

    if v_participant.archived_at is null or v_participant.pinned_at is not null then
      raise exception 'FAIL: archiving did not unpin the participant conversation';
    end if;

    begin
      perform *
      from update_conversation_preferences(
        v_conversation_id,
        null,
        true,
        true
      );
      raise exception 'FAIL: one request archived and pinned the same conversation';
    exception
      when others then
        if sqlerrm = 'FAIL: one request archived and pinned the same conversation' then
          raise;
        end if;
        if sqlerrm not ilike '%cannot be archived and pinned at the same time%' then
          raise exception 'FAIL: unexpected archive/pin conflict error: %', sqlerrm;
        end if;
    end;

    raise exception using
      errcode = 'P5096',
      message = 'RESLU_VERIFY_096_PASS';
  exception
    when sqlstate 'P5096' then
      if sqlerrm <> 'RESLU_VERIFY_096_PASS' then
        raise;
      end if;
      raise notice 'PASS: mute, pin and archive are private, visible and mutually consistent; all test changes rolled back';
  end;
end;
$verify$;
