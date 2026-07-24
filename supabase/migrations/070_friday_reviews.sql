-- Friday Review: one weekly meeting record with one review row per active project.
-- Client-worthy updates remain approval-gated: Aria drafts; a human publishes.

create table if not exists friday_reviews (
  id            uuid primary key default gen_random_uuid(),
  week_ending   date not null unique,
  status        text not null default 'draft' check (status in ('draft', 'completed')),
  created_by    uuid references profiles(id) on delete set null,
  completed_by  uuid references profiles(id) on delete set null,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists friday_review_projects (
  id                uuid primary key default gen_random_uuid(),
  review_id         uuid not null references friday_reviews(id) on delete cascade,
  project_id        uuid not null references projects(id) on delete cascade,
  review_status     text not null default 'not_started'
                    check (review_status in ('not_started', 'in_progress', 'complete')),
  this_week         text not null default '',
  next_week         text not null default '',
  blockers          text not null default '',
  client_update     text not null default '',
  action_items      text[] not null default '{}'::text[],
  client_worthy     boolean not null default false,
  no_update         boolean not null default false,
  office_task_ids   uuid[] not null default '{}'::uuid[],
  diary_update_id   uuid references portal_updates(id) on delete set null,
  aria_queue_id     uuid references aria_queue(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (review_id, project_id)
);

create index if not exists idx_friday_review_projects_review
  on friday_review_projects(review_id, review_status);
create index if not exists idx_friday_review_projects_project
  on friday_review_projects(project_id, created_at desc);

drop trigger if exists trg_friday_reviews_updated_at on friday_reviews;
create trigger trg_friday_reviews_updated_at
  before update on friday_reviews
  for each row execute function set_updated_at();

drop trigger if exists trg_friday_review_projects_updated_at on friday_review_projects;
create trigger trg_friday_review_projects_updated_at
  before update on friday_review_projects
  for each row execute function set_updated_at();

alter table friday_reviews enable row level security;
alter table friday_review_projects enable row level security;

drop policy if exists "team_all" on friday_reviews;
create policy "team_all" on friday_reviews
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on friday_review_projects;
create policy "team_all" on friday_review_projects
  for all to authenticated using (true) with check (true);

comment on table friday_reviews is
  'One RESLU Friday project meeting per Adelaide week-ending Friday. Completing a review creates explicitly listed Office actions and queues client-worthy diary copy for Aria; it never publishes client content.';
comment on table friday_review_projects is
  'One active-project card in a Friday Review. Internal notes remain here; only client_update is copied into an approval-gated portal_updates draft when client_worthy is true.';

alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in (
      'price_request','trade_reminder','lead_flag','approval_needed',
      'email_proposal','draft_proposal','daily_review','weekly_review',
      'invoice_candidate','calendar_sync','followup_draft','followup_approved',
      'meeting_transcription','organic_review','diary_draft'
    ));

-- Close the pre-existing diary handoff gap. Drafts with useful notes or
-- attached photos were labelled "awaiting Aria" but never entered her queue.
insert into aria_queue (kind, payload, dedupe_key, source)
select
  'diary_draft',
  jsonb_build_object(
    'project_id', update_row.project_id,
    'post_id', update_row.id,
    'instruction',
    'Use draft_diary_entry in fetch mode, write a concise warm client-facing update from the supplied notes and photo captions, then submit it for human approval. Never publish it.'
  ),
  'diary_draft:' || update_row.id::text,
  'diary-backfill'
from portal_updates update_row
where update_row.status = 'draft'
  and update_row.deleted_at is null
  and (
    nullif(btrim(update_row.body_richtext), '') is not null
    or exists (
      select 1 from portal_update_photos link where link.update_id = update_row.id
    )
  )
on conflict (dedupe_key) do nothing;

notify pgrst, 'reload schema';
