-- Run in the Supabase SQL Editor only after migration 103 succeeds.
-- Proves staging, member RLS, destination revalidation, one canonical linked
-- timeline record and rollback safety. No source recording is uploaded.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_minutes_id uuid := gen_random_uuid();
  v_project_id uuid;
  v_lead_id uuid;
  v_destination_kind text;
  v_minutes conversation_meeting_minutes;
  v_message_count integer;
  v_event_count integer;
  v_invalid_recording_rejected boolean := false;
begin
  if to_regclass('public.conversation_meeting_minutes') is null
     or to_regclass('public.conversation_meeting_minute_events') is null then
    raise exception 'FAIL: migration 103 Meeting Mode tables are missing';
  end if;
  if to_regprocedure('public.file_conversation_meeting_minutes(uuid,uuid,integer,boolean)') is null then
    raise exception 'FAIL: migration 103 filing function is missing';
  end if;
  if to_regprocedure('public.guard_conversation_meeting_minutes_mutation()') is null then
    raise exception 'FAIL: migration 103 lifecycle guard is missing';
  end if;
  if position(
    'only the recorder can control or discard this meeting capture'
    in pg_get_functiondef('public.guard_conversation_meeting_minutes_mutation()'::regprocedure)
  ) = 0 then
    raise exception 'FAIL: recorder-only capture/discard guard is missing';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.conversation_meeting_minutes'::regclass
      and tgname = 'trg_conversation_meeting_minutes_guard'
      and not tgisinternal
  ) then
    raise exception 'FAIL: migration 103 lifecycle guard trigger is missing';
  end if;
  if not has_function_privilege('authenticated', 'public.file_conversation_meeting_minutes(uuid,uuid,integer,boolean)', 'EXECUTE') then
    raise exception 'FAIL: authenticated members cannot approve meeting filing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.conversation_meeting_minutes'::regclass) then
    raise exception 'FAIL: Meeting Mode RLS is disabled';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'conversation_meeting_minutes') < 3 then
    raise exception 'FAIL: Meeting Mode member policies are incomplete';
  end if;
  if has_table_privilege('authenticated', 'public.conversation_meeting_minutes', 'DELETE')
     or has_table_privilege('authenticated', 'public.conversation_meeting_minute_events', 'INSERT')
     or has_table_privilege('anon', 'public.conversation_meeting_minutes', 'SELECT') then
    raise exception 'FAIL: Meeting Mode table privileges exceed the staged member boundary';
  end if;
  if position(
    'meeting recording source is immutable after upload'
    in pg_get_functiondef('public.guard_conversation_meeting_minutes_mutation()'::regprocedure)
  ) = 0 then
    raise exception 'FAIL: uploaded recording immutability guard is missing';
  end if;

  select human.profile_id, human.conversation_id
  into v_profile_id, v_conversation_id
  from conversation_participants human
  join conversation_participants aria_participant
    on aria_participant.conversation_id = human.conversation_id
   and aria_participant.agent_id is not null
  join conversation_agents aria on aria.id = aria_participant.agent_id and aria.slug = 'aria'
  where human.profile_id is not null
  limit 1;
  if v_profile_id is null then
    raise exception 'FAIL: no human and Aria conversation exists for the rollback test';
  end if;

  select id into v_project_id from projects where deleted_at is null limit 1;
  if v_project_id is not null then
    v_destination_kind := 'project';
  else
    select id into v_lead_id from leads where deleted_at is null limit 1;
    v_destination_kind := 'lead';
  end if;
  if v_project_id is null and v_lead_id is null then
    raise exception 'FAIL: no lead or project exists for destination revalidation';
  end if;

  begin
    insert into conversation_meeting_minutes(
      conversation_id, created_by, client_session_id, consent_confirmed_at,
      recording_storage_path, recording_filename, recording_mime_type, recording_byte_size
    ) values (
      v_conversation_id, v_profile_id, gen_random_uuid(), now(),
      'meeting-minutes/another-conversation/another-user/another-meeting/recording.m4a',
      'recording.m4a', 'audio/mp4', 1024
    );
  exception when check_violation then
    v_invalid_recording_rejected := true;
  end;
  if not v_invalid_recording_rejected then
    raise exception 'FAIL: a meeting accepted a recording path outside its private namespace';
  end if;

  begin
    perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);

    insert into conversation_meeting_minutes(
      id, conversation_id, created_by, client_session_id, status, meeting_type,
      destination_kind, lead_id, project_id, destination_label_snapshot,
      destination_confidence, destination_reasons, consent_confirmed_at,
      started_at, ended_at, duration_seconds, transcript, transcript_segments,
      summary, decisions, client_requests, reslu_actions, client_actions,
      open_questions, important_notes, draft_version
    ) values (
      v_minutes_id, v_conversation_id, v_profile_id, gen_random_uuid(), 'review', 'client_meeting',
      v_destination_kind, v_lead_id, v_project_id, 'Rollback verification destination',
      0.9, '["rollback verifier"]'::jsonb, now(), now() - interval '10 minutes', now(), 600,
      'Rollback-only meeting transcript.',
      '[{"item_id":"verify","text":"Rollback-only meeting transcript.","sequence":0,"captured_at":"2026-08-11T00:00:00Z"}]'::jsonb,
      'Rollback-only meeting summary.', '["Decision"]'::jsonb, '["Client request"]'::jsonb,
      '["RESLU action"]'::jsonb, '["Client action"]'::jsonb, '["Open question"]'::jsonb,
      '["Important note"]'::jsonb, 1
    );

    select * into strict v_minutes
    from file_conversation_meeting_minutes(v_conversation_id, v_minutes_id, 1, false);
    if v_minutes.status <> 'filed' or v_minutes.filed_message_id is null or v_minutes.filed_by <> v_profile_id then
      raise exception 'FAIL: explicit approval did not file the canonical minutes';
    end if;

    select count(*) into v_message_count
    from conversation_messages
    where id = v_minutes.filed_message_id
      and conversation_id = v_conversation_id
      and kind = 'meeting_record'
      and metadata->>'meeting_minutes_id' = v_minutes_id::text;
    if v_message_count <> 1 then
      raise exception 'FAIL: filing did not create exactly one linked timeline record';
    end if;

    select count(*) into v_event_count
    from conversation_meeting_minute_events
    where minutes_id = v_minutes_id and event_type in ('created','filed');
    if v_event_count <> 2 then
      raise exception 'FAIL: Meeting Mode audit events are incomplete';
    end if;

    raise exception using errcode = 'P5103', message = 'RESLU_VERIFY_103_PASS';
  exception
    when sqlstate 'P5103' then
      if sqlerrm <> 'RESLU_VERIFY_103_PASS' then raise; end if;
      raise notice 'PASS: Meeting Mode is staged, member-scoped, destination-revalidated and explicitly filed; all test changes rolled back';
  end;
end;
$verify$;
