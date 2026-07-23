-- ============================================================
-- RESLU Spec System — approve specification-item invoice matches
-- without manufacturing duplicate estimate rows.
--
-- Specification items are already costed in the read-only FF&E
-- schedule rollup. A supplier invoice may therefore legitimately
-- match an item (or one of its assembly components) that has no
-- cost_lines row. Keep the invoice allocation as the actual-spend
-- record, update the project/library unit cost from source lines, and
-- credit a cost line only when exactly one real linked line exists.
-- ============================================================

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

  select * into v_invoice from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if v_invoice.status in ('approved', 'rejected') then
    raise exception 'Cannot edit an invoice that is already %', v_invoice.status;
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocations must be an array';
  end if;

  v_count := jsonb_array_length(p_allocations);
  if v_count > 100 then raise exception 'An invoice can have no more than 100 allocations'; end if;
  select count(*) into v_source_line_count
  from supplier_invoice_lines where invoice_id = p_invoice_id;

  for v_allocation in select value from jsonb_array_elements(p_allocations)
  loop
    v_match_type := v_allocation->>'match_type';
    v_match_id := (v_allocation->>'match_id')::uuid;
    v_source_line_id := nullif(v_allocation->>'source_line_id', '')::uuid;
    v_amount := round((v_allocation->>'amount_ex_gst')::numeric, 2);

    if v_match_type is null or v_match_type not in ('cost_line', 'item', 'item_component') then
      raise exception 'Invalid invoice allocation match type';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Invoice allocation amounts must be greater than zero';
    end if;

    if v_source_line_id is not null then
      select amount_ex_gst into v_source_amount
      from supplier_invoice_lines
      where id = v_source_line_id and invoice_id = p_invoice_id;
      if not found then raise exception 'A supplier invoice line was not found on this invoice'; end if;
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
        where id = v_match_id and project_id = v_invoice.project_id and deleted_at is null
      ) then raise exception 'A matched cost line was not found in this project'; end if;
    elsif v_match_type = 'item' then
      if not exists (
        select 1 from items
        where id = v_match_id and project_id = v_invoice.project_id and deleted_at is null
      ) then raise exception 'A matched item was not found in this project'; end if;
      select count(*) into v_linked_count
      from cost_lines
      where item_id = v_match_id and project_id = v_invoice.project_id and deleted_at is null;
      if v_linked_count > 1 then
        raise exception 'A matched item has more than one linked estimate cost line';
      end if;
    else
      if not exists (
        select 1
        from item_components component
        join items item on item.id = component.item_id
        where component.id = v_match_id
          and component.deleted_at is null
          and item.deleted_at is null
          and item.project_id = v_invoice.project_id
      ) then raise exception 'A matched assembly component was not found in this project'; end if;
      select count(*) into v_linked_count
      from cost_lines line
      join item_components component on component.item_id = line.item_id
      where component.id = v_match_id
        and line.project_id = v_invoice.project_id
        and line.deleted_at is null;
      if v_linked_count > 1 then
        raise exception 'A matched assembly has more than one linked estimate cost line';
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
  v_component_id uuid;
  v_library_item_id uuid;
  v_project_quantity numeric;
  v_component_quantity numeric;
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
    ) then raise exception 'Only admins can approve invoices'; end if;
  end if;

  select * into v_invoice from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if v_invoice.status = 'approved' then raise exception 'Invoice is already approved'; end if;
  if v_invoice.status = 'rejected' then raise exception 'Cannot approve a rejected invoice'; end if;
  if not exists (select 1 from invoice_allocations where invoice_id = p_invoice_id) then
    raise exception 'Invoice has no allocations to approve';
  end if;

  select coalesce(sum(amount_ex_gst), 0), count(source_line_id)
  into v_total, v_source_backed_count
  from invoice_allocations where invoice_id = p_invoice_id;
  if v_total <> v_invoice.amount_ex_gst then
    raise exception 'Allocations must equal the invoice ex-GST total';
  end if;
  select count(*) into v_source_line_count
  from supplier_invoice_lines where invoice_id = p_invoice_id;
  if v_source_line_count > 0 and v_source_backed_count <> v_source_line_count then
    raise exception 'Every supplier invoice line must be allocated before approval';
  end if;

  for v_allocation in
    select * from invoice_allocations where invoice_id = p_invoice_id order by sort, created_at
  loop
    if v_allocation.source_line_id is not null and not exists (
      select 1 from supplier_invoice_lines
      where id = v_allocation.source_line_id
        and invoice_id = p_invoice_id
        and amount_ex_gst = v_allocation.amount_ex_gst
    ) then raise exception 'A source-backed allocation no longer matches its supplier line'; end if;

    if v_allocation.match_type = 'cost_line' then
      if not exists (
        select 1 from cost_lines
        where id = v_allocation.match_id
          and project_id = v_invoice.project_id
          and deleted_at is null
      ) then raise exception 'A matched cost line was not found in this project'; end if;
    elsif v_allocation.match_type = 'item' then
      if not exists (
        select 1 from items
        where id = v_allocation.match_id
          and project_id = v_invoice.project_id
          and deleted_at is null
      ) then raise exception 'A matched item was not found in this project'; end if;
      select count(*) into v_linked_count
      from cost_lines
      where item_id = v_allocation.match_id
        and project_id = v_invoice.project_id
        and deleted_at is null;
      if v_linked_count > 1 then
        raise exception 'A matched item has more than one linked estimate cost line';
      end if;
    else
      if not exists (
        select 1 from item_components component
        join items item on item.id = component.item_id
        where component.id = v_allocation.match_id
          and component.deleted_at is null
          and item.deleted_at is null
          and item.project_id = v_invoice.project_id
      ) then raise exception 'A matched assembly component was not found in this project'; end if;
      select count(*) into v_linked_count
      from cost_lines line
      join item_components component on component.item_id = line.item_id
      where component.id = v_allocation.match_id
        and line.project_id = v_invoice.project_id
        and line.deleted_at is null;
      if v_linked_count > 1 then
        raise exception 'A matched assembly has more than one linked estimate cost line';
      end if;
    end if;
  end loop;

  for v_allocation in
    select * from invoice_allocations where invoice_id = p_invoice_id order by sort, created_at
  loop
    v_line_id := null;
    v_item_id := null;
    v_component_id := null;
    v_library_item_id := null;
    v_project_quantity := null;
    v_component_quantity := null;
    v_source_quantity := null;
    v_source_unit_price := null;
    v_supplier_item_code := null;
    v_previous_library_price := null;
    v_unit_cost := null;

    if v_allocation.match_type = 'cost_line' then
      v_line_id := v_allocation.match_id;
      select item_id into v_item_id from cost_lines where id = v_line_id;
    elsif v_allocation.match_type = 'item' then
      v_item_id := v_allocation.match_id;
      select id into v_line_id
      from cost_lines
      where item_id = v_item_id
        and project_id = v_invoice.project_id
        and deleted_at is null
      limit 1;
    else
      v_component_id := v_allocation.match_id;
      select component.item_id, component.library_item_id, component.quantity_per_item
      into v_item_id, v_library_item_id, v_component_quantity
      from item_components component
      where component.id = v_component_id and component.deleted_at is null;
      select id into v_line_id
      from cost_lines
      where item_id = v_item_id
        and project_id = v_invoice.project_id
        and deleted_at is null
      limit 1;
    end if;

    if v_line_id is not null then
      update cost_lines
      set actual_paid_ex_gst = round(coalesce(actual_paid_ex_gst, 0) + v_allocation.amount_ex_gst, 2)
      where id = v_line_id;
    end if;

    if v_item_id is not null
      and (v_allocation.source_line_id is not null or v_allocation.apply_to_library_cost)
    then
      if v_component_id is null then
        select library_item_id, quantity
        into v_library_item_id, v_project_quantity
        from items where id = v_item_id;
      else
        select quantity * v_component_quantity
        into v_project_quantity
        from items where id = v_item_id;
      end if;

      if v_allocation.source_line_id is not null then
        select quantity, unit_price_ex_gst, supplier_item_code
        into v_source_quantity, v_source_unit_price, v_supplier_item_code
        from supplier_invoice_lines where id = v_allocation.source_line_id;
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

      if v_component_id is null then
        update items
        set price_trade = v_unit_cost,
            trade_price_received_at = coalesce(v_invoice.invoice_date, current_date)
        where id = v_item_id;
      else
        update item_components
        set price_trade = v_unit_cost,
            trade_price_received_at = coalesce(v_invoice.invoice_date, current_date),
            trade_price_source = 'Invoice ' || v_invoice.invoice_number || ' · ' || v_invoice.supplier
        where id = v_component_id;
      end if;

      if v_allocation.apply_to_library_cost and v_library_item_id is not null then
        select price_trade into v_previous_library_price
        from library_items where id = v_library_item_id;
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
