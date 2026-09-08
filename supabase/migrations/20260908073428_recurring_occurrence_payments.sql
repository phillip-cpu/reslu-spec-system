-- Prospective occurrence tracking: old anchor dates are not proof of unpaid debt.
alter table public.finance_recurring_commitments
  add column if not exists tracking_started_on date not null default current_date;
comment on column public.finance_recurring_commitments.tracking_started_on is
  'First date whose unpaid occurrences remain outstanding. Existing commitments begin tracking on migration day; no historical payment is inferred.';

-- New one-time purchases are explicit obligations even if entered after their due
-- date. This INSERT-only rule leaves migrated records and repeated anchors alone.
create function public.initialize_recurring_occurrence_tracking()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.frequency = 'once' then
    new.tracking_started_on := least(current_date, new.first_due_date);
  end if;
  return new;
end;
$$;
revoke all on function public.initialize_recurring_occurrence_tracking() from public, anon, authenticated;
create trigger finance_recurring_initialize_occurrence_tracking
  before insert on public.finance_recurring_commitments
  for each row execute function public.initialize_recurring_occurrence_tracking();

create table public.finance_recurring_occurrence_payments (
  commitment_id uuid not null references public.finance_recurring_commitments(id) on delete restrict,
  due_date date not null,
  scheduled_amount_minor bigint not null check (scheduled_amount_minor > 0 and scheduled_amount_minor <= 9007199254740991),
  amount_paid_minor bigint not null check (amount_paid_minor >= 0 and amount_paid_minor <= scheduled_amount_minor),
  paid_on date,
  payment_entries jsonb not null check (jsonb_typeof(payment_entries) = 'array'),
  version integer not null default 1 check (version > 0),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (commitment_id, due_date),
  check ((amount_paid_minor = 0 and paid_on is null and jsonb_array_length(payment_entries) = 0)
    or (amount_paid_minor > 0 and paid_on is not null and jsonb_array_length(payment_entries) > 0))
);
create index finance_recurring_occurrence_payments_due_idx
  on public.finance_recurring_occurrence_payments(due_date);
alter table public.finance_recurring_occurrence_payments enable row level security;
revoke all on public.finance_recurring_occurrence_payments from public, anon, authenticated;
grant select on public.finance_recurring_occurrence_payments to authenticated;
grant all on public.finance_recurring_occurrence_payments to service_role;
create policy finance_recurring_occurrence_payments_read
  on public.finance_recurring_occurrence_payments for select to authenticated
  using ((select public.has_finance_capability('finance.view_company', null))
      or (select public.has_finance_capability('finance.edit_forecast', null)));

alter table public.invoices add column if not exists recurring_due_date date;
alter table public.invoices add constraint invoices_recurring_due_date_requires_commitment
  check (recurring_due_date is null or recurring_commitment_id is not null);
alter table public.invoices add constraint invoices_recurring_occurrence_aud_only
  check (recurring_due_date is null or currency_code is not distinct from 'AUD');
create unique index invoices_one_approved_recurring_occurrence
  on public.invoices(recurring_commitment_id, recurring_due_date)
  where status = 'approved' and recurring_due_date is not null;
comment on column public.invoices.recurring_due_date is
  'Explicit occurrence replaced by this company bill; never inferred from invoice or payment date.';

-- Date calculation is anchored to the original day (Jan 31 -> Feb 28 -> Mar 31).
create function public.finance_recurring_date_matches(
  p_first date, p_frequency text, p_end date, p_due date
) returns boolean language plpgsql immutable security invoker
set search_path = '' as $$
declare
  v_days integer;
  v_months integer;
  v_step integer;
begin
  if p_due is null or p_first is null or p_due < p_first or (p_end is not null and p_due > p_end) then return false; end if;
  if p_frequency = 'once' then return p_due = p_first; end if;
  if p_frequency in ('weekly', 'fortnightly') then
    v_days := p_due - p_first;
    v_step := case when p_frequency = 'weekly' then 7 else 14 end;
    return mod(v_days, v_step) = 0 and v_days / v_step < 10000;
  end if;
  v_step := case p_frequency when 'monthly' then 1 when 'quarterly' then 3 when 'annually' then 12 else null end;
  if v_step is null then return false; end if;
  v_months := (extract(year from p_due)::integer - extract(year from p_first)::integer) * 12
    + extract(month from p_due)::integer - extract(month from p_first)::integer;
  return mod(v_months, v_step) = 0 and v_months / v_step < 10000
    and (p_first + make_interval(months => v_months))::date = p_due;
