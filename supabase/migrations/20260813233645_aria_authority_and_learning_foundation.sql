-- Aria capability restoration: action-level authority, immutable receipts,
-- governed learning candidates, and a real curriculum state machine.
--
-- Aria is operational. R0/R1 work is not blocked by a blanket read-only
-- policy. R2/R3 authority is enforced at the data boundary and bound to the
-- exact effect, not inferred from model prose.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create or replace function private.current_profile_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function private.current_actor_is_aria()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.conversation_agents
    where slug = 'aria'
      and active
      and auth_profile_id = auth.uid()
  );
$$;

revoke all on function private.current_profile_is_admin() from public;
revoke all on function private.current_actor_is_aria() from public;
grant execute on function private.current_profile_is_admin() to authenticated, service_role;
grant execute on function private.current_actor_is_aria() to authenticated, service_role;

create or replace function private.canonical_jsonb_text(value jsonb)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case jsonb_typeof(value)
    when 'object' then '{' || coalesce((
      select string_agg(to_json(key)::text || ':' || private.canonical_jsonb_text(item), ',' order by key)
      from jsonb_each(value) as entry(key, item)
    ), '') || '}'
    when 'array' then '[' || coalesce((
      select string_agg(private.canonical_jsonb_text(item), ',' order by ordinal)
      from jsonb_array_elements(value) with ordinality as entry(item, ordinal)
    ), '') || ']'
    else value::text
  end;
$$;

revoke all on function private.canonical_jsonb_text(jsonb) from public;
grant execute on function private.canonical_jsonb_text(jsonb) to authenticated, service_role;

create table if not exists public.aria_tool_registry (
  tool_name text primary key check (tool_name ~ '^[a-z][a-z0-9_]{1,119}$'),
  owner text not null,
  purpose text not null,
  action_class text not null check (action_class in ('read','prepare','commit','restricted')),
  risk_tier text not null check (risk_tier in ('R0','R1','R2','R3')),
  allowed_agent_slugs text[] not null default array['aria']::text[],
  tenant_scope text not null default 'reslu' check (tenant_scope = 'reslu'),
  approval_rule text not null check (approval_rule in ('none','exact-owner','exact-owner-plus-review','prohibited')),
  verification_kind text not null check (verification_kind in ('none','draft_record','spec_readback','provider_readback','specialised')),
  idempotency_kind text not null check (idempotency_kind in ('none','client-key','natural-key','provider-key','specialised')),
  rollback_kind text not null check (rollback_kind in ('none','delete-draft','restore-version','compensating-action','manual-recovery','specialised')),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (risk_tier = 'R0' and action_class = 'read' and approval_rule = 'none')
    or (risk_tier = 'R1' and action_class = 'prepare' and approval_rule = 'none')
    or (risk_tier = 'R2' and action_class = 'commit' and approval_rule = 'exact-owner')
    or (risk_tier = 'R3' and action_class = 'restricted' and approval_rule in ('exact-owner-plus-review','prohibited'))
  )
);

drop trigger if exists trg_aria_tool_registry_updated_at on public.aria_tool_registry;
create trigger trg_aria_tool_registry_updated_at
  before update on public.aria_tool_registry
  for each row execute function public.set_updated_at();

create table if not exists public.aria_approval_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'reslu' check (tenant_id = 'reslu'),
  tool_name text not null references public.aria_tool_registry(tool_name),
  target_type text not null check (char_length(target_type) between 1 and 80),
  target_id text not null check (char_length(target_id) between 1 and 240),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  expected_version text,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  approval_scope text not null check (char_length(approval_scope) between 1 and 500),
  approval_source text not null check (approval_source in ('task_artifact','effect_preview','standing_policy_exception')),
  approved_by uuid not null references public.profiles(id) on delete restrict,
  source_task_id uuid references public.agent_tasks(id) on delete restrict,
  source_artifact_id uuid references public.agent_task_artifacts(id) on delete restrict,
  domain_review_ref text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  check (expires_at > issued_at),
  check ((source_task_id is null) = (source_artifact_id is null)),
  check (domain_review_ref is null or char_length(domain_review_ref) between 1 and 500)
);

create index if not exists aria_approval_receipts_lookup_idx
  on public.aria_approval_receipts(tool_name, target_id, payload_sha256, expires_at)
  where revoked_at is null;

create table if not exists public.aria_action_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'reslu' check (tenant_id = 'reslu'),
  tool_name text not null references public.aria_tool_registry(tool_name),
  risk_tier text not null check (risk_tier in ('R1','R2','R3')),
  target_type text not null check (char_length(target_type) between 1 and 80),
  target_id text not null check (char_length(target_id) between 1 and 240),
  request_id text not null check (char_length(request_id) between 1 and 240),
  correlation_id text not null check (char_length(correlation_id) between 1 and 240),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  expected_version text,
  expected_absent boolean not null default false,
  approval_receipt_id uuid references public.aria_approval_receipts(id) on delete restrict,
  authorization_kind text not null check (authorization_kind in ('request','exact-approval','standing-policy')),
  state text not null default 'authorized' check (state in ('authorized','executing','verifying','verified','partial','blocked','failed')),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  failure_code text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  unique (tenant_id, tool_name, idempotency_key),
  check (not (expected_absent and expected_version is not null))
);

create index if not exists aria_action_runs_correlation_idx
  on public.aria_action_runs(correlation_id, started_at desc);

create table if not exists public.aria_action_receipts (
  id uuid primary key default gen_random_uuid(),
  action_run_id uuid not null unique references public.aria_action_runs(id) on delete restrict,
  outcome text not null check (outcome in ('verified','partial','blocked','failed')),
  receipt_ref text,
  result_sha256 text check (result_sha256 is null or result_sha256 ~ '^[a-f0-9]{64}$'),
  resulting_version text,
  verification_kind text not null check (verification_kind in ('none','draft_record','spec_readback','provider_readback','specialised')),
  verification_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(verification_evidence) = 'object'),
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  check (outcome <> 'verified' or (receipt_ref is not null and result_sha256 is not null and verification_kind <> 'none'))
);

alter table public.agent_tasks
  add column if not exists approval_receipt_id uuid
  references public.aria_approval_receipts(id) on delete restrict;

create or replace function private.block_immutable_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% records are immutable', tg_table_name;
end;
$$;

drop trigger if exists trg_aria_approval_receipts_immutable on public.aria_approval_receipts;
create trigger trg_aria_approval_receipts_immutable
  before update or delete on public.aria_approval_receipts
  for each row execute function private.block_immutable_change();

drop trigger if exists trg_aria_action_receipts_immutable on public.aria_action_receipts;
create trigger trg_aria_action_receipts_immutable
  before update or delete on public.aria_action_receipts
  for each row execute function private.block_immutable_change();

alter table public.aria_tool_registry enable row level security;
alter table public.aria_approval_receipts enable row level security;
alter table public.aria_action_runs enable row level security;
alter table public.aria_action_receipts enable row level security;

revoke all on public.aria_tool_registry, public.aria_approval_receipts,
  public.aria_action_runs, public.aria_action_receipts from public, anon, authenticated;
