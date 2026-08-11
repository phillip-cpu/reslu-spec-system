-- Run in the Supabase SQL Editor only after migrations 105 and 106. It proves
-- reaction replacement/toggle, the five-pin limit and deletion cleanup, then
-- rolls every test row back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_message_id uuid := gen_random_uuid();
  v_extra_message_id uuid;
  v_reaction_count integer;
  v_pin_count integer;
  v_index integer;
  v_limit_rejected boolean := false;
begin
  if to_regclass('public.conversation_message_reactions') is null
     or to_regclass('public.conversation_message_pins') is null
     or to_regprocedure('public.toggle_conversation_message_reaction(uuid,uuid,text)') is null
     or to_regprocedure('public.set_conversation_message_pinned(uuid,uuid,boolean)') is null then
    raise exception 'FAIL: migration 106 objects are missing';
  end if;
  if to_regprocedure('public.delete_conversation_message_recoverably(uuid,uuid)') is null then
    raise exception 'FAIL: migration 105 must be applied before migration 106 verification';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.conversation_message_reactions'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.conversation_message_pins'::regclass) then
    raise exception 'FAIL: reaction or pin RLS is disabled';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('conversation_message_reactions', 'conversation_message_pins')
      and cmd <> 'SELECT'
  ) then
    raise exception 'FAIL: clients can bypass the reaction/pin RPC boundary';
  end if;

  select participant.profile_id, participant.conversation_id
  into v_profile_id, v_conversation_id
  from conversation_participants participant
  where participant.profile_id is not null
  limit 1;
  if v_profile_id is null then
    raise exception 'FAIL: no human conversation exists for the rollback test';
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
    'Migration 106 reaction and pin test',
    jsonb_build_object('background_task', true)
  );

  perform * from toggle_conversation_message_reaction(v_conversation_id, v_message_id, '👍');
  perform * from toggle_conversation_message_reaction(v_conversation_id, v_message_id, '❤️');
  select count(*) into v_reaction_count
  from conversation_message_reactions
  where message_id = v_message_id and profile_id = v_profile_id and reaction = '❤️';
  if v_reaction_count <> 1 then
    raise exception 'FAIL: choosing another reaction did not replace the first';
  end if;

  perform * from toggle_conversation_message_reaction(v_conversation_id, v_message_id, '❤️');
  select count(*) into v_reaction_count
  from conversation_message_reactions where message_id = v_message_id;
  if v_reaction_count <> 0 then
    raise exception 'FAIL: tapping the same reaction did not remove it';
  end if;
  perform * from toggle_conversation_message_reaction(v_conversation_id, v_message_id, '👍');

  if not set_conversation_message_pinned(v_conversation_id, v_message_id, true) then
    raise exception 'FAIL: the first message was not pinned';
  end if;
  if not set_conversation_message_pinned(v_conversation_id, v_message_id, true) then
    raise exception 'FAIL: a retry did not return the existing pin';
  end if;

  for v_index in 1..5 loop
    v_extra_message_id := gen_random_uuid();
    insert into conversation_messages(
      id, conversation_id, author_profile_id, kind, body, metadata
    ) values (
      v_extra_message_id,
      v_conversation_id,
      v_profile_id,
      'text',
      'Migration 106 extra pin ' || v_index::text,
      jsonb_build_object('background_task', true)
    );
    if v_index <= 4 then
      perform set_conversation_message_pinned(v_conversation_id, v_extra_message_id, true);
    else
      begin
        perform set_conversation_message_pinned(v_conversation_id, v_extra_message_id, true);
      exception
        when others then
          if sqlerrm not like '%no more than five messages%' then raise; end if;
          v_limit_rejected := true;
      end;
    end if;
  end loop;

  select count(*) into v_pin_count
  from conversation_message_pins where conversation_id = v_conversation_id;
  if not v_limit_rejected or v_pin_count <> 5 then
    raise exception 'FAIL: the shared five-message pin limit was not enforced';
  end if;

  perform delete_conversation_message_recoverably(v_conversation_id, v_message_id);
  select count(*) into v_reaction_count
  from conversation_message_reactions where message_id = v_message_id;
  select count(*) into v_pin_count
  from conversation_message_pins where message_id = v_message_id;
  if v_reaction_count <> 0 or v_pin_count <> 0 then
    raise exception 'FAIL: deleting a message did not clear its reaction and pin';
  end if;

  raise exception using errcode = 'P5106', message = 'RESLU_VERIFY_106_PASS';
exception
  when sqlstate 'P5106' then
    if sqlerrm <> 'RESLU_VERIFY_106_PASS' then raise; end if;
    raise notice 'PASS: reactions and shared five-message pins are member-scoped, bounded and deletion-safe; all test changes rolled back';
end;
$verify$;
