-- Run only after migration 115. This verifier proves fixed deadlines,
-- browser immutability and source-scrub audit vocabulary, then rolls back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_minutes_id uuid := gen_random_uuid();
  v_started_at timestamptz := now() - interval '1 hour';
  v_minutes conversation_meeting_minutes;
  v_guard_rejected boolean := false;
begin
  if to_regprocedure('public.set_conversation_meeting_source_retention()') is null
     or to_regprocedure('public.guard_conversation_meeting_source_retention()') is null then
    raise exception 'FAIL: migration 115 retention functions are missing';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.conversation_meeting_minutes'::regclass
      and tgname = 'trg_conversation_meeting_source_retention_guard'
      and not tgisinternal
  ) then
    raise exception 'FAIL: migration 115 retention guard is missing';
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

  perform set_config('request.jwt.claim.sub', v_profile_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;

  insert into conversation_meeting_minutes(
    id, conversation_id, created_by, client_session_id, consent_confirmed_at,
    started_at, recording_retain_until, transcript_retain_until
  ) values (
    v_minutes_id, v_conversation_id, v_profile_id, gen_random_uuid(), now(),
    v_started_at, now() + interval '20 years', now() + interval '20 years'
  ) returning * into v_minutes;

  if v_minutes.recording_retain_until <> v_started_at + interval '30 days'
     or v_minutes.transcript_retain_until <> v_started_at + interval '365 days' then
    raise exception 'FAIL: browser-supplied retention overrode the fixed privacy baseline';
  end if;

  begin
    update conversation_meeting_minutes
    set recording_retain_until = recording_retain_until + interval '1 day'
    where id = v_minutes_id;
  exception when others then
    if position('protected privacy endpoint' in sqlerrm) > 0 then
      v_guard_rejected := true;
    else
      raise;
    end if;
  end;
  if not v_guard_rejected then
    raise exception 'FAIL: an authenticated client changed source retention directly';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.conversation_meeting_minute_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%retention_purged%'
      and pg_get_constraintdef(oid) like '%source_deleted%'
  ) then
    raise exception 'FAIL: source deletion audit event types are missing';
  end if;

  reset role;
  raise exception using errcode = 'P5115', message = 'RESLU_VERIFY_115_PASS';
exception
  when sqlstate 'P5115' then
    if sqlerrm <> 'RESLU_VERIFY_115_PASS' then raise; end if;
    raise notice 'PASS: Meeting Mode source retention is fixed, protected and auditable; all test changes rolled back';
end;
$verify$;
