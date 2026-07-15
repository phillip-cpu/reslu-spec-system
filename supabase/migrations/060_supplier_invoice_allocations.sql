-- ============================================================
-- RESLU Spec System — supplier invoice split allocation.
--
-- One supplier invoice can cover several estimate/spec lines. Draft
-- allocations are editable, but approval is permitted only when every
-- ex-GST cent is allocated. Both saving and applying a split happen in
-- database functions so a partial failure cannot leave misleading
-- financial actuals.
-- ============================================================

create table if not exists invoice_allocations (
  id                      uuid primary key default gen_random_uuid(),
  invoice_id              uuid not null references invoices(id) on delete cascade,
  match_type              text not null check (match_type in ('cost_line', 'item')),
  match_id                uuid not null,
  amount_ex_gst           numeric(12,2) not null check (amount_ex_gst > 0),
  apply_to_library_cost   boolean not null default false,
  library_cost_applied    boolean not null default false,
  sort                    integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (invoice_id, match_type, match_id)
);

create index if not exists idx_invoice_allocations_invoice
  on invoice_allocations(invoice_id, sort);

drop trigger if exists trg_invoice_allocations_updated_at on invoice_allocations;
create trigger trg_invoice_allocations_updated_at
  before update on invoice_allocations
  for each row execute function set_updated_at();

alter table invoice_allocations enable row level security;
drop policy if exists "team_all" on invoice_allocations;
create policy "team_all" on invoice_allocations
  for all to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- Draft splits may be read by the admin UI, but all writes go through
-- the validating functions below. This also closes the small race that
-- direct table DML could otherwise create during approval.
revoke insert, update, delete on invoice_allocations from authenticated;
grant select on invoice_allocations to authenticated;

comment on table invoice_allocations is
  'Approval-gated ex-GST allocations for a supplier invoice. The polymorphic match is validated against the invoice project by set_supplier_invoice_allocations and applied atomically by approve_supplier_invoice_allocations.';

-- Convert any live legacy one-match draft to the new one-line model.
-- Approved history remains untouched; its original match columns stay
-- available for audit/backwards compatibility.
insert into invoice_allocations (
  invoice_id,
  match_type,
  match_id,
  amount_ex_gst,
  apply_to_library_cost,
  sort
)
select
  i.id,
  i.proposed_match_type,
  i.proposed_match_id,
  i.amount_ex_gst,
  false,
  0
from invoices i
where i.status = 'proposed'
  and i.proposed_match_type is not null
  and i.proposed_match_id is not null
  and (
    (
      i.proposed_match_type = 'cost_line'
      and exists (
        select 1 from cost_lines c
        where c.id = i.proposed_match_id
          and c.project_id = i.project_id
          and c.deleted_at is null
      )
    )
    or
    (
      i.proposed_match_type = 'item'
      and exists (
        select 1 from items it
        where it.id = i.proposed_match_id
          and it.project_id = i.project_id
          and it.deleted_at is null
      )
    )
  )
on conflict (invoice_id, match_type, match_id) do nothing;

update invoices
set proposed_match_type = null,
    proposed_match_id = null,
    status = 'proposed'
where status = 'proposed'
  and exists (
    select 1 from invoice_allocations a where a.invoice_id = invoices.id
  );

-- A legacy cross-project/deleted target is unsafe. Do not preserve it
-- merely for backwards compatibility; return the draft to unmatched so
-- an admin has to choose a real current target.
update invoices
set proposed_match_type = null,
    proposed_match_id = null,
    status = 'unmatched'
