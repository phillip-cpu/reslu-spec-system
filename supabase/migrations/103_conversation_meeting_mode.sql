-- Aria Meeting Mode: silent live transcription, staged minutes and explicit
-- destination approval. The meeting row is the canonical record after filing;
-- the conversation timeline only links to it.

create table if not exists conversation_meeting_minutes (
  id                         uuid primary key default gen_random_uuid(),
  conversation_id            uuid not null references conversations(id) on delete cascade,
  source_call_id              uuid references conversation_calls(id) on delete set null,
  created_by                  uuid not null references profiles(id) on delete restrict,
  client_session_id           uuid not null,
  status                      text not null default 'recording' check (
                                status in ('recording','paused','processing','review','filed','discarded','failed')
                              ),
  meeting_type                text not null default 'client_meeting' check (
                                meeting_type in ('new_lead','design_meeting','client_meeting','site_meeting','other')
                              ),
  lead_id                     uuid references leads(id) on delete set null,
  project_id                  uuid references projects(id) on delete set null,
  client_event_id             uuid references client_events(id) on delete set null,
  destination_kind            text check (destination_kind in ('lead','project')),
  destination_label_snapshot  text,
  destination_confidence      numeric(4,3) check (
                                destination_confidence is null
                                or destination_confidence between 0 and 1
                              ),
  destination_reasons         jsonb not null default '[]'::jsonb check (
                                jsonb_typeof(destination_reasons) = 'array'
                              ),
  source_snapshot              jsonb not null default '{}'::jsonb check (
                                jsonb_typeof(source_snapshot) = 'object'
                              ),
  consent_confirmed_at         timestamptz not null,
  started_at                   timestamptz not null default now(),
  ended_at                     timestamptz,
  duration_seconds             integer check (duration_seconds is null or duration_seconds >= 0),
  recording_storage_path       text unique,
  recording_filename           text,
  recording_mime_type          text,
  recording_byte_size          bigint check (recording_byte_size is null or recording_byte_size > 0),
  transcript                   text,
  transcript_segments          jsonb not null default '[]'::jsonb check (
                                jsonb_typeof(transcript_segments) = 'array'
                              ),
  summary                      text,
  decisions                    jsonb not null default '[]'::jsonb check (jsonb_typeof(decisions) = 'array'),
  client_requests              jsonb not null default '[]'::jsonb check (jsonb_typeof(client_requests) = 'array'),
  reslu_actions                jsonb not null default '[]'::jsonb check (jsonb_typeof(reslu_actions) = 'array'),
  client_actions               jsonb not null default '[]'::jsonb check (jsonb_typeof(client_actions) = 'array'),
  open_questions               jsonb not null default '[]'::jsonb check (jsonb_typeof(open_questions) = 'array'),
  important_notes              jsonb not null default '[]'::jsonb check (jsonb_typeof(important_notes) = 'array'),
  draft_version                integer not null default 0 check (draft_version >= 0),
  filed_message_id             uuid unique references conversation_messages(id) on delete set null,
  filed_by                     uuid references profiles(id) on delete set null,
  filed_at                     timestamptz,
  failure_note                 text,
  metadata                     jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (conversation_id, client_session_id),
  constraint conversation_meeting_destination_consistent check (
    (destination_kind is null and lead_id is null and project_id is null and client_event_id is null)
    or (destination_kind = 'lead' and lead_id is not null and project_id is null and client_event_id is null)
    or (destination_kind = 'project' and project_id is not null and lead_id is null)
  )
);

create index if not exists conversation_meeting_minutes_thread_idx
  on conversation_meeting_minutes(conversation_id, created_at desc);
create index if not exists conversation_meeting_minutes_review_idx
  on conversation_meeting_minutes(status, updated_at)
  where status in ('processing','review');
create index if not exists conversation_meeting_minutes_lead_idx
  on conversation_meeting_minutes(lead_id, filed_at desc)
  where status = 'filed' and lead_id is not null;
create index if not exists conversation_meeting_minutes_project_idx
  on conversation_meeting_minutes(project_id, filed_at desc)
  where status = 'filed' and project_id is not null;

