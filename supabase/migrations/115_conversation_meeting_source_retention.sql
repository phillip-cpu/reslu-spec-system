-- Privacy lifecycle metadata for Meeting Mode source material. Filed minutes
-- remain the canonical business record. The 30/365-day values are the proposed
-- RESLU baseline; this migration does not install an automatic purge job.

alter table conversation_meeting_minutes
  add column if not exists recording_retain_until timestamptz,
  add column if not exists transcript_retain_until timestamptz,
  add column if not exists recording_deleted_at timestamptz,
  add column if not exists recording_deleted_by uuid references profiles(id) on delete set null,
  add column if not exists transcript_deleted_at timestamptz,
  add column if not exists transcript_deleted_by uuid references profiles(id) on delete set null;

update conversation_meeting_minutes
set recording_retain_until = started_at + interval '30 days'
where recording_retain_until is null;

update conversation_meeting_minutes
set transcript_retain_until = started_at + interval '365 days'
where transcript_retain_until is null;

alter table conversation_meeting_minutes
  alter column recording_retain_until set not null,
  alter column transcript_retain_until set not null;

create index if not exists conversation_meeting_recording_retention_idx
  on conversation_meeting_minutes(recording_retain_until)
  where recording_storage_path is not null and recording_deleted_at is null;

create index if not exists conversation_meeting_transcript_retention_idx
  on conversation_meeting_minutes(transcript_retain_until)
  where transcript is not null and transcript_deleted_at is null;

create or replace function set_conversation_meeting_source_retention()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The fixed privacy baseline cannot be lengthened by a browser insert. A
  -- later product decision may shorten it, but requires a reviewed migration.
  new.recording_retain_until := new.started_at + interval '30 days';
  new.transcript_retain_until := new.started_at + interval '365 days';
  new.recording_deleted_at := null;
  new.recording_deleted_by := null;
  new.transcript_deleted_at := null;
  new.transcript_deleted_by := null;
  return new;
end;
$$;

drop trigger if exists trg_conversation_meeting_source_retention on conversation_meeting_minutes;
create trigger trg_conversation_meeting_source_retention
  before insert on conversation_meeting_minutes
  for each row execute function set_conversation_meeting_source_retention();

create or replace function guard_conversation_meeting_source_retention()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user = 'authenticated' and (
       new.recording_retain_until is distinct from old.recording_retain_until
       or new.transcript_retain_until is distinct from old.transcript_retain_until
       or new.recording_deleted_at is distinct from old.recording_deleted_at
       or new.recording_deleted_by is distinct from old.recording_deleted_by
       or new.transcript_deleted_at is distinct from old.transcript_deleted_at
       or new.transcript_deleted_by is distinct from old.transcript_deleted_by
     ) then
    raise exception 'meeting source retention can only change through the protected privacy endpoint';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_conversation_meeting_source_retention_guard on conversation_meeting_minutes;
create trigger trg_conversation_meeting_source_retention_guard
  before update on conversation_meeting_minutes
  for each row execute function guard_conversation_meeting_source_retention();

alter table conversation_meeting_minute_events
  drop constraint if exists conversation_meeting_minute_events_event_type_check;
alter table conversation_meeting_minute_events
  add constraint conversation_meeting_minute_events_event_type_check check (
    event_type in (
      'created','paused','resumed','checkpointed','processing','drafted','edited',
      'destination_changed','filed','discarded','failed','source_exported',
      'source_deleted','retention_purged'
    )
  );

comment on column conversation_meeting_minutes.recording_retain_until is
  'Proposed raw-recording deletion date: 30 days from capture start. No automatic purge is installed by migration 115.';
comment on column conversation_meeting_minutes.transcript_retain_until is
  'Proposed source-transcript deletion date: 365 days from capture start. No automatic purge is installed by migration 115.';
