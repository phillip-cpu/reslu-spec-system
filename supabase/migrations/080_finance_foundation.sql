-- ============================================================
-- RESLU Spec System - Finance foundation (Milestone 1)
--
-- Additive, feature-flagged foundations for:
--   - explicit finance capabilities enforced by Postgres RLS;
--   - project finance lifecycle and atomic activation;
--   - immutable estimate/program baselines;
--   - contribution-level forecast inputs in integer minor units;
--   - immutable projection schema for later publication.
--
-- This migration deliberately does NOT connect Xero, publish a company
-- cash forecast, infer missing dates, enable BAS forecasting, or enable
-- retention. The seeded policy is a DRAFT with M0 confirmations open,
-- so production activation fails closed until it is replaced by an
-- approved published policy.
-- ============================================================

-- ------------------------------------------------------------
-- Capability grants
-- ------------------------------------------------------------
create table if not exists finance_capability_grants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  capability    text not null check (capability in (
                  'finance.view_company',
                  'finance.view_project',
                  'finance.activate_project',
                  'finance.edit_forecast',
                  'finance.resolve_match',
                  'finance.manage_policy',
                  'finance.manage_xero',
                  'finance.run_sync',
                  'finance.view_audit',
                  'finance.export',
                  'finance.use_ai',
                  'finance.manage_access'
                )),
  project_id    uuid references projects(id) on delete cascade,
  grant_source  text not null default 'manual'
                check (grant_source in ('manual', 'bootstrap_admin')),
  granted_by    uuid references profiles(id) on delete set null,
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists idx_finance_grants_company_active
  on finance_capability_grants(user_id, capability)
  where project_id is null and revoked_at is null;

create unique index if not exists idx_finance_grants_project_active
  on finance_capability_grants(user_id, capability, project_id)
  where project_id is not null and revoked_at is null;

create index if not exists idx_finance_grants_lookup
  on finance_capability_grants(user_id, capability, project_id)
  where revoked_at is null;

create or replace function has_finance_capability(
  p_capability text,
  p_project_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    auth.role() = 'service_role'
    or exists (
      select 1
      from finance_capability_grants g
      where g.user_id = auth.uid()
        and g.capability = p_capability
        and g.revoked_at is null
        and (
          (p_project_id is null and g.project_id is null)
          or
          (p_project_id is not null and (g.project_id is null or g.project_id = p_project_id))
        )
    ),
    false
  );
$$;

create or replace function can_view_finance_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_finance_capability('finance.view_company', null)
      or has_finance_capability('finance.view_project', p_project_id);
$$;

revoke all on function has_finance_capability(text, uuid) from public;
revoke all on function can_view_finance_project(uuid) from public;
grant execute on function has_finance_capability(text, uuid) to authenticated, service_role;
grant execute on function can_view_finance_project(uuid) to authenticated, service_role;

-- Existing admins receive explicit bootstrap grants. The trigger keeps
-- future admin promotions usable and revokes only bootstrap grants on
-- demotion, preserving any deliberate manual/project grant.
create or replace function sync_admin_finance_capabilities()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_capability text;
  v_capabilities constant text[] := array[
    'finance.view_company',
    'finance.view_project',
    'finance.activate_project',
    'finance.edit_forecast',
    'finance.resolve_match',
    'finance.manage_policy',
    'finance.manage_xero',
    'finance.run_sync',
    'finance.view_audit',
    'finance.export',
    'finance.use_ai',
    'finance.manage_access'
  ];
begin
  if new.role = 'admin' then
    foreach v_capability in array v_capabilities loop
      if not exists (
        select 1
        from finance_capability_grants g
        where g.user_id = new.id
          and g.capability = v_capability
          and g.project_id is null
          and g.revoked_at is null
      ) then
        insert into finance_capability_grants (
          user_id, capability, project_id, grant_source, granted_by
        ) values (
          new.id, v_capability, null, 'bootstrap_admin', new.id
        );
      end if;
    end loop;
  elsif tg_op = 'UPDATE' and old.role = 'admin' then
    update finance_capability_grants
    set revoked_at = now()
    where user_id = new.id
      and grant_source = 'bootstrap_admin'
      and revoked_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_finance_capabilities on profiles;
create trigger trg_profiles_finance_capabilities
  after insert or update of role on profiles
  for each row execute function sync_admin_finance_capabilities();

insert into finance_capability_grants (
  user_id, capability, project_id, grant_source, granted_by
)
select
  p.id,
  c.capability,
  null,
  'bootstrap_admin',
  p.id
