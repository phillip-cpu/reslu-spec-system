-- ============================================================
-- RESLU Spec System — Site capture + mobile QoL (r21)
-- docs/BUILD-SPEC.md §"Site capture + mobile QoL (r21)", item 3:
-- "Migration 050: site_captures (id, project_id FK, kind photo|note|
-- audio check, storage_path text null, text_content text null,
-- transcript text null, transcript_status pending|done|failed null
-- (audio only), author_user_id null, author_contact_id null (exactly
-- one set), trade_visit_id null, created_at). Storage bucket
-- site-captures (private)."
--
-- Two entry points write this one table (item 1):
--   a. /capture (authenticated team/Phillip) — author_user_id set,
--      author_contact_id null, trade_visit_id null.
--   b. /trade/[token] capture section (unauthenticated, token-gated,
--      service-role client — same trust boundary as every other
--      /api/trade/[token]/** write, see 016_trade_visits.sql's own
--      header comment) — author_contact_id set (the visit's contact),
--      author_user_id null, trade_visit_id set (the visit the capture
--      was dropped against).
--
-- Conventions carried over from every prior migration:
--   - uuid pk via gen_random_uuid()
--   - text + CHECK instead of a Postgres enum (house style)
--   - idempotent throughout (create table if not exists / drop+
--     recreate policy / on conflict do nothing) so a partial apply
--     converges cleanly on re-run
--   - RLS: single permissive "team_all" policy (Phase 1 — "no
--     unenforced role theatre"); site captures carry no pricing/
--     financial data. The public trade-side write path goes through
--     the service-role client (bypasses RLS entirely, same as
--     POST /api/trade/[token]/respond) — the route handler itself is
--     responsible for verifying the confirm_token before acting,
--     exactly like every other tokened public write in this schema.
--   - storage bucket created via `insert into storage.buckets` (same
--     mechanism 009_assets_bucket.sql used for `assets`) + explicit
--     storage.objects RLS policies (same mechanism 010_storage_
--     policies.sql used) — buckets in this codebase are NOT created
--     via the Supabase dashboard, they are created here, in SQL, so a
--     fresh Supabase project works out of the box (009's own stated
--     reason for existing).
--
-- File-boundary note: owned entirely by this round. Does not touch
-- any Second Brain table (migrations 033-045) or any table owned by
-- another round. Only new object created here is `site_captures` +
-- the `site-captures` storage bucket/policies.
-- ============================================================

create table if not exists site_captures (
  id                  uuid primary key default gen_random_uuid(),

  project_id          uuid not null references projects(id) on delete cascade,

  kind                text not null check (kind in ('photo', 'note', 'audio')),

  -- Storage object key in the private `site-captures` bucket (see
  -- below). Required for photo/audio, null for a plain typed note.
  storage_path        text,

  -- Note body (typed, or iOS keyboard dictation — zero infra, see
  -- BUILD-SPEC.md item 2). Required for kind='note', null otherwise.
  text_content         text,

  -- Populated by Aria's Mac mini (local Whisper, MCP set_capture_
  -- transcript tool) once an audio capture has been transcribed.
  transcript          text,

  -- Audio-only queue state: 'pending' the moment an audio row is
  -- created, 'done' once transcript lands, 'failed' if Aria gives up.
  -- Null for photo/note rows — this is NOT a general capture-status
  -- column.
  transcript_status   text check (transcript_status in ('pending', 'done', 'failed')),

  -- Exactly one of these two is set per row (CHECK below) — the
  -- "who captured this" attribution is either an authenticated team
  -- member (/capture) or an unauthenticated trade contact
  -- (/trade/[token]'s capture section).
  author_user_id      uuid references profiles(id) on delete set null,
  author_contact_id   uuid references contacts(id) on delete set null,

  -- Set only for a capture dropped via /trade/[token] — links the
  -- capture back to the specific visit the trade was on when they
  -- captured it. Null for every /capture (team-side) row. ON DELETE
  -- SET NULL, mirroring trade_visits.contact_id/booking_request_id's
  -- own "optional link, never cascades" discipline — a visit being
  -- deleted must not destroy real site-diary history.
  trade_visit_id      uuid references trade_visits(id) on delete set null,

  created_at          timestamptz not null default now(),

  constraint chk_site_captures_one_author
    check (num_nonnulls(author_user_id, author_contact_id) = 1),

  constraint chk_site_captures_note_text
    check (kind <> 'note' or text_content is not null),

  constraint chk_site_captures_media_path
    check (kind = 'note' or storage_path is not null),

  constraint chk_site_captures_transcript_audio_only
    check (kind = 'audio' or transcript_status is null)
);

comment on table site_captures is
  'Site capture + mobile QoL round (r21). One row per photo/note/audio capture from either /capture (authenticated team, author_user_id set) or the /trade/[token] capture section (unauthenticated, token-gated, author_contact_id set, trade_visit_id set). Surfaced reverse-chronologically as the project''s "Site diary" (GET /api/projects/[id]/site-captures). Audio rows queue for transcription by Aria''s Mac mini (local Whisper, no external AI) via the MCP tools list_pending_transcriptions/set_capture_transcript.';
comment on column site_captures.storage_path is
  'Object key in the private `site-captures` bucket (created by this same migration, below). Required for kind photo/audio; null for kind note.';
comment on column site_captures.text_content is
  'The note body for kind=''note'' (typed, or iOS keyboard dictation — no server-side speech-to-text involved for typed notes at all). Null for photo/audio.';
comment on column site_captures.transcript_status is
  'Audio-only queue state (''pending''/''done''/''failed''), set to ''pending'' at insert time for every kind=''audio'' row and flipped by the MCP set_capture_transcript tool once Aria''s Mac mini (local Whisper) has produced a transcript. Always null for photo/note.';
comment on column site_captures.author_user_id is
  'Set for a /capture (authenticated team) row. Exactly one of author_user_id/author_contact_id is set — see chk_site_captures_one_author.';
comment on column site_captures.author_contact_id is
  'Set for a /trade/[token] capture-section row — the visit''s own contact_id (the trade actually on site), resolved server-side from trade_visit_id, never client-supplied. Exactly one of author_user_id/author_contact_id is set — see chk_site_captures_one_author.';
comment on column site_captures.trade_visit_id is
  'Set only for a capture dropped via /trade/[token] — the visit the trade was booked on when they captured it. Null for every /capture (team-side) row.';

-- Primary query shape: "this project''s captures, newest first" (Site
-- diary, GET /api/projects/[id]/site-captures) and the MCP
-- list_site_captures tool.
create index if not exists idx_site_captures_project_created
  on site_captures(project_id, created_at desc);

-- MCP list_pending_transcriptions — audio rows still queued.
create index if not exists idx_site_captures_pending_transcripts
  on site_captures(created_at)
  where kind = 'audio' and transcript_status = 'pending';

create index if not exists idx_site_captures_trade_visit
  on site_captures(trade_visit_id);

alter table site_captures enable row level security;

drop policy if exists "team_all" on site_captures;
create policy "team_all" on site_captures
  for all to authenticated using (true) with check (true);

-- ============================================================
-- Storage: `site-captures` bucket (private) + RLS policies.
-- Mirrors 009_assets_bucket.sql (bucket creation) and
-- 010_storage_policies.sql (authenticated read/write policies)
-- exactly. Every consumer mints a short-TTL signed URL server-side
-- per request (createSignedUrl) — nothing reads this bucket via
-- getPublicUrl, same private-bucket discipline as `assets`.
--
-- No anon-role storage policy is defined here on purpose: the
-- /trade/[token] capture-section upload route
-- (POST /api/trade/[token]/captures) writes via the SERVICE ROLE
-- client, which bypasses storage RLS entirely, same as every other
-- unauthenticated-but-token-gated write in this schema.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('site-captures', 'site-captures', false)
on conflict (id) do nothing;

drop policy if exists "team_site_captures_insert" on storage.objects;
create policy "team_site_captures_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'site-captures');

drop policy if exists "team_site_captures_select" on storage.objects;
create policy "team_site_captures_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'site-captures');

drop policy if exists "team_site_captures_update" on storage.objects;
create policy "team_site_captures_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'site-captures');

drop policy if exists "team_site_captures_delete" on storage.objects;
create policy "team_site_captures_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'site-captures');

notify pgrst, 'reload schema';
