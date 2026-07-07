-- ============================================================
-- RESLU Spec System — "Two from Phillip — 7 July 2026" round.
-- BUILD-SPEC.md §"Two from Phillip — 7 July 2026 (migration 030
-- round)" incl. the per-project checklist amendment.
--
-- Two independent pieces of schema:
--   PART 1 — library_items.is_standard: a per-product "always include
--   this in a new job" flag, surfaced as a checklist at project
--   creation and at the leads "Progress to job" handoff, so a studio
--   standard (e.g. a default tapware line) doesn't have to be manually
--   re-added to every new register by hand.
--   PART 2 — lead_notes: an attributed, timestamped notes feed for
--   leads, mirroring item_notes (001_initial.sql) exactly in shape —
--   replacing the single free-text leads.notes column as the editable
--   surface (that column itself is NOT dropped — see PART 2's own
--   header — so nothing already pointing at it breaks, but the UI no
--   longer offers it for direct editing once this ships).
--
-- Conventions carried over from every prior migration (029 most
-- recently):
--   - uuid pks via gen_random_uuid()
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"; admin gating for leads happens at
--     the route layer, same as every other leads table)
--   - idempotent throughout (add column if not exists / create table
--     if not exists / drop+recreate policies / on conflict do nothing)
--     so a partial apply converges cleanly on re-run
-- ============================================================

-- ============================================================
-- PART 1 — library_items.is_standard
--
-- A plain boolean, not a separate join table — a "standard spec item"
-- is a property of the product itself (BUILD-SPEC.md: toggle per
-- item in the Library UI, badge '★ Standard' in the list), not a
-- per-project relationship the way project_library_items already
-- tracks usage. Defaults false so every existing library item is
-- unaffected until someone explicitly flags it.
-- ============================================================
alter table library_items
  add column if not exists is_standard boolean not null default false;

create index if not exists idx_library_items_is_standard
  on library_items(is_standard) where is_standard = true;

comment on column library_items.is_standard is
  'Migration 030 round. Toggled from the Library UI (badge "★ Standard" in the list, PATCH /api/library/[id] whitelist addition). Drives the "Standard spec items" checklist shown, all pre-ticked, at Create Project (GET /api/library?standard=1) and at the leads "Progress to job" handoff (same query) — see lib/library-items.ts copyLibraryItemToProject() for the shared copy path both flows call.';

-- ============================================================
-- PART 2 — lead_notes: attributed, timestamped notes feed.
--
-- Deliberate structural mirror of item_notes (001_initial.sql) —
-- same four content columns, same cascade-on-parent-delete, same
-- single per-parent index. leads.notes (014_leads.sql) is left in
-- place (still nullable free text) rather than dropped: dropping a
-- column is irreversible and this migration's job is additive: the
-- data migration immediately below folds any EXISTING legacy notes
-- into this new feed as one imported entry, and from that point on
-- the UI (components/leads/LeadDetailPanel.tsx) no longer offers
-- leads.notes for direct editing — display migrates into the feed,
-- the column itself just stops being written to by the app.
-- ============================================================
create table if not exists lead_notes (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references leads(id) on delete cascade,
  author_id    uuid references profiles(id) on delete set null,
  author_name  text not null,   -- denormalised for display, same as item_notes
  text         text not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_lead_notes_lead_id on lead_notes(lead_id);

alter table lead_notes enable row level security;

drop policy if exists "team_all" on lead_notes;
create policy "team_all" on lead_notes
  for all to authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- Data migration: fold every lead's existing non-empty legacy
-- `notes` free-text column into exactly one lead_notes row, so
-- nothing written before this migration is silently lost once the UI
-- stops offering leads.notes for direct editing.
--
-- Idempotent guard: a NOT EXISTS check keyed on (lead_id, author_name
-- = 'Imported note') stops this insert from re-running on every
-- migration re-apply — without it, re-running this file (this
-- schema's stated re-run-safety discipline — see every prior
-- migration's own header) would duplicate the imported note on every
-- apply. This assumes at most one "Imported note" row per lead ever
-- gets created by this migration, which holds as long as this exact
-- INSERT is the only writer of that author_name — true today.
-- ------------------------------------------------------------
insert into lead_notes (lead_id, author_id, author_name, text, created_at)
select
  l.id,
  null,
  'Imported note',
  l.notes,
  l.created_at
from leads l
where l.notes is not null
  and btrim(l.notes) <> ''
  and not exists (
    select 1 from lead_notes ln
    where ln.lead_id = l.id
      and ln.author_name = 'Imported note'
  );

comment on table lead_notes is
  'Migration 030 round. Attributed, timestamped notes feed for a lead — mirrors item_notes exactly. Replaces leads.notes as the editable surface in the UI (components/leads/LeadDetailPanel.tsx); leads.notes itself is left in the schema (not dropped) but is no longer written to by the app once this ships. See GET/POST /api/leads/[id]/notes and this migration''s data-migration block above for the one-time import of any pre-existing leads.notes text.';

notify pgrst, 'reload schema';
