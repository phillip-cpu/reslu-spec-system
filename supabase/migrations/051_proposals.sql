-- ============================================================
-- RESLU Spec System — Fee proposal phase (r23)
-- docs/BUILD-SPEC.md §"Fee proposal phase (r23)" item 1 + its
-- DECISIONS paragraph: "ONE signable document: proposal + terms
-- merged (replaces LawDepot service contract). Client signs on the
-- tokened page -> signed PDF stored + emailed -> deposit invoice
-- auto-DRAFTED (never auto-sent) via 046 machinery -> attention item."
--
-- This migration builds ONLY the `proposals` table, letter-for-letter
-- per item 1's column list, plus the minimum supporting CHECK-
-- constraint widenings other rounds' own migrations have already
-- established the convention for (email_sends.record_type widened by
-- 046/049; the SAME "drop+recreate the default-named constraint from
-- a LATER migration, never edit the owning file" technique is reused
-- here for aria_queue.kind (033) and daily_brief_items.source (041) —
-- see PART 2/3/4 below). No other table is touched.
--
-- Storage: signed PDFs are NOT given a new bucket. Per this round's own
-- build instruction ("store in an existing suitable private bucket if
-- one fits, check 009/010/050 bucket conventions"): the private
-- `assets` bucket (009_assets_bucket.sql, lib/storage.ts's
-- ASSET_BUCKET) already stores signature certificates
-- (lib/signatures.ts's certificatePath()) and every other private
-- generated-PDF-per-record object in this schema — a signed proposal
-- PDF is the same shape of object (one immutable generated PDF per
-- record, private, signed-URL-only access), so it reuses that bucket
-- at path `proposals/{proposal_id}/{timestamp}-signed.pdf` (see
-- lib/proposals.ts's proposalPdfPath()). No new
-- `insert into storage.buckets` statement is needed in this migration.
--
-- Conventions carried over from every prior migration:
--   - uuid pk via gen_random_uuid()
--   - text + CHECK instead of a Postgres enum (house style)
--   - idempotent throughout (create table if not exists / add column
--     if not exists / drop+recreate policy or constraint) so a partial
--     apply converges cleanly on re-run
--   - RLS: single permissive "team_all" policy (house style) — real
--     enforcement (admin-only create/send/edit; public token-gated
--     accept/view) happens at the API route layer, exactly like every
--     other financial-adjacent table in this schema (client_invoices,
--     leads) per BUILD-SPEC.md §Security's "RLS is permissive, the API
--     is the real gate" split.
--   - token default `encode(gen_random_bytes(32), 'hex')` — same
--     unguessable-32-byte-hex shape as trade_booking_requests.token
--     (049), leads.brief_token (048), trade_visits.confirm_token (016).
--
-- File-boundary note: owned entirely by this round. Does not touch any
-- Second Brain table body (033-045 untouched — only aria_queue's own
-- CHECK constraint is widened, via THIS migration, the same technique
-- 046/049 already used on email_sends, itself owned by 043) or any
-- table another round owns.
-- ============================================================

-- ============================================================
-- PART 1 — proposals
-- ============================================================
create table if not exists proposals (
  id              uuid primary key default gen_random_uuid(),

  lead_id         uuid references leads(id) on delete set null,
  project_id      uuid references projects(id) on delete set null,

  token           text not null unique default encode(gen_random_bytes(32), 'hex'),

  status          text not null default 'draft'
                  check (status in ('draft', 'sent', 'accepted', 'closed')),

  -- {letter, vision, scope_sections[{title, intro?, bullets[],
  -- deliverables[]}], fees{mode staged|single, stages[{label,
  -- total_inc, milestones[{label, amount_inc}]}], payment_lines[]},
  -- timeline[{phase, duration}], exclusions{bullets[], allowance},
  -- terms_md} — see types/proposals.ts's ProposalContent for the
  -- exact TS shape this jsonb blob is read/written as, and
  -- lib/proposal-templates.ts for the three seed templates + default
  -- terms_md. No sub-table per section/stage/milestone/row — the
  -- whole document is one editable blob, matching this round's own
  -- "draft-commit-on-blur over the whole content object" builder UI
  -- decision (see components/proposals/ProposalEditor.tsx), the same
  -- "flat jsonb document, not normalised rows" shape sow-templates.ts
  -- content takes before being copied into real sow_sections/sow_lines
  -- rows — proposals never gets that normalisation step, since (unlike
  -- a SOW) nothing else in this schema needs to query into a single
  -- scope bullet or fee milestone relationally.
  content         jsonb not null default '{}'::jsonb,

  -- Server-computed from content.fees at every create/PATCH (never
  -- accepted verbatim from the client) — see lib/proposals.ts's
  -- computeProposalTotals(), same "never trust a client-supplied
  -- total" posture as client_invoices' subtotal/gst/total_inc_gst
  -- (046). Inc-GST, dollars (numeric(12,2)) — matches the existing
  -- client_invoices numeric convention (NOT cents-as-integer).
  total_inc       numeric(12,2) not null default 0,

  -- Defaults to round(30% of total_inc) at proposal-create time (see
  -- lib/proposals.ts's defaultDepositInc()), then a plain editable
  -- field on this row from then on — the server does NOT keep forcing
  -- it back to 30% on every content edit, so an admin's manual
  -- override sticks.
  deposit_inc     numeric(12,2) not null default 0,

  -- Public client-page GET /proposal/[token] sets this once, only
  -- while status = 'sent' and only if still null (see that route's own
  -- comment) — never set for a draft-status preview visit (the
  -- Builder UI's own "Live preview link" hits this same route before
  -- Send is ever pressed) and never re-set on a later visit.
  viewed_at       timestamptz,

  -- Stamped once by POST /api/proposals/[id]/send. Drives the >5-day
  -- "not accepted" My Work follow-up (see lib/proposals.ts's
  -- isProposalFollowupDue()) — a resend does NOT reset this (same
  -- "sent_at is stamped once, resend has its own guard" discipline as
  -- trade_booking_requests.sent_at, 049).
  sent_at         timestamptz,

  signed_name     text,
  signed_at       timestamptz,

  -- { drawn_data_url (PNG data URL, canvas-captured — reuses
  -- components/portal/SignatureCanvas.tsx's own draw pattern),
  -- typed_name, consent: true, ip, user_agent }. Stamped once, by
  -- POST /api/proposal/[token]/accept — see that route's own doc
  -- comment for why the drawn signature image lives INSIDE this jsonb
  -- blob rather than as a separate private-storage object + path
  -- column (the pre-existing signature_requests/signature_events
  -- machinery, lib/signatures.ts, is typed to subject_type
  -- 'project_file'|'variation'|'sow' only and is a project-scoped
  -- portal feature — a proposal is neither project-scoped-only
  -- (lead_id-only proposals exist) nor one of those three subjects, so
  -- this round captures the SAME evidence shape (typed name + drawn
  -- PNG + consent + ip/user-agent, per BUILD-SPEC.md item 4) as its
  -- own self-contained record on this row instead of forcing an
  -- unrelated table's CHECK constraint open).
  signature       jsonb,

  -- Object key in the private `assets` bucket (ASSET_BUCKET) — see
  -- this migration's own header comment on bucket reuse.
  signed_pdf_path text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint chk_proposals_lead_or_project
    check (num_nonnulls(lead_id, project_id) >= 1)
);

comment on table proposals is
  'Fee proposal phase (r23). ONE signable document (proposal + terms merged, replacing the old LawDepot service contract) — see docs/BUILD-SPEC.md §"Fee proposal phase (r23)". lead_id/project_id: at least one set (chk_proposals_lead_or_project) — a proposal can be raised against a pre-project lead OR an existing project. status: draft (Builder UI, editable, "Live preview" link already live at /proposal/{token}) -> sent (POST .../send, email fired) -> accepted (client signed on /proposal/{token}, signed PDF stored+emailed, deposit invoice drafted) -> closed (reserved, not set by any route in this round — same "reserved for a future explicit close-out" shape as trade_booking_requests.status=''closed'', 049).';
comment on column proposals.lead_id is
  'Nullable + ON DELETE SET NULL (same "optional link, never cascades real history away" discipline as trade_visits.contact_id/board_tasks.visit_id) — at least one of lead_id/project_id is set (chk_proposals_lead_or_project). Set when the proposal is raised from a lead''s detail panel BEFORE a project exists.';
comment on column proposals.project_id is
  'Nullable + ON DELETE SET NULL — see lead_id''s own comment. Set when raised from a project (post "Progress to job"), or backfilled onto a lead-originated proposal once that lead becomes a project (not automated in this round — no route currently re-links an existing proposal when a lead progresses to a job; documented as a known gap, not silently worked around).';
comment on column proposals.token is
  'Unguessable 32-byte hex token — same shape/trust model as trade_booking_requests.token/leads.brief_token/trade_visits.confirm_token. Security boundary for GET /proposal/[token] (also the Builder UI''s own "Live preview" link, reachable before Send) and POST /api/proposal/[token]/accept — both use the service-role client, bypassing RLS, exactly like every other tokened public surface in this schema.';
comment on column proposals.content is
  'jsonb document — see types/proposals.ts''s ProposalContent for the exact shape (letter, vision, scope_sections[], fees{}, timeline[], exclusions{}, terms_md) and this table''s own header comment for why it stays one flat blob rather than being normalised into per-section/stage/milestone rows.';
comment on column proposals.total_inc is
  'Server-computed from content.fees at every create/PATCH — see lib/proposals.ts''s computeProposalTotals(). Never accepted verbatim from the client, same posture as client_invoices'' stored (not derived-on-read) totals (046).';
comment on column proposals.deposit_inc is
  'Defaults to round(30% of total_inc) to the nearest dollar at proposal-create time (lib/proposals.ts''s defaultDepositInc()) — a plain editable field on this row from then on, never silently re-forced back to 30% by a later content edit.';
comment on column proposals.viewed_at is
  'Set once by GET /proposal/[token], only while status=''sent'' and only if still null — see that route''s own doc comment. A draft-status "Live preview" visit from the Builder UI never sets this.';
comment on column proposals.sent_at is
  'Stamped once by POST /api/proposals/[id]/send. Drives the >5-day-not-accepted My Work follow-up (lib/proposals.ts''s isProposalFollowupDue()) — a resend (POST /api/proposals/[id]/resend) does NOT reset this, same discipline as trade_booking_requests.sent_at (049).';
comment on column proposals.signature is
  '{ drawn_data_url, typed_name, consent: true, ip, user_agent } — captured once by POST /api/proposal/[token]/accept. See this table''s own doc comment for why the drawn signature PNG lives inside this jsonb blob rather than a separate private-storage path column (unlike lib/signatures.ts''s signature_events.signature_image_path) — this round''s proposals are not one of that machinery''s three typed subjects and are not always project-scoped, so re-using its schema/CHECK would require widening a table this round is told to read-not-edit.';
comment on column proposals.signed_pdf_path is
  'Object key in the private `assets` bucket (ASSET_BUCKET, lib/storage.ts) — e.g. proposals/{id}/{timestamp}-signed.pdf. Set once, alongside signature/signed_name/signed_at/status=''accepted'', by POST /api/proposal/[token]/accept. Never overwritten — a re-POST to an already-accepted proposal is a no-op (idempotent) that returns the SAME path.';

create index if not exists idx_proposals_lead on proposals(lead_id);
create index if not exists idx_proposals_project on proposals(project_id);
-- Follow-up query shape ("proposals still sent, sent more than 5 days
-- ago") — same composite-index reasoning as
-- idx_trade_booking_requests_status_sent (049).
create index if not exists idx_proposals_status_sent on proposals(status, sent_at);

drop trigger if exists trg_proposals_updated_at on proposals;
create trigger trg_proposals_updated_at
  before update on proposals
  for each row execute function set_updated_at();

alter table proposals enable row level security;

drop policy if exists "team_all" on proposals;
create policy "team_all" on proposals
  for all to authenticated using (true) with check (true);

-- ============================================================
-- PART 2 — email_sends.record_type: widen to accept 'proposal'.
-- Same drop+recreate-under-default-name technique 046/049 already used
-- on this exact column (owned by 043_visit_emails.sql) — record_id
-- points at proposals.id (no FK, same polymorphic-reference-by-
-- convention as every other record_type value here). template values
-- used: 'proposal-sent' (POST /api/proposals/[id]/send and .../resend)
-- and 'proposal-accepted' (the signed-copy email POST
-- /api/proposal/[token]/accept sends to client + phillip@reslu.com.au)
-- — both free text, no schema change needed for those (template was
-- never a CHECK-constrained column).
-- ============================================================
alter table email_sends
  drop constraint if exists email_sends_record_type_check;
alter table email_sends
  add constraint email_sends_record_type_check
    check (record_type in ('lead', 'client_event', 'client_invoice', 'trade_booking_request', 'proposal'));

comment on column email_sends.record_type is
  'Polymorphic reference discriminator (no FK — see this column''s original doc comment in 043_visit_emails.sql). lead -> leads.id, client_event -> client_events.id, client_invoice -> client_invoices.id (046), trade_booking_request -> trade_booking_requests.id (049), proposal -> proposals.id (051, fee proposal phase — covers both the ''proposal-sent'' send/resend and the ''proposal-accepted'' signed-copy email).';

-- ============================================================
-- PART 3 — aria_queue.kind: widen to accept 'draft_proposal'.
-- Same technique, applied to aria_queue (owned by 033_aria_queue.sql,
-- Second Brain) — this migration only widens the CHECK constraint from
-- outside that file, exactly the same shape as PART 2 above; no row in
-- 033-045 is touched. Raised by POST /api/proposals (proposal create)
-- when the source lead has brief_answers — see docs/BUILD-SPEC.md item
-- 5: "aria_queue item 'draft_proposal' created when proposal created
-- from a lead with brief answers."
-- ============================================================
alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in ('price_request','trade_reminder','lead_flag','approval_needed','email_proposal','draft_proposal'));

comment on column aria_queue.kind is
  'price_request/trade_reminder/lead_flag/approval_needed/email_proposal — Second Brain, 033_aria_queue.sql. draft_proposal (051, fee proposal phase) — payload {proposal_id, lead_id}, raised by POST /api/proposals when the source lead has brief_answers; Aria drafts content.letter/content.vision via the set_proposal_draft MCP tool (only while status=''draft'') then resolves the item via resolve_queue_item, per docs/ARIA.md.';

-- ============================================================
-- PART 4 — daily_brief_items.source: widen to accept 'proposal'.
-- Same technique, applied to daily_brief_items (owned by
-- 041_brief_and_due_times.sql). Raised by POST
-- /api/proposal/[token]/accept (dedupe-guarded — see that route's own
-- doc comment for the exact "existing open row" check, same shape as
-- POST /api/brief-submit/[token]'s own daily_brief_items insert).
-- ============================================================
alter table daily_brief_items
  drop constraint if exists daily_brief_items_source_check;
alter table daily_brief_items
  add constraint daily_brief_items_source_check
    check (source in ('booking', 'ordering', 'lead', 'trade', 'email', 'invoice', 'manual', 'aria', 'proposal'));

comment on column daily_brief_items.source is
  'booking = bookings_overdue; ordering = order-by engine ordering_due rollup; lead = leads nurture/stale_proposals; trade = trade proposed_change OR expiring/expired insurance; email/invoice = reserved; manual = typed inline; aria = appended via add_brief_item MCP tool; proposal (051, fee proposal phase) = a client just accepted a fee proposal (POST /api/proposal/[token]/accept), dedupe-guarded the same way as the ''lead'' source''s own brief-submitted insert.';

notify pgrst, 'reload schema';
