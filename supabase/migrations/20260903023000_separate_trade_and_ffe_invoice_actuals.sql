-- Keep Estimate labour/install actuals separate from FF&E product actuals.
-- An item link on a cost line is contextual; it does not merge the two
-- financial lanes. Approved invoice_allocations are the FF&E actual ledger.

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
  if v_invoice.status = 'voided' then raise exception 'Cannot approve a voided invoice'; end if;
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
          and cost_scope <> 'trade_package'
          and deleted_at is null
      ) then raise exception 'A matched direct item was not found in this project'; end if;
    elsif v_allocation.match_type = 'item_component' then
      if not exists (
        select 1 from item_components component
        join items item on item.id = component.item_id
        where component.id = v_allocation.match_id
          and component.deleted_at is null
          and item.deleted_at is null
          and item.cost_scope <> 'trade_package'
          and item.project_id = v_invoice.project_id
      ) then raise exception 'A matched direct-item component was not found in this project'; end if;
    else
      raise exception 'Invalid invoice allocation match type';
    end if;
  end loop;

  for v_allocation in
    select * from invoice_allocations where invoice_id = p_invoice_id order by sort, created_at
  loop
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
      -- Only trade/installation allocations alter Estimate actuals. A linked
      -- item is context, not permission to count or reprice its product.
      update cost_lines
      set actual_paid_ex_gst = round(
        coalesce(actual_paid_ex_gst, 0) + v_allocation.amount_ex_gst,
        2
      )
      where id = v_allocation.match_id;
      continue;
    elsif v_allocation.match_type = 'item' then
      v_item_id := v_allocation.match_id;
    else
      v_component_id := v_allocation.match_id;
      select component.item_id, component.library_item_id, component.quantity_per_item
      into v_item_id, v_library_item_id, v_component_quantity
      from item_components component
      where component.id = v_component_id and component.deleted_at is null;
    end if;

    -- The approved allocation is the durable FF&E actual. Detailed source
    -- lines may refresh the project price; the checkbox separately controls
    -- whether the reusable library price changes.
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
          v_library_item_id, p_invoice_id, v_allocation.source_line_id,
          v_invoice.supplier, v_supplier_item_code, v_previous_library_price,
          v_unit_cost, coalesce(v_source_quantity, v_project_quantity),
          coalesce(v_invoice.invoice_date, current_date),
          'Invoice ' || v_invoice.invoice_number || ' · ' || v_invoice.supplier,
          p_approved_by
        )
        on conflict (invoice_line_id) where invoice_line_id is not null do nothing;

        update invoice_allocations set library_cost_applied = true
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

create or replace function void_supplier_invoice(
  p_invoice_id uuid,
  p_voided_by uuid,
  p_reason text default 'Voided by admin'
)
returns invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_allocation invoice_allocations%rowtype;
  v_current_actual numeric(12,2);
begin
  if session_user <> 'postgres' then
    if coalesce(auth.role(), '') <> 'service_role' then
      if auth.uid() is null
         or p_voided_by <> auth.uid()
         or not exists (
           select 1 from profiles where id = auth.uid() and role = 'admin'
         )
      then
        raise exception 'Only admins can void invoices';
      end if;
    end if;
  end if;

  select * into v_invoice
  from invoices
  where id = p_invoice_id
  for update;

  if not found then raise exception 'Invoice not found'; end if;
  if v_invoice.status = 'voided' then raise exception 'Invoice is already voided'; end if;
  if v_invoice.status = 'rejected' then raise exception 'A rejected invoice cannot be voided'; end if;

  if v_invoice.status = 'approved' then
    for v_allocation in
      select *
      from invoice_allocations
      where invoice_id = p_invoice_id
        and match_type = 'cost_line'
      order by sort, created_at
    loop
      select actual_paid_ex_gst into v_current_actual
      from cost_lines
      where id = v_allocation.match_id
        and project_id = v_invoice.project_id
        and deleted_at is null
      for update;

      if not found then
        raise exception 'Cannot reverse an allocation because its cost line is missing';
      end if;
      if coalesce(v_current_actual, 0) < v_allocation.amount_ex_gst then
        raise exception 'Cannot reverse an allocation below zero actual cost';
      end if;

      update cost_lines
      set actual_paid_ex_gst = round(
        coalesce(actual_paid_ex_gst, 0) - v_allocation.amount_ex_gst,
        2
      )
      where id = v_allocation.match_id;
    end loop;
  end if;

  update invoices
  set status = 'voided',
      voided_by = p_voided_by,
      voided_at = now(),
      void_reason = coalesce(nullif(btrim(p_reason), ''), 'Voided by admin')
  where id = p_invoice_id
  returning * into v_invoice;

  return v_invoice;
end;
$$;

comment on function approve_supplier_invoice_allocations(uuid, uuid) is
  'Approves exact invoice allocations. Cost-line matches update trade/install actuals; item and component matches remain FF&E actuals represented by invoice allocations.';
comment on function void_supplier_invoice(uuid, uuid, text) is
  'Voids an invoice and reverses only cost-line actuals. FF&E actuals disappear from reporting with the voided invoice status.';

revoke all on function approve_supplier_invoice_allocations(uuid, uuid) from public;
grant execute on function approve_supplier_invoice_allocations(uuid, uuid) to authenticated;
grant execute on function approve_supplier_invoice_allocations(uuid, uuid) to service_role;
revoke all on function void_supplier_invoice(uuid, uuid, text) from public;
grant execute on function void_supplier_invoice(uuid, uuid, text) to authenticated;
grant execute on function void_supplier_invoice(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