from profiles p
cross join unnest(array[
  'finance.view_company',
  'finance.view_project',
  'finance.activate_project',
  'finance.edit_forecast',
  'finance.resolve_match',
  'finance.manage_policy',
  'finance.manage_xero',
  'finance.run_sync',
  'finance.view_audit',
  'finance.export',
  'finance.use_ai',
  'finance.manage_access'
]) as c(capability)
where p.role = 'admin'
  and not exists (
    select 1
    from finance_capability_grants g
    where g.user_id = p.id
      and g.capability = c.capability
      and g.project_id is null
      and g.revoked_at is null
  );

-- ------------------------------------------------------------
-- Policy, lifecycle and immutable inputs
-- ------------------------------------------------------------
create table if not exists finance_policy_versions (
  id             uuid primary key default gen_random_uuid(),
  policy_key     text not null default 'company',
  version_number integer not null check (version_number > 0),
  status         text not null default 'draft'
                 check (status in ('draft', 'published', 'superseded')),
  effective_from date not null,
  configuration  jsonb not null,
  confirmations  jsonb not null default '{}'::jsonb,
  note           text,
  created_by     uuid references profiles(id) on delete set null,
  approved_by    uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  approved_at    timestamptz,
  unique (policy_key, version_number),
  check (
    (status = 'published' and approved_by is not null and approved_at is not null)
    or status <> 'published'
  )
);

insert into finance_policy_versions (
  policy_key,
  version_number,
  status,
  effective_from,
  configuration,
  confirmations,
  note
)
select
  'company',
  1,
  'draft',
  current_date,
  jsonb_build_object(
    'schema_version', 'finance-policy-v1',
    'forecast_timezone', 'Australia/Adelaide',
    'weekly_periods', 13,
    'monthly_horizon_months', 18,
    'cash_basis', 'gross',
    'margin_basis', 'ex_gst',
    'bas_forecast_enabled', false,
    'retention_enabled', false,
    'overhead_allocation', 'company_only',
    'pipeline_base_treatment', 'named_scenarios_only',
    'requires_confirmation', jsonb_build_array(
      'activation_evidence',
      'cash_and_margin_basis',
      'opening_cash_accounts',
      'overhead_allocation',
      'gst_and_bas',
      'claims_and_retention',
      'record_retention'
    )
  ),
  jsonb_build_object(
    'owner', 'pending',
    'accountant', 'pending',
    'legal', 'pending'
  ),
  'M0 draft only. Must be confirmed and published before activation.'
where not exists (
  select 1 from finance_policy_versions where policy_key = 'company'
);

