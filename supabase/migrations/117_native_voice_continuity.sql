-- Content-free native iPhone continuity evidence for physical lock-screen,
-- CallKit, route-change and reconnect acceptance. Canonical call content stays
-- in ordinary conversation messages; this object contains counters only.

-- All call mutations already go through member-scoped security-definer RPCs.
-- Remove the legacy broad table update grant so an authenticated client cannot
-- bypass the bounded metadata validators with a direct PostgREST update.
revoke update on table conversation_calls from anon, authenticated;

create or replace function record_conversation_call_native_continuity(
  p_conversation_id uuid,
  p_call_id uuid,
  p_native_continuity jsonb
)
returns conversation_calls
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  call_row conversation_calls%rowtype;
  previous jsonb;
  merged jsonb;
  counter_key text;
  counter_value numeric;
begin
  if actor_id is null or p_conversation_id is null or p_call_id is null then
    raise exception 'unauthorized';
  end if;
  if p_native_continuity is null
     or jsonb_typeof(p_native_continuity) <> 'object'
     or pg_column_size(p_native_continuity) > 2048
     or p_native_continuity->>'schema_version' <> '1'
     or p_native_continuity->>'transport' <> 'native_webrtc_callkit' then
    raise exception 'native continuity metadata is invalid';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_native_continuity) supplied(key)
    where supplied.key <> all (array[
      'schema_version','transport','background_transitions','reconnect_attempts',
      'data_channel_opens','audio_route_changes','callkit_audio_activations',
      'mute_changes','ended_while_background','replayed_web_events',
      'peak_buffered_web_events'
    ])
  ) then
    raise exception 'native continuity metadata contains private or unknown fields';
  end if;
  if not p_native_continuity ?& array[
    'schema_version','transport','background_transitions','reconnect_attempts',
    'data_channel_opens','audio_route_changes','callkit_audio_activations',
    'mute_changes','ended_while_background','replayed_web_events',
    'peak_buffered_web_events'
  ] then
    raise exception 'native continuity metadata is incomplete';
  end if;
  if jsonb_typeof(p_native_continuity->'ended_while_background') is distinct from 'boolean' then
    raise exception 'native continuity end state is invalid';
  end if;
  foreach counter_key in array array[
    'background_transitions','reconnect_attempts','data_channel_opens',
    'audio_route_changes','callkit_audio_activations','mute_changes',
    'replayed_web_events','peak_buffered_web_events'
  ] loop
    if jsonb_typeof(p_native_continuity->counter_key) is distinct from 'number' then
      raise exception 'native continuity counter is invalid';
    end if;
    counter_value := (p_native_continuity->>counter_key)::numeric;
    if counter_value <> trunc(counter_value)
       or counter_value < 0
       or counter_value > (case when counter_key = 'peak_buffered_web_events' then 80 else 1000 end) then
      raise exception 'native continuity counter is out of bounds';
    end if;
  end loop;

  select * into call_row
  from conversation_calls call
  where call.id = p_call_id
    and call.conversation_id = p_conversation_id
    and call.started_by = actor_id
  for update;
  if call_row.id is null then raise exception 'call not found'; end if;

  previous := coalesce(call_row.metadata->'native_voice_continuity', '{}'::jsonb);
  merged := jsonb_build_object(
    'schema_version', 1,
    'transport', 'native_webrtc_callkit',
    'background_transitions', greatest(coalesce((previous->>'background_transitions')::integer, 0), (p_native_continuity->>'background_transitions')::integer),
    'reconnect_attempts', greatest(coalesce((previous->>'reconnect_attempts')::integer, 0), (p_native_continuity->>'reconnect_attempts')::integer),
    'data_channel_opens', greatest(coalesce((previous->>'data_channel_opens')::integer, 0), (p_native_continuity->>'data_channel_opens')::integer),
    'audio_route_changes', greatest(coalesce((previous->>'audio_route_changes')::integer, 0), (p_native_continuity->>'audio_route_changes')::integer),
    'callkit_audio_activations', greatest(coalesce((previous->>'callkit_audio_activations')::integer, 0), (p_native_continuity->>'callkit_audio_activations')::integer),
    'mute_changes', greatest(coalesce((previous->>'mute_changes')::integer, 0), (p_native_continuity->>'mute_changes')::integer),
    'ended_while_background', coalesce((previous->>'ended_while_background')::boolean, false) or (p_native_continuity->>'ended_while_background')::boolean,
    'replayed_web_events', greatest(coalesce((previous->>'replayed_web_events')::integer, 0), (p_native_continuity->>'replayed_web_events')::integer),
    'peak_buffered_web_events', greatest(coalesce((previous->>'peak_buffered_web_events')::integer, 0), (p_native_continuity->>'peak_buffered_web_events')::integer)
  );

  update conversation_calls call
  set metadata = jsonb_set(coalesce(call.metadata, '{}'::jsonb), '{native_voice_continuity}', merged, true)
  where call.id = p_call_id
  returning * into call_row;

  update conversation_messages message
  set metadata = coalesce(message.metadata, '{}'::jsonb)
    || jsonb_build_object('native_voice_continuity', merged)
  where message.kind = 'call_record'
    and message.conversation_id = p_conversation_id
    and message.metadata->>'call_id' = p_call_id::text;
  return call_row;
end;
$$;

revoke all on function record_conversation_call_native_continuity(uuid,uuid,jsonb) from public, anon;
grant execute on function record_conversation_call_native_continuity(uuid,uuid,jsonb) to authenticated;

comment on function record_conversation_call_native_continuity(uuid,uuid,jsonb) is
  'Stores bounded content-free native CallKit/WebRTC continuity counters on the starter''s canonical conversation call.';
