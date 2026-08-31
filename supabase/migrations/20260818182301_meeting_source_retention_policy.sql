-- Admin-governed Meeting Mode source retention. This migration is inert by
-- default: it stores the proposed 30/365-day policy but does not delete any
-- source until an authenticated RESLU admin explicitly enables it.

create table if not exists meeting_source_retention_policy (
  singleton             boolean primary key default true check (singleton),
  recording_days        integer not null default 30 check (recording_days between 1 and 365),
  transcript_days       integer not null default 365 check (transcript_days between 1 and 3650),
  enabled               boolean not null default false,
  approved_at           timestamptz,
  approved_by           uuid references profiles(id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references profiles(id) on delete set null,
  constraint meeting_source_retention_order_check check (transcript_days >= recording_days),
  constraint meeting_source_retention_approval_check check (
    (enabled and approved_at is not null and approved_by is not null)
    or (not enabled and approved_at is null and approved_by is null)
  )
);

insert into meeting_source_retention_policy(singleton, recording_days, transcript_days, enabled)
values (true, 30, 365, false)
on conflict (singleton) do nothing;

create table if not exists meeting_source_retention_policy_events (
  id                uuid primary key default gen_random_uuid(),
  actor_id          uuid references profiles(id) on delete set null,
  action            text not null check (action in ('saved','enabled','disabled')),
  recording_days    integer not null check (recording_days between 1 and 365),
  transcript_days   integer not null check (transcript_days between 1 and 3650),
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create index if not exists meeting_source_retention_policy_events_created_idx
  on meeting_source_retention_policy_events(created_at desc, id desc);

alter table meeting_source_retention_policy enable row level security;
alter table meeting_source_retention_policy_events enable row level security;

drop policy if exists "team can read meeting retention policy" on meeting_source_retention_policy;
create policy "team can read meeting retention policy"
  on meeting_source_retention_policy for select
  to authenticated
  using ((select auth.uid()) is not null);

revoke all on meeting_source_retention_policy from public, anon, authenticated;
grant select on meeting_source_retention_policy to authenticated;
grant all on meeting_source_retention_policy to service_role;
revoke all on meeting_source_retention_policy_events from public, anon, authenticated;
grant all on meeting_source_retention_policy_events to service_role;

create or replace function set_meeting_source_retention_policy(
  p_recording_days integer,
  p_transcript_days integer,
  p_enabled boolean,
  p_actor_id uuid
)
returns meeting_source_retention_policy
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_policy meeting_source_retention_policy;
  v_previous meeting_source_retention_policy;
  v_action text;
begin
  if not exists (
    select 1 from profiles
    where id = p_actor_id and role = 'admin'
  ) then
    raise exception 'Only a RESLU admin can change meeting source retention';
  end if;
  if p_recording_days not between 1 and 365
     or p_transcript_days not between 1 and 3650
     or p_transcript_days < p_recording_days then
    raise exception 'Invalid meeting source retention periods';
  end if;

  select * into v_previous
  from meeting_source_retention_policy
  where singleton = true
  for update;

  v_action := case
    when p_enabled then 'enabled'
    when v_previous.enabled then 'disabled'
    else 'saved'
  end;

  update meeting_source_retention_policy
  set recording_days = p_recording_days,
      transcript_days = p_transcript_days,
      enabled = p_enabled,
      approved_at = case when p_enabled then now() else null end,
      approved_by = case when p_enabled then p_actor_id else null end,
      updated_at = now(),
      updated_by = p_actor_id
  where singleton = true
  returning * into v_policy;

  insert into meeting_source_retention_policy_events(
    actor_id, action, recording_days, transcript_days, metadata
  ) values (
    p_actor_id,
    v_action,
    p_recording_days,
    p_transcript_days,
    jsonb_build_object(
      'previous_enabled', v_previous.enabled,
      'previous_recording_days', v_previous.recording_days,
      'previous_transcript_days', v_previous.transcript_days
    )
  );

  return v_policy;
end;
$$;

revoke execute on function set_meeting_source_retention_policy(integer, integer, boolean, uuid)
  from public, anon, authenticated;
grant execute on function set_meeting_source_retention_policy(integer, integer, boolean, uuid)
  to service_role;

-- New captures inherit the currently configured periods even while automatic
-- deletion is disabled. Existing proposed dates remain unchanged so editing a
-- policy can never silently move old source material closer to deletion.
create or replace function set_conversation_meeting_source_retention()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_recording_days integer := 30;
  v_transcript_days integer := 365;
begin
  select recording_days, transcript_days
  into v_recording_days, v_transcript_days
  from meeting_source_retention_policy
  where singleton = true;

  new.recording_retain_until := new.started_at + make_interval(days => coalesce(v_recording_days, 30));
  new.transcript_retain_until := new.started_at + make_interval(days => coalesce(v_transcript_days, 365));
  new.recording_deleted_at := null;
  new.recording_deleted_by := null;
  new.transcript_deleted_at := null;
  new.transcript_deleted_by := null;
  return new;
end;
$$;

create or replace function finalize_meeting_source_retention_purge(
  p_minutes_id uuid,
  p_kind text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_changed_id uuid;
begin
  if p_kind = 'recording' then
    update conversation_meeting_minutes
    set recording_storage_path = null,
        recording_filename = null,
        recording_mime_type = null,
        recording_byte_size = null,
        recording_deleted_at = now(),
        recording_deleted_by = null
    where id = p_minutes_id
      and recording_deleted_at is null
      and recording_retain_until <= now()
      and status in ('review','filed','discarded','failed')
    returning id into v_changed_id;
  elsif p_kind = 'transcript' then
    update conversation_meeting_minutes
    set transcript = null,
        transcript_segments = '[]'::jsonb,
        transcript_deleted_at = now(),
        transcript_deleted_by = null
    where id = p_minutes_id
      and transcript_deleted_at is null
      and transcript_retain_until <= now()
      and status in ('review','filed','discarded','failed')
    returning id into v_changed_id;
  else
    raise exception 'Choose recording or transcript';
  end if;

  if v_changed_id is null then
    return false;
  end if;

  insert into conversation_meeting_minute_events(
    minutes_id, actor_id, event_type, metadata
  ) values (
    v_changed_id, null, 'retention_purged', jsonb_build_object('kinds', jsonb_build_array(p_kind))
  );
  return true;
end;
$$;

revoke execute on function finalize_meeting_source_retention_purge(uuid, text)
  from public, anon, authenticated;
grant execute on function finalize_meeting_source_retention_purge(uuid, text)
  to service_role;

comment on table meeting_source_retention_policy is
  'Singleton, admin-approved Meeting Mode source policy. Automatic deletion is disabled until enabled with an audited admin action.';
comment on function finalize_meeting_source_retention_purge(uuid, text) is
  'Service-role-only atomic source scrub and retention_purged audit event. Storage object deletion happens before recording finalization.';