drop trigger if exists trg_conversation_meeting_minutes_updated_at on conversation_meeting_minutes;
create trigger trg_conversation_meeting_minutes_updated_at
  before update on conversation_meeting_minutes
  for each row execute function set_updated_at();

create table if not exists conversation_meeting_minute_events (
  id          uuid primary key default gen_random_uuid(),
  minutes_id  uuid not null references conversation_meeting_minutes(id) on delete cascade,
  actor_id    uuid references profiles(id) on delete set null,
  event_type  text not null check (
                event_type in ('created','paused','resumed','checkpointed','processing','drafted','edited','destination_changed','filed','discarded','failed')
              ),
  detail      text,
  metadata    jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at  timestamptz not null default now()
);

create index if not exists conversation_meeting_minute_events_minutes_idx
  on conversation_meeting_minute_events(minutes_id, created_at, id);

create or replace function guard_conversation_meeting_minutes_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  draft_changed boolean;
begin
  -- Service-role processing and the SECURITY DEFINER filing transaction run as
  -- trusted database roles. Browser/API requests run as `authenticated` and
  -- must stay inside the staged lifecycle even if they bypass the Next route.
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.created_by <> auth.uid()
       or new.status <> 'recording'
       or new.transcript is not null
       or new.summary is not null
       or new.draft_version <> 0
       or new.filed_message_id is not null
       or new.filed_by is not null
       or new.filed_at is not null then
      raise exception 'meeting capture must begin as an unfiled recording';
    end if;
    return new;
  end if;

  if new.id <> old.id
     or new.conversation_id <> old.conversation_id
     or new.created_by <> old.created_by
     or new.client_session_id <> old.client_session_id
     or new.source_call_id is distinct from old.source_call_id
     or new.source_snapshot is distinct from old.source_snapshot
     or new.consent_confirmed_at <> old.consent_confirmed_at
     or new.started_at <> old.started_at then
    raise exception 'meeting capture identity and source are immutable';
  end if;

  -- Capture lifecycle and deletion remain owned by the person who explicitly
  -- started/consented to recording. Other thread members may collaborate on a
  -- staged review draft, but cannot pause, finish, retry, fail or discard the
  -- recorder's source by bypassing the authenticated API route.
  if old.created_by <> auth.uid() and (
       old.status in ('recording','paused','processing','failed')
       or new.status = 'discarded'
     ) then
    raise exception 'only the recorder can control or discard this meeting capture';
  end if;

  if new.filed_message_id is distinct from old.filed_message_id
     or new.filed_by is distinct from old.filed_by
     or new.filed_at is distinct from old.filed_at
     or new.status = 'filed' and old.status <> 'filed' then
    raise exception 'meeting minutes can only be filed through explicit approval';
  end if;

  if new.transcript is distinct from old.transcript
     or new.transcript_segments is distinct from old.transcript_segments then
    raise exception 'only Aria can replace the staged meeting transcript';
  end if;

  if old.status = 'recording' and new.status not in ('recording','paused','processing','failed','discarded')
     or old.status = 'paused' and new.status not in ('paused','recording','processing','failed','discarded')
     or old.status = 'processing' and new.status not in ('processing','failed','discarded')
     or old.status = 'failed' and new.status not in ('failed','processing','discarded')
     or old.status = 'review' and new.status not in ('review','discarded')
     or old.status in ('filed','discarded') and new.status <> old.status then
    raise exception 'invalid meeting lifecycle transition from % to %', old.status, new.status;
  end if;

  draft_changed := (new.summary, new.decisions, new.client_requests, new.reslu_actions,
                    new.client_actions, new.open_questions, new.important_notes,
                    new.meeting_type, new.destination_kind, new.lead_id, new.project_id,
                    new.client_event_id, new.destination_label_snapshot)
                   is distinct from
                   (old.summary, old.decisions, old.client_requests, old.reslu_actions,
                    old.client_actions, old.open_questions, old.important_notes,
                    old.meeting_type, old.destination_kind, old.lead_id, old.project_id,
                    old.client_event_id, old.destination_label_snapshot);
  if draft_changed and (old.status <> 'review' or new.status <> 'review') then
    raise exception 'meeting draft and destination can only change during review';
  end if;
  if draft_changed and new.draft_version <> old.draft_version + 1 then
    raise exception 'meeting draft edits must advance exactly one version';
  end if;
  if not draft_changed and new.draft_version <> old.draft_version then
    raise exception 'meeting draft version changed without a draft edit';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_conversation_meeting_minutes_guard on conversation_meeting_minutes;
