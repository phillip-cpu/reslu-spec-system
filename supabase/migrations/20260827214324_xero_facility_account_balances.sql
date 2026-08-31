-- Tie every manually maintained facility limit to the Xero bank or credit-card
-- account that supplies its balance. The balance itself remains exclusively in
-- the Xero read model; it is never copied into the facility register.
alter table public.finance_credit_facilities
  add column if not exists xero_bank_account_id uuid
    references public.xero_bank_accounts(id) on delete set null;

create index if not exists idx_finance_credit_facilities_xero_account
  on public.finance_credit_facilities(xero_bank_account_id)
  where xero_bank_account_id is not null;

create unique index if not exists uq_finance_credit_facilities_open_xero_account
  on public.finance_credit_facilities(xero_bank_account_id)
  where xero_bank_account_id is not null and status <> 'closed';

create or replace function public.save_finance_credit_facility(
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
  p_reason text,
  p_xero_bank_account_id uuid
)
returns public.finance_credit_facilities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.finance_credit_facilities%rowtype;
  v_saved public.finance_credit_facilities%rowtype;
  v_xero_account public.xero_bank_accounts%rowtype;
  v_action text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if not public.has_finance_capability('finance.edit_forecast', null) then
    raise exception 'Missing finance.edit_forecast capability';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Change reason is required'; end if;
  if p_xero_bank_account_id is null then raise exception 'Choose the matching Xero account'; end if;

  select * into v_xero_account
  from public.xero_bank_accounts
  where id = p_xero_bank_account_id
    and upper(coalesce(status, 'ACTIVE')) = 'ACTIVE'
    and upper(coalesce(bank_account_type, '')) in ('BANK', 'CREDITCARD');
  if not found then raise exception 'The Xero bank or credit-card account is unavailable'; end if;

  if upper(v_xero_account.bank_account_type) = 'CREDITCARD'
     and p_facility_type <> 'credit_card' then
    raise exception 'A Xero credit-card account must use the credit-card facility type';
  end if;
  if upper(v_xero_account.bank_account_type) = 'BANK'
     and p_facility_type = 'credit_card' then
    raise exception 'A Xero bank account cannot use the credit-card facility type';
  end if;
  if nullif(trim(p_name), '') is null then raise exception 'Facility name is required'; end if;

  if p_id is null then
    if p_expected_version is not null then
      raise exception 'expected_version must be null when creating a facility';
    end if;
    insert into public.finance_credit_facilities (
      name, provider, facility_type, credit_limit_minor, current_balance_minor,
      interest_rate_bps, status, notes, xero_bank_account_id, created_by, updated_by
    ) values (
      trim(p_name), nullif(trim(p_provider), ''), p_facility_type,
      p_credit_limit_minor, 0, p_interest_rate_bps,
      p_status, nullif(trim(p_notes), ''), p_xero_bank_account_id, v_actor, v_actor
    ) returning * into v_saved;
    v_action := 'create';
  else
    select * into v_existing
    from public.finance_credit_facilities
    where id = p_id
    for update;
    if not found then raise exception 'Credit facility not found'; end if;
    if p_expected_version is null or p_expected_version <> v_existing.version then
      raise exception 'Credit facility changed; refresh before saving';
    end if;
    update public.finance_credit_facilities
    set name = trim(p_name),
        provider = nullif(trim(p_provider), ''),
        facility_type = p_facility_type,
        credit_limit_minor = p_credit_limit_minor,
        current_balance_minor = 0,
        interest_rate_bps = p_interest_rate_bps,
        status = p_status,
        notes = nullif(trim(p_notes), ''),
        xero_bank_account_id = p_xero_bank_account_id,
        version = version + 1,
        updated_by = v_actor
    where id = p_id
    returning * into v_saved;
    v_action := 'update';
  end if;

  insert into public.finance_audit_events (
    actor_id, source, action, object_type, object_id, payload
  ) values (
    v_actor, 'credit_facility_register', v_action,
    'finance_credit_facility', v_saved.id,
    jsonb_build_object(
      'reason', trim(p_reason),
      'name', v_saved.name,
      'facility_type', v_saved.facility_type,
      'credit_limit_minor', v_saved.credit_limit_minor,
      'xero_bank_account_id', v_saved.xero_bank_account_id,
      'status', v_saved.status,
      'version', v_saved.version
    )
  );
  return v_saved;
end;
$$;

revoke all on function public.save_finance_credit_facility(
  uuid, text, text, text, bigint, bigint, integer, text, text, integer, text, uuid
) from public;
grant execute on function public.save_finance_credit_facility(
  uuid, text, text, text, bigint, bigint, integer, text, text, integer, text, uuid
) to authenticated, service_role;

comment on column public.finance_credit_facilities.xero_bank_account_id is
  'The Xero bank or credit-card account that supplies this facility balance. Users maintain the limit only.';

notify pgrst, 'reload schema';
