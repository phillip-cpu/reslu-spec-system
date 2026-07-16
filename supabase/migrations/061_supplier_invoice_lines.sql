-- ============================================================
-- RESLU Spec System — supplier invoice source lines.
--
-- Keeps the supplier's SKU/quantity/unit pricing as immutable evidence,
-- then maps each line to a project estimate/specification destination.
-- Approval remains the only operation that changes actuals or prices.
-- ============================================================

create table if not exists supplier_invoice_lines (
  id                         uuid primary key default gen_random_uuid(),
  invoice_id                 uuid not null references invoices(id) on delete cascade,
  supplier_item_code         text,
  description                text not null,
  quantity                   numeric(12,3) not null check (quantity > 0),
  unit                       text,
  unit_price_ex_gst          numeric(12,2) check (unit_price_ex_gst >= 0),
  amount_ex_gst              numeric(12,2) not null check (amount_ex_gst > 0),
  gst                        numeric(12,2) check (gst >= 0),
  amount_inc_gst             numeric(12,2) check (amount_inc_gst > 0),
  raw_text                   text,
  suggested_match_type       text check (suggested_match_type in ('cost_line', 'item')),
  suggested_match_id         uuid,
  suggestion_note            text,
  apply_to_library_cost      boolean not null default false,
  sort                       integer not null default 0,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (invoice_id, sort),
  check (
    (suggested_match_type is null and suggested_match_id is null)
    or (suggested_match_type is not null and suggested_match_id is not null)
  )
);

create index if not exists idx_supplier_invoice_lines_invoice
  on supplier_invoice_lines(invoice_id, sort);

drop trigger if exists trg_supplier_invoice_lines_updated_at on supplier_invoice_lines;
create trigger trg_supplier_invoice_lines_updated_at
  before update on supplier_invoice_lines
  for each row execute function set_updated_at();

alter table supplier_invoice_lines enable row level security;
drop policy if exists "team_all" on supplier_invoice_lines;
create policy "team_all" on supplier_invoice_lines
  for all to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

comment on table supplier_invoice_lines is
  'Immutable supplier/PDF line evidence. Matching fields are suggestions only; invoice_allocations and explicit approval control all financial writes.';

alter table invoice_allocations
  add column if not exists source_line_id uuid references supplier_invoice_lines(id) on delete restrict;

-- Several supplier lines may legitimately map to one project target.
alter table invoice_allocations
  drop constraint if exists invoice_allocations_invoice_id_match_type_match_id_key;

create unique index if not exists idx_invoice_allocations_source_line
  on invoice_allocations(invoice_id, source_line_id)
  where source_line_id is not null;

comment on column invoice_allocations.source_line_id is
  'Supplier/PDF line this allocation came from. Null only for legacy or manually summarised allocations.';

create table if not exists library_price_history (
  id                    uuid primary key default gen_random_uuid(),
  library_item_id       uuid not null references library_items(id) on delete cascade,
  invoice_id            uuid references invoices(id) on delete set null,
  invoice_line_id       uuid references supplier_invoice_lines(id) on delete set null,
  supplier              text,
  supplier_item_code    text,
  previous_unit_price_ex_gst numeric(12,2),
  unit_price_ex_gst     numeric(12,2) not null check (unit_price_ex_gst >= 0),
  quantity              numeric(12,3),
  price_date            date not null default current_date,
  source                text not null,
  approved_by           uuid references profiles(id) on delete set null,
  created_at            timestamptz not null default now()
);

create index if not exists idx_library_price_history_item_date
  on library_price_history(library_item_id, price_date desc, created_at desc);

create unique index if not exists idx_library_price_history_invoice_line
  on library_price_history(invoice_line_id)
  where invoice_line_id is not null;

alter table library_price_history enable row level security;
drop policy if exists "team_all" on library_price_history;
create policy "team_all" on library_price_history
  for all to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

comment on table library_price_history is
  'Point-in-time approved supplier unit prices. library_items.price_trade holds the current value; this table preserves the invoice trail.';

-- Exact Bunnings W288707086-1 lines recovered from the ingested PDF.
-- This is evidence-only backfill: no allocation, approval, actual or
-- library price is created by this migration.
insert into supplier_invoice_lines (
  invoice_id, supplier_item_code, description, quantity, unit,
  unit_price_ex_gst, amount_ex_gst, gst, amount_inc_gst, sort
)
select
  '033fdbad-e885-45a9-a3be-fe855b4b22c3'::uuid,
  line.supplier_item_code,
  line.description,
  line.quantity,
  'EACH',
  line.unit_price_ex_gst,
  line.amount_ex_gst,
  line.gst,
  line.amount_inc_gst,
  line.sort
