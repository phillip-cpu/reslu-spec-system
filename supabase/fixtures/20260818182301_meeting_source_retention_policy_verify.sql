-- Run after 20260818182301_meeting_source_retention_policy.sql. This
-- verifier enables a custom policy, exercises both purge finalizers, proves
-- least-privilege grants, and rolls every test change back.

do $verify$
declare
  v_admin_id uuid;
  v_conversation_id uuid;
  v_minutes_id uuid := gen_random_uuid();
  v_started_at timestamptz := now() - interval '500 days';
  v_policy meeting_source_retention_policy;
  v_minutes conversation_meeting_minutes;
begin
  if to_regclass('public.meeting_source_retention_policy') is null
     or to_regprocedure('public.set_meeting_source_retention_policy(integer,integer,boolean,uuid)') is null
     or to_regprocedure('public.finalize_meeting_source_retention_purge(uuid,text)') is null then
    raise exception 'FAIL: meeting source retention governance is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.meeting_source_retention_policy'::regclass) then
    raise exception 'FAIL: retention policy RLS is disabled';
  end if;
  if has_table_privilege('anon', 'public.meeting_source_retention_policy', 'select')
     or has_table_privilege('authenticated', 'public.meeting_source_retention_policy', 'update')
     or has_function_privilege('authenticated', 'public.set_meeting_source_retention_policy(integer,integer,boolean,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.finalize_meeting_source_retention_purge(uuid,text)', 'execute') then
    raise exception 'FAIL: browser roles can bypass the protected retention routes';
  end if;
  if not has_table_privilege('authenticated', 'public.meeting_source_retention_policy', 'select')
     or not has_function_privilege('service_role', 'public.set_meeting_source_retention_policy(integer,integer,boolean,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.finalize_meeting_source_retention_purge(uuid,text)', 'execute') then
    raise exception 'FAIL: intended retention grants are missing';
  end if;

  select p.id, cp.conversation_id
  into v_admin_id, v_conversation_id
  from profiles p
  join conversation_participants cp on cp.profile_id = p.id
  join conversation_participants agent_participant
    on agent_participant.conversation_id = cp.conversation_id
   and agent_participant.agent_id is not null
  where p.role = 'admin'
  limit 1;
  if v_admin_id is null then
    raise exception 'FAIL: no admin conversation exists for the rollback verifier';
  end if;

  select * into v_policy
  from set_meeting_source_retention_policy(20, 400, true, v_admin_id);
  if not v_policy.enabled
     or v_policy.recording_days <> 20
     or v_policy.transcript_days <> 400
     or v_policy.approved_by <> v_admin_id then
    raise exception 'FAIL: approved policy was not saved atomically';
  end if;

  insert into conversation_meeting_minutes(
    id, conversation_id, created_by, client_session_id, consent_confirmed_at,
    started_at, transcript, recording_storage_path, recording_filename,
    recording_mime_type, recording_byte_size
  ) values (
    v_minutes_id, v_conversation_id, v_admin_id, gen_random_uuid(), now(),
    v_started_at, 'temporary source transcript',
    'meeting-minutes/' || v_conversation_id::text || '/' || v_admin_id::text || '/'
      || v_minutes_id::text || '/recording.m4a',
    'retention.m4a', 'audio/mp4', 128
  ) returning * into v_minutes;
  if v_minutes.recording_retain_until <> v_started_at + interval '20 days'
     or v_minutes.transcript_retain_until <> v_started_at + interval '400 days' then
    raise exception 'FAIL: new meeting did not inherit the configured policy';
  end if;

  update conversation_meeting_minutes
  set status = 'review'
  where id = v_minutes_id;

  if not finalize_meeting_source_retention_purge(v_minutes_id, 'recording')
     or not finalize_meeting_source_retention_purge(v_minutes_id, 'transcript') then
    raise exception 'FAIL: eligible source was not finalized';
  end if;
  if finalize_meeting_source_retention_purge(v_minutes_id, 'transcript') then
    raise exception 'FAIL: purge finalization was not idempotent';
  end if;

  select * into v_minutes
  from conversation_meeting_minutes
  where id = v_minutes_id;
  if v_minutes.recording_storage_path is not null
     or v_minutes.recording_deleted_at is null
     or v_minutes.transcript is not null
     or v_minutes.transcript_deleted_at is null
     or v_minutes.summary is not null then
    raise exception 'FAIL: purge did not remove only temporary source material';
  end if;
  if (
    select count(*) from conversation_meeting_minute_events
    where minutes_id = v_minutes_id and event_type = 'retention_purged'
  ) <> 2 then
    raise exception 'FAIL: source purge audit events are incomplete';
  end if;

  raise exception using errcode = 'P5120', message = 'RESLU_RETENTION_POLICY_VERIFY_PASS';
exception
  when sqlstate 'P5120' then
    if sqlerrm <> 'RESLU_RETENTION_POLICY_VERIFY_PASS' then raise; end if;
    raise notice 'PASS: meeting source retention is admin-governed, least-privilege, audited and idempotent; all test changes rolled back';
end;
$verify$;
