-- ============================================================
-- RESLU Phase 6 — personal navigation + lead meeting recordings.
-- ============================================================

create table if not exists user_navigation_preferences (
  user_id             uuid primary key references profiles(id) on delete cascade,
  sidebar_order       text[] not null default '{}'::text[],
  recent_project_ids  uuid[] not null default '{}'::uuid[],
  updated_at          timestamptz not null default now()
);

drop trigger if exists trg_user_navigation_preferences_updated_at on user_navigation_preferences;
create trigger trg_user_navigation_preferences_updated_at
  before update on user_navigation_preferences
  for each row execute function set_updated_at();

alter table user_navigation_preferences enable row level security;
drop policy if exists "own_navigation_preferences" on user_navigation_preferences;
create policy "own_navigation_preferences" on user_navigation_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

comment on table user_navigation_preferences is
  'Phase 6 per-user sidebar order and three most recently visited projects. Stable navigation ids are stored instead of labels or URLs so copy and routes may change safely.';

create table if not exists lead_meeting_recordings (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references leads(id) on delete cascade,
  storage_path       text not null unique,
  original_filename text not null,
  mime_type          text,
  recorded_at        timestamptz,
  duration_seconds   integer check (duration_seconds is null or duration_seconds >= 0),
  transcript         text,
  transcript_status  text not null default 'pending'
                       check (transcript_status in ('pending','processing','done','failed')),
  summary            text,
  action_items       jsonb not null default '[]'::jsonb,
  decisions          jsonb not null default '[]'::jsonb,
  failure_note       text,
  created_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create index if not exists idx_lead_meeting_recordings_lead
  on lead_meeting_recordings(lead_id, created_at desc)
  where deleted_at is null;
create index if not exists idx_lead_meeting_recordings_transcription
  on lead_meeting_recordings(transcript_status, created_at)
  where deleted_at is null;

drop trigger if exists trg_lead_meeting_recordings_updated_at on lead_meeting_recordings;
create trigger trg_lead_meeting_recordings_updated_at
  before update on lead_meeting_recordings
  for each row execute function set_updated_at();

alter table lead_meeting_recordings enable row level security;
drop policy if exists "team_all" on lead_meeting_recordings;
create policy "team_all" on lead_meeting_recordings
  for all to authenticated using (true) with check (true);

comment on table lead_meeting_recordings is
  'Phase 6 lead-linked meeting audio. The original private audio remains in Storage; Aria local Whisper supplies transcript/summary/actions. Nothing is copied into lead notes without an explicit user action.';

alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in (
      'price_request','trade_reminder','lead_flag','approval_needed',
      'email_proposal','draft_proposal','daily_review','weekly_review',
      'invoice_candidate','calendar_sync','followup_draft','followup_approved',
      'meeting_transcription'
    ));

notify pgrst, 'reload schema';