from (values
  (0, '9920161', 'Standard Metro UTE delivery', 1::numeric, 50.00::numeric, 50.00::numeric, 5.00::numeric, 55.00::numeric),
  (1, '3063570', 'Lattice maker stakes 25 × 25mm × 1200mm — pack of 6', 1::numeric, 16.40::numeric, 16.40::numeric, 1.64::numeric, 18.04::numeric),
  (2, '1038104', 'Rapid Onion barrier mesh 900mm × 50m', 1::numeric, 25.05::numeric, 25.05::numeric, 2.50::numeric, 27.55::numeric),
  (3, '3332296', 'Heavy-duty tarpaulin 160gsm — 3.0 × 3.6m silver/green', 1::numeric, 33.76::numeric, 33.76::numeric, 3.38::numeric, 37.14::numeric),
  (4, '0400888', 'Builders Edge carpet protective film — 73.1cm × 61m', 2::numeric, 44.31::numeric, 88.62::numeric, 8.86::numeric, 97.48::numeric),
  (5, '1214167', 'ScotchBlue Original masking tape — 48mm × 54.8m', 3::numeric, 12.26::numeric, 36.79::numeric, 3.68::numeric, 40.47::numeric),
  (6, '0948816', 'RamBoard 36-inch door jamb protector', 5::numeric, 16.46::numeric, 82.32::numeric, 8.23::numeric, 90.55::numeric),
  (7, '1090814', 'RamBoard surface protection tape — 72mm', 1::numeric, 19.09::numeric, 19.09::numeric, 1.91::numeric, 21.00::numeric),
  (8, '1090813', 'RamBoard temporary floor protection', 2::numeric, 115.87::numeric, 231.75::numeric, 23.17::numeric, 254.92::numeric),
  (9, '0712284', 'OCP Eco-Caterpillar Killer — 40g', 1::numeric, 20.87::numeric, 20.87::numeric, 2.09::numeric, 22.96::numeric)
) as line(sort, supplier_item_code, description, quantity, unit_price_ex_gst, amount_ex_gst, gst, amount_inc_gst)
where exists (
  select 1 from invoices
  where id = '033fdbad-e885-45a9-a3be-fe855b4b22c3'::uuid
    and approved_at is null
)
on conflict (invoice_id, sort) do nothing;