create trigger trg_conversation_meeting_minutes_guard
  before insert or update on conversation_meeting_minutes
  for each row execute function guard_conversation_meeting_minutes_mutation();

create or replace function log_conversation_meeting_minute_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  event_name text;
  event_metadata jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    event_name := 'created';
  elsif new.status = 'paused' and old.status <> 'paused' then
    event_name := 'paused';
  elsif old.status = 'paused' and new.status = 'recording' then
    event_name := 'resumed';
  elsif new.status = 'processing' and old.status <> 'processing' then
    event_name := 'processing';
  elsif new.status = 'review' and old.status <> 'review' then
    event_name := 'drafted';
  elsif new.status = 'filed' and old.status <> 'filed' then
    event_name := 'filed';
  elsif new.status = 'discarded' and old.status <> 'discarded' then
    event_name := 'discarded';
  elsif new.status = 'failed' and old.status <> 'failed' then
    event_name := 'failed';
  elsif (new.lead_id, new.project_id, new.client_event_id) is distinct from
        (old.lead_id, old.project_id, old.client_event_id) then
    event_name := 'destination_changed';
    event_metadata := jsonb_build_object(
      'previous_kind', old.destination_kind,
      'previous_lead_id', old.lead_id,
      'previous_project_id', old.project_id,
      'previous_client_event_id', old.client_event_id,
      'next_kind', new.destination_kind,
      'next_lead_id', new.lead_id,
      'next_project_id', new.project_id,
      'next_client_event_id', new.client_event_id
    );
  elsif new.draft_version <> old.draft_version then
    event_name := 'edited';
  elsif new.transcript_segments is distinct from old.transcript_segments then
    event_name := 'checkpointed';
  elsif new.metadata is distinct from old.metadata then
    event_name := 'checkpointed';
  else
    return new;
  end if;

  insert into conversation_meeting_minute_events(minutes_id, actor_id, event_type, metadata)
  values (new.id, auth.uid(), event_name, event_metadata);
  return new;
end;
$$;

drop trigger if exists trg_conversation_meeting_minute_change on conversation_meeting_minutes;
create trigger trg_conversation_meeting_minute_change
  after insert or update on conversation_meeting_minutes
  for each row execute function log_conversation_meeting_minute_change();

alter table conversation_meeting_minutes enable row level security;
alter table conversation_meeting_minute_events enable row level security;

drop policy if exists "members_read_meeting_minutes" on conversation_meeting_minutes;
create policy "members_read_meeting_minutes" on conversation_meeting_minutes
  for select to authenticated using (is_conversation_member(conversation_id));
drop policy if exists "members_create_meeting_minutes" on conversation_meeting_minutes;
create policy "members_create_meeting_minutes" on conversation_meeting_minutes
  for insert to authenticated with check (
    created_by = auth.uid() and is_conversation_member(conversation_id)
  );
drop policy if exists "members_update_meeting_minutes" on conversation_meeting_minutes;
create policy "members_update_meeting_minutes" on conversation_meeting_minutes
  for update to authenticated using (is_conversation_member(conversation_id))
  with check (is_conversation_member(conversation_id));
drop policy if exists "members_read_meeting_minute_events" on conversation_meeting_minute_events;
create policy "members_read_meeting_minute_events" on conversation_meeting_minute_events
  for select to authenticated using (
    exists (
      select 1 from conversation_meeting_minutes minutes
      where minutes.id = conversation_meeting_minute_events.minutes_id
        and is_conversation_member(minutes.conversation_id)
    )
  );

drop function if exists file_conversation_meeting_minutes(uuid, uuid, integer);
create or replace function file_conversation_meeting_minutes(
  p_conversation_id uuid,
  p_minutes_id uuid,
  p_expected_version integer,
  p_allow_duplicate boolean default false
)
returns conversation_meeting_minutes
language plpgsql
security definer
set search_path = public
as $$
declare
  minutes conversation_meeting_minutes;
  destination_label text;
  timeline_body text;
  message_id uuid;
