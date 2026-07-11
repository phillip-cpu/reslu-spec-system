-- ============================================================
-- RESLU Spec System — Grouped trade booking round (r20)
-- docs/BUILD-SPEC.md §"Grouped trade booking (r20)": booking one trade
-- for several spaced-apart tasks used to fire one email PER visit
-- (spam). This round adds a "request" wrapper — one email covering
-- every task proposed for a trade on a project, with the trade
-- responding per line (task) on a single tokened page.
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - text + CHECK instead of a Postgres enum (house style)
--   - idempotent throughout (create table if not exists / add column
--     if not exists / drop+recreate policy / drop+recreate constraint)
--     so a partial apply converges cleanly on re-run
--   - RLS: single permissive "team_all" policy (Phase 1 — "no
--     unenforced role theatre"); this is scheduling data, not
--     financial
--   - token default `encode(gen_random_bytes(32), 'hex')` copied
--     character-for-character from trade_visits.confirm_token
--     (016_trade_visits.sql) / leads.brief_token (048_lead_brief.sql)
--     — the same unguessable-public-link token shape used everywhere
--     else in this schema. Same trust model: the token itself, not a
--     hidden route, is the security boundary for the public
--     /trade-request/[token] page and its respond route (both go
--     through the service-role client, exactly like /trade/[token]).
-- ============================================================

-- ============================================================
-- trade_booking_requests — one row per "send" of a grouped trade
-- booking (one trade contact, many tasks/dates, one email, one
-- tokened response link). Each task/date line the request covers is
-- a real trade_visits row (see PART 2 below), linked back here via
-- trade_visits.booking_request_id — this table itself carries no line
-- items, only the envelope (who, which project, what token, what
-- state).
--
-- contact_id is NULLABLE + ON DELETE SET NULL, mirroring the exact
-- precedent trade_visits.contact_id already set (016_trade_visits.sql)
-- and board_tasks.contact_id before it (013_boards_contacts.sql): a
-- request's own history (who it was sent to, its lines, its
-- responses) must survive an Address Book cleanup that deletes the
-- contact — losing the contact_id degrades the admin detail view's
-- "sent to {company}" label, it never deletes real scheduling/
-- response history.
-- ============================================================
create table if not exists trade_booking_requests (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  contact_id    uuid references contacts(id) on delete set null,

  token         text not null unique default encode(gen_random_bytes(32), 'hex'),

  status        text not null default 'draft'
                check (status in ('draft', 'sent', 'responded', 'closed')),

  sent_at       timestamptz,
  responded_at  timestamptz,
  -- Review fix: separate from sent_at (which is documented as
  -- "stamped once" and drives the 3-day follow-up clock — a resend
  -- must not reset that). Backs claim_trade_request_resend() below,
  -- the atomic duplicate-send guard for POST /api/trade-requests/[id]/
  -- resend.
  last_resend_at timestamptz,

  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- Not in BUILD-SPEC.md's literal column list for this table, but
  -- every other table in this schema carries updated_at + the shared
  -- set_updated_at() trigger (defined in 001_initial.sql) — added here
  -- for that house-wide consistency, not a functional requirement of
  -- this round's own flows (which only ever read/write sent_at/
  -- responded_at explicitly).
  updated_at    timestamptz not null default now()
);

