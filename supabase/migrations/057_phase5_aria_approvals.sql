-- ============================================================
-- RESLU Phase 5 — prioritised Aria work + approval-gated follow-ups.
--
-- Adds explicit queue kinds for invoice detection, Google Calendar
-- handoff and the lead follow-up drafting/approval lifecycle. The
-- follow-up table stores a proposed email separately from lead notes;
-- no row can be sent merely by inserting it. A human admin must approve
-- it first, after which Aria receives a distinct followup_approved queue
-- item and records the final send outcome for the audit trail.
-- ============================================================

alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in (
      'price_request','trade_reminder','lead_flag','approval_needed',
      'email_proposal','draft_proposal','daily_review','weekly_review',
      'invoice_candidate','calendar_sync','followup_draft','followup_approved'
    ));

create table if not exists aria_followup_drafts (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  source_queue_id  uuid references aria_queue(id) on delete set null,
  dedupe_key       text unique not null,
  recipient_email  text not null,
  subject          text not null,
  body             text not null,
  context_summary  text,
  status           text not null default 'pending' check
                     (status in ('pending','approved','rejected','sent','failed')),
  created_by       uuid references profiles(id) on delete set null,
  approved_by      uuid references profiles(id) on delete set null,
  approved_at      timestamptz,
  decision_note    text,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_aria_followup_drafts_status_created
  on aria_followup_drafts(status, created_at desc);
create index if not exists idx_aria_followup_drafts_lead
  on aria_followup_drafts(lead_id, created_at desc);

drop trigger if exists trg_aria_followup_drafts_updated_at on aria_followup_drafts;
create trigger trg_aria_followup_drafts_updated_at
  before update on aria_followup_drafts
  for each row execute function set_updated_at();

alter table aria_followup_drafts enable row level security;
drop policy if exists "team_all" on aria_followup_drafts;
create policy "team_all" on aria_followup_drafts
  for all to authenticated using (true) with check (true);

comment on table aria_followup_drafts is
  'Phase 5 approval gate for Aria-prepared lead follow-ups. pending is draft-only; approved means Phillip explicitly approved it for Aria to send; sent/failed are recorded by Aria after the approved queue item is handled. Inserting a draft never sends email.';

comment on column aria_followup_drafts.dedupe_key is
  'Stable business key, normally lead-followup:{lead_id}:{follow_up_date}, preventing repeated daily reviews from creating duplicate approval cards.';

notify pgrst, 'reload schema';
