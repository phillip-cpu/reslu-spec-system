-- Company credit facilities are liquidity, not cash or revenue. They are kept
-- separately so the cockpit can show spendable headroom without disguising
-- debt as bank cash.
create table if not exists finance_credit_facilities (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (length(trim(name)) between 1 and 120),
  provider               text,
  facility_type          text not null check (facility_type in (
                           'overdraft', 'credit_card', 'line_of_credit', 'other'
                         )),
  credit_limit_minor     bigint not null check (credit_limit_minor > 0),
  current_balance_minor  bigint not null default 0 check (current_balance_minor >= 0),
  interest_rate_bps      integer check (
                           interest_rate_bps is null or interest_rate_bps between 0 and 100000
                         ),
  status                 text not null default 'active' check (status in (
                           'active', 'paused', 'closed'
                         )),
  notes                  text,
  version                integer not null default 1 check (version > 0),
  created_by             uuid references profiles(id) on delete set null,
  updated_by             uuid references profiles(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_finance_credit_facilities_active
  on finance_credit_facilities(updated_at desc)
  where status = 'active';
create index if not exists idx_finance_credit_facilities_created_by
  on finance_credit_facilities(created_by)
  where created_by is not null;
create index if not exists idx_finance_credit_facilities_updated_by
  on finance_credit_facilities(updated_by)
  where updated_by is not null;

drop trigger if exists trg_finance_credit_facilities_updated_at
  on finance_credit_facilities;
create trigger trg_finance_credit_facilities_updated_at
  before update on finance_credit_facilities
  for each row execute function set_updated_at();

create or replace function save_finance_credit_facility(
  p_id uuid,
  p_name text,
  p_provider text,
  p_facility_type text,
  p_credit_limit_minor bigint,
  p_current_balance_minor bigint,
  p_interest_rate_bps integer,
  p_status text,
  p_notes text,
  p_expected_version integer,
  p_reason text
)
returns finance_credit_facilities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing finance_credit_facilities%rowtype;
  v_saved finance_credit_facilities%rowtype;
  v_action text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if not has_finance_capability('finance.edit_forecast', null) then
    raise exception 'Missing finance.edit_forecast capability';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Change reason is required'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Facility name is required'; end if;

  if p_id is null then
    if p_expected_version is not null then
      raise exception 'expected_version must be null when creating a facility';
    end if;
    insert into finance_credit_facilities (
      name, provider, facility_type, credit_limit_minor, current_balance_minor,
      interest_rate_bps, status, notes, created_by, updated_by
    ) values (
      trim(p_name), nullif(trim(p_provider), ''), p_facility_type,
      p_credit_limit_minor, p_current_balance_minor, p_interest_rate_bps,
      p_status, nullif(trim(p_notes), ''), v_actor, v_actor
    ) returning * into v_saved;
    v_action := 'create';
  else
    select * into v_existing from finance_credit_facilities where id = p_id for update;
    if not found then raise exception 'Credit facility not found'; end if;
    if p_expected_version is null or p_expected_version <> v_existing.version then
      raise exception 'Credit facility changed; refresh before saving';
    end if;
    update finance_credit_facilities
    set name = trim(p_name),
        provider = nullif(trim(p_provider), ''),
        facility_type = p_facility_type,
        credit_limit_minor = p_credit_limit_minor,
        current_balance_minor = p_current_balance_minor,
        interest_rate_bps = p_interest_rate_bps,
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
    v_actor, 'credit_facility_register', v_action,
    'finance_credit_facility', v_saved.id,
    jsonb_build_object(
      'reason', trim(p_reason),
      'name', v_saved.name,
      'facility_type', v_saved.facility_type,
      'credit_limit_minor', v_saved.credit_limit_minor,
      'current_balance_minor', v_saved.current_balance_minor,
      'status', v_saved.status,
      'version', v_saved.version
    )
  );
  return v_saved;
end;
$$;

revoke all on function save_finance_credit_facility(
  uuid, text, text, text, bigint, bigint, integer, text, text, integer, text
) from public;
grant execute on function save_finance_credit_facility(
  uuid, text, text, text, bigint, bigint, integer, text, text, integer, text
) to authenticated, service_role;

alter table finance_credit_facilities enable row level security;

drop policy if exists finance_credit_facilities_select on finance_credit_facilities;
create policy finance_credit_facilities_select
  on finance_credit_facilities for select to authenticated
  using (
    has_finance_capability('finance.view_company', null)
    or has_finance_capability('finance.edit_forecast', null)
  );

revoke insert, update, delete on finance_credit_facilities from authenticated;
grant select on finance_credit_facilities to authenticated;
grant all on finance_credit_facilities to service_role;

comment on table finance_credit_facilities is
  'Audited overdrafts, cards and credit lines. Limits add liquidity headroom; balances are debt and never revenue or bank cash.';

notify pgrst, 'reload schema';
