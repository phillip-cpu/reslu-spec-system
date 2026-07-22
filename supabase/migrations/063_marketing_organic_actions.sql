-- ============================================================
-- Marketing organic action workflow.
--
-- Search Console recommendations remain evidence until a human creates
-- an action. Creating an action links it to Office/My Work. Aria may
-- prepare a draft through an approval-gated queue item, but this table
-- has no publish flag or website-write mechanism: publishing remains a
-- separate human action outside the Spec System.
-- ============================================================

create table if not exists marketing_organic_actions (
  id                    uuid primary key default gen_random_uuid(),
  insight_key           text not null,
  page                  text not null,
  affected_pages        text[] not null default '{}'::text[],
  page_kind             text not null check (page_kind in ('blog','page')),
  title                 text not null,
  reason                text not null,
  recommended_action    text not null,
  predicted_impact      text,
  opportunity_score     integer not null check (opportunity_score between 0 and 100),
  range_from            date not null,
  range_to              date not null,
  comparison_from       date not null,
  comparison_to         date not null,
  baseline              jsonb not null default '{}'::jsonb,
  status                text not null default 'new' check
                          (status in ('new','approved','in_progress','monitoring','complete','dismissed')),
  draft_status          text not null default 'not_requested' check
                          (draft_status in ('not_requested','queued','ready','failed')),
  aria_draft            jsonb,
  aria_queue_id         uuid references aria_queue(id) on delete set null,
  office_task_id        uuid references office_tasks(id) on delete set null,
  recheck_on            date,
  created_by            uuid references profiles(id) on delete set null,
  reviewed_by           uuid references profiles(id) on delete set null,
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (insight_key, range_from, range_to),
  check (range_from <= range_to),
  check (comparison_from <= comparison_to)
);

create index if not exists idx_marketing_organic_actions_status
  on marketing_organic_actions(status, created_at desc);
create index if not exists idx_marketing_organic_actions_recheck
  on marketing_organic_actions(recheck_on)
  where status = 'monitoring';
create index if not exists idx_marketing_organic_actions_office_task
  on marketing_organic_actions(office_task_id);

drop trigger if exists trg_marketing_organic_actions_updated_at on marketing_organic_actions;
create trigger trg_marketing_organic_actions_updated_at
  before update on marketing_organic_actions
  for each row execute function set_updated_at();

alter table marketing_organic_actions enable row level security;
drop policy if exists "team_all" on marketing_organic_actions;
create policy "team_all" on marketing_organic_actions
  for all to authenticated using (true) with check (true);

comment on table marketing_organic_actions is
  'Human-controlled workflow for Search Console opportunities. Action creation produces an Office task. Aria can submit draft recommendations only; no row or route in this workflow can publish website changes.';
comment on column marketing_organic_actions.baseline is
  'Immutable Search Console evidence snapshot captured when Phillip creates the action.';
comment on column marketing_organic_actions.aria_draft is
  'Structured analysis/draft supplied by Aria for human review. It is never applied to the website automatically.';

alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in (
      'price_request','trade_reminder','lead_flag','approval_needed',
      'email_proposal','draft_proposal','daily_review','weekly_review',
      'invoice_candidate','calendar_sync','followup_draft','followup_approved',
      'meeting_transcription','organic_review'
    ));

notify pgrst, 'reload schema';