begin
  if auth.uid() is null or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  select * into minutes
  from conversation_meeting_minutes
  where id = p_minutes_id and conversation_id = p_conversation_id
  for update;
  if minutes.id is null then raise exception 'meeting minutes not found'; end if;
  if minutes.status = 'filed' then return minutes; end if;
  if minutes.status <> 'review' then raise exception 'meeting minutes are not ready for approval'; end if;
  if minutes.draft_version <> p_expected_version then raise exception 'meeting minutes changed; refresh before filing'; end if;
  if nullif(btrim(coalesce(minutes.summary, '')), '') is null then raise exception 'meeting summary is required'; end if;

  if minutes.destination_kind = 'lead' then
    select coalesce(nullif(btrim(concat_ws(' ', lead.first_name, lead.surname_project)), ''), 'Lead')
      into destination_label
    from leads lead
    where lead.id = minutes.lead_id and lead.deleted_at is null;
    if destination_label is not null
       and nullif(minutes.source_snapshot ->> 'source_reference', '') is not null
       and minutes.source_snapshot ->> 'id' = minutes.lead_id::text
       and not p_allow_duplicate
       and exists (
         select 1 from conversation_meeting_minutes existing
         where existing.id <> minutes.id
           and existing.lead_id = minutes.lead_id
           and existing.status = 'filed'
           and existing.source_snapshot ->> 'source_reference' = minutes.source_snapshot ->> 'source_reference'
       ) then
      raise exception 'minutes are already filed for this lead visit; confirm the duplicate before filing again';
    end if;
  elsif minutes.destination_kind = 'project' then
    select coalesce(nullif(btrim(project.name), ''), 'Project')
      into destination_label
    from projects project
    where project.id = minutes.project_id and project.deleted_at is null;
    if destination_label is not null and minutes.client_event_id is not null and not exists (
      select 1 from client_events event
      where event.id = minutes.client_event_id
        and event.project_id = minutes.project_id
        and event.deleted_at is null
    ) then
      raise exception 'the selected calendar event no longer belongs to this project';
    end if;
    if destination_label is not null and minutes.client_event_id is not null and not p_allow_duplicate and exists (
      select 1 from conversation_meeting_minutes existing
      where existing.id <> minutes.id
        and existing.client_event_id = minutes.client_event_id
        and existing.status = 'filed'
    ) then
      raise exception 'minutes are already filed for this calendar event; confirm the duplicate before filing again';
    end if;
  else
    raise exception 'choose a lead or project before filing';
  end if;
  if destination_label is null then raise exception 'the selected destination no longer exists'; end if;

  timeline_body := left(
    concat('Meeting minutes — ', destination_label, E'\n', btrim(minutes.summary)),
    20000
  );
  insert into conversation_messages(
    conversation_id, author_profile_id, kind, body, metadata
  ) values (
    p_conversation_id,
    auth.uid(),
    'meeting_record',
    timeline_body,
    jsonb_build_object(
      'meeting_minutes_id', minutes.id,
      'status', 'filed',
      'meeting_type', minutes.meeting_type,
      'destination_kind', minutes.destination_kind,
      'destination_id', coalesce(minutes.lead_id, minutes.project_id),
      'destination_label', destination_label,
      'client_event_id', minutes.client_event_id,
      'decisions', minutes.decisions,
      'reslu_actions', minutes.reslu_actions,
      'client_actions', minutes.client_actions,
      'open_questions', minutes.open_questions
    )
  ) returning id into message_id;

  update conversation_meeting_minutes
  set status = 'filed',
      destination_label_snapshot = destination_label,
      filed_message_id = message_id,
      filed_by = auth.uid(),
      filed_at = now(),
      failure_note = null
  where id = minutes.id
  returning * into minutes;
  return minutes;
end;
$$;

revoke all on function file_conversation_meeting_minutes(uuid, uuid, integer, boolean) from public, anon;
grant execute on function file_conversation_meeting_minutes(uuid, uuid, integer, boolean) to authenticated;

comment on table conversation_meeting_minutes is
  'Canonical staged Aria Meeting Mode minutes. Capture and drafting never file automatically; filing is a reviewed, destination-revalidated transaction that writes one linked conversation timeline item.';

notify pgrst, 'reload schema';