create or replace function set_supplier_invoice_allocations(
  p_invoice_id uuid,
  p_allocations jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_allocation jsonb;
  v_count integer;
  v_sort integer := 0;
  v_match_type text;
  v_match_id uuid;
  v_source_line_id uuid;
  v_source_amount numeric(12,2);
  v_amount numeric(12,2);
  v_total numeric(12,2) := 0;
  v_line_id uuid;
  v_linked_count integer;
  v_source_line_count integer;
  v_source_backed_count integer := 0;
  v_seen_source_line_ids uuid[] := '{}'::uuid[];
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Only admins can update invoice allocations';
  end if;

  select * into v_invoice
  from invoices
  where id = p_invoice_id
  for update;

  if not found then raise exception 'Invoice not found'; end if;
  if v_invoice.status in ('approved', 'rejected') then
    raise exception 'Cannot edit an invoice that is already %', v_invoice.status;
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocations must be an array';
  end if;

  v_count := jsonb_array_length(p_allocations);
  if v_count > 100 then
    raise exception 'An invoice can have no more than 100 allocations';
  end if;

  select count(*) into v_source_line_count
  from supplier_invoice_lines
  where invoice_id = p_invoice_id;

  for v_allocation in select value from jsonb_array_elements(p_allocations)
  loop
    v_match_type := v_allocation->>'match_type';
    v_match_id := (v_allocation->>'match_id')::uuid;
    v_source_line_id := nullif(v_allocation->>'source_line_id', '')::uuid;
    v_amount := round((v_allocation->>'amount_ex_gst')::numeric, 2);

    if v_match_type is null or v_match_type not in ('cost_line', 'item') then
      raise exception 'Invalid invoice allocation match type';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Invoice allocation amounts must be greater than zero';
    end if;

    if v_source_line_id is not null then
      select amount_ex_gst into v_source_amount
      from supplier_invoice_lines
      where id = v_source_line_id and invoice_id = p_invoice_id;
      if not found then
        raise exception 'A supplier invoice line was not found on this invoice';
      end if;
      if v_source_amount <> v_amount then
        raise exception 'A source-backed allocation must equal its supplier line amount';
      end if;
      if v_source_line_id = any(v_seen_source_line_ids) then
        raise exception 'A supplier invoice line cannot be allocated twice';
      end if;
      v_seen_source_line_ids := array_append(v_seen_source_line_ids, v_source_line_id);
      v_source_backed_count := v_source_backed_count + 1;
    end if;

    if v_match_type = 'cost_line' then
      if not exists (
        select 1 from cost_lines
        where id = v_match_id
          and project_id = v_invoice.project_id
          and deleted_at is null
      ) then
        raise exception 'A matched cost line was not found in this project';
      end if;
    else
      if not exists (
        select 1 from items
        where id = v_match_id
          and project_id = v_invoice.project_id
          and deleted_at is null
      ) then
        raise exception 'A matched item was not found in this project';
      end if;

      select count(*) into v_linked_count
      from cost_lines
      where item_id = v_match_id
        and project_id = v_invoice.project_id
        and deleted_at is null;
      if v_linked_count = 0 then
        raise exception 'A matched item has no linked estimate cost line';
      elsif v_linked_count > 1 then
        raise exception 'A matched item has more than one linked estimate cost line';
      end if;
    end if;

    v_total := v_total + v_amount;
  end loop;

  if v_count > 0 and v_total <> v_invoice.amount_ex_gst then
    raise exception 'Allocations must equal the invoice ex-GST total';
  end if;
  if v_source_line_count > 0 and v_count > 0 and v_source_backed_count <> v_source_line_count then
    raise exception 'Every supplier invoice line must have exactly one allocation';
  end if;

  delete from invoice_allocations where invoice_id = p_invoice_id;

  for v_allocation in select value from jsonb_array_elements(p_allocations)
  loop
    insert into invoice_allocations (
      invoice_id, source_line_id, match_type, match_id,
      amount_ex_gst, apply_to_library_cost, sort
    ) values (
      p_invoice_id,
      nullif(v_allocation->>'source_line_id', '')::uuid,
      v_allocation->>'match_type',
      (v_allocation->>'match_id')::uuid,
      round((v_allocation->>'amount_ex_gst')::numeric, 2),
      coalesce((v_allocation->>'apply_to_library_cost')::boolean, false),
      v_sort
    );
    v_sort := v_sort + 1;
  end loop;

  update invoices
  set proposed_match_type = null,
      proposed_match_id = null,
      status = case when v_count = 0 then 'unmatched' else 'proposed' end
  where id = p_invoice_id;
end;
$$;

create or replace function approve_supplier_invoice_allocations(
  p_invoice_id uuid,
  p_approved_by uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_allocation invoice_allocations%rowtype;
  v_line_id uuid;
  v_item_id uuid;
  v_library_item_id uuid;
  v_project_quantity numeric;
  v_source_quantity numeric;
  v_source_unit_price numeric(12,2);
  v_supplier_item_code text;
  v_unit_cost numeric(12,2);
  v_previous_library_price numeric(12,2);
  v_linked_count integer;
  v_total numeric(12,2);
  v_source_line_count integer;
  v_source_backed_count integer;
  v_library_applied boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or p_approved_by <> auth.uid() or not exists (
      select 1 from profiles where id = auth.uid() and role = 'admin'
    ) then
      raise exception 'Only admins can approve invoices';
    end if;
  end if;

  select * into v_invoice
  from invoices
  where id = p_invoice_id
  for update;

  if not found then raise exception 'Invoice not found'; end if;
  if v_invoice.status = 'approved' then raise exception 'Invoice is already approved'; end if;
  if v_invoice.status = 'rejected' then raise exception 'Cannot approve a rejected invoice'; end if;
  if not exists (select 1 from invoice_allocations where invoice_id = p_invoice_id) then
    raise exception 'Invoice has no allocations to approve';
  end if;

  select coalesce(sum(amount_ex_gst), 0), count(source_line_id)
  into v_total, v_source_backed_count
  from invoice_allocations
  where invoice_id = p_invoice_id;
  if v_total <> v_invoice.amount_ex_gst then
    raise exception 'Allocations must equal the invoice ex-GST total';
  end if;

  select count(*) into v_source_line_count
  from supplier_invoice_lines
  where invoice_id = p_invoice_id;
  if v_source_line_count > 0 and v_source_backed_count <> v_source_line_count then
    raise exception 'Every supplier invoice line must be allocated before approval';
  end if;

  -- Validate all targets and source amounts before any financial write.
  for v_allocation in
    select * from invoice_allocations
    where invoice_id = p_invoice_id
    order by sort, created_at
  loop
    if v_allocation.source_line_id is not null and not exists (
      select 1 from supplier_invoice_lines
      where id = v_allocation.source_line_id
        and invoice_id = p_invoice_id
        and amount_ex_gst = v_allocation.amount_ex_gst
    ) then
      raise exception 'A source-backed allocation no longer matches its supplier line';
    end if;

    if v_allocation.match_type = 'cost_line' then
      if not exists (
        select 1 from cost_lines
        where id = v_allocation.match_id
          and project_id = v_invoice.project_id
          and deleted_at is null
      ) then
        raise exception 'A matched cost line was not found in this project';
      end if;
    else
      if not exists (
        select 1 from items
        where id = v_allocation.match_id
          and project_id = v_invoice.project_id
          and deleted_at is null
      ) then
        raise exception 'A matched item was not found in this project';
      end if;
      select count(*) into v_linked_count
      from cost_lines
      where item_id = v_allocation.match_id
        and project_id = v_invoice.project_id
        and deleted_at is null;
      if v_linked_count = 0 then
        raise exception 'A matched item has no linked estimate cost line';
      elsif v_linked_count > 1 then
        raise exception 'A matched item has more than one linked estimate cost line';
      end if;
    end if;
  end loop;

  for v_allocation in
    select * from invoice_allocations
    where invoice_id = p_invoice_id
    order by sort, created_at
  loop
    v_item_id := null;
    v_library_item_id := null;
    v_project_quantity := null;
    v_source_quantity := null;
    v_source_unit_price := null;
    v_supplier_item_code := null;
    v_previous_library_price := null;

    if v_allocation.match_type = 'cost_line' then
      v_line_id := v_allocation.match_id;
      select item_id into v_item_id from cost_lines where id = v_line_id;
    else
      v_item_id := v_allocation.match_id;
      select id into v_line_id
      from cost_lines
      where item_id = v_item_id
        and project_id = v_invoice.project_id
        and deleted_at is null;
    end if;

    update cost_lines
    set actual_paid_ex_gst = round(coalesce(actual_paid_ex_gst, 0) + v_allocation.amount_ex_gst, 2)
    where id = v_line_id;

    if v_allocation.apply_to_library_cost and v_item_id is not null then
      select library_item_id, quantity
      into v_library_item_id, v_project_quantity
      from items
      where id = v_item_id;

      if v_allocation.source_line_id is not null then
        select quantity, unit_price_ex_gst, supplier_item_code
        into v_source_quantity, v_source_unit_price, v_supplier_item_code
        from supplier_invoice_lines
        where id = v_allocation.source_line_id;
        v_unit_cost := coalesce(
          v_source_unit_price,
          round(v_allocation.amount_ex_gst / greatest(coalesce(v_source_quantity, 1), 1), 2)
        );
      else
        v_unit_cost := round(
          v_allocation.amount_ex_gst / greatest(coalesce(v_project_quantity, 1), 1),
          2
        );
      end if;

      update items set price_trade = v_unit_cost where id = v_item_id;

      if v_library_item_id is not null then
        select price_trade into v_previous_library_price
        from library_items
        where id = v_library_item_id;

        update library_items
        set price_trade = v_unit_cost,
            trade_price_received_at = coalesce(v_invoice.invoice_date, current_date),
            trade_price_source = 'Invoice ' || v_invoice.invoice_number || ' · ' || v_invoice.supplier
        where id = v_library_item_id;

        insert into library_price_history (
          library_item_id, invoice_id, invoice_line_id, supplier,
          supplier_item_code, previous_unit_price_ex_gst,
          unit_price_ex_gst, quantity, price_date, source, approved_by
        ) values (
          v_library_item_id,
          p_invoice_id,
          v_allocation.source_line_id,
          v_invoice.supplier,
          v_supplier_item_code,
          v_previous_library_price,
          v_unit_cost,
          coalesce(v_source_quantity, v_project_quantity),
          coalesce(v_invoice.invoice_date, current_date),
          'Invoice ' || v_invoice.invoice_number || ' · ' || v_invoice.supplier,
          p_approved_by
        )
        on conflict (invoice_line_id) where invoice_line_id is not null do nothing;

        update invoice_allocations
        set library_cost_applied = true
        where id = v_allocation.id;
        v_library_applied := true;
      end if;
    end if;
  end loop;

  update invoices
  set status = 'approved',
      approved_by = p_approved_by,
      approved_at = now(),
      library_cost_applied = v_library_applied
  where id = p_invoice_id;

  return v_library_applied;
end;
$$;

revoke all on function set_supplier_invoice_allocations(uuid, jsonb) from public;
grant execute on function set_supplier_invoice_allocations(uuid, jsonb) to authenticated;
grant execute on function set_supplier_invoice_allocations(uuid, jsonb) to service_role;

revoke all on function approve_supplier_invoice_allocations(uuid, uuid) from public;
grant execute on function approve_supplier_invoice_allocations(uuid, uuid) to authenticated;
grant execute on function approve_supplier_invoice_allocations(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