grant select on public.aria_tool_registry to authenticated;

create policy aria_tool_registry_read on public.aria_tool_registry
  for select to authenticated using (active);
create policy aria_approval_receipts_audit_read on public.aria_approval_receipts
  for select to authenticated using (private.current_profile_is_admin() or approved_by = auth.uid());
create policy aria_action_runs_audit_read on public.aria_action_runs
  for select to authenticated using (private.current_profile_is_admin() or actor_profile_id = auth.uid());
create policy aria_action_receipts_audit_read on public.aria_action_receipts
  for select to authenticated using (
    private.current_profile_is_admin()
    or exists (
      select 1 from public.aria_action_runs run
      where run.id = action_run_id and run.actor_profile_id = auth.uid()
    )
  );

create or replace function public.issue_aria_approval_receipt(
  p_tool_name text,
  p_target_type text,
  p_target_id text,
  p_payload_sha256 text,
  p_expected_version text,
  p_idempotency_key text,
  p_approval_scope text,
  p_expires_at timestamptz,
  p_domain_review_ref text default null
)
returns public.aria_approval_receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  policy public.aria_tool_registry;
  receipt public.aria_approval_receipts;
begin
  if auth.uid() is null or not private.current_profile_is_admin() then
    raise exception 'administrator approval required';
  end if;
  select * into policy from public.aria_tool_registry
  where tool_name = p_tool_name and active for share;
  if policy.tool_name is null or policy.risk_tier not in ('R2','R3') then
    raise exception 'tool does not accept an approval receipt';
  end if;
  if p_payload_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'invalid payload digest'; end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '24 hours' then
    raise exception 'approval expiry must be within 24 hours';
  end if;
  if policy.risk_tier = 'R3' and policy.approval_rule = 'exact-owner-plus-review'
    and nullif(btrim(coalesce(p_domain_review_ref, '')), '') is null then
    raise exception 'domain or security review receipt required';
  end if;
  insert into public.aria_approval_receipts (
    tool_name, target_type, target_id, payload_sha256, expected_version,
    idempotency_key, approval_scope, approval_source, approved_by,
    expires_at, domain_review_ref
  ) values (
    p_tool_name, btrim(p_target_type), btrim(p_target_id), p_payload_sha256,
    nullif(btrim(coalesce(p_expected_version, '')), ''), btrim(p_idempotency_key),
    btrim(p_approval_scope), 'effect_preview', auth.uid(), p_expires_at,
    nullif(btrim(coalesce(p_domain_review_ref, '')), '')
  ) returning * into receipt;
  return receipt;
end;
$$;

