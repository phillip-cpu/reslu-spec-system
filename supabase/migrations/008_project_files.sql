-- ============================================================
-- RESLU Spec System — Project Documents
-- BUILD-SPEC.md "Project documents": plans, council approvals,
-- engineering, scope of works, other — five sections, revision-labelled
-- (T1/T2/T3 tender sets), team-visible (NOT admin-gated — documents
-- aren't financial, unlike the Estimate/Invoices modules).
--
-- Conventions carried over from 001_initial.sql / 007_estimating.sql:
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() NOT used here — project_files has no updated_at
--     column (mirrors item_files, which also has none: uploads are
--     immutable, a new revision is a new row, not an edit)
--   - RLS: single permissive "team_all" policy (Phase 1: no unenforced
--     role theatre — enforcement, where needed, is API-side)
--   - soft delete via nullable deleted_at (unlike item_files, which
--     hard-deletes — project_files gets deleted_at because revisioned
--     documents benefit from an audit trail; hard delete would lose
--     the history of what a T1/T2 revision used to be)
-- ============================================================

create table project_files (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  kind            text not null
                  check (kind in ('plans', 'council', 'engineering', 'scope_of_works', 'other')),
  storage_path    text not null,
  filename        text not null,
  -- Tender/revision label, e.g. "T3" — first-class per BUILD-SPEC.md
  -- ("Revision label is first-class (T1/T2/T3 tender sets)"), nullable
  -- since not every document is part of a numbered revision set (e.g.
  -- a one-off "Other" upload).
  revision_label  text,
  uploaded_by     uuid references profiles(id) on delete set null,
  uploaded_at     timestamptz not null default now(),
  deleted_at      timestamptz
);

create index idx_project_files_project on project_files(project_id, kind);
create index idx_project_files_deleted_at on project_files(deleted_at);

alter table project_files enable row level security;

create policy "team_all" on project_files
  for all to authenticated using (true) with check (true);