end;
$$;
revoke all on function public.finance_recurring_date_matches(date, text, date, date) from public, anon;
grant execute on function public.finance_recurring_date_matches(date, text, date, date) to authenticated, service_role;

-- Definer is required only for the audited mutation: clients have SELECT, not direct writes.
-- Authentication, capability, schedule, total and optimistic version are enforced in the DB.
create function public.record_finance_recurring_payment(
  p_commitment_id uuid, p_due_date date, p_amount_minor bigint, p_paid_on date,
  p_expected_version integer, p_expected_commitment_version integer, p_reason text
) returns public.finance_recurring_occurrence_payments
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_commitment public.finance_recurring_commitments%rowtype;
  v_existing public.finance_recurring_occurrence_payments%rowtype;
  v_saved public.finance_recurring_occurrence_payments%rowtype;
  v_scheduled bigint;
  v_years integer;
  v_total bigint;
  v_entries jsonb;
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.has_finance_capability('finance.edit_forecast', null) then
    raise exception 'Missing finance.edit_forecast capability' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Payment reference or note is required'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 9007199254740991 then raise exception 'Payment amount must be positive minor units'; end if;
  if p_paid_on is null or p_paid_on > (now() at time zone 'Australia/Adelaide')::date then raise exception 'Enter the actual payment date, not a future date'; end if;
  select * into v_commitment from public.finance_recurring_commitments where id = p_commitment_id for update;
  if not found then raise exception 'Recurring commitment not found'; end if;
  if p_expected_commitment_version is null or p_expected_commitment_version <> v_commitment.version then
    raise exception 'Commitment changed; refresh before recording payment' using errcode = '40001';
  end if;
  select * into v_existing from public.finance_recurring_occurrence_payments
    where commitment_id = p_commitment_id and due_date = p_due_date for update;
  if p_expected_version is null or p_expected_version <> coalesce(v_existing.version, 0) then
    raise exception 'Payment changed; refresh before recording another payment' using errcode = '40001';
  end if;
  if v_existing.commitment_id is null then
    if v_commitment.status <> 'active' then raise exception 'Only active commitments can receive a new occurrence'; end if;
    if not public.finance_recurring_date_matches(v_commitment.first_due_date, v_commitment.frequency, v_commitment.end_date, p_due_date) then
      raise exception 'Due date is not an occurrence of this commitment';
    end if;
    v_years := extract(year from p_due_date)::integer - extract(year from v_commitment.first_due_date)::integer;
    if to_char(p_due_date, 'MMDD') < to_char(v_commitment.first_due_date, 'MMDD') then v_years := v_years - 1; end if;
    v_scheduled := round(v_commitment.amount_minor::numeric * power(1 + v_commitment.annual_escalation_bps::numeric / 10000, greatest(v_years, 0)))::bigint;
  else
    v_scheduled := v_existing.scheduled_amount_minor;
  end if;
  if exists (select 1 from public.invoices where status = 'approved'
    and recurring_commitment_id = p_commitment_id and recurring_due_date = p_due_date) then
    raise exception 'This occurrence is linked to a company bill; record its payment on the bill';
  end if;
  v_total := coalesce(v_existing.amount_paid_minor, 0) + p_amount_minor;
  if v_total > v_scheduled then raise exception 'Payment exceeds the outstanding amount for this occurrence'; end if;
  v_entries := coalesce(v_existing.payment_entries, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('amount_minor', p_amount_minor, 'paid_on', p_paid_on));
  insert into public.finance_recurring_occurrence_payments (
    commitment_id, due_date, scheduled_amount_minor, amount_paid_minor, paid_on,
    payment_entries, version, created_by, updated_by
  ) values (p_commitment_id, p_due_date, v_scheduled, v_total,
    greatest(v_existing.paid_on, p_paid_on), v_entries, 1, v_actor, v_actor)
  on conflict (commitment_id, due_date) do update
    set amount_paid_minor = excluded.amount_paid_minor, paid_on = excluded.paid_on,
      payment_entries = excluded.payment_entries, version = finance_recurring_occurrence_payments.version + 1,
      updated_by = v_actor, updated_at = now()
  returning * into v_saved;
  insert into public.finance_audit_events(actor_id, source, action, object_type, object_id, payload)
  values (v_actor, 'recurring_occurrence_payment', 'record_payment', 'finance_recurring_commitment', p_commitment_id,
    jsonb_build_object('due_date', p_due_date, 'amount_minor', p_amount_minor, 'paid_on', p_paid_on,
      'total_paid_minor', v_saved.amount_paid_minor, 'version', v_saved.version, 'reason', trim(p_reason)));
  return v_saved;