create table if not exists project_finance_profiles (
  project_id            uuid primary key references projects(id) on delete cascade,
  finance_state         text not null default 'design_only'
                        check (finance_state in (
                          'design_only', 'candidate', 'ready', 'active',
                          'suspended', 'closed', 'cancelled'
                        )),
  policy_version_id     uuid references finance_policy_versions(id),
  active_baseline_id    uuid,
  current_projection_id uuid,
  activated_at          timestamptz,
  activated_by          uuid references profiles(id) on delete set null,
  version               integer not null default 1 check (version > 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

insert into project_finance_profiles (project_id)
select p.id
from projects p
where not exists (
  select 1 from project_finance_profiles f where f.project_id = p.id
);

create or replace function create_project_finance_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into project_finance_profiles (project_id)
  values (new.id)
  on conflict (project_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_projects_finance_profile on projects;
create trigger trg_projects_finance_profile
  after insert on projects
  for each row execute function create_project_finance_profile();

drop trigger if exists trg_project_finance_profiles_updated_at on project_finance_profiles;
create trigger trg_project_finance_profiles_updated_at
  before update on project_finance_profiles
  for each row execute function set_updated_at();

create table if not exists forecast_baselines (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects(id) on delete cascade,
  policy_version_id    uuid not null references finance_policy_versions(id),
  estimate_version_id  uuid not null references estimate_versions(id),
  effective_date       date not null,
  program_watermark    text not null,
  snapshot             jsonb not null,
  content_hash         text not null,
  created_by           uuid references profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  unique (project_id, content_hash)
);

create index if not exists idx_forecast_baselines_project
  on forecast_baselines(project_id, created_at desc);

create table if not exists finance_forecast_lines (
  id                        uuid primary key default gen_random_uuid(),
  baseline_id               uuid not null references forecast_baselines(id) on delete restrict,
  project_id                uuid not null references projects(id) on delete cascade,
  contribution_key          text not null,
  direction                 text not null check (direction in ('inflow', 'outflow')),
  source_type               text not null,
  source_record_id          uuid,
  source_version_id         uuid,
  description               text not null,
  dimension                 jsonb not null default '{}'::jsonb,
  planned_net_minor         bigint not null default 0 check (planned_net_minor >= 0),
  committed_net_minor       bigint not null default 0 check (committed_net_minor >= 0),
  actual_accrued_net_minor  bigint not null default 0 check (actual_accrued_net_minor >= 0),
  actual_paid_net_minor     bigint not null default 0 check (actual_paid_net_minor >= 0),
  planned_tax_minor         bigint,
  planned_gross_minor       bigint,
  planned_date              date,
  committed_date            date,
  actual_due_date           date,
  actual_paid_date          date,
  timing_source             text not null default 'unmapped'
                            check (timing_source in (
                              'actual', 'manual_override', 'promised_due',
                              'stage_derived', 'policy_fallback', 'unmapped'
                            )),
  confidence                text not null default 'unknown'
                            check (confidence in (
                              'confirmed', 'high', 'medium', 'low', 'unknown'
                            )),
  created_at                timestamptz not null default now(),
  unique (baseline_id, contribution_key),
  check (actual_paid_net_minor <= actual_accrued_net_minor)
);

create index if not exists idx_finance_forecast_lines_project
  on finance_forecast_lines(project_id, baseline_id);

create table if not exists finance_activation_events (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  from_state        text not null,
  to_state          text not null,
  effective_date    date not null,
  policy_version_id uuid not null references finance_policy_versions(id),
  baseline_id       uuid not null references forecast_baselines(id) on delete restrict,
  contract_evidence jsonb not null,
  prerequisites     jsonb not null,
  reason            text not null,
  idempotency_key   text not null unique,
  actor_id           uuid not null references profiles(id) on delete restrict,
  created_at         timestamptz not null default now()
);

create index if not exists idx_finance_activation_project
  on finance_activation_events(project_id, created_at desc);

-- ------------------------------------------------------------
-- Immutable projection schema (publication begins in a later milestone;
-- M1's TypeScript engine runs in shadow/preview mode).
-- ------------------------------------------------------------
create table if not exists finance_projection_versions (
  id                    uuid primary key default gen_random_uuid(),
  scope_type            text not null check (scope_type in ('company', 'project')),
  project_id            uuid references projects(id) on delete cascade,
  baseline_id           uuid references forecast_baselines(id) on delete restrict,
  mode                   text not null default 'shadow' check (mode in ('shadow', 'current')),
  status                 text not null default 'published' check (status in ('published', 'superseded')),
  as_of_date             date not null,
  opening_cash_minor     bigint not null default 0,
  calculation_version   text not null,
  input_watermarks       jsonb not null,
  data_quality           jsonb not null,
  totals                 jsonb not null,
  content_hash           text not null,
  created_by             uuid references profiles(id) on delete set null,
  created_at             timestamptz not null default now(),
  unique (scope_type, project_id, content_hash),
  check (
    (scope_type = 'company' and project_id is null)
    or (scope_type = 'project' and project_id is not null)
  )
);

create index if not exists idx_finance_projection_scope
  on finance_projection_versions(scope_type, project_id, created_at desc);

-- PostgreSQL treats nulls as distinct in ordinary unique constraints. Keep
-- company-wide projection publication idempotent with a partial unique index.
create unique index if not exists idx_finance_projection_company_content
  on finance_projection_versions(scope_type, content_hash)
  where scope_type = 'company' and project_id is null;

create table if not exists finance_projection_periods (
  id                  uuid primary key default gen_random_uuid(),
  projection_id       uuid not null references finance_projection_versions(id) on delete restrict,
  period_kind         text not null check (period_kind in ('week', 'month')),
  period_index        integer not null check (period_index >= 0),
  starts_on           date not null,
  ends_on             date not null,
  opening_cash_minor  bigint not null,
  inflow_minor        bigint not null default 0 check (inflow_minor >= 0),
  outflow_minor       bigint not null default 0 check (outflow_minor >= 0),
  actual_inflow_minor bigint not null default 0 check (actual_inflow_minor >= 0),
  actual_outflow_minor bigint not null default 0 check (actual_outflow_minor >= 0),
  closing_cash_minor  bigint not null,
  created_at          timestamptz not null default now(),
  unique (projection_id, period_kind, period_index),
  check (ends_on >= starts_on),
  check (closing_cash_minor = opening_cash_minor + inflow_minor - outflow_minor)
);

create table if not exists finance_projection_contributions (
  id                uuid primary key default gen_random_uuid(),
  projection_id     uuid not null references finance_projection_versions(id) on delete restrict,
  period_id         uuid references finance_projection_periods(id) on delete restrict,
  forecast_line_id  uuid references finance_forecast_lines(id) on delete restrict,
  contribution_key  text not null,
  direction         text not null check (direction in ('inflow', 'outflow')),
  effective_state   text not null check (effective_state in (
                      'planned', 'committed', 'actual_accrued', 'actual_paid'
                    )),
  amount_minor      bigint not null check (amount_minor >= 0),
  effective_date    date,
  source_trace      jsonb not null,
  created_at        timestamptz not null default now()
);

create index if not exists idx_finance_projection_contributions_version
  on finance_projection_contributions(projection_id, contribution_key);

alter table project_finance_profiles
  drop constraint if exists project_finance_profiles_active_baseline_id_fkey;
alter table project_finance_profiles
  add constraint project_finance_profiles_active_baseline_id_fkey
  foreign key (active_baseline_id) references forecast_baselines(id) on delete restrict;

alter table project_finance_profiles
  drop constraint if exists project_finance_profiles_current_projection_id_fkey;
alter table project_finance_profiles
  add constraint project_finance_profiles_current_projection_id_fkey
  foreign key (current_projection_id) references finance_projection_versions(id) on delete restrict;

create table if not exists finance_audit_events (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid references projects(id) on delete cascade,
  actor_id         uuid references profiles(id) on delete set null,
  source           text not null,
  action           text not null,
  object_type      text not null,
  object_id        uuid,
  idempotency_key  text,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists idx_finance_audit_project
  on finance_audit_events(project_id, created_at desc);

create or replace function publish_finance_policy(
  p_policy_id uuid,
  p_effective_from date,
  p_configuration jsonb,
  p_confirmations jsonb,
  p_reason text
)
returns finance_policy_versions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_policy finance_policy_versions%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;
  if not has_finance_capability('finance.manage_policy', null) then
    raise exception 'Missing finance.manage_policy capability';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Policy publication reason is required';
  end if;
  if lower(coalesce(p_confirmations->>'owner', '')) <> 'confirmed'
     or lower(coalesce(p_confirmations->>'accountant', '')) <> 'confirmed'
     or lower(coalesce(p_confirmations->>'legal', '')) <> 'confirmed' then
    raise exception 'Owner, accountant and legal confirmations are required';
  end if;
  if not (
    p_configuration ? 'forecast_timezone'
    and p_configuration ? 'weekly_periods'
    and p_configuration ? 'monthly_horizon_months'
    and p_configuration ? 'cash_basis'
    and p_configuration ? 'margin_basis'
    and p_configuration ? 'bas_forecast_enabled'
    and p_configuration ? 'retention_enabled'
    and p_configuration ? 'overhead_allocation'
  ) then
    raise exception 'Finance policy configuration is incomplete';
  end if;
  if coalesce((p_configuration->>'weekly_periods')::integer, 0) not between 1 and 52
     or coalesce((p_configuration->>'monthly_horizon_months')::integer, 0) not between 3 and 36 then
    raise exception 'Finance policy forecast horizons are invalid';
  end if;

  select * into v_policy
  from finance_policy_versions p
  where p.id = p_policy_id
  for update;
  if not found or v_policy.status <> 'draft' then
    raise exception 'Finance policy is not an editable draft';
  end if;

  update finance_policy_versions
  set status = 'published',
      effective_from = p_effective_from,
      configuration = p_configuration,
      confirmations = p_confirmations,
      note = concat_ws(E'\n', nullif(v_policy.note, ''), trim(p_reason)),
      approved_by = v_actor,
      approved_at = now()
  where id = p_policy_id
  returning * into v_policy;

  insert into finance_audit_events (
    actor_id,
    source,
    action,
    object_type,
    object_id,
    payload
  ) values (
    v_actor,
    'publish_finance_policy',
    'publish',
    'finance_policy_version',
    v_policy.id,
    jsonb_build_object(
      'policy_key', v_policy.policy_key,
      'version_number', v_policy.version_number,
      'effective_from', v_policy.effective_from,
      'reason', trim(p_reason)
    )
  );

  return v_policy;
end;
$$;

revoke all on function publish_finance_policy(uuid, date, jsonb, jsonb, text) from public;
grant execute on function publish_finance_policy(uuid, date, jsonb, jsonb, text)
  to authenticated, service_role;

-- ------------------------------------------------------------
-- Immutability controls
-- ------------------------------------------------------------
create or replace function prevent_finance_immutable_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% rows are immutable; append a corrective version/event', tg_table_name;
end;
$$;

create or replace function prevent_published_finance_policy_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status in ('published', 'superseded') then
    raise exception 'Published finance policy versions are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_finance_policy_immutable on finance_policy_versions;
create trigger trg_finance_policy_immutable
  before update or delete on finance_policy_versions
  for each row execute function prevent_published_finance_policy_change();

drop trigger if exists trg_forecast_baselines_immutable on forecast_baselines;
create trigger trg_forecast_baselines_immutable
  before update or delete on forecast_baselines
  for each row execute function prevent_finance_immutable_change();

drop trigger if exists trg_finance_forecast_lines_immutable on finance_forecast_lines;
create trigger trg_finance_forecast_lines_immutable
  before update or delete on finance_forecast_lines
  for each row execute function prevent_finance_immutable_change();

drop trigger if exists trg_finance_activation_events_immutable on finance_activation_events;
create trigger trg_finance_activation_events_immutable
  before update or delete on finance_activation_events
  for each row execute function prevent_finance_immutable_change();

drop trigger if exists trg_finance_projection_versions_immutable on finance_projection_versions;
create trigger trg_finance_projection_versions_immutable
  before update or delete on finance_projection_versions
  for each row execute function prevent_finance_immutable_change();

drop trigger if exists trg_finance_projection_periods_immutable on finance_projection_periods;
create trigger trg_finance_projection_periods_immutable
  before update or delete on finance_projection_periods
  for each row execute function prevent_finance_immutable_change();

drop trigger if exists trg_finance_projection_contributions_immutable on finance_projection_contributions;
create trigger trg_finance_projection_contributions_immutable
  before update or delete on finance_projection_contributions
  for each row execute function prevent_finance_immutable_change();

drop trigger if exists trg_finance_audit_events_immutable on finance_audit_events;
create trigger trg_finance_audit_events_immutable
  before update or delete on finance_audit_events
  for each row execute function prevent_finance_immutable_change();

-- ------------------------------------------------------------
-- Program watermark and atomic activation
-- ------------------------------------------------------------
create or replace function finance_program_snapshot(p_project_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', sp.id,
        'name', sp.name,
        'start_date', sp.start_date,
        'end_date', sp.end_date,
        'kind', sp.kind,
        'sort', sp.sort,
        'updated_at', sp.updated_at
      ) order by sp.sort, sp.id
    ),
    '[]'::jsonb
  )
  from schedule_phases sp
  where sp.project_id = p_project_id
    and sp.deleted_at is null;
$$;

create or replace function finance_program_watermark(p_project_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (
    can_view_finance_project(p_project_id)
    or has_finance_capability('finance.activate_project', p_project_id)
  ) then
    raise exception 'Project finance access denied';
  end if;
  return encode(
    digest(convert_to(finance_program_snapshot(p_project_id)::text, 'UTF8'), 'sha256'),
    'hex'
  );
end;
$$;

revoke all on function finance_program_snapshot(uuid) from public;
revoke all on function finance_program_watermark(uuid) from public;
grant execute on function finance_program_watermark(uuid) to authenticated, service_role;

create or replace function activate_project_finance(
  p_project_id uuid,
  p_effective_date date,
  p_estimate_version_id uuid,
  p_program_watermark text,
  p_policy_version_id uuid,
  p_contract_evidence jsonb,
  p_reason text,
  p_idempotency_key text,
  p_expected_profile_version integer
)
returns table (
  activation_event_id uuid,
  baseline_id uuid,
  profile_version integer,
  finance_state text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing finance_activation_events%rowtype;
  v_profile project_finance_profiles%rowtype;
  v_policy finance_policy_versions%rowtype;
  v_estimate estimate_versions%rowtype;
  v_program jsonb;
  v_watermark text;
  v_snapshot jsonb;
  v_content_hash text;
  v_baseline_id uuid;
  v_event_id uuid;
  v_previous_state text;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;
  if not has_finance_capability('finance.activate_project', p_project_id) then
    raise exception 'Missing finance.activate_project capability';
  end if;
  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'idempotency_key is required';
  end if;

  select * into v_existing
  from finance_activation_events e
  where e.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.project_id <> p_project_id then
      raise exception 'idempotency_key already belongs to another project';
    end if;
    return query
      select v_existing.id, v_existing.baseline_id, p.version, p.finance_state
      from project_finance_profiles p
      where p.project_id = p_project_id;
    return;
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'Activation reason is required';
  end if;
  if nullif(trim(p_contract_evidence->>'reference'), '') is null
     or nullif(trim(p_contract_evidence->>'signed_at'), '') is null then
    raise exception 'Signed contract evidence requires reference and signed_at';
  end if;

  select * into v_policy
  from finance_policy_versions p
  where p.id = p_policy_version_id
    and p.status = 'published'
    and p.effective_from <= p_effective_date;
  if not found then
    raise exception 'A published effective finance policy is required';
  end if;

  select * into v_estimate
  from estimate_versions e
  where e.id = p_estimate_version_id
    and e.project_id = p_project_id;
  if not found then
    raise exception 'Estimate version does not belong to project';
  end if;

  v_program := finance_program_snapshot(p_project_id);
  if jsonb_array_length(v_program) = 0 then
    raise exception 'A dated project program is required';
  end if;
  v_watermark := finance_program_watermark(p_project_id);
  if v_watermark <> p_program_watermark then
    raise exception 'Program changed after readiness preview';
  end if;

  select * into v_profile
  from project_finance_profiles p
  where p.project_id = p_project_id
  for update;
  if not found then
    insert into project_finance_profiles (project_id)
    values (p_project_id)
    returning * into v_profile;
  end if;
  if v_profile.version <> p_expected_profile_version then
    raise exception 'Finance profile changed after readiness preview';
  end if;
  if v_profile.finance_state not in ('design_only', 'candidate', 'ready') then
    raise exception 'Project cannot activate from finance state %', v_profile.finance_state;
  end if;
  v_previous_state := v_profile.finance_state;

  v_snapshot := jsonb_build_object(
    'schema_version', 'finance-baseline-v1',
    'project_id', p_project_id,
    'effective_date', p_effective_date,
    'estimate_version_id', v_estimate.id,
    'estimate_label', v_estimate.label,
    'estimate', v_estimate.snapshot,
    'program_watermark', v_watermark,
    'program', v_program,
    'policy_version_id', v_policy.id,
    'policy', v_policy.configuration
  );
  v_content_hash := encode(
    digest(convert_to(v_snapshot::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into forecast_baselines (
    project_id,
    policy_version_id,
    estimate_version_id,
    effective_date,
    program_watermark,
    snapshot,
    content_hash,
    created_by
  ) values (
    p_project_id,
    v_policy.id,
    v_estimate.id,
    p_effective_date,
    v_watermark,
    v_snapshot,
    v_content_hash,
    v_actor
  )
  on conflict (project_id, content_hash) do nothing
  returning id into v_baseline_id;

  if v_baseline_id is null then
    select b.id into v_baseline_id
    from forecast_baselines b
    where b.project_id = p_project_id
      and b.content_hash = v_content_hash;
  end if;

  -- Freeze one planned contribution per trade estimate line. No date is
  -- inferred because the current schema has no cost-line-to-phase link.
  insert into finance_forecast_lines (
    baseline_id,
    project_id,
    contribution_key,
    direction,
    source_type,
    source_record_id,
    source_version_id,
    description,
    dimension,
    planned_net_minor,
    timing_source,
    confidence
  )
  select
    v_baseline_id,
    p_project_id,
    'project:' || p_project_id::text || '|cost_line:' || (line->>'id') || '|scope:base',
    'outflow',
    'estimate_cost_line',
    (line->>'id')::uuid,
    v_estimate.id,
    coalesce(nullif(line->>'description', ''), 'Estimate cost line'),
    jsonb_build_object(
      'section_id', section->>'id',
      'section_name', section->>'name'
    ),
    round(amount.amount_ex_gst * 100)::bigint,
    'unmapped',
    'unknown'
  from jsonb_array_elements(coalesce(v_estimate.snapshot->'sections', '[]'::jsonb)) section
  cross join lateral jsonb_array_elements(coalesce(section->'lines', '[]'::jsonb)) line
  cross join lateral (
    select case
      when nullif(line->>'cost_ex_gst', '') is not null
        and (
          (line->>'cost_ex_gst')::numeric <> 0
          or coalesce((line->>'qty')::numeric, 0) * coalesce((line->>'rate_ex_gst')::numeric, 0) = 0
        )
      then (line->>'cost_ex_gst')::numeric
      else coalesce((line->>'qty')::numeric, 0) * coalesce((line->>'rate_ex_gst')::numeric, 0)
    end as amount_ex_gst
  ) amount
  where amount.amount_ex_gst > 0
  on conflict (baseline_id, contribution_key) do nothing;

  -- FF&E snapshots are category aggregates in the existing version
  -- schema, so they are preserved honestly at that granularity.
  insert into finance_forecast_lines (
    baseline_id,
    project_id,
    contribution_key,
    direction,
    source_type,
    source_version_id,
    description,
    dimension,
    planned_net_minor,
    timing_source,
    confidence
  )
  select
    v_baseline_id,
    p_project_id,
    'project:' || p_project_id::text || '|ffe_category:' || (category->>'category') || '|scope:base',
    'outflow',
    'estimate_ffe_category',
    v_estimate.id,
    'FF&E - ' || coalesce(nullif(category->>'category', ''), 'Uncategorised'),
    jsonb_build_object('category', category->>'category'),
    round((category->>'total')::numeric * 100)::bigint,
    'unmapped',
    case
      when coalesce((category->>'placeholder_count')::integer, 0) > 0
        or coalesce((category->>'unpriced_count')::integer, 0) > 0
      then 'low'
      else 'medium'
    end
  from jsonb_array_elements(coalesce(v_estimate.snapshot->'ffe'->'categories', '[]'::jsonb)) category
  where coalesce((category->>'total')::numeric, 0) > 0
  on conflict (baseline_id, contribution_key) do nothing;

  -- Approved variations are aggregated in existing estimate snapshots.
  insert into finance_forecast_lines (
    baseline_id,
    project_id,
    contribution_key,
    direction,
    source_type,
    source_version_id,
    description,
    dimension,
    planned_net_minor,
    timing_source,
    confidence
  )
  select
    v_baseline_id,
    p_project_id,
    'project:' || p_project_id::text || '|approved_variations|scope:base',
    'outflow',
    'estimate_approved_variations',
    v_estimate.id,
    'Approved variations',
    '{}'::jsonb,
    round((v_estimate.snapshot->'rollup'->>'approvedVariationsExGst')::numeric * 100)::bigint,
    'unmapped',
    'medium'
  where coalesce((v_estimate.snapshot->'rollup'->>'approvedVariationsExGst')::numeric, 0) > 0
  on conflict (baseline_id, contribution_key) do nothing;

  insert into finance_activation_events (
    project_id,
    from_state,
    to_state,
    effective_date,
    policy_version_id,
    baseline_id,
    contract_evidence,
    prerequisites,
    reason,
    idempotency_key,
    actor_id
  ) values (
    p_project_id,
    v_previous_state,
    'active',
    p_effective_date,
    v_policy.id,
    v_baseline_id,
    p_contract_evidence,
    jsonb_build_object(
      'signed_contract', true,
      'estimate_version_id', v_estimate.id,
      'program_watermark', v_watermark,
      'policy_version_id', v_policy.id
    ),
    trim(p_reason),
    trim(p_idempotency_key),
    v_actor
  ) returning id into v_event_id;

  update project_finance_profiles
  set finance_state = 'active',
      policy_version_id = v_policy.id,
      active_baseline_id = v_baseline_id,
      current_projection_id = null,
      activated_at = now(),
      activated_by = v_actor,
      version = version + 1
  where project_id = p_project_id
  returning * into v_profile;

  insert into finance_audit_events (
    project_id,
    actor_id,
    source,
    action,
    object_type,
    object_id,
    idempotency_key,
    payload
  ) values (
    p_project_id,
    v_actor,
    'activate_project_finance',
    'activate',
    'project_finance_profile',
    p_project_id,
    trim(p_idempotency_key),
    jsonb_build_object(
      'from_state', v_previous_state,
      'to_state', 'active',
      'baseline_id', v_baseline_id,
      'policy_version_id', v_policy.id,
      'estimate_version_id', v_estimate.id,
      'program_watermark', v_watermark,
      'profile_version', v_profile.version
    )
  );

  return query
    select v_event_id, v_baseline_id, v_profile.version, v_profile.finance_state;
end;
$$;

revoke all on function activate_project_finance(
  uuid, date, uuid, text, uuid, jsonb, text, text, integer
) from public;
grant execute on function activate_project_finance(
  uuid, date, uuid, text, uuid, jsonb, text, text, integer
) to authenticated, service_role;

-- ------------------------------------------------------------
-- Row-level security and least-privilege table access
-- ------------------------------------------------------------
alter table finance_capability_grants enable row level security;
alter table finance_policy_versions enable row level security;
alter table project_finance_profiles enable row level security;
alter table forecast_baselines enable row level security;
alter table finance_forecast_lines enable row level security;
alter table finance_activation_events enable row level security;
alter table finance_projection_versions enable row level security;
alter table finance_projection_periods enable row level security;
alter table finance_projection_contributions enable row level security;
alter table finance_audit_events enable row level security;

drop policy if exists finance_grants_select on finance_capability_grants;
create policy finance_grants_select on finance_capability_grants
  for select to authenticated
  using (
    user_id = auth.uid()
    or has_finance_capability('finance.manage_access', null)
  );

drop policy if exists finance_policy_select on finance_policy_versions;
create policy finance_policy_select on finance_policy_versions
  for select to authenticated
  using (
    has_finance_capability('finance.view_company', null)
    or has_finance_capability('finance.manage_policy', null)
  );

drop policy if exists project_finance_profiles_select on project_finance_profiles;
create policy project_finance_profiles_select on project_finance_profiles
  for select to authenticated
  using (can_view_finance_project(project_id));

drop policy if exists forecast_baselines_select on forecast_baselines;
create policy forecast_baselines_select on forecast_baselines
  for select to authenticated
  using (can_view_finance_project(project_id));

drop policy if exists finance_forecast_lines_select on finance_forecast_lines;
create policy finance_forecast_lines_select on finance_forecast_lines
  for select to authenticated
  using (can_view_finance_project(project_id));

drop policy if exists finance_activation_events_select on finance_activation_events;
create policy finance_activation_events_select on finance_activation_events
  for select to authenticated
  using (can_view_finance_project(project_id));

drop policy if exists finance_projection_versions_select on finance_projection_versions;
create policy finance_projection_versions_select on finance_projection_versions
  for select to authenticated
  using (
    (scope_type = 'company' and has_finance_capability('finance.view_company', null))
    or (scope_type = 'project' and can_view_finance_project(project_id))
  );

drop policy if exists finance_projection_periods_select on finance_projection_periods;
create policy finance_projection_periods_select on finance_projection_periods
  for select to authenticated
  using (
    exists (
      select 1
      from finance_projection_versions v
      where v.id = projection_id
        and (
          (v.scope_type = 'company' and has_finance_capability('finance.view_company', null))
          or (v.scope_type = 'project' and can_view_finance_project(v.project_id))
        )
    )
  );

drop policy if exists finance_projection_contributions_select on finance_projection_contributions;
create policy finance_projection_contributions_select on finance_projection_contributions
  for select to authenticated
  using (
    exists (
      select 1
      from finance_projection_versions v
      where v.id = projection_id
        and (
          (v.scope_type = 'company' and has_finance_capability('finance.view_company', null))
          or (v.scope_type = 'project' and can_view_finance_project(v.project_id))
        )
    )
  );

drop policy if exists finance_audit_events_select on finance_audit_events;
create policy finance_audit_events_select on finance_audit_events
  for select to authenticated
  using (
    has_finance_capability('finance.view_audit', null)
    and (project_id is null or can_view_finance_project(project_id))
  );

-- All writes pass through audited/domain functions (or later narrowly
-- scoped service-role workers). Authenticated clients can read only the
-- rows their capability allows.
revoke insert, update, delete on finance_capability_grants from authenticated;
revoke insert, update, delete on finance_policy_versions from authenticated;
revoke insert, update, delete on project_finance_profiles from authenticated;
revoke insert, update, delete on forecast_baselines from authenticated;
revoke insert, update, delete on finance_forecast_lines from authenticated;
revoke insert, update, delete on finance_activation_events from authenticated;
revoke insert, update, delete on finance_projection_versions from authenticated;
revoke insert, update, delete on finance_projection_periods from authenticated;
revoke insert, update, delete on finance_projection_contributions from authenticated;
revoke insert, update, delete on finance_audit_events from authenticated;

grant select on finance_capability_grants to authenticated;
grant select on finance_policy_versions to authenticated;
grant select on project_finance_profiles to authenticated;
grant select on forecast_baselines to authenticated;
grant select on finance_forecast_lines to authenticated;
grant select on finance_activation_events to authenticated;
grant select on finance_projection_versions to authenticated;
grant select on finance_projection_periods to authenticated;
grant select on finance_projection_contributions to authenticated;
grant select on finance_audit_events to authenticated;

grant all on finance_capability_grants to service_role;
grant all on finance_policy_versions to service_role;
grant all on project_finance_profiles to service_role;
grant all on forecast_baselines to service_role;
grant all on finance_forecast_lines to service_role;
grant all on finance_activation_events to service_role;
grant all on finance_projection_versions to service_role;
grant all on finance_projection_periods to service_role;
grant all on finance_projection_contributions to service_role;
grant all on finance_audit_events to service_role;

comment on table finance_capability_grants is
  'Explicit company/project finance capabilities. Project grants never authorise company aggregates.';
comment on table project_finance_profiles is
  'One finance lifecycle record per project. Project existence alone never activates construction finance.';
comment on table forecast_baselines is
  'Immutable estimate, program and policy snapshot created by explicit activation.';
comment on table finance_forecast_lines is
  'Immutable contribution-level baseline inputs in integer minor units. Unmapped timing remains null/unknown.';
comment on function activate_project_finance(uuid, date, uuid, text, uuid, jsonb, text, text, integer) is
  'Atomic, capability-gated project finance activation with idempotency and optimistic concurrency.';

notify pgrst, 'reload schema';