where status in ('unmatched', 'proposed')
  and proposed_match_type is not null
  and proposed_match_id is not null
  and not exists (
    select 1 from invoice_allocations a where a.invoice_id = invoices.id
  );

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
  v_amount numeric(12,2);
  v_total numeric(12,2) := 0;
  v_line_id uuid;
  v_linked_count integer;
  v_seen_line_ids uuid[] := '{}'::uuid[];
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

  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.status in ('approved', 'rejected') then
    raise exception 'Cannot edit an invoice that is already %', v_invoice.status;
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocations must be an array';
  end if;

  v_count := jsonb_array_length(p_allocations);
  if v_count > 50 then
    raise exception 'An invoice can have no more than 50 allocations';
  end if;

  for v_allocation in select value from jsonb_array_elements(p_allocations)
  loop
    v_match_type := v_allocation->>'match_type';
    v_match_id := (v_allocation->>'match_id')::uuid;
    v_amount := round((v_allocation->>'amount_ex_gst')::numeric, 2);

    if v_match_type is null or v_match_type not in ('cost_line', 'item') then
      raise exception 'Invalid invoice allocation match type';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Invoice allocation amounts must be greater than zero';
    end if;
    if v_match_type = 'cost_line' and not exists (
      select 1 from cost_lines
      where id = v_match_id
        and project_id = v_invoice.project_id
        and deleted_at is null
    ) then
      raise exception 'A matched cost line was not found in this project';
    end if;
    if v_match_type = 'cost_line' then
      v_line_id := v_match_id;
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

      select id into v_line_id
      from cost_lines
      where item_id = v_match_id
        and project_id = v_invoice.project_id
        and deleted_at is null
      limit 1;
    end if;

    if v_line_id = any(v_seen_line_ids) then
      raise exception 'Two allocations resolve to the same estimate cost line';
    end if;
    v_seen_line_ids := array_append(v_seen_line_ids, v_line_id);

    v_total := v_total + v_amount;
  end loop;

  if v_count > 0 and v_total <> v_invoice.amount_ex_gst then
    raise exception 'Allocations must equal the invoice ex-GST total';
  end if;

  delete from invoice_allocations where invoice_id = p_invoice_id;

  for v_allocation in select value from jsonb_array_elements(p_allocations)
  loop
    insert into invoice_allocations (
      invoice_id,
      match_type,
      match_id,
      amount_ex_gst,
      apply_to_library_cost,
      sort
    ) values (
      p_invoice_id,
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
  v_quantity numeric;
  v_linked_count integer;
  v_total numeric(12,2);
  v_library_applied boolean := false;
  v_seen_line_ids uuid[] := '{}'::uuid[];
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

  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.status = 'approved' then
    raise exception 'Invoice is already approved';
  end if;
  if v_invoice.status = 'rejected' then
    raise exception 'Cannot approve a rejected invoice';
  end if;
  if not exists (select 1 from invoice_allocations where invoice_id = p_invoice_id) then
    raise exception 'Invoice has no allocations to approve';
  end if;

  select coalesce(sum(amount_ex_gst), 0)
  into v_total
  from invoice_allocations
  where invoice_id = p_invoice_id;

  if v_total <> v_invoice.amount_ex_gst then
    raise exception 'Allocations must equal the invoice ex-GST total';
  end if;

  -- Validate every target before writing any actuals.
  for v_allocation in
    select * from invoice_allocations
    where invoice_id = p_invoice_id
    order by sort, created_at
  loop
    if v_allocation.match_type = 'cost_line' then
      v_line_id := v_allocation.match_id;
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

      select count(*)
      into v_linked_count
      from cost_lines
      where item_id = v_allocation.match_id
        and project_id = v_invoice.project_id
        and deleted_at is null;

      if v_linked_count = 0 then
        raise exception 'A matched item has no linked estimate cost line';
      elsif v_linked_count > 1 then
        raise exception 'A matched item has more than one linked estimate cost line';
      end if;

      select id into v_line_id
      from cost_lines
      where item_id = v_allocation.match_id
        and project_id = v_invoice.project_id
        and deleted_at is null
      limit 1;
    end if;

    if v_line_id = any(v_seen_line_ids) then
      raise exception 'Two allocations resolve to the same estimate cost line';
    end if;
    v_seen_line_ids := array_append(v_seen_line_ids, v_line_id);
  end loop;

  -- All checks passed. Apply every allocation inside this transaction.
  for v_allocation in
    select * from invoice_allocations
    where invoice_id = p_invoice_id
    order by sort, created_at
  loop
    v_item_id := null;
    v_library_item_id := null;
    v_quantity := null;

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
      into v_library_item_id, v_quantity
      from items
      where id = v_item_id;

      if v_library_item_id is not null then
        update library_items
        set price_trade = round(v_allocation.amount_ex_gst / greatest(coalesce(v_quantity, 1), 1), 2),
            trade_price_received_at = current_date,
            trade_price_source = 'Invoice ' || v_invoice.invoice_number || ' · ' || v_invoice.supplier
        where id = v_library_item_id;

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
