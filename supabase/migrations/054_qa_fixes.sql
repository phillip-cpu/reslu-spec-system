-- ============================================================
-- RESLU Spec System — QA fix round (r27)
-- docs/BUILD-SPEC.md §"QA fix round (r27)", item 7 — the only item this
-- round needs a migration for (kept minimal, one migration for the
-- round per BUILD-SPEC.md's standing "one numbered migration per
-- round" ruling).
--
-- Orphaned deposit invoices: migration 046 already made
-- client_invoices.project_id NULLABLE on purpose ("design-fees-first"
-- phasing — a deposit invoice can be raised before a project exists).
-- What was missing: when that invoice comes from an ACCEPTED fee
-- proposal raised against a lead (POST /api/proposal/[token]/accept),
-- nothing recorded which lead it belonged to — so once that lead later
-- became a project (POST /api/leads/[id]/create-project), there was no
-- way to find and re-link the invoice. This migration adds the missing
-- column + index only; the actual set/backfill logic lives at the two
-- route call sites (not here):
--   - app/api/proposal/[token]/accept/route.ts sets lead_id at insert
--     time whenever the accepted proposal is lead-only (project_id
--     still null at that point).
--   - app/api/leads/[id]/create-project/route.ts backfills
--     project_id (lead_id is left set, for history) on any of that
--     lead's still-unlinked (project_id is null) invoices once the
--     lead becomes a real project.
-- A small "Unlinked invoices" list (components/leads/
-- UnlinkedInvoicesPanel.tsx, on the admin-only /leads page — see that
-- component's own header comment for why /leads over Office) surfaces
-- any client_invoices row with project_id still null, lead_id or not,
-- so a genuinely orphaned invoice (e.g. a manually-created one with no
-- lead at all) is never invisible either.
-- ============================================================

alter table client_invoices
  add column if not exists lead_id uuid references leads(id) on delete set null;

create index if not exists idx_client_invoices_lead on client_invoices(lead_id);

comment on column client_invoices.lead_id is
  'QA fix round (r27) item 7. Nullable + ON DELETE SET NULL — same "optional link, never cascades real history away" discipline as trade_visits.contact_id / board_tasks.visit_id. Set once by POST /api/proposal/[token]/accept when the accepted proposal is lead-only (no project_id yet) — see that route''s own client_invoices insert. Read by POST /api/leads/[id]/create-project to backfill project_id onto any of the lead''s still-unlinked invoices once the lead becomes a project (project_id is what actually changes there; lead_id is left set as history, not cleared).';

notify pgrst, 'reload schema';
