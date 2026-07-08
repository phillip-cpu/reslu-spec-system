-- ============================================================
-- RESLU Spec System — Second Brain, Step 8: emails table (schema only).
-- docs/RESLU-second-brain-build-brief.md, Step 8.
--
-- This migration is the ONLY part of Step 8 buildable/verifiable from
-- this side. Step 8's actual pipeline (IMAP/Gmail fetch, talon strip,
-- pdftotext/ocrmypdf) is Mac-mini-side per the brief's own header —
-- it needs local binaries (pdftotext, ocrmypdf) and network access to
-- Phillip's actual mailbox, neither of which exist in this sandbox.
-- That script is written separately and must be installed/run/tested
-- on the Mac mini itself; this migration only creates the tables it
-- writes into.
--
-- Two columns added beyond the brief's literal SQL, needed to actually
-- support what its OWN pipeline description (step 3) asks for: "still
-- nothing -> needs_vision=true and store page count" and "keep only
-- pages containing $, digit+wk/week, or known item names when the doc
-- is >5 pages (store which pages)" — the brief's schema block had
-- nowhere to put a page count or a kept-pages list. Added:
--   email_attachments.page_count (the "store page count" ask)
--   email_attachments.kept_pages (the "store which pages" ask, for the
--     >5-page regex-filter case; null when not applicable)
--
-- Conventions: text + check instead of enum (matches this migration's
-- own literal SQL already, no change needed there), permissive
-- team_all RLS, idempotent throughout.
-- ============================================================
create table if not exists emails (
  id                 uuid primary key default gen_random_uuid(),
  message_id         text unique not null,
  thread_id          text,
  from_addr          text not null,
  subject            text,
  received_at        timestamptz not null,
  raw_ref            text,
  clean_text         text,
  token_estimate     int,
  triage_label       text,
  triage_confidence  numeric,
  matched_project_id uuid references projects(id) on delete set null,
  match_confidence   numeric,
  match_method       text,
  status             text not null default 'new' check (status in
                       ('new','triaged','extracted','matched','proposed','done','review','skipped')),
  processed_at       timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists idx_emails_status on emails(status);
create index if not exists idx_emails_matched_project_id on emails(matched_project_id);

create table if not exists email_attachments (
  id               uuid primary key default gen_random_uuid(),
  email_id         uuid not null references emails(id) on delete cascade,
  filename         text,
  mime             text,
  storage_ref      text,
  extracted_text   text,
  extraction_method text,
  needs_vision     boolean not null default false,
  page_count       int,
  kept_pages       int[]
);

create index if not exists idx_email_attachments_email_id on email_attachments(email_id);

alter table emails enable row level security;
drop policy if exists "team_all" on emails;
create policy "team_all" on emails
  for all to authenticated using (true) with check (true);

alter table email_attachments enable row level security;
drop policy if exists "team_all" on email_attachments;
create policy "team_all" on email_attachments
  for all to authenticated using (true) with check (true);

comment on table emails is
  'RESLU Second Brain, Step 8 (docs/RESLU-second-brain-build-brief.md). Inbound mail ingested by the Mac-mini pipeline script (IMAP/Gmail fetch, talon-stripped clean_text, dedupe on message_id). status walks new -> triaged (Step 9 Haiku) -> extracted (Step 9 Sonnet, actionable only) -> matched (Step 10) -> proposed (Step 11 change_proposals) -> done, with skipped (hard-rule newsletters/auto-replies/noreply) and review (low-confidence match or failed verification) side branches.';

comment on table email_attachments is
  'RESLU Second Brain, Step 8. page_count/kept_pages support the pipeline''s own >5-page regex-filter step (keep only pages containing $, digit+wk/week, or known item names) — not in the brief''s literal SQL block but needed by its pipeline description (see this migration''s header). needs_vision=true when pdftotext and ocrmypdf both yield no text layer — those pages get sent to Claude vision in Step 9, not this step.';

notify pgrst, 'reload schema';
