-- Preserve dated increments instead of moving all cash to the latest paid_at.
-- Empty history on existing invoices means their existing amount/date remains
-- the only known evidence. Do not manufacture earlier instalment dates.
alter table public.invoices add column payment_history jsonb not null default '[]'::jsonb
  check (jsonb_typeof(payment_history) = 'array');
comment on column public.invoices.payment_history is
  'Dated gross payment increments maintained from amount_paid/paid_at. Legacy empty history falls back to the recorded aggregate date; no earlier dates inferred.';

create function public.preserve_supplier_payment_history()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_entries jsonb := '[]'::jsonb;
  v_old_minor bigint := 0;
  v_new_minor bigint := round(coalesce(new.amount_paid, 0) * 100)::bigint;
  v_remove bigint;
  v_last integer;
  v_amount bigint;
  v_latest date;
begin
  if v_new_minor < 0 then raise exception 'Paid amount cannot be negative'; end if;
  if v_new_minor > 0 and new.paid_at is null then raise exception 'A recorded payment needs its actual date'; end if;
  if tg_op = 'UPDATE' then
    v_old_minor := round(coalesce(old.amount_paid, 0) * 100)::bigint;
    v_entries := old.payment_history;
    if jsonb_array_length(v_entries) = 0 and v_old_minor > 0 then
      if old.paid_at is null then raise exception 'Existing payment date needs review before editing'; end if;
      v_entries := jsonb_build_array(jsonb_build_object('amount_minor', v_old_minor, 'paid_on', old.paid_at));
    end if;
  end if;
  if v_new_minor > v_old_minor then
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'amount_minor', v_new_minor - v_old_minor, 'paid_on', new.paid_at));
  elsif v_new_minor < v_old_minor then
    -- Explicit downward corrections remove newest recorded increments first.
    -- This corrects the record; it does not create an assumed cash refund.
    v_remove := v_old_minor - v_new_minor;
    while v_remove > 0 and jsonb_array_length(v_entries) > 0 loop
      v_last := jsonb_array_length(v_entries) - 1;
      v_amount := (v_entries -> v_last ->> 'amount_minor')::bigint;
      if v_remove >= v_amount then
        v_entries := v_entries - v_last;
        v_remove := v_remove - v_amount;
      else
        v_entries := jsonb_set(v_entries, array[v_last::text, 'amount_minor'], to_jsonb(v_amount - v_remove));
        v_remove := 0;
      end if;
    end loop;
  elsif tg_op = 'UPDATE' and new.paid_at is distinct from old.paid_at and v_new_minor > 0 then
    -- A date-only correction changes the latest entry, not every instalment.
    select (entry.ordinality - 1)::integer into v_last
      from jsonb_array_elements(v_entries) with ordinality as entry(value, ordinality)
      order by (entry.value ->> 'paid_on')::date desc, entry.ordinality desc limit 1;
    v_entries := jsonb_set(v_entries, array[v_last::text, 'paid_on'], to_jsonb(new.paid_at));
  end if;
  if coalesce((select sum((value ->> 'amount_minor')::bigint) from jsonb_array_elements(v_entries)), 0) <> v_new_minor then
    raise exception 'Payment history does not match paid amount';
  end if;
  select max((value ->> 'paid_on')::date) into v_latest from jsonb_array_elements(v_entries);
  new.paid_at := v_latest;
  -- Ignore direct client attempts to supply history; the cash fields are the
  -- existing admin-controlled mutation interface and determine this ledger.
  new.payment_history := v_entries;
  return new;
end;
$$;
revoke all on function public.preserve_supplier_payment_history() from public, anon, authenticated;
create trigger invoices_preserve_payment_history before insert or update on public.invoices
  for each row execute function public.preserve_supplier_payment_history();
notify pgrst, 'reload schema';
