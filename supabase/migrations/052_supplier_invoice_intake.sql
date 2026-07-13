-- ============================================================
-- RESLU Spec System — Booking selection v2 + Aria supplier invoices (r24)
-- docs/BUILD-SPEC.md §"Booking selection v2 + Aria supplier invoices
-- (r24)", item 8: "Migration 052 only for what's genuinely missing
-- after studying the existing supplier-invoice tables (extraction/
-- source columns, status, email link). One migration."
--
-- STUDY NOTES (why this migration is small):
--   The supplier-invoice queue already exists — `invoices`
--   (007_estimating.sql, money OUT, NOT to be confused with
--   `client_invoices` from 046_client_invoices.sql, money IN — see
--   that migration's own "NAME COLLISION NOTE"). It already has:
--     - status text check ('unmatched','proposed','approved','rejected')
--       — 'proposed' already means "has a proposed match, awaiting
--       admin approval", which is exactly the state an Aria-drafted row
--       lands in (Aria always proposes a match at creation time). No
--       new status value is needed — see "Aria · needs approval" below.
--     - storage_path — already the PDF-on-the-job field (item 6);
--       nothing new needed there either.
--     - approved_by / approved_at — already exist (item covers
--       "approved_by/at" from the round brief's own list; it turned out
--       already present, not missing).
--   Genuinely missing, added below:
--     - source ('manual'|'aria') — which pipeline created this row.
--     - source_email_id — traceability back to the ALREADY-INGESTED
--       Second Brain email this was extracted from (Aria rows only;
--       null for manual). Same FK shape as 040_change_proposals.sql's
--       own source_email_id column.
--     - extracted (jsonb) — Aria's raw extraction payload (abn,
--       line_hints, job_hints, and anything else beyond the invoice's
--       own canonical columns) — shown/edited in the approval UI
--       alongside the canonical fields, kept separately so the
--       canonical columns stay the single source of truth for the
--       actual invoice numbers.
--     - library_cost_applied (boolean) — audit flag set by POST
--       /api/invoices/[id]/approve when it also updated the matched
--       item's linked library product's price_trade (item 7's "cost
--       flow-through" toggle) — lets the approval UI show "library cost
--       updated" after the fact without re-deriving it.
--
-- `invoices.status='proposed'` + the new `source='aria'` together are
-- exactly the "Aria · needs approval" pill (item 6) — a display-only
-- derivation (source='aria' AND status NOT IN ('approved','rejected')),
-- no new status value, no new table.
--
-- `daily_brief_items.source='invoice'` is ALREADY a valid value —
-- 041_brief_and_due_times.sql's original check constraint lists it
-- (comment: "email/invoice = reserved") and 051_proposals.sql's own
-- PART 4 shows the house technique for widening it further if a future
-- round ever needs to. This round doesn't — 'invoice' was reserved for
-- exactly this moment, so POST /api/projects/[id]/invoices' new
-- Aria-dedupe-guarded insert (see that route's own doc comment) needs
-- no ALTER here.
--
-- File-boundary note: only touches `invoices` (007_estimating.sql,
-- owned outside the Second Brain range) — no Second Brain table
-- (033-045) is altered; `emails` is only ever read via the new FK.
-- Idempotent throughout (add column if not exists).
-- ============================================================

alter table invoices
  add column if not exists source text not null default 'manual',
  add column if not exists source_email_id uuid references emails(id) on delete set null,
  add column if not exists extracted jsonb,
  add column if not exists library_cost_applied boolean not null default false;

-- Constraint added separately (not inline on the ADD COLUMN above) so
-- re-running this migration against a database that already has the
-- column but not yet the constraint (partial-apply recovery) still
-- converges — same drop-then-add idempotency technique
-- 051_proposals.sql's own PART 4 uses for daily_brief_items.source.
alter table invoices
  drop constraint if exists invoices_source_check;
alter table invoices
  add constraint invoices_source_check
    check (source in ('manual', 'aria'));

create index if not exists idx_invoices_source_email_id
  on invoices(source_email_id)
  where source_email_id is not null;

comment on column invoices.source is
  'manual = created via the Invoice queue''s own "+ Add invoice" form (UploadForm, existing); aria = created by the MCP propose_supplier_invoice tool (r24) after Second Brain''s email pipeline flagged a likely supplier invoice on an ALREADY-INGESTED email. Combined with status (still ''proposed'' — no new status value needed, see this migration''s header), source=''aria'' AND status NOT IN (''approved'',''rejected'') is exactly the "Aria · needs approval" sand/amber pill the queue UI shows — a pure display derivation, not a stored flag.';

comment on column invoices.source_email_id is
  'Traceability back to the ALREADY-INGESTED Second Brain email (emails.id, 037_emails.sql) this row was extracted from by Aria — null for source=''manual''. Same FK shape/on-delete-set-null-not-cascade choice as 040_change_proposals.sql''s own source_email_id column (losing the source email row should never silently delete a real financial record). Read-only from this app''s side — Second Brain''s own email pipeline (033-045) is never written to by this round.';

comment on column invoices.extracted is
  'Aria''s raw extraction payload at propose time — supplier/ABN/invoice number/date/total/GST as SHE read them off the PDF (may differ slightly from the canonical amount_ex_gst/gst/total/invoice_date columns above if an admin edits those during review), plus line_hints/job_hints (free text — what she matched project/cost-line/item against and why). Shown read-only as extraction context in the approval UI; the canonical columns are what actually gets applied on Approve, never this blob directly. Null for source=''manual''.';

comment on column invoices.library_cost_applied is
  'Audit flag, not a gate — set true by POST /api/invoices/[id]/approve exactly when it ALSO wrote the matched item''s linked library product''s price_trade (item 7''s per-line "update library product cost" toggle, default on when the matched item carries a library_item_id). Approve itself is idempotent via the existing status transition (an already-approved invoice 400s before this ever runs twice — see that route''s own doc comment), so this column is purely so the queue UI can show "library cost updated" after the fact without re-deriving whether it happened.';

notify pgrst, 'reload schema';
