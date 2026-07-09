-- ============================================================
-- RESLU Spec System — Client invoicing, phase 1 (design fees).
-- BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 5 +
-- its DECISIONS paragraph: "Branded invoicing + payments ... PHASING:
-- invoice PDF + bank details first (small), Stripe second, MYOB sync
-- third." + "invoices use the ACTUAL logo file ... MYOB stays, manual
-- entry (no API sync for now) ... proceed design-fees-first".
--
-- NAME COLLISION NOTE: this codebase already has an `invoices` table
-- (007_estimating.sql) — that one is SUPPLIER invoices (money OUT,
-- trade/supplier bills matched against cost lines/items, admin
-- approves). This migration's `client_invoices` table is the exact
-- opposite direction — RESLU billing ITS OWN client (money IN) — a
-- completely separate concept that happens to share the word
-- "invoice" in English. Every identifier in this feature is prefixed
-- `client_invoice(s)` specifically to prevent any accidental
-- cross-reference/confusion with the supplier `invoices` table, its
-- routes, or its RLS policies. Nothing in this migration touches the
-- `invoices` table.
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - text + CHECK instead of a Postgres enum (house style)
--   - idempotent throughout (create table if not exists / add column
--     if not exists / drop+recreate policy or constraint) so a partial
--     apply converges cleanly on re-run
--   - RLS: single permissive "team_all" policy at the DB layer (Phase 1
--     house style — see email_sends, board_tasks, etc.) — BUT this
--     table carries financial data, so (per this round's brief)
--     every API route touching client_invoices is admin-gated in the
--     application layer (lib/auth.ts isAdmin/getUserRole), exactly the
--     same "RLS is permissive, the API is the real gate" shape already
--     used for the existing `invoices` table and `estimate`/cost_lines
--     — see docs/API.md "Auth tiers used below" > "admin".
--
-- File-boundary note: owned entirely by this task (client invoicing,
-- phase 1). Does not touch any table another concurrent task owns —
-- in particular, the CPD tracker round owns migration 047 and its own
-- tables; this migration only touches `client_invoices` (new) and
-- `email_sends` (additive constraint widen, see PART 2 below).
-- ============================================================

-- ------------------------------------------------------------
-- PART 1 — client_invoices
--
-- project_id is NULLABLE: per BUILD-SPEC.md's design-fees-first phasing,
-- a design-fee deposit invoice can legitimately be raised BEFORE a
-- project row exists yet (e.g. an initial consultation fee ahead of
-- project creation) — DECISIONS: "proceed design-fees-first". When
-- project_id is null, client_name/client_email/address on THIS row are
-- the source of truth (no project to fall back to); when project_id is
-- set, the UI prefills those fields from the project but still stores
-- its own copy on the invoice row so a later edit to the project's
-- client details never silently rewrites the wording of an
-- already-issued invoice (same "snapshot at send time" principle
-- email_sends.detail already uses for visit emails).
--
-- line_items jsonb: [{ description: text, amount_ex_gst: number }, ...]
-- — phase 1 is manual line items only (BUILD-SPEC.md this round:
-- "phase 1 is manual line items only"); a future "progress claims"
-- feature hooking into estimate whole-job/versions would ADD a
-- generation path that still lands in this same jsonb shape, not a
-- schema change.
--
-- subtotal_ex_gst / gst / total_inc_gst are STORED, not computed
-- on-read-only, even though they're mechanically derivable from
-- line_items: (a) GST is a point-in-time legal calculation on a
-- document that must not silently change if the GST rate or rounding
-- rule is ever revisited, (b) a sent/paid tax invoice's totals must
-- never drift because someone edited line_items after the fact (the
-- API only allows line_items edits while status = 'draft' — see
-- lib/client-invoices.ts / the route layer). See that lib's own header
-- comment for the exact GST rounding rule (round-half-up to cents).
create table if not exists client_invoices (
  id                 uuid primary key default gen_random_uuid(),

  project_id         uuid references projects(id),

  -- '{job_number}-{seq}' (e.g. "026-01") when project_id is set and the
  -- project has a job_number; 'GEN-{seq}' (global sequence) otherwise.
  -- See lib/client-invoices.ts nextInvoiceNumber() for the exact
  -- generation rule (sequence counts VOID invoices too, so a voided
  -- number is never reissued to a different invoice).
  invoice_number     text not null unique,

  kind               text not null default 'design_fee'
                     check (kind in ('design_fee', 'other')),

  -- Snapshot client details (see header comment above for why these are
  -- not just a join through project_id).
  client_name        text not null,
  client_email       text,
  address            text,

  -- [{ description: text, amount_ex_gst: number }, ...]
  line_items         jsonb not null default '[]'::jsonb,

  subtotal_ex_gst    numeric(12,2) not null default 0,
  gst                numeric(12,2) not null default 0,
  total_inc_gst      numeric(12,2) not null default 0,

  status             text not null default 'draft'
                     check (status in ('draft', 'sent', 'paid', 'void')),

  due_days           int not null default 14,

  issued_at          timestamptz,
  paid_at            timestamptz,

  -- Set only by the explicit "Create payment link" admin action (never
  -- auto-created) — see app/api/client-invoices/[id]/stripe-link/route.ts.
  -- Null = no "Pay online" button on the PDF/email (BUILD-SPEC.md this
  -- round: "Pay online button ONLY when stripe_payment_url set").
  stripe_payment_url text,
  -- Review fix: the Stripe Payment Link's own id (plink_...) from the
  -- creation response, needed to deactivate it via the Stripe API
  -- (POST /v1/payment_links/{id}, active=false) when the invoice is
  -- voided or marked paid another way — without this, only the LINK
  -- URL was stored, and there was no way to actually kill the live,
  -- still-payable Stripe-hosted page once our own app stopped showing
  -- it. Null whenever stripe_payment_url is null.
  stripe_payment_link_id text,

  notes              text,

  created_by         uuid references profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

comment on table client_invoices is
  'RESLU Spec System — client invoicing phase 1 (design fees). Money IN (RESLU bills its client) — the OPPOSITE direction of the pre-existing `invoices` table (supplier bills, money OUT). Migration 046. project_id nullable: a design-fee invoice may be raised before a project row exists. All routes touching this table are admin-gated in the API layer (lib/auth.ts) even though RLS below is the house-standard permissive team_all — this table carries financial/client-contact data, matching the existing `invoices` table''s own gating shape.';

comment on column client_invoices.invoice_number is
  '{job_number}-{seq} (e.g. "026-01") when raised against a project with a job_number; GEN-{seq} (global sequence) when project_id is null or the project has no job_number yet. Sequence is per-project (or global for GEN-) and counts void invoices, so a number is never reissued — see lib/client-invoices.ts nextInvoiceNumber().';

comment on column client_invoices.line_items is
  'jsonb array [{ description: text, amount_ex_gst: number }, ...]. Phase 1 is manual entry only — no generation from estimate/progress-claim data yet (future hook, not a schema change).';

comment on column client_invoices.subtotal_ex_gst is
  'Stored, not derived on read — see table comment. subtotal_ex_gst = sum(line_items[].amount_ex_gst), computed server-side by lib/client-invoices.ts computeTotals() at every create/edit while status=draft.';

comment on column client_invoices.gst is
  'GST = subtotal_ex_gst * 0.1, rounded half-up to whole cents. See lib/client-invoices.ts computeTotals() for the exact rounding implementation and rationale.';

comment on column client_invoices.total_inc_gst is
  'total_inc_gst = subtotal_ex_gst + gst (both already rounded to cents individually, then summed — not subtotal * 1.1 rounded once — see lib/client-invoices.ts computeTotals() header comment for why line-by-line rounding order matters for cent-exact reproducibility).';

-- Trigger-free updated_at: this codebase has a shared set_updated_at()
-- trigger function (used by app_settings, 023_phases_insurance.sql,
-- etc.) — reuse it here rather than inventing a second convention.
drop trigger if exists trg_client_invoices_updated_at on client_invoices;
create trigger trg_client_invoices_updated_at
  before update on client_invoices
  for each row execute function set_updated_at();

-- Primary list query: "every client invoice for this project, newest
-- first" (the project Invoices tab's new Client invoices section).
create index if not exists idx_client_invoices_project
  on client_invoices(project_id, created_at desc)
  where deleted_at is null;

-- Status-filtered list (e.g. an "unpaid" view) — same shape as the
-- existing invoices table's status-filter usage pattern.
create index if not exists idx_client_invoices_status
  on client_invoices(status)
  where deleted_at is null;

alter table client_invoices enable row level security;

drop policy if exists "team_all" on client_invoices;
create policy "team_all" on client_invoices
  for all to authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- PART 2 — email_sends.record_type: widen to accept 'client_invoice'.
--
-- email_sends (043_visit_emails.sql) is reused as-is for logging client
-- invoice sends (BUILD-SPEC.md this round: "log via email_sends with
-- record_type addition ... check the check constraint: extend it in
-- YOUR migration to add 'client_invoice'") — record_id points at
-- client_invoices.id (same polymorphic-reference-by-convention pattern
-- as the existing 'lead'/'client_event' rows; no FK, per that table's
-- own documented reasoning). template is free text already (not a
-- CHECK enum) — this send uses template = 'client-invoice', which
-- needs no schema change; only record_type's CHECK enum needs widening.
--
-- Drop + re-add the constraint under its Postgres-default name
-- (unnamed inline `check (...)` on table creation is auto-named
-- `<table>_<column>_check` — matches 029_board_cockpit.sql's own
-- drop-constraint-if-exists/add-constraint pattern for widening a
-- check in place, idempotent on re-run).
-- ------------------------------------------------------------
alter table email_sends
  drop constraint if exists email_sends_record_type_check;
alter table email_sends
  add constraint email_sends_record_type_check
    check (record_type in ('lead', 'client_event', 'client_invoice'));

comment on column email_sends.record_type is
  'Polymorphic reference discriminator (no FK — see this column''s original doc comment in 043_visit_emails.sql). lead -> leads.id, client_event -> client_events.id, client_invoice -> client_invoices.id (added by migration 046, client invoicing phase 1).';

notify pgrst, 'reload schema';
