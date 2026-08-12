-- Stuart: first-class finance agent identity plus service-role-only review data.
-- This migration does not grant payment, payroll, Xero write, journal or bank
-- detail permissions. Stuart receives only the existing conversational agent
-- transport and purpose-built, read-only finance summaries.

alter table conversation_agents
  drop constraint if exists conversation_agents_slug_check;
alter table conversation_agents
  add constraint conversation_agents_slug_check
  check (slug in ('aria', 'marco', 'stuart'));

insert into conversation_agents (slug, display_name, role_label, voice_name, auth_profile_id)
values (
  'stuart',
  'Stuart',
  'Finance and commercial',
  'cedar',
  (select id from profiles where lower(email) = 'accounts@reslu.com.au' limit 1)
)
on conflict (slug) do update set
  display_name = excluded.display_name,
  role_label = excluded.role_label,
  voice_name = excluded.voice_name,
  auth_profile_id = coalesce(conversation_agents.auth_profile_id, excluded.auth_profile_id),
  active = true,
  updated_at = now();

-- The accounts Auth user may be provisioned after this migration. Link it
-- automatically when its normal profile row appears, without granting that
-- profile any broader role.
create or replace function link_stuart_accounts_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(new.email) = 'accounts@reslu.com.au' then
    update conversation_agents
    set auth_profile_id = new.id, updated_at = now()
    where slug = 'stuart';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_link_stuart_accounts_profile on profiles;
create trigger trg_link_stuart_accounts_profile
  after insert or update of email on profiles
  for each row execute function link_stuart_accounts_profile();

-- Installed conversation functions deliberately validated the original two
-- slugs. Preserve their complete, already-verified bodies while widening only
-- the explicit agent allowlist and maximum target count.
do $$
declare
  definition text;
begin
  definition := pg_get_functiondef(
    'create_conversation_idempotent(text,uuid[],text[],uuid)'::regprocedure
  );
  definition := replace(definition,
    'cardinality(coalesce(p_agent_slugs, array[]::text[])) > 2',
    'cardinality(coalesce(p_agent_slugs, array[]::text[])) > 3');
  definition := replace(definition,
    'not in (''aria'', ''marco'')',
    'not in (''aria'', ''marco'', ''stuart'')');
  execute definition;

  definition := pg_get_functiondef(
    'create_conversation_message_idempotent(uuid,text,jsonb,uuid,uuid[],uuid)'::regprocedure
  );
  definition := replace(definition,
    'jsonb_array_length(p_metadata->''target_agent_slugs'') > 2',
    'jsonb_array_length(p_metadata->''target_agent_slugs'') > 3');
  definition := replace(definition,
    'not in (''aria'', ''marco'')',
    'not in (''aria'', ''marco'', ''stuart'')');
  execute definition;

  definition := pg_get_functiondef(
    'add_conversation_group_participants(uuid,uuid[],text[],uuid)'::regprocedure
  );
  definition := replace(definition,
    'cardinality(requested_agent_slugs) > 2',
    'cardinality(requested_agent_slugs) > 3');
  definition := replace(definition,
    'not in (''aria'', ''marco'')',
    'not in (''aria'', ''marco'', ''stuart'')');
  execute definition;
end;
$$;

drop policy if exists "members_send_messages" on conversation_messages;
create policy "members_send_messages" on conversation_messages
  for insert to authenticated
  with check (
    is_conversation_member(conversation_id)
    and author_profile_id = auth.uid()
    and author_agent_id is null
    and kind = 'text'
    and jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 8192
    and case
      when not (metadata ? 'target_agent_slugs') then true
      when jsonb_typeof(metadata->'target_agent_slugs') <> 'array' then false
      when jsonb_array_length(metadata->'target_agent_slugs') > 3 then false
      else not exists (
        select 1
        from jsonb_array_elements(metadata->'target_agent_slugs') target(value)
        where jsonb_typeof(value) <> 'string'
          or value #>> '{}' not in ('aria', 'marco', 'stuart')
      )
    end
    and reply_to_id is null
  );

create table if not exists stuart_review_runs (
  id                 uuid primary key default gen_random_uuid(),
  status             text not null check (status in ('running','completed','failed')),
  triggered_by       uuid references profiles(id) on delete set null,
  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  finding_count      integer not null default 0,
  feedback_count     integer not null default 0,
  error_message      text
);

create table if not exists stuart_finance_findings (
  id                 uuid primary key default gen_random_uuid(),
  finding_key        text not null unique,
  kind               text not null check (kind in (
                       'overdue_receivable','overdue_payable','due_soon_receivable',
                       'due_soon_payable','missing_from_xero','xero_conflict',
                       'unmatched_accounts_email','cost_change','forecast_risk'
                     )),
  severity           text not null check (severity in ('info','warning','urgent')),
  status             text not null default 'open' check (status in ('open','dismissed','resolved')),
  title              text not null,
  detail             text not null,
  source_type        text not null,
  source_id          text,
  evidence           jsonb not null default '{}'::jsonb,
  confidence         text not null check (confidence in ('low','medium','high')),
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_stuart_findings_open
  on stuart_finance_findings(severity, last_seen_at desc)
  where status = 'open';

create table if not exists stuart_aria_feedback (
  id                 uuid primary key default gen_random_uuid(),
  source_email_id    uuid not null unique references emails(id) on delete cascade,
  reason             text not null,
  corrected_route    text not null,
  training_rule      text not null,
  status             text not null default 'pending' check (status in ('pending','delivered','accepted','dismissed')),
  created_at         timestamptz not null default now(),
  delivered_at       timestamptz,
  resolved_at        timestamptz
);

-- Aria already polls this durable queue. This new kind makes Stuart's routing
-- correction actionable through the existing, audited delivery loop.
alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in (
      'price_request','trade_reminder','lead_flag','approval_needed',
      'email_proposal','draft_proposal','daily_review','weekly_review',
      'invoice_candidate','calendar_sync','followup_draft','followup_approved',
      'meeting_transcription','organic_review','diary_draft',
      'email_reply_requested','finance_routing_feedback'
    ));

alter table stuart_review_runs enable row level security;
alter table stuart_finance_findings enable row level security;
alter table stuart_aria_feedback enable row level security;

revoke all on table stuart_review_runs from public, anon, authenticated;
revoke all on table stuart_finance_findings from public, anon, authenticated;
revoke all on table stuart_aria_feedback from public, anon, authenticated;
grant all on table stuart_review_runs to service_role;
grant all on table stuart_finance_findings to service_role;
grant all on table stuart_aria_feedback to service_role;

drop trigger if exists trg_stuart_finance_findings_updated_at on stuart_finance_findings;
create trigger trg_stuart_finance_findings_updated_at
  before update on stuart_finance_findings
  for each row execute function set_updated_at();

comment on table stuart_finance_findings is
  'Service-role-only deterministic exceptions for Stuart. LLM output never creates authoritative financial facts.';
comment on table stuart_aria_feedback is
  'Controlled coaching queue for accounts emails incorrectly forwarded by Aria. Email content cannot directly alter either agent prompt or memory.';

notify pgrst, 'reload schema';
