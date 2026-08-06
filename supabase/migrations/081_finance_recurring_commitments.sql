-- ============================================================
-- RESLU Spec System - Company recurring commitments (Milestone 2)
--
-- Company overheads such as wages, super, rent and marketing live here.
-- Cash occurrences are generated deterministically by the application;
-- this table stores the approved recurrence rule, never expanded rows.
-- ============================================================

create table if not exists finance_recurring_commitments (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (length(trim(name)) between 1 and 120),
  category               text not null check (category in (
                           'wages', 'superannuation', 'rent', 'marketing',
                           'software', 'insurance', 'utilities',
                           'professional_fees', 'vehicles', 'other'
                         )),
  supplier_or_payee      text,
  amount_minor           bigint not null check (amount_minor > 0),
  frequency              text not null check (frequency in (
                           'weekly', 'fortnightly', 'monthly', 'quarterly', 'annually'
                         )),
  first_due_date         date not null,
  end_date               date check (end_date is null or end_date >= first_due_date),
  gst_treatment          text not null default 'inclusive' check (gst_treatment in (
                           'inclusive', 'exclusive', 'gst_free', 'not_applicable'
                         )),
  annual_escalation_bps  integer not null default 0
                         check (annual_escalation_bps between 0 and 10000),
  confidence             text not null default 'confirmed' check (confidence in (
                           'confirmed', 'high', 'medium', 'low', 'unknown'
                         )),
  status                 text not null default 'active' check (status in (
                           'draft', 'active', 'paused', 'archived'
                         )),
  notes                  text,
  version                integer not null default 1 check (version > 0),
  created_by             uuid references profiles(id) on delete set null,
  updated_by             uuid references profiles(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_finance_recurring_commitments_projection
  on finance_recurring_commitments(status, first_due_date, end_date)
  where status = 'active';

drop trigger if exists trg_finance_recurring_commitments_updated_at
  on finance_recurring_commitments;
create trigger trg_finance_recurring_commitments_updated_at
  before update on finance_recurring_commitments
  for each row execute function set_updated_at();

create or replace function save_finance_recurring_commitment(
  p_id uuid,
  p_name text,
  p_category text,
  p_supplier_or_payee text,
  p_amount_minor bigint,
  p_frequency text,
  p_first_due_date date,
  p_end_date date,
  p_gst_treatment text,
  p_annual_escalation_bps integer,
  p_confidence text,
  p_status text,
  p_notes text,
  p_expected_version integer,
  p_reason text
)
returns finance_recurring_commitments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing finance_recurring_commitments%rowtype;
  v_saved finance_recurring_commitments%rowtype;
  v_action text;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;
  if not has_finance_capability('finance.edit_forecast', null) then
    raise exception 'Missing finance.edit_forecast capability';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Change reason is required';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Commitment name is required';
  end if;
  if p_status = 'archived' then
    raise exception 'Use archive_finance_recurring_commitment to archive';
  end if;

  if p_id is null then
    if p_expected_version is not null then
      raise exception 'expected_version must be null when creating a commitment';
    end if;
    insert into finance_recurring_commitments (
      name, category, supplier_or_payee, amount_minor, frequency,
      first_due_date, end_date, gst_treatment, annual_escalation_bps,
      confidence, status, notes, created_by, updated_by
    ) values (
      trim(p_name), p_category, nullif(trim(p_supplier_or_payee), ''),
      p_amount_minor, p_frequency, p_first_due_date, p_end_date,
      p_gst_treatment, p_annual_escalation_bps, p_confidence, p_status,
      nullif(trim(p_notes), ''), v_actor, v_actor
    ) returning * into v_saved;
    v_action := 'create';
  else
    select * into v_existing
    from finance_recurring_commitments
    where id = p_id
    for update;
    if not found then
      raise exception 'Recurring commitment not found';
    end if;
    if v_existing.status = 'archived' then
      raise exception 'Archived recurring commitments are immutable';
    end if;
    if p_expected_version is null or p_expected_version <> v_existing.version then
      raise exception 'Recurring commitment changed; refresh before saving';
    end if;
    update finance_recurring_commitments
    set name = trim(p_name),
        category = p_category,
        supplier_or_payee = nullif(trim(p_supplier_or_payee), ''),
        amount_minor = p_amount_minor,
        frequency = p_frequency,
        first_due_date = p_first_due_date,
        end_date = p_end_date,
        gst_treatment = p_gst_treatment,
        annual_escalation_bps = p_annual_escalation_bps,
        confidence = p_confidence,
        status = p_status,
        notes = nullif(trim(p_notes), ''),
        version = version + 1,
        updated_by = v_actor
    where id = p_id
    returning * into v_saved;
    v_action := 'update';
  end if;

  insert into finance_audit_events (
    actor_id, source, action, object_type, object_id, payload
  ) values (
    v_actor, 'recurring_commitment_register', v_action,
    'finance_recurring_commitment', v_saved.id,
    jsonb_build_object(
      'reason', trim(p_reason),
      'name', v_saved.name,
      'category', v_saved.category,
      'amount_minor', v_saved.amount_minor,
      'frequency', v_saved.frequency,
      'first_due_date', v_saved.first_due_date,
      'status', v_saved.status,
      'version', v_saved.version
    )
  );

  return v_saved;
end;
$$;

create or replace function archive_finance_recurring_commitment(
  p_id uuid,
  p_expected_version integer,
  p_reason text
)
returns finance_recurring_commitments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_saved finance_recurring_commitments%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;
  if not has_finance_capability('finance.edit_forecast', null) then
    raise exception 'Missing finance.edit_forecast capability';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Archive reason is required';
  end if;

  update finance_recurring_commitments
  set status = 'archived', version = version + 1, updated_by = v_actor
  where id = p_id
    and version = p_expected_version
    and status <> 'archived'
  returning * into v_saved;
  if not found then
    raise exception 'Recurring commitment not found or changed; refresh before archiving';
  end if;

  insert into finance_audit_events (
    actor_id, source, action, object_type, object_id, payload
  ) values (
    v_actor, 'recurring_commitment_register', 'archive',
    'finance_recurring_commitment', v_saved.id,
    jsonb_build_object(
      'reason', trim(p_reason), 'name', v_saved.name, 'version', v_saved.version
    )
  );

  return v_saved;
end;
$$;

revoke all on function save_finance_recurring_commitment(
  uuid, text, text, text, bigint, text, date, date, text,
  integer, text, text, text, integer, text
) from public;
grant execute on function save_finance_recurring_commitment(
  uuid, text, text, text, bigint, text, date, date, text,
  integer, text, text, text, integer, text
) to authenticated, service_role;

revoke all on function archive_finance_recurring_commitment(uuid, integer, text)
  from public;
grant execute on function archive_finance_recurring_commitment(uuid, integer, text)
  to authenticated, service_role;

alter table finance_recurring_commitments enable row level security;

drop policy if exists finance_recurring_commitments_select
  on finance_recurring_commitments;
create policy finance_recurring_commitments_select
  on finance_recurring_commitments
  for select to authenticated
  using (
    has_finance_capability('finance.view_company', null)
    or has_finance_capability('finance.edit_forecast', null)
  );

revoke insert, update, delete on finance_recurring_commitments from authenticated;
grant select on finance_recurring_commitments to authenticated;
grant all on finance_recurring_commitments to service_role;

comment on table finance_recurring_commitments is
  'Audited company-level recurring cash commitments. amount_minor is the cash amount per occurrence; GST treatment is classification only.';
comment on function save_finance_recurring_commitment(
  uuid, text, text, text, bigint, text, date, date, text,
  integer, text, text, text, integer, text
) is 'Capability-gated create/update with optimistic concurrency and an immutable audit event.';

notify pgrst, 'reload schema';