create or replace function public.begin_aria_action(
  p_tool_name text,
  p_target_type text,
  p_target_id text,
  p_request_id text,
  p_correlation_id text,
  p_idempotency_key text,
  p_payload_sha256 text,
  p_expected_version text default null,
  p_expected_absent boolean default false,
  p_approval_receipt_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.aria_action_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  policy public.aria_tool_registry;
  approval public.aria_approval_receipts;
  existing public.aria_action_runs;
  result public.aria_action_runs;
  auth_kind text;
begin
  if auth.uid() is null or (auth.role() <> 'service_role' and not private.current_actor_is_aria()) then
    raise exception 'active Aria identity required';
  end if;
  select * into policy from public.aria_tool_registry
  where tool_name = p_tool_name and active for share;
  if policy.tool_name is null then raise exception 'tool is not registered for Aria'; end if;
  if policy.risk_tier = 'R0' then raise exception 'read-only actions do not create mutation runs'; end if;
  if p_payload_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'invalid payload digest'; end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then raise exception 'metadata must be an object'; end if;

  perform pg_advisory_xact_lock(hashtextextended('aria:' || p_tool_name || ':' || p_idempotency_key, 0));
  select * into existing from public.aria_action_runs
  where tenant_id = 'reslu' and tool_name = p_tool_name and idempotency_key = p_idempotency_key;
  if existing.id is not null then
    if existing.target_type <> p_target_type or existing.target_id <> p_target_id
      or existing.payload_sha256 <> p_payload_sha256
      or existing.expected_version is distinct from nullif(btrim(coalesce(p_expected_version, '')), '')
      or existing.expected_absent <> coalesce(p_expected_absent, false) then
      raise exception 'idempotency key conflict';
    end if;
    existing.metadata := existing.metadata || jsonb_build_object('authorization_replay', true);
    return existing;
  end if;

  if policy.risk_tier = 'R1' then
    auth_kind := 'request';
  elsif policy.approval_rule = 'prohibited' then
    raise exception 'action is prohibited and cannot be approved';
  else
    select * into approval from public.aria_approval_receipts
    where id = p_approval_receipt_id for share;
    if approval.id is null or approval.revoked_at is not null or approval.expires_at <= now()
      or approval.tenant_id <> 'reslu' or approval.tool_name <> p_tool_name
      or approval.target_type <> p_target_type or approval.target_id <> p_target_id
      or approval.payload_sha256 <> p_payload_sha256
      or approval.expected_version is distinct from nullif(btrim(coalesce(p_expected_version, '')), '')
      or approval.idempotency_key <> p_idempotency_key then
      raise exception 'missing, expired, or mismatched exact approval receipt';
    end if;
    if policy.risk_tier = 'R3' and policy.approval_rule = 'exact-owner-plus-review'
      and approval.domain_review_ref is null then
      raise exception 'required domain or security review is missing';
    end if;
    auth_kind := 'exact-approval';
  end if;

  insert into public.aria_action_runs (
    tool_name, risk_tier, target_type, target_id, request_id, correlation_id,
    idempotency_key, payload_sha256, expected_version, expected_absent,
    approval_receipt_id, authorization_kind, actor_profile_id, state, metadata
  ) values (
    p_tool_name, policy.risk_tier, btrim(p_target_type), btrim(p_target_id),
    btrim(p_request_id), btrim(p_correlation_id), btrim(p_idempotency_key),
    p_payload_sha256, nullif(btrim(coalesce(p_expected_version, '')), ''),
    coalesce(p_expected_absent, false), p_approval_receipt_id, auth_kind,
    auth.uid(), 'executing', coalesce(p_metadata, '{}'::jsonb)
  ) returning * into result;
  return result;
end;
$$;

create or replace function public.finish_aria_action(
  p_action_run_id uuid,
  p_outcome text,
  p_receipt_ref text,
  p_result_sha256 text,
  p_resulting_version text,
  p_verification_kind text,
  p_verification_evidence jsonb default '{}'::jsonb,
  p_failure_code text default null
)
returns public.aria_action_receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run public.aria_action_runs;
  policy public.aria_tool_registry;
  receipt public.aria_action_receipts;
begin
  if auth.uid() is null or (auth.role() <> 'service_role' and not private.current_actor_is_aria()) then
    raise exception 'active Aria identity required';
  end if;
  if p_outcome not in ('verified','partial','blocked','failed') then raise exception 'invalid outcome'; end if;
  select * into run from public.aria_action_runs where id = p_action_run_id for update;
  if run.id is null or (auth.role() <> 'service_role' and run.actor_profile_id <> auth.uid()) then
    raise exception 'action run not found';
  end if;
  if run.state not in ('authorized','executing','verifying') then raise exception 'action run already terminal'; end if;
  select * into policy from public.aria_tool_registry where tool_name = run.tool_name;
  if p_outcome = 'verified' and p_verification_kind <> policy.verification_kind then
    raise exception 'verification kind does not match tool registry';
  end if;
  insert into public.aria_action_receipts (
    action_run_id, outcome, receipt_ref, result_sha256, resulting_version,
    verification_kind, verification_evidence, recorded_by
  ) values (
    run.id, p_outcome, nullif(btrim(coalesce(p_receipt_ref, '')), ''),
    nullif(btrim(coalesce(p_result_sha256, '')), ''),
    nullif(btrim(coalesce(p_resulting_version, '')), ''), p_verification_kind,
    coalesce(p_verification_evidence, '{}'::jsonb), auth.uid()
  ) returning * into receipt;
  update public.aria_action_runs
  set state = p_outcome, finished_at = now(), failure_code = nullif(btrim(coalesce(p_failure_code, '')), '')
  where id = run.id;
  return receipt;
end;
$$;

revoke all on function public.issue_aria_approval_receipt(text,text,text,text,text,text,text,timestamptz,text) from public, anon;
revoke all on function public.begin_aria_action(text,text,text,text,text,text,text,text,boolean,uuid,jsonb) from public, anon;
revoke all on function public.finish_aria_action(uuid,text,text,text,text,text,jsonb,text) from public, anon;
grant execute on function public.issue_aria_approval_receipt(text,text,text,text,text,text,text,timestamptz,text) to authenticated;
grant execute on function public.begin_aria_action(text,text,text,text,text,text,text,text,boolean,uuid,jsonb) to authenticated, service_role;
grant execute on function public.finish_aria_action(uuid,text,text,text,text,text,jsonb,text) to authenticated, service_role;

-- Replace the legacy task approval function so a visible structured effect
-- preview can mint one exact, expiring R2/R3 receipt. Plain text/draft
-- approvals keep their existing behaviour but do not magically grant tool
-- authority.
create or replace function public.decide_agent_task_artifact(
  p_conversation_id uuid,
  p_task_id uuid,
  p_artifact_id uuid,
  p_approved boolean,
  p_note text default null
)
returns public.agent_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.agent_tasks;
  artifact public.agent_task_artifacts;
  authority_request jsonb;
  tool_policy public.aria_tool_registry;
  receipt public.aria_approval_receipts;
  computed_payload_sha text;
  requested_expiry timestamptz;
begin
  if auth.uid() is null or not public.is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  if p_note is not null and char_length(p_note) > 2000 then raise exception 'approval note is too long'; end if;
  select * into artifact from public.agent_task_artifacts
  where id = p_artifact_id and task_id = p_task_id and status = 'draft'
  for update;
  if artifact.id is null then raise exception 'draft artifact not found'; end if;

  if p_approved and artifact.content ? 'authority_request' then
    authority_request := artifact.content->'authority_request';
    if jsonb_typeof(authority_request) <> 'object'
      or jsonb_typeof(authority_request->'tool_args') <> 'object' then
      raise exception 'authority request must contain exact tool_args';
    end if;
    select * into tool_policy from public.aria_tool_registry
    where tool_name = authority_request->>'tool_name' and active for share;
    if tool_policy.tool_name is null or tool_policy.risk_tier not in ('R2','R3')
      or tool_policy.approval_rule = 'prohibited' then
      raise exception 'artifact does not describe an approvable consequential tool';
    end if;
    if tool_policy.risk_tier = 'R3'
      and nullif(btrim(coalesce(authority_request->>'domain_review_ref','')), '') is null then
      raise exception 'R3 artifact requires a domain or security review receipt';
    end if;
    computed_payload_sha := encode(digest(
      convert_to(private.canonical_jsonb_text(authority_request->'tool_args'), 'UTF8'),
      'sha256'
    ), 'hex');
    requested_expiry := coalesce(
      nullif(authority_request->>'expires_at','')::timestamptz,
      now() + interval '30 minutes'
    );
    if requested_expiry <= now() or requested_expiry > now() + interval '24 hours' then
      raise exception 'authority request expiry must be within 24 hours';
    end if;
    insert into public.aria_approval_receipts (
      tool_name, target_type, target_id, payload_sha256, expected_version,
      idempotency_key, approval_scope, approval_source, approved_by,
      source_task_id, source_artifact_id, domain_review_ref, expires_at
    ) values (
      tool_policy.tool_name,
      btrim(authority_request->>'target_type'),
      btrim(authority_request->>'target_id'),
      computed_payload_sha,
      nullif(btrim(coalesce(authority_request->>'expected_version','')), ''),
      btrim(authority_request->>'idempotency_key'),
      btrim(authority_request->>'approval_scope'),
      'task_artifact',
      auth.uid(),
      p_task_id,
      p_artifact_id,
      nullif(btrim(coalesce(authority_request->>'domain_review_ref','')), ''),
      requested_expiry
    ) returning * into receipt;
  end if;

  update public.agent_task_artifacts
  set status = case when p_approved then 'approved' else 'rejected' end
  where id = p_artifact_id and task_id = p_task_id;

  update public.agent_tasks task
  set
    approval_state = case when p_approved then 'approved' else 'rejected' end,
    approval_note = nullif(btrim(coalesce(p_note, '')), ''),
    approval_receipt_id = receipt.id,
    status = case when p_approved then 'queued' else 'cancelled' end,
    completed_at = case when p_approved then null else now() end
  where task.id = p_task_id
    and task.conversation_id = p_conversation_id
    and task.status = 'awaiting_approval'
  returning * into result;

  if result.id is null then raise exception 'task is not awaiting approval'; end if;
  insert into public.agent_task_events(task_id, event_type, label, detail, metadata)
  values (
    result.id,
    case when p_approved then 'approved' else 'rejected' end,
    case when p_approved then 'Draft approved' else 'Draft rejected' end,
    result.approval_note,
    jsonb_build_object('approval_receipt_id', receipt.id, 'artifact_sha256', computed_payload_sha)
  );
  return result;
end;
$$;

revoke all on function public.decide_agent_task_artifact(uuid,uuid,uuid,boolean,text) from public, anon;
grant execute on function public.decide_agent_task_artifact(uuid,uuid,uuid,boolean,text) to authenticated;

-- Governed learning lifecycle. Aria can capture, research, evaluate, request
-- review, stage an exactly approved candidate, and monitor. She cannot approve
-- or promote herself.
create table if not exists public.aria_learning_candidates (
  id uuid primary key default gen_random_uuid(),
  candidate_key text not null unique check (candidate_key ~ '^learn-[0-9]{8}-[a-z0-9-]{3,100}$'),
  tenant_id text not null default 'reslu' check (tenant_id = 'reslu'),
  state text not null default 'captured' check (state in (
    'captured','researching','evidence_ready','evaluated','review_requested',
    'approved','staged','released','monitoring','rejected','superseded','expired'
  )),
  question text not null check (char_length(question) between 1 and 2000),
  trigger_type text not null check (trigger_type in ('correction','failure','expiry','conflict','new_obligation','opportunity','source_change')),
  trigger_summary text not null check (char_length(trigger_summary) between 1 and 4000),
  affected_assets text[] not null default '{}',
  proposed_change_summary text not null check (char_length(proposed_change_summary) between 1 and 4000),
  proposed_version text not null check (char_length(proposed_version) between 1 and 200),
  artifact_ref text not null check (char_length(artifact_ref) between 1 and 1000),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  risk_tier text not null check (risk_tier in ('R1','R2','R3')),
  owner_profile_id uuid references public.profiles(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  review_by timestamptz not null,
  expires_at timestamptz not null,
  rollback_plan text not null check (char_length(rollback_plan) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (review_by > created_at),
  check (expires_at > created_at)
);

create table if not exists public.aria_learning_sources (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.aria_learning_candidates(id) on delete cascade,
  source_key text not null,
  canonical_ref text not null,
  publisher text not null,
  title text not null,
  authority_tier text not null check (authority_tier in ('T0','T1','T2','T3','T4')),
  jurisdiction text,
  tenant_id text not null default 'reslu' check (tenant_id = 'reslu'),
  sensitivity text not null check (sensitivity in ('public','internal','confidential','restricted')),
  purpose text not null,
  rights_or_licence text not null,
  issued_at timestamptz,
  effective_at timestamptz,
  fetched_at timestamptz not null,
  review_by timestamptz not null,
  revision_or_sha256 text not null,
  parser_version text,
  status text not null check (status in ('candidate','active','superseded','disputed','expired','withdrawn')),
  created_at timestamptz not null default now(),
  unique (candidate_id, source_key),
  check (review_by > fetched_at)
);

create table if not exists public.aria_learning_evals (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.aria_learning_candidates(id) on delete restrict,
  run_id text not null,
  suite_id text not null,
  artifact_ref text not null,
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_artifact_sha256 text not null check (candidate_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  hard_gates_passed boolean not null,
  critical_regressions integer not null default 0 check (critical_regressions >= 0),
  human_review_status text not null check (human_review_status in ('not_required','pending','passed','failed')),
  trajectory_status text not null check (trajectory_status in ('not_required','pending','passed','failed')),
  completed_at timestamptz not null,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (candidate_id, run_id)
);

create table if not exists public.aria_learning_reviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.aria_learning_candidates(id) on delete restrict,
  decision text not null check (decision in ('approved','rejected')),
  bound_artifact_sha256 text not null check (bound_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  scope text not null,
  decided_by uuid not null references public.profiles(id) on delete restrict,
  decided_at timestamptz not null default now(),
  expires_at timestamptz not null,
  note text,
  unique (candidate_id, bound_artifact_sha256),
  check (expires_at > decided_at)
);

create table if not exists public.aria_learning_releases (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.aria_learning_candidates(id) on delete restrict,
  release_version text not null,
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  previous_version text not null,
  previous_artifact_sha256 text not null check (previous_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  deployment_receipt_ref text not null,
  monitoring_plan jsonb not null check (jsonb_typeof(monitoring_plan) = 'object'),
  released_by uuid not null references public.profiles(id) on delete restrict,
  released_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (candidate_id, release_version)
);

create table if not exists public.aria_learning_monitors (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.aria_learning_candidates(id) on delete restrict,
  release_id uuid not null references public.aria_learning_releases(id) on delete restrict,
  metric_key text not null,
  metric_value jsonb not null,
  status text not null check (status in ('healthy','watch','rollback_recommended','rolled_back')),
  evidence_ref text not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (release_id, metric_key, observed_at)
);

create table if not exists public.aria_learning_modules (
  module_key text primary key,
  week_start integer not null check (week_start between 1 and 12),
  week_end integer not null check (week_end between week_start and 12),
  title text not null,
  competency text not null,
  pass_threshold numeric(5,2) not null check (pass_threshold between 0 and 100),
  human_reviewer_role text not null,
  active boolean not null default true
);

create table if not exists public.aria_learning_enrolments (
  id uuid primary key default gen_random_uuid(),
  module_key text not null references public.aria_learning_modules(module_key),
  state text not null default 'planned' check (state in ('planned','in_progress','review','passed','failed','deferred')),
  started_at timestamptz,
  review_due_at timestamptz not null,
  reviewer_profile_id uuid references public.profiles(id) on delete restrict,
  score numeric(5,2) check (score between 0 and 100),
  evidence_ref text,
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (module_key)
);

drop trigger if exists trg_aria_learning_candidates_updated_at on public.aria_learning_candidates;
create trigger trg_aria_learning_candidates_updated_at before update on public.aria_learning_candidates
  for each row execute function public.set_updated_at();
drop trigger if exists trg_aria_learning_enrolments_updated_at on public.aria_learning_enrolments;
create trigger trg_aria_learning_enrolments_updated_at before update on public.aria_learning_enrolments
  for each row execute function public.set_updated_at();

drop trigger if exists trg_aria_learning_evals_immutable on public.aria_learning_evals;
create trigger trg_aria_learning_evals_immutable before update or delete on public.aria_learning_evals
  for each row execute function private.block_immutable_change();
drop trigger if exists trg_aria_learning_reviews_immutable on public.aria_learning_reviews;
create trigger trg_aria_learning_reviews_immutable before update or delete on public.aria_learning_reviews
  for each row execute function private.block_immutable_change();
drop trigger if exists trg_aria_learning_releases_immutable on public.aria_learning_releases;
create trigger trg_aria_learning_releases_immutable before update or delete on public.aria_learning_releases
  for each row execute function private.block_immutable_change();
drop trigger if exists trg_aria_learning_monitors_immutable on public.aria_learning_monitors;
create trigger trg_aria_learning_monitors_immutable before update or delete on public.aria_learning_monitors
  for each row execute function private.block_immutable_change();

alter table public.aria_learning_candidates enable row level security;
alter table public.aria_learning_sources enable row level security;
alter table public.aria_learning_evals enable row level security;
alter table public.aria_learning_reviews enable row level security;
alter table public.aria_learning_releases enable row level security;
alter table public.aria_learning_monitors enable row level security;
alter table public.aria_learning_modules enable row level security;
alter table public.aria_learning_enrolments enable row level security;

revoke all on public.aria_learning_candidates, public.aria_learning_sources,
  public.aria_learning_evals, public.aria_learning_reviews,
  public.aria_learning_releases, public.aria_learning_modules,
  public.aria_learning_enrolments, public.aria_learning_monitors from public, anon, authenticated;
grant select on public.aria_learning_candidates, public.aria_learning_sources,
  public.aria_learning_evals, public.aria_learning_reviews,
  public.aria_learning_releases, public.aria_learning_modules,
  public.aria_learning_enrolments, public.aria_learning_monitors to authenticated;

create policy aria_learning_candidates_read on public.aria_learning_candidates
  for select to authenticated using (private.current_profile_is_admin() or private.current_actor_is_aria());
create policy aria_learning_sources_read on public.aria_learning_sources
  for select to authenticated using (private.current_profile_is_admin() or private.current_actor_is_aria());
create policy aria_learning_evals_read on public.aria_learning_evals
  for select to authenticated using (private.current_profile_is_admin() or private.current_actor_is_aria());
create policy aria_learning_reviews_read on public.aria_learning_reviews
  for select to authenticated using (private.current_profile_is_admin() or private.current_actor_is_aria());
create policy aria_learning_releases_read on public.aria_learning_releases
  for select to authenticated using (private.current_profile_is_admin() or private.current_actor_is_aria());
create policy aria_learning_monitors_read on public.aria_learning_monitors
  for select to authenticated using (private.current_profile_is_admin() or private.current_actor_is_aria());
create policy aria_learning_modules_read on public.aria_learning_modules
  for select to authenticated using (true);
create policy aria_learning_enrolments_read on public.aria_learning_enrolments
  for select to authenticated using (private.current_profile_is_admin() or private.current_actor_is_aria());

create or replace function public.create_aria_learning_candidate(
  p_candidate_key text,
  p_question text,
  p_trigger_type text,
  p_trigger_summary text,
  p_affected_assets text[],
  p_proposed_change_summary text,
  p_proposed_version text,
  p_artifact_ref text,
  p_artifact_sha256 text,
  p_risk_tier text,
  p_owner_profile_id uuid,
  p_review_by timestamptz,
  p_expires_at timestamptz,
  p_rollback_plan text
)
returns public.aria_learning_candidates
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result public.aria_learning_candidates;
begin
  if auth.uid() is null or (auth.role() <> 'service_role' and not private.current_actor_is_aria()) then
    raise exception 'active Aria identity required';
  end if;
  insert into public.aria_learning_candidates (
    candidate_key, question, trigger_type, trigger_summary, affected_assets,
    proposed_change_summary, proposed_version, artifact_ref, artifact_sha256,
    risk_tier, owner_profile_id, created_by, review_by, expires_at, rollback_plan
  ) values (
    p_candidate_key, btrim(p_question), p_trigger_type, btrim(p_trigger_summary),
    coalesce(p_affected_assets, '{}'), btrim(p_proposed_change_summary),
    btrim(p_proposed_version), btrim(p_artifact_ref), p_artifact_sha256,
    p_risk_tier, p_owner_profile_id, auth.uid(), p_review_by, p_expires_at,
    btrim(p_rollback_plan)
  ) returning * into result;
  return result;
end;
$$;

create or replace function public.add_aria_learning_source(
  p_candidate_id uuid,
  p_source jsonb
)
returns public.aria_learning_sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare candidate public.aria_learning_candidates; result public.aria_learning_sources;
begin
  if auth.uid() is null or (auth.role() <> 'service_role' and not private.current_actor_is_aria()) then
    raise exception 'active Aria identity required';
  end if;
  select * into candidate from public.aria_learning_candidates where id = p_candidate_id for update;
  if candidate.id is null or candidate.state not in ('captured','researching','evidence_ready') then
    raise exception 'candidate cannot accept sources in its current state';
  end if;
  insert into public.aria_learning_sources (
    candidate_id, source_key, canonical_ref, publisher, title, authority_tier,
    jurisdiction, sensitivity, purpose, rights_or_licence, issued_at,
    effective_at, fetched_at, review_by, revision_or_sha256, parser_version, status
  ) values (
    p_candidate_id, p_source->>'source_key', p_source->>'canonical_ref',
    p_source->>'publisher', p_source->>'title', p_source->>'authority_tier',
    nullif(p_source->>'jurisdiction',''), p_source->>'sensitivity',
    p_source->>'purpose', p_source->>'rights_or_licence',
    nullif(p_source->>'issued_at','')::timestamptz,
    nullif(p_source->>'effective_at','')::timestamptz,
    (p_source->>'fetched_at')::timestamptz, (p_source->>'review_by')::timestamptz,
    p_source->>'revision_or_sha256', nullif(p_source->>'parser_version',''),
    p_source->>'status'
  ) returning * into result;
  update public.aria_learning_candidates set state = 'researching' where id = p_candidate_id and state = 'captured';
  return result;
end;
$$;

create or replace function public.record_aria_learning_eval(
  p_candidate_id uuid,
  p_run_id text,
  p_suite_id text,
  p_artifact_ref text,
  p_artifact_sha256 text,
  p_candidate_artifact_sha256 text,
  p_hard_gates_passed boolean,
  p_critical_regressions integer,
  p_human_review_status text,
  p_trajectory_status text,
  p_completed_at timestamptz
)
returns public.aria_learning_evals
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare candidate public.aria_learning_candidates; result public.aria_learning_evals;
begin
  if auth.uid() is null or (auth.role() <> 'service_role' and not private.current_actor_is_aria()) then
    raise exception 'active Aria identity required';
  end if;
  select * into candidate from public.aria_learning_candidates where id = p_candidate_id for update;
  if candidate.id is null or candidate.state not in ('researching','evidence_ready','evaluated') then
    raise exception 'candidate is not ready for evaluation';
  end if;
  if candidate.artifact_sha256 <> p_candidate_artifact_sha256 then
    raise exception 'evaluation does not bind to current candidate artifact';
  end if;
  insert into public.aria_learning_evals (
    candidate_id, run_id, suite_id, artifact_ref, artifact_sha256,
    candidate_artifact_sha256, hard_gates_passed, critical_regressions,
    human_review_status, trajectory_status, completed_at, recorded_by
  ) values (
    p_candidate_id, p_run_id, p_suite_id, p_artifact_ref, p_artifact_sha256,
    p_candidate_artifact_sha256, p_hard_gates_passed, p_critical_regressions,
    p_human_review_status, p_trajectory_status, p_completed_at, auth.uid()
  ) returning * into result;
  update public.aria_learning_candidates set state = 'evaluated' where id = p_candidate_id;
  return result;
end;
$$;

create or replace function public.request_aria_learning_review(p_candidate_id uuid)
returns public.aria_learning_candidates
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare candidate public.aria_learning_candidates;
begin
  if auth.uid() is null or (auth.role() <> 'service_role' and not private.current_actor_is_aria()) then
    raise exception 'active Aria identity required';
  end if;
  select * into candidate from public.aria_learning_candidates where id = p_candidate_id for update;
  if candidate.id is null or candidate.state <> 'evaluated' then raise exception 'candidate is not evaluated'; end if;
  if candidate.owner_profile_id is null then raise exception 'accountable owner is unassigned'; end if;
  if not exists (
    select 1 from public.aria_learning_evals eval
    where eval.candidate_id = candidate.id
      and eval.candidate_artifact_sha256 = candidate.artifact_sha256
      and eval.hard_gates_passed and eval.critical_regressions = 0
  ) then raise exception 'no passing immutable eval for current artifact'; end if;
  update public.aria_learning_candidates set state = 'review_requested'
  where id = candidate.id returning * into candidate;
  return candidate;
end;
$$;

create or replace function public.decide_aria_learning_candidate(
  p_candidate_id uuid,
  p_approved boolean,
  p_scope text,
  p_expires_at timestamptz,
  p_note text default null
)
returns public.aria_learning_candidates
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare candidate public.aria_learning_candidates; decision_text text;
begin
  if auth.uid() is null or not private.current_profile_is_admin() then
    raise exception 'administrator review required';
  end if;
  select * into candidate from public.aria_learning_candidates where id = p_candidate_id for update;
  if candidate.id is null or candidate.state <> 'review_requested' then raise exception 'candidate is not awaiting review'; end if;
  if candidate.owner_profile_id <> auth.uid() then raise exception 'assigned accountable owner must decide'; end if;
  if p_expires_at <= now() or p_expires_at > least(candidate.expires_at, now() + interval '30 days') then
    raise exception 'review receipt expiry is invalid';
  end if;
  decision_text := case when p_approved then 'approved' else 'rejected' end;
  insert into public.aria_learning_reviews (
    candidate_id, decision, bound_artifact_sha256, scope, decided_by, expires_at, note
  ) values (
    candidate.id, decision_text, candidate.artifact_sha256, btrim(p_scope), auth.uid(), p_expires_at,
    nullif(btrim(coalesce(p_note,'')),'')
  );
  update public.aria_learning_candidates set state = decision_text
  where id = candidate.id returning * into candidate;
  return candidate;
end;
$$;

create or replace function public.stage_aria_learning_candidate(p_candidate_id uuid)
returns public.aria_learning_candidates
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare candidate public.aria_learning_candidates;
begin
  if auth.uid() is null or (auth.role() <> 'service_role' and not private.current_actor_is_aria()) then
    raise exception 'active Aria identity required';
  end if;
  select * into candidate from public.aria_learning_candidates where id = p_candidate_id for update;
  if candidate.id is null or candidate.state <> 'approved' then raise exception 'candidate is not approved'; end if;
  if candidate.review_by <= now() or candidate.expires_at <= now() then raise exception 'candidate is stale'; end if;
  if not exists (
    select 1 from public.aria_learning_reviews review
    where review.candidate_id = candidate.id and review.decision = 'approved'
      and review.bound_artifact_sha256 = candidate.artifact_sha256 and review.expires_at > now()
  ) then raise exception 'current authenticated approval receipt missing'; end if;
  if exists (
    select 1 from public.aria_learning_sources source
    where source.candidate_id = candidate.id
      and (source.authority_tier = 'T4' or source.status <> 'active' or source.review_by <= now())
  ) or not exists (select 1 from public.aria_learning_sources source where source.candidate_id = candidate.id) then
    raise exception 'sources are missing, stale, disputed, or discovery-only';
  end if;
  update public.aria_learning_candidates set state = 'staged'
  where id = candidate.id returning * into candidate;
  return candidate;
end;
$$;

create or replace function public.release_aria_learning_candidate(
  p_candidate_id uuid,
  p_release_version text,
  p_previous_version text,
  p_previous_artifact_sha256 text,
  p_deployment_receipt_ref text,
  p_monitoring_plan jsonb
)
returns public.aria_learning_releases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare candidate public.aria_learning_candidates; result public.aria_learning_releases;
begin
  if auth.uid() is null or not private.current_profile_is_admin() then
    raise exception 'accountable release operator required';
  end if;
  select * into candidate from public.aria_learning_candidates where id = p_candidate_id for update;
  if candidate.id is null or candidate.state <> 'staged' then raise exception 'candidate is not staged'; end if;
  if candidate.owner_profile_id <> auth.uid() then raise exception 'assigned accountable owner must release'; end if;
  if candidate.review_by <= now() or candidate.expires_at <= now() then raise exception 'candidate is stale'; end if;
  if not exists (
    select 1 from public.aria_learning_reviews review
    where review.candidate_id = candidate.id and review.decision = 'approved'
      and review.bound_artifact_sha256 = candidate.artifact_sha256 and review.expires_at > now()
  ) then raise exception 'current authenticated approval receipt missing'; end if;
  if not exists (
    select 1 from public.aria_learning_evals eval
    where eval.candidate_id = candidate.id
      and eval.candidate_artifact_sha256 = candidate.artifact_sha256
      and eval.hard_gates_passed and eval.critical_regressions = 0
      and eval.human_review_status in ('not_required','passed')
      and eval.trajectory_status in ('not_required','passed')
  ) then raise exception 'release-grade evaluation is incomplete'; end if;
  if jsonb_typeof(p_monitoring_plan) <> 'object' or p_monitoring_plan = '{}'::jsonb then
    raise exception 'monitoring plan is required';
  end if;
  insert into public.aria_learning_releases (
    candidate_id, release_version, artifact_sha256, previous_version,
    previous_artifact_sha256, deployment_receipt_ref, monitoring_plan, released_by
  ) values (
    candidate.id, btrim(p_release_version), candidate.artifact_sha256,
    btrim(p_previous_version), p_previous_artifact_sha256,
    btrim(p_deployment_receipt_ref), p_monitoring_plan, auth.uid()
  ) returning * into result;
  update public.aria_learning_candidates set state = 'released' where id = candidate.id;
  return result;
end;
$$;

create or replace function public.record_aria_learning_monitor(
  p_candidate_id uuid,
  p_release_id uuid,
  p_metric_key text,
  p_metric_value jsonb,
  p_status text,
  p_evidence_ref text,
  p_evidence_sha256 text,
  p_observed_at timestamptz
)
returns public.aria_learning_monitors
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare candidate public.aria_learning_candidates; result public.aria_learning_monitors;
begin
  if auth.uid() is null or (auth.role() <> 'service_role' and not private.current_actor_is_aria()) then
    raise exception 'active Aria identity required';
  end if;
  select * into candidate from public.aria_learning_candidates where id = p_candidate_id for update;
  if candidate.id is null or candidate.state not in ('released','monitoring') then
    raise exception 'candidate has no monitored release';
  end if;
  if not exists (
    select 1 from public.aria_learning_releases release
    where release.id = p_release_id and release.candidate_id = candidate.id
  ) then raise exception 'release does not belong to candidate'; end if;
  insert into public.aria_learning_monitors (
    candidate_id, release_id, metric_key, metric_value, status,
    evidence_ref, evidence_sha256, observed_at, recorded_by
  ) values (
    candidate.id, p_release_id, btrim(p_metric_key), p_metric_value, p_status,
    btrim(p_evidence_ref), p_evidence_sha256, p_observed_at, auth.uid()
  ) returning * into result;
  update public.aria_learning_candidates set state = 'monitoring' where id = candidate.id and state = 'released';
  return result;
end;
$$;

revoke all on function public.create_aria_learning_candidate(text,text,text,text,text[],text,text,text,text,text,uuid,timestamptz,timestamptz,text) from public, anon;
revoke all on function public.add_aria_learning_source(uuid,jsonb) from public, anon;
revoke all on function public.record_aria_learning_eval(uuid,text,text,text,text,text,boolean,integer,text,text,timestamptz) from public, anon;
revoke all on function public.request_aria_learning_review(uuid) from public, anon;
revoke all on function public.decide_aria_learning_candidate(uuid,boolean,text,timestamptz,text) from public, anon;
revoke all on function public.stage_aria_learning_candidate(uuid) from public, anon;
revoke all on function public.release_aria_learning_candidate(uuid,text,text,text,text,jsonb) from public, anon;
revoke all on function public.record_aria_learning_monitor(uuid,uuid,text,jsonb,text,text,text,timestamptz) from public, anon;
grant execute on function public.create_aria_learning_candidate(text,text,text,text,text[],text,text,text,text,text,uuid,timestamptz,timestamptz,text) to authenticated, service_role;
grant execute on function public.add_aria_learning_source(uuid,jsonb) to authenticated, service_role;
grant execute on function public.record_aria_learning_eval(uuid,text,text,text,text,text,boolean,integer,text,text,timestamptz) to authenticated, service_role;
grant execute on function public.request_aria_learning_review(uuid) to authenticated, service_role;
grant execute on function public.decide_aria_learning_candidate(uuid,boolean,text,timestamptz,text) to authenticated;
grant execute on function public.stage_aria_learning_candidate(uuid) to authenticated, service_role;
grant execute on function public.release_aria_learning_candidate(uuid,text,text,text,text,jsonb) to authenticated;
grant execute on function public.record_aria_learning_monitor(uuid,uuid,text,jsonb,text,text,text,timestamptz) to authenticated, service_role;

insert into public.aria_learning_modules(module_key, week_start, week_end, title, competency, pass_threshold, human_reviewer_role)
values
  ('source-ncc',1,2,'Source discipline and NCC version control','Classify sources and select applicable versions without impersonating a certifier',90,'building certifier or licensed professional'),
  ('planning',3,4,'Planning and approval lifecycle','Build location-specific approval packets and preserve professional decisions',90,'planner, accredited professional, council, or relevant authority'),
  ('licensing',5,5,'Licensing, contracts, supervision, and insurance','Check licence scope, insurance, contract controls, and unresolved exceptions',100,'licensed builder, insurer, or construction lawyer'),
  ('whs',6,7,'Construction WHS','Escalate every red flag and produce hold-point questions without declaring safety',100,'competent WHS adviser or applicable specialist'),
  ('environment',8,8,'Environment, stormwater, waste, and contamination','Create evidence-based containment and escalation packets',100,'environmental professional or regulator'),
  ('procurement',9,9,'Product and procurement assurance','Match model, scope, certificate, expiry, batch, recall, and substitution evidence',100,'certifier, designer, engineer, or licensed trade'),
  ('sustainable-design',10,10,'Sustainable and adaptable Adelaide design','Present sourced options without inventing ratings or certification',90,'NatHERS assessor, designer, engineer, or certifier'),
  ('project-operations',11,11,'Project and client operations','Keep scope, change, cost, programme, approval, and closure traceable',90,'project lead or relevant specialist'),
  ('agent-capstone',12,12,'Agent operations and capstone','Apply least privilege, injection resistance, evals, rollback, and source-backed memory',100,'privacy/security reviewer plus accountable domain reviewers')
on conflict (module_key) do update set
  week_start = excluded.week_start,
  week_end = excluded.week_end,
  title = excluded.title,
  competency = excluded.competency,
  pass_threshold = excluded.pass_threshold,
  human_reviewer_role = excluded.human_reviewer_role,
  active = true;

-- Canonical classification for every tool currently exposed by the RESLU MCP
-- server. Draft/preparation tools remain R1 even when their subject matter is
-- financial or client-facing; the later publish/send/pay transition is the R2
-- effect. Generic lead-stage changes, bookings, proposal decisions, Xero draft
-- creation, and trusted-memory writes receive the stronger boundary here.
insert into public.aria_tool_registry (
  tool_name, owner, purpose, action_class, risk_tier, approval_rule,
  verification_kind, idempotency_kind, rollback_kind, active
)
values
  ('list_projects','Spec','Read active projects','read','R0','none','none','none','none',true),
  ('get_project','Spec','Read one project','read','R0','none','none','none','none',true),
  ('list_items','Spec','Read project specification items','read','R0','none','none','none','none',true),
  ('create_item','Spec','Create a reversible specification working item','prepare','R1','none','spec_readback','client-key','delete-draft',true),
  ('update_item_status','Spec','Record a verified procurement state','prepare','R1','none','spec_readback','client-key','restore-version',true),
  ('update_item_pricing','Spec','Record sourced quoted trade evidence','prepare','R1','none','spec_readback','client-key','restore-version',true),
  ('create_project','Spec','Create an internal project working record','prepare','R1','none','spec_readback','client-key','delete-draft',true),
  ('list_leads','Spec','Read lead records','read','R0','none','none','none','none',true),
  ('move_lead_stage','Spec','Change an authoritative lead outcome','commit','R2','exact-owner','spec_readback','client-key','restore-version',true),
  ('update_lead','Spec','Update reversible lead working fields','prepare','R1','none','spec_readback','client-key','restore-version',true),
  ('add_lead_note','Spec','Append an attributed lead note','prepare','R1','none','spec_readback','client-key','manual-recovery',true),
  ('get_lead_notes','Spec','Read lead notes','read','R0','none','none','none','none',true),
  ('get_needs_attention','Spec','Read lead attention queues','read','R0','none','none','none','none',true),
  ('list_invoices','Spec','Read draft and approved invoice records','read','R0','none','none','none','none',true),
  ('create_invoice','Spec','Create a supplier invoice draft','prepare','R1','none','draft_record','client-key','delete-draft',true),
  ('propose_supplier_invoice','Spec','Create a traced supplier invoice proposal','prepare','R1','none','draft_record','natural-key','delete-draft',true),
  ('post_client_update','Spec','Create an unpublished client update draft','prepare','R1','none','draft_record','client-key','delete-draft',true),
  ('draft_diary_entry','Spec','Read or prepare a diary entry for approval','prepare','R1','none','draft_record','client-key','restore-version',true),
  ('list_site_photos','Spec','Read site photo metadata','read','R0','none','none','none','none',true),
  ('list_pending_transcriptions','Spec','Read pending transcription work','read','R0','none','none','none','none',true),
  ('set_capture_transcript','Spec','Store a locally produced site transcript','prepare','R1','none','spec_readback','natural-key','restore-version',true),
  ('list_site_captures','Spec','Read site capture metadata','read','R0','none','none','none','none',true),
  ('get_lead_meeting_recording','Spec','Claim and read one lead recording','prepare','R1','none','spec_readback','natural-key','manual-recovery',true),
  ('complete_lead_meeting_transcription','Spec','Store a lead meeting transcript draft','prepare','R1','none','spec_readback','natural-key','restore-version',true),
  ('get_conversation_meeting_source','Spec','Read a retained meeting source','read','R0','none','none','none','none',true),
  ('complete_conversation_meeting_draft','Spec','Store draft meeting minutes','prepare','R1','none','draft_record','natural-key','restore-version',true),
  ('list_contacts','Spec','Read contacts','read','R0','none','none','none','none',true),
  ('create_board_task','Spec','Create a reversible internal action item','prepare','R1','none','spec_readback','client-key','delete-draft',true),
  ('list_pending_plan_analyses','Spec','Read pending plan analysis work','read','R0','none','none','none','none',true),
  ('submit_plan_analysis','Spec','Store a sourced plan analysis draft','prepare','R1','none','draft_record','natural-key','restore-version',true),
  ('draft_sow_section','Spec','Store a scope-of-work draft','prepare','R1','none','draft_record','client-key','restore-version',true),
  ('create_client_event','Spec','Create an internal client timeline record','prepare','R1','none','spec_readback','client-key','delete-draft',true),
  ('create_office_task','Spec','Create a reversible Office task','prepare','R1','none','spec_readback','client-key','delete-draft',true),
  ('list_office_tasks','Spec','Read Office tasks','read','R0','none','none','none','none',true),
  ('list_design_phases','Spec','Read design phases and tasks','read','R0','none','none','none','none',true),
  ('create_design_task','Spec','Create a reversible design task','prepare','R1','none','spec_readback','client-key','delete-draft',true),
  ('get_bookings_overdue','Spec','Read booking attention evidence','read','R0','none','none','none','none',true),
  ('get_ordering_attention','Spec','Read procurement attention evidence','read','R0','none','none','none','none',true),
  ('add_brief_item','Spec','Create an internal brief item','prepare','R1','none','spec_readback','client-key','delete-draft',true),
  ('add_brain_note','Second Brain','Promote content into trusted retrieval memory','restricted','R3','exact-owner-plus-review','specialised','client-key','specialised',true),
  ('get_aria_queue','Spec','Atomically claim Aria queue work','prepare','R1','none','spec_readback','client-key','manual-recovery',true),
  ('resolve_queue_item','Spec','Resolve one claimed queue item after outcome verification','prepare','R1','none','spec_readback','client-key','manual-recovery',true),
  ('get_organic_action','Spec','Read an approved organic-action packet','read','R0','none','none','none','none',true),
  ('submit_organic_action_draft','Spec','Store an organic marketing recommendation draft','prepare','R1','none','draft_record','client-key','restore-version',true),
  ('submit_followup_draft','Spec','Store an unsent follow-up draft','prepare','R1','none','draft_record','natural-key','delete-draft',true),
  ('complete_followup_send','Spec','Record the authoritative outcome of an already approved send','prepare','R1','none','provider_readback','natural-key','manual-recovery',true),
  ('get_proposal','Spec','Read a fee proposal draft','read','R0','none','none','none','none',true),
  ('set_proposal_draft','Spec','Store a fee proposal draft','prepare','R1','none','draft_record','client-key','restore-version',true),
  ('index_rebuild','Second Brain','Rebuild a derived search index','prepare','R1','none','spec_readback','natural-key','specialised',true),
  ('get_email','Second Brain','Read one already-ingested email','read','R0','none','none','none','none',true),
  ('search','Second Brain','Search authorised business evidence','read','R0','none','none','none','none',true),
  ('get_project_health','Spec','Read project health evidence','read','R0','none','none','none','none',true),
  ('get_context_snapshot','Spec','Read a bounded context snapshot','read','R0','none','none','none','none',true),
  ('approve_proposal','Spec','Approve an authoritative Second Brain proposal','commit','R2','exact-owner','spec_readback','client-key','restore-version',true),
  ('reject_proposal','Spec','Reject an authoritative Second Brain proposal','commit','R2','exact-owner','spec_readback','client-key','restore-version',true),
  ('correct_match','Second Brain','Correct a reversible evidence match','prepare','R1','none','spec_readback','client-key','restore-version',true),
  ('book_trade_visit','Spec','Book a trade visit commitment','commit','R2','exact-owner','provider_readback','provider-key','compensating-action',true),
  ('get_materials_needing_aria','Spec','Read material pricing gaps','read','R0','none','none','none','none',true),
  ('submit_material_price','Spec','Record sourced material price evidence','prepare','R1','none','spec_readback','client-key','restore-version',true),
  ('add_cpd_entry','Spec','Log a reversible CPD evidence record','prepare','R1','none','spec_readback','natural-key','delete-draft',true),
  ('post_heartbeat','Health','Record a local health heartbeat','prepare','R1','none','spec_readback','natural-key','manual-recovery',true),
  ('report_channel_status','Health','Record a verified channel-health state','prepare','R1','none','spec_readback','natural-key','restore-version',true),
  ('get_pending_diagnostics','Health','Claim a requested diagnostic job','prepare','R1','none','spec_readback','natural-key','manual-recovery',true),
  ('complete_diagnostic','Health','Record a diagnostic outcome','prepare','R1','none','spec_readback','natural-key','manual-recovery',true),
  ('get_stuart_finance_brief','Finance','Read Stuart finance exceptions','read','R0','none','none','none','none',true),
  ('run_stuart_finance_review','Finance','Run a deterministic read-only finance review','prepare','R1','none','spec_readback','natural-key','manual-recovery',true),
  ('attach_stuart_source_invoice','Finance','Attach verified source evidence to a draft invoice','prepare','R1','none','spec_readback','natural-key','manual-recovery',true),
  ('create_stuart_xero_draft_bill','Finance','Create a provider-side accounting draft','commit','R2','exact-owner','provider_readback','provider-key','compensating-action',true),
  ('reconcile_stuart_supplier_statement','Finance','Store a deterministic reconciliation audit','prepare','R1','none','spec_readback','natural-key','manual-recovery',true),
  ('delegate_reslu_agent_task','Conversations','Create one bounded specialist task','prepare','R1','none','spec_readback','client-key','manual-recovery',true)
  ,('list_learning_candidates','Learning','Read governed learning and curriculum state','read','R0','none','none','none','none',true)
  ,('create_learning_candidate','Learning','Persist a bounded governed candidate','prepare','R1','none','spec_readback','client-key','manual-recovery',true)
  ,('add_learning_source','Learning','Attach claim-level source evidence','prepare','R1','none','spec_readback','client-key','manual-recovery',true)
  ,('record_learning_eval','Learning','Bind an immutable evaluation result','prepare','R1','none','spec_readback','natural-key','manual-recovery',true)
  ,('request_learning_review','Learning','Request accountable review of an evaluated candidate','prepare','R1','none','spec_readback','natural-key','manual-recovery',true)
  ,('stage_learning_candidate','Learning','Stage an exactly approved candidate without promoting it','prepare','R1','none','spec_readback','natural-key','manual-recovery',true)
  ,('record_learning_monitor','Learning','Record post-release outcome evidence','prepare','R1','none','spec_readback','natural-key','manual-recovery',true)
on conflict (tool_name) do update set
  owner = excluded.owner,
  purpose = excluded.purpose,
  action_class = excluded.action_class,
  risk_tier = excluded.risk_tier,
  allowed_agent_slugs = excluded.allowed_agent_slugs,
  tenant_scope = excluded.tenant_scope,
  approval_rule = excluded.approval_rule,
  verification_kind = excluded.verification_kind,
  idempotency_kind = excluded.idempotency_kind,
  rollback_kind = excluded.rollback_kind,
  active = excluded.active,
  updated_at = now();

notify pgrst, 'reload schema';
