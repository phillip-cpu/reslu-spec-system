-- Run after migration 117. The deliberate PASS exception rolls the entire
-- fixture back, including its synthetic call row.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_call_id uuid := gen_random_uuid();
  v_record_id uuid := gen_random_uuid();
  v_metadata jsonb;
  v_private_field_rejected boolean := false;
  v_direct_update_rejected boolean := false;
begin
  if to_regprocedure('public.record_conversation_call_native_continuity(uuid,uuid,jsonb)') is null then
    raise exception 'FAIL: migration 117 native continuity function is missing';
  end if;

  select participant.profile_id, participant.conversation_id
  into v_profile_id, v_conversation_id
  from conversation_participants participant
  where participant.profile_id is not null
  limit 1;
  if v_profile_id is null then raise exception 'FAIL: a human conversation member is required'; end if;

  insert into conversation_calls(id, conversation_id, started_by, status, presentation)
  values (v_call_id, v_conversation_id, v_profile_id, 'ended', 'office');
  insert into conversation_messages(id, conversation_id, author_profile_id, kind, body, metadata)
  values (
    v_record_id, v_conversation_id, v_profile_id, 'call_record', 'Synthetic native continuity verifier call.',
    jsonb_build_object('call_id', v_call_id)
  );

  perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;

  begin
    update conversation_calls
    set metadata = jsonb_build_object('transcript', 'private')
    where id = v_call_id;
  exception when insufficient_privilege then
    v_direct_update_rejected := true;
  end;
  if not v_direct_update_rejected then
    raise exception 'FAIL: authenticated clients can bypass native continuity validation';
  end if;

  perform record_conversation_call_native_continuity(v_conversation_id, v_call_id, jsonb_build_object(
    'schema_version', 1,
    'transport', 'native_webrtc_callkit',
    'background_transitions', 2,
    'reconnect_attempts', 2,
    'data_channel_opens', 3,
    'audio_route_changes', 1,
    'callkit_audio_activations', 2,
    'mute_changes', 1,
    'ended_while_background', true,
    'replayed_web_events', 6,
    'peak_buffered_web_events', 4
  ));
  perform record_conversation_call_native_continuity(v_conversation_id, v_call_id, jsonb_build_object(
    'schema_version', 1,
    'transport', 'native_webrtc_callkit',
    'background_transitions', 1,
    'reconnect_attempts', 1,
    'data_channel_opens', 1,
    'audio_route_changes', 0,
    'callkit_audio_activations', 1,
    'mute_changes', 0,
    'ended_while_background', false,
    'replayed_web_events', 2,
    'peak_buffered_web_events', 2
  ));

  select metadata->'native_voice_continuity' into v_metadata
  from conversation_calls where id = v_call_id;
  if v_metadata->>'reconnect_attempts' <> '2'
     or v_metadata->>'data_channel_opens' <> '3'
     or v_metadata->>'ended_while_background' <> 'true'
     or v_metadata ? 'transcript' then
    raise exception 'FAIL: native continuity counters were not private, monotonic and idempotent';
  end if;
  if not exists (
    select 1 from conversation_messages
    where id = v_record_id
      and metadata->'native_voice_continuity' = v_metadata
  ) then
    raise exception 'FAIL: canonical call record did not receive continuity evidence';
  end if;

  begin
    perform record_conversation_call_native_continuity(v_conversation_id, v_call_id, v_metadata || jsonb_build_object('transcript', 'private'));
  exception when others then
    if position('private or unknown fields' in sqlerrm) > 0 then v_private_field_rejected := true;
    else raise;
    end if;
  end;
  if not v_private_field_rejected then raise exception 'FAIL: private native continuity content was accepted'; end if;

  raise exception using errcode = 'P5117', message = 'RESLU_VERIFY_117_PASS';
exception
  when sqlstate 'P5117' then
    if sqlerrm <> 'RESLU_VERIFY_117_PASS' then raise; end if;
    raise notice 'PASS: native voice continuity metadata is bounded, content-free, monotonic and starter-scoped; all test changes rolled back';
end;
$verify$;