create index if not exists idx_trade_booking_requests_project on trade_booking_requests(project_id);
create index if not exists idx_trade_booking_requests_contact on trade_booking_requests(contact_id);
-- token is already indexed by its unique constraint (the public
-- respond route's own lookup shape), but the 3-day-follow-up query
-- (My Work follow-ups source, app/api/my-work/route.ts) filters on
-- (status, sent_at) together, so a composite index serves that
-- without a sequential scan as requests accumulate.
create index if not exists idx_trade_booking_requests_status_sent on trade_booking_requests(status, sent_at);

create trigger trg_trade_booking_requests_updated_at
  before update on trade_booking_requests
  for each row execute function set_updated_at();

alter table trade_booking_requests enable row level security;

drop policy if exists "team_all" on trade_booking_requests;
create policy "team_all" on trade_booking_requests
  for all to authenticated using (true) with check (true);

comment on table trade_booking_requests is
  'Grouped trade booking round (r20). The envelope for a "send one trade every proposed task/date on this project in one email" request — see BUILD-SPEC.md §"Grouped trade booking (r20)". Each task/date line the request actually covers is a trade_visits row with booking_request_id pointing back here (see that column''s own comment). status: draft (being assembled in the panel, not yet sent — today the panel always sends immediately on submit, so this state is transient/defensive rather than a persisted staff step) -> sent (email sent, awaiting the trade) -> responded (the trade has acted on every line — accepted or suggested a new date on all of them; individual lines may still need STAFF follow-up, e.g. a suggested date, but nothing is awaiting the TRADE any more) -> closed (reserved for a future explicit "close out" action; not set by any route in this round).';
comment on column trade_booking_requests.token is
  'Unguessable 32-byte hex token — same shape/trust model as trade_visits.confirm_token and leads.brief_token. Security boundary for the public GET /trade-request/[token] page and POST /api/trade-request/[token]/respond route (both use the service-role client, bypassing RLS, exactly like every other tokened public surface in this schema).';
comment on column trade_booking_requests.sent_at is
  'Stamped once, when the grouped email actually sends (POST /api/projects/[id]/trade-requests). Drives the 3-day follow-up surfaced in My Work (app/api/my-work/route.ts) — a request with status=''sent'' and sent_at more than 3 days ago with no response yet.';
comment on column trade_booking_requests.responded_at is
  'Stamped the moment every line (trade_visits row) linked to this request has moved off line_status=''proposed'' (i.e. the trade has either accepted or suggested a date on all of them) — see POST /api/trade-request/[token]/respond''s own doc comment for the exact "all lines resolved" check.';
comment on column trade_booking_requests.last_resend_at is
  'Review fix. Stamped by claim_trade_request_resend() on every successful resend claim — kept separate from sent_at (which stays "stamped once" and must not move, since it drives the 3-day follow-up clock). Not read anywhere else.';

-- Review fix: POST /api/trade-requests/[id]/resend used to SELECT the
-- most recent email_sends row and compare its timestamp in application
-- code, then separately call sendOrQueue — a real gap between the
-- check and the send with no lock, so two near-simultaneous resend
-- clicks (double-click, two admin tabs) could both read "no recent
-- send" before either commits, defeating the guard's whole purpose.
-- Single atomic UPDATE ... RETURNING (same pattern as migration 048's
-- increment_visit_ics_sequence()) so Postgres's own row lock
-- serializes concurrent callers: the second caller's UPDATE blocks
-- until the first commits, then re-evaluates its WHERE clause against
-- the now-fresh last_resend_at and correctly fails to match.
create or replace function claim_trade_request_resend(p_request_id uuid, p_guard_ms int)
returns boolean
language plpgsql
as $$
declare
  v_claimed boolean;
begin
  update trade_booking_requests
  set last_resend_at = now()
  where id = p_request_id
    and status = 'sent'
    and (last_resend_at is null or now() - last_resend_at > (p_guard_ms || ' milliseconds')::interval)
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

comment on function claim_trade_request_resend(uuid, int) is
  'Review fix, grouped trade booking round (r20). Atomically claims the right to resend a trade_booking_requests row — returns false (no claim, no state change) if the request is not status=''sent'' or a claim was already made within p_guard_ms. Called from POST /api/trade-requests/[id]/resend BEFORE any email send is attempted, replacing a non-atomic select-then-send check that had a real double-submit race.';

-- ============================================================
-- trade_visits — grouped-booking additions (PART 2). Every line of a
-- grouped request is a REAL trade_visits row (same table the r15
-- single-visit flow already uses) — this is deliberate reuse, not a
-- parallel "line items" table: the existing day-before reminder cron
-- (app/api/trade-reminders/route.ts), "who else is on site" overlap
-- detection, the order-by engine's works-date sources, and My Work's
-- own trade_visits queries all keep working unmodified for a grouped
-- line, because from their point of view it is just an ordinary
-- trade_visits row with a start_date/end_date and a status — see
-- BUILD-SPEC.md's own "existing confirmation email/reminder machinery
-- per visit — day-before reminders unchanged, per visit not per blob"
-- wording for exactly this reasoning.
-- ============================================================
alter table trade_visits
  add column if not exists booking_request_id uuid references trade_booking_requests(id) on delete set null;

-- Trade-proposed alternative dates for a GROUPED line — deliberately
-- separate columns from proposed_start/proposed_end/proposed_note
-- (the r15 single-visit "propose another day" fields just above in
-- 016_trade_visits.sql), even though the shape looks similar: the r15
-- proposed_* trio drives status='proposed_change' inside the r15
-- state machine (unconfirmed/confirmed/tentative/declined/
-- proposed_change) and its own admin resolve-proposal route. This
-- round's suggested_start/suggested_end/response_note instead drive
-- line_status (a NEW, separate, grouped-booking-only state machine —
-- see that column's own comment) and never touch/consult the r15
-- proposed_* columns at all, so a single trade_visits row can never
-- have two different in-flight "trade proposed something" stories
-- colliding on one pair of columns. A grouped line is never both r15-
-- proposed AND grouped-suggested at once in practice (grouped lines
-- are only ever reached via the /trade-request/[token] flow, never
-- the r15 /trade/[token] flow — see lib/trade-booking.ts), but keeping
-- the columns fully separate means that invariant doesn't have to be
-- enforced at the schema level to stay safe.
alter table trade_visits
  add column if not exists suggested_start date;

alter table trade_visits
  add column if not exists suggested_end date;

alter table trade_visits
  add column if not exists response_note text;

-- line_status is NULL for every ordinary (non-grouped) visit — the
-- r15 single-visit flow never sets it, and this column is never
-- consulted by any r15 code path (attention grouping, reminders,
-- overlap detection all key off the existing `status` column only).
-- Only non-null for a line created by/linked to a trade_booking_request:
--   - 'proposed'       — staff proposed this date, awaiting the trade.
--   - 'accepted'        — the trade accepted; `status` is also set to
--                          the existing 'confirmed' value in the same
--                          write (see POST /api/trade-request/[token]/
--                          respond) so every existing status-driven
--                          feature treats it exactly like any other
--                          confirmed visit.
--   - 'date_suggested'  — the trade suggested different dates
--                          (suggested_start/suggested_end/
--                          response_note populated); the board is
--                          NEVER moved automatically on this
--                          transition (BUILD-SPEC.md "Suggestions
--                          never move the board") — a daily_brief_items
--                          attention row is inserted instead, and
--                          staff resolves it explicitly via POST
--                          /api/trade-requests/[id]/lines/[visitId]/resolve.
alter table trade_visits
  add column if not exists line_status text
    check (line_status in ('proposed', 'accepted', 'date_suggested'));

create index if not exists idx_trade_visits_booking_request on trade_visits(booking_request_id);

comment on column trade_visits.booking_request_id is
  'Grouped trade booking round (r20). Nullable + ON DELETE SET NULL, same "optional link, never cascades" discipline as trade_visits.contact_id/board_tasks.visit_id — a request being deleted (never done by any route in this round, but the FK still needs a defined behaviour) must not cascade-delete real scheduling history. Null for every visit booked through the r15 single-visit flow (POST /api/board-tasks/[id]/book-visit, POST /api/projects/[id]/visits) — those never set this column.';
comment on column trade_visits.suggested_start is
  'Grouped trade booking round (r20). Trade-suggested alternative start date for a GROUPED line (line_status=''date_suggested''), set via POST /api/trade-request/[token]/respond''s ''suggest'' action. Distinct from the r15 proposed_start column (016_trade_visits.sql) — see this migration''s own header comment for why these two "trade suggested a different date" stories are deliberately kept on separate columns.';
comment on column trade_visits.suggested_end is
  'Grouped trade booking round (r20). Companion to suggested_start — see that column''s comment.';
comment on column trade_visits.response_note is
  'Grouped trade booking round (r20). Optional free-text note the trade attached to a suggested-date response (POST /api/trade-request/[token]/respond''s ''suggest'' action). Distinct from the r15 proposed_note column and from the internal-only `notes` column.';
comment on column trade_visits.line_status is
  'Grouped trade booking round (r20). Null for every ordinary (non-grouped, r15) visit. proposed|accepted|date_suggested for a line linked to a trade_booking_request (booking_request_id not null) — see this migration''s own header comment for the full state description.';

-- ============================================================
-- email_sends — widen record_type to add 'trade_booking_request'
-- (BUILD-SPEC.md item 3: send the grouped request email via the
-- EXISTING visit-emails machinery — sendOrQueue/email_sends log/
-- 7am-7pm Adelaide window, lib/visit-emails.ts — not a new,
-- parallel send pipeline). record_id points at
-- trade_booking_requests.id (no FK — same polymorphic-reference-by-
-- convention already established for 'lead'/'client_event'/
-- 'client_invoice', see 043_visit_emails.sql's own doc comment).
--
-- Drop + re-add the constraint under its Postgres-default name —
-- matches 029_board_cockpit.sql's and 046_client_invoices.sql's own
-- drop-constraint-if-exists/add-constraint pattern for widening a
-- check in place, idempotent on re-run.
-- ============================================================
alter table email_sends
  drop constraint if exists email_sends_record_type_check;
alter table email_sends
  add constraint email_sends_record_type_check
    check (record_type in ('lead', 'client_event', 'client_invoice', 'trade_booking_request'));

comment on column email_sends.record_type is
  'Polymorphic reference discriminator (no FK — see this column''s original doc comment in 043_visit_emails.sql). lead -> leads.id, client_event -> client_events.id, client_invoice -> client_invoices.id (migration 046), trade_booking_request -> trade_booking_requests.id (migration 049, grouped trade booking round — covers BOTH the initial grouped-request send, template ''trade-booking-request'', and the admin ''keep original + reply'' short reply, template ''trade-booking-reply''; see lib/visit-emails.ts''s TEMPLATE_FILES map).';

notify pgrst, 'reload schema';