end;
$$;
revoke all on function public.record_finance_recurring_payment(uuid, date, bigint, date, integer, integer, text) from public, anon;
grant execute on function public.record_finance_recurring_payment(uuid, date, bigint, date, integer, integer, text) to authenticated, service_role;

-- Correct a mistaken record; this is not a refund or a bank transfer.
-- Keep a zero-balance row and increase its version, preventing stale version-0 saves after undo.
create function public.undo_finance_recurring_payment(
  p_commitment_id uuid, p_due_date date, p_expected_version integer,
  p_expected_commitment_version integer, p_reason text
) returns public.finance_recurring_occurrence_payments
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_commitment public.finance_recurring_commitments%rowtype;
  v_existing public.finance_recurring_occurrence_payments%rowtype;
  v_saved public.finance_recurring_occurrence_payments%rowtype;
  v_removed jsonb;
  v_entries jsonb;
  v_paid_on date;
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.has_finance_capability('finance.edit_forecast', null) then
    raise exception 'Missing finance.edit_forecast capability' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Correction reason is required'; end if;
  select * into v_commitment from public.finance_recurring_commitments where id = p_commitment_id for update;
  if not found then raise exception 'Recurring commitment not found'; end if;
  if p_expected_commitment_version is null or p_expected_commitment_version <> v_commitment.version then
    raise exception 'Commitment changed; refresh before correcting payment' using errcode = '40001';
  end if;
  select * into v_existing from public.finance_recurring_occurrence_payments
    where commitment_id = p_commitment_id and due_date = p_due_date for update;
  if not found or p_expected_version is null or p_expected_version <> v_existing.version then
    raise exception 'Payment changed; refresh before correcting payment' using errcode = '40001';
  end if;
  if jsonb_array_length(v_existing.payment_entries) = 0 then raise exception 'There is no payment to undo'; end if;
  if exists (select 1 from public.invoices where status = 'approved'
    and recurring_commitment_id = p_commitment_id and recurring_due_date = p_due_date) then
    raise exception 'This occurrence is linked to a company bill; review the payment on that bill';
  end if;
  v_removed := v_existing.payment_entries -> (jsonb_array_length(v_existing.payment_entries) - 1);
  v_entries := v_existing.payment_entries - (jsonb_array_length(v_existing.payment_entries) - 1);
  select max((value ->> 'paid_on')::date) into v_paid_on from jsonb_array_elements(v_entries);
  update public.finance_recurring_occurrence_payments
    set payment_entries = v_entries,
      amount_paid_minor = amount_paid_minor - (v_removed ->> 'amount_minor')::bigint,
      paid_on = v_paid_on, version = version + 1, updated_by = v_actor, updated_at = now()
    where commitment_id = p_commitment_id and due_date = p_due_date returning * into v_saved;
  insert into public.finance_audit_events(actor_id, source, action, object_type, object_id, payload)
  values (v_actor, 'recurring_occurrence_payment', 'undo_recorded_payment', 'finance_recurring_commitment', p_commitment_id,
    jsonb_build_object('due_date', p_due_date, 'removed_payment', v_removed,
      'total_paid_minor', v_saved.amount_paid_minor, 'version', v_saved.version, 'reason', trim(p_reason)));
  return v_saved;
end;
$$;
revoke all on function public.undo_finance_recurring_payment(uuid, date, integer, integer, text) from public, anon;
grant execute on function public.undo_finance_recurring_payment(uuid, date, integer, integer, text) to authenticated, service_role;
notify pgrst, 'reload schema';
