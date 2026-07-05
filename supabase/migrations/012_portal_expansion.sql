-- ============================================================
-- RESLU Spec System — Week 8B: Client portal expansion + native
-- e-signature.
-- BUILD-SPEC.md §"Week 8 — Client portal expansion" and
-- §"Built-in digital signature" (the signature section is the
-- security spec — followed exactly below).
--
-- File-boundary note: this agent owns app/portal/**, app/api/portal/**,
-- components/portal/**, app/(dashboard)/projects/[id]/client/**,
-- app/api/projects/[id]/client-updates/**, app/api/signatures/**,
-- lib/signatures.ts, and this migration. types/index.ts,
-- app/(dashboard)/projects/[id]/page.tsx, components/projects/**,
-- components/sow/**, components/estimate/**, components/items/**,
-- lib/scraper/**, and migration 011 are NOT touched here.
--
-- Conventions carried over from 001/007/008:
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per table, EXCEPT
--     signature_events, which gets its own append-only policy set
--     per BUILD-SPEC.md (see below) — this is the one table in the
--     whole schema that deliberately does NOT follow the team_all
--     shape.
--   - soft delete via nullable deleted_at where the spec calls for it
-- ============================================================

-- ============================================================
-- PART 1 — Portal updates (fortnightly rich-text posts)
-- BUILD-SPEC.md: "portal_updates (id, project_id, title, body_richtext
-- text — store markdown, author_id, published_at nullable — draft
-- until published, created_at, updated_at, deleted_at)".
-- ============================================================
create table if not exists portal_updates (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  title           text not null,
  -- Column name is body_richtext per BUILD-SPEC.md letter-for-letter,
  -- but the content stored is markdown (spec: "store markdown") — the
  -- portal feed renders it through a tiny safe paragraph/bold/list
  -- renderer, never dangerouslySetInnerHTML of raw input (see
  -- components/portal/UpdatesFeed.tsx).
  body_richtext   text not null,
  author_id       uuid references profiles(id) on delete set null,
  -- Null = draft. Set = published and visible on the portal feed.
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists idx_portal_updates_project on portal_updates(project_id, published_at);
create index if not exists idx_portal_updates_deleted_at on portal_updates(deleted_at);

create trigger trg_portal_updates_updated_at
  before update on portal_updates
  for each row execute function set_updated_at();

-- ============================================================
-- PART 2 — Progress photos
-- BUILD-SPEC.md: "progress_photos (id, project_id, storage_path,
-- caption, taken_at date nullable, uploaded_by, created_at, deleted_at)".
-- ============================================================
create table if not exists progress_photos (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  storage_path    text not null,
  caption         text,
  taken_at        date,
  uploaded_by     uuid references profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists idx_progress_photos_project on progress_photos(project_id, created_at);
create index if not exists idx_progress_photos_deleted_at on progress_photos(deleted_at);

-- No updated_at trigger — mirrors item_files/project_files: uploads are
-- immutable, a caption edit is a small PATCH but the row is otherwise
-- write-once (see app/api/projects/[id]/client-updates/photos/[photoId]/route.ts).

-- ============================================================
-- PART 3 — project_files / variations gain portal-sharing + response
-- columns.
-- ============================================================
alter table project_files
  add column if not exists share_to_portal boolean not null default false;

alter table variations
  add column if not exists share_to_portal boolean not null default false,
  add column if not exists client_response text
    check (client_response in ('approved', 'declined')),
  add column if not exists client_response_note text,
  add column if not exists client_responded_at timestamptz;

create index if not exists idx_project_files_share_to_portal
  on project_files(project_id) where share_to_portal;
create index if not exists idx_variations_share_to_portal
  on variations(project_id) where share_to_portal;

-- ============================================================
-- PART 4 — Signature requests
-- BUILD-SPEC.md: "signature_requests (id, project_id, subject_type in
-- ('project_file','variation','sow'), subject_id, status in
-- ('pending','signed','void'), requested_by, created_at, voided
-- reason?)".
--
-- subject_id has no FK — subject_type varies between project_files,
-- variations, and (future) an sow table, so a single-column FK isn't
-- possible (same pattern as invoices.proposed_match_id in
-- 007_estimating.sql). The API validates subject existence/ownership
-- against the project at request-creation time (see
-- app/api/signatures/route.ts).
-- ============================================================
create table if not exists signature_requests (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  subject_type    text not null check (subject_type in ('project_file', 'variation', 'sow')),
  subject_id      uuid not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'signed', 'void')),
  requested_by    uuid references profiles(id) on delete set null,
  -- Populated when status transitions to 'void' — either by the
  -- void-on-change trigger below (variation edited after signing) or
  -- by a team member manually voiding a superseded file's request.
  voided_reason   text,
  voided_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_signature_requests_project on signature_requests(project_id, status);
create index if not exists idx_signature_requests_subject on signature_requests(subject_type, subject_id);

create trigger trg_signature_requests_updated_at
  before update on signature_requests
  for each row execute function set_updated_at();

-- ============================================================
-- PART 5 — Signature events (append-only evidence ledger)
-- BUILD-SPEC.md §"Built-in digital signature" — followed EXACTLY, this
-- is the security spec:
--
--   "Evidence record (signature_events table, append-only — no
--   UPDATE/DELETE policies): id, project_id, subject_type
--   ('project_file'|'variation'|'sow'), subject_id, document_sha256
--   (hash of the exact PDF/content signed — computed server-side at
--   sign time), signer_name_typed, signature_image_path (drawn PNG in
--   private storage), portal_token_used, ip, user_agent, signed_at."
--
-- RLS per this migration's BUILD task: "RLS grants INSERT+SELECT to
-- authenticated, INSERT via service role for portal, NO update/delete
-- policies." The portal signing route is unauthenticated (token-gated,
-- like every other portal route) and uses the service-role client,
-- which bypasses RLS entirely for its own inserts — the "INSERT via
-- service role for portal" clause is therefore satisfied by that
-- client's privilege level, not a policy naming `service_role`
-- (service_role already bypasses RLS by definition; no policy is
-- needed or possible to "grant" it something it already has). The
-- authenticated INSERT+SELECT policies below cover any future
-- non-portal (team-side) writer/reader of this table using a normal
-- session, and let team UI (e.g. "Signed by X on date" badges) read
-- the ledger directly under RLS without needing the service-role
-- client for that alone.
-- ============================================================
create table if not exists signature_events (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references projects(id) on delete cascade,
  subject_type            text not null check (subject_type in ('project_file', 'variation', 'sow')),
  subject_id              uuid not null,
  signature_request_id    uuid references signature_requests(id) on delete set null,
  document_sha256         text not null,
  signer_name_typed       text not null,
  signature_image_path    text not null,
  portal_token_used       text not null,
  ip                      text,
  user_agent              text,
  signed_at               timestamptz not null default now()
);

create index if not exists idx_signature_events_project on signature_events(project_id);
create index if not exists idx_signature_events_subject on signature_events(subject_type, subject_id);
create index if not exists idx_signature_events_request on signature_events(signature_request_id);

-- No set_updated_at trigger — this table has no updated_at column at
-- all (append-only ledgers don't get edited, so there is nothing to
-- stamp an update time on; adding the column would only invite a
-- future UPDATE that the policies below are specifically designed to
-- forbid).

alter table signature_events enable row level security;

-- Append-only per BUILD-SPEC.md: INSERT + SELECT only, to
-- `authenticated`. Deliberately NOT `for all` like every other table's
-- "team_all" policy in this codebase — there is intentionally no
-- UPDATE or DELETE policy of any kind (including for authenticated),
-- which means Postgres denies those operations to every role except
-- the service-role/superuser client (which bypasses RLS but is only
-- ever used server-side, is never exposed to a client request path
-- that would issue an UPDATE/DELETE against this table, and is not a
-- substitute for a policy — it's an intentional escape hatch reserved
-- for migrations/ops, not application code, per the append-only
-- design). This is the actual enforcement mechanism the security
-- spec's "no UPDATE/DELETE policies" describes.
drop policy if exists "signature_events_insert" on signature_events;
create policy "signature_events_insert" on signature_events  for insert to authenticated with check (true);

drop policy if exists "signature_events_select" on signature_events;
create policy "signature_events_select" on signature_events  for select to authenticated using (true);

-- ============================================================
-- PART 6 — Void-on-change trigger (variations)
-- BUILD-SPEC.md: "Void-on-change: ... for variations, implement a
-- trigger ... that sets related signature_requests.status='void' on
-- variation UPDATE of cost/description after signed."
--
-- "After signed" = there exists a signature_events row for this
-- variation (i.e. it has actually been signed at least once) — a
-- pending, never-signed request doesn't need voiding just because the
-- team is still drafting the variation; voiding only matters once a
-- client has put a signature to a specific cost/description and that
-- content then changes under them.
-- ============================================================
create or replace function void_signature_on_variation_change()
returns trigger as $$
begin
  if (new.cost_ex_gst is distinct from old.cost_ex_gst
      or new.description is distinct from old.description)
     and exists (
       select 1 from signature_events se
       where se.subject_type = 'variation' and se.subject_id = old.id
     )
  then
    update signature_requests
    set status = 'void',
        voided_reason = 'Variation cost or description edited after signing — hash mismatch, re-signature required.',
        voided_at = now()
    where subject_type = 'variation'
      and subject_id = old.id
      and status = 'signed';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_void_signature_on_variation_change
  after update on variations
  for each row execute function void_signature_on_variation_change();

-- ------------------------------------------------------------
-- Void-on-change for project_files: NOT a trigger. project_files
-- revisions are new ROWS (uploaded_at-ordered, see 008_project_files.sql
-- and ProjectDocuments.tsx's "latest revision shown, history beneath"
-- pattern) rather than edits to an existing row, so there is no UPDATE
-- to a signed file's content for a trigger to catch — a new revision
-- simply doesn't match any existing signature_request.subject_id (that
-- id still points at the OLD file row, which is untouched and still
-- validly signed for its own content/hash).
--
-- Handling therefore lives in the team UI + API layer instead of SQL:
-- when a new project_files row is uploaded for a kind/slot that has a
-- prior row with a 'signed' (or 'pending') signature_requests entry,
-- the client-area UI shows a "superseded" badge on the OLD file's
-- request (see components under app/(dashboard)/projects/[id]/client/
-- — SignatureStatusChip) and the team must knowingly create a NEW
-- signature_request against the NEW file's row if a fresh signature is
-- wanted. The old signature_events row is never touched (it remains
-- correct, permanent evidence for the document it actually hashed).
-- ------------------------------------------------------------

-- ============================================================
-- PART 7 — Row Level Security for the remaining new/altered tables
-- Same Phase 1 "team_all" shape as every other non-financial,
-- non-append-only table in this codebase.
-- ============================================================
alter table portal_updates enable row level security;
alter table progress_photos enable row level security;
alter table signature_requests enable row level security;

drop policy if exists "team_all" on portal_updates;
create policy "team_all" on portal_updates  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on progress_photos;
create policy "team_all" on progress_photos  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on signature_requests;
create policy "team_all" on signature_requests  for all to authenticated using (true) with check (true);

-- project_files and variations already have "team_all" policies from
-- 008_project_files.sql / 007_estimating.sql — the new columns added
-- in PART 3 are covered by those existing policies automatically (RLS
-- policies apply at the row level, not per-column).
