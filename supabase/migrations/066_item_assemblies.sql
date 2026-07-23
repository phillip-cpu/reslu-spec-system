-- ============================================================
-- RESLU Spec System — item assemblies and component-level invoices.
--
-- A client-facing item remains one specification line, while its
-- separately purchased bodies, cartridges, trim kits and accessories
-- are tracked as component rows. Component cost and procurement dates
-- roll up to the parent item. Invoice source lines can be matched to a
-- component and update that component's linked library price.
-- ============================================================

create table if not exists library_item_components (
  id                         uuid primary key default gen_random_uuid(),
  parent_library_item_id     uuid not null references library_items(id) on delete cascade,
  component_library_item_id  uuid references library_items(id) on delete set null,
  name                       text not null,
  supplier                   text,
  supplier_email             text,
  brand                      text,
  supplier_item_code         text,
  quantity_per_item          numeric(12,3) not null default 1 check (quantity_per_item > 0),
  unit                       text not null default 'ea',
  price_trade                numeric(12,2) check (price_trade >= 0),
  finish                     text,
  product_url                text,
  lead_time_weeks            numeric(6,1) check (lead_time_weeks >= 0),
  sort                       integer not null default 0,
  created_by                 uuid references profiles(id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  check (
    component_library_item_id is null
    or component_library_item_id <> parent_library_item_id
  )
);

create index if not exists idx_library_item_components_parent
  on library_item_components(parent_library_item_id, sort);
create index if not exists idx_library_item_components_component
  on library_item_components(component_library_item_id)
  where component_library_item_id is not null;

drop trigger if exists trg_library_item_components_updated_at on library_item_components;
create trigger trg_library_item_components_updated_at
  before update on library_item_components
  for each row execute function set_updated_at();

alter table library_item_components enable row level security;
drop policy if exists "team_all" on library_item_components;
create policy "team_all" on library_item_components
  for all to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

create table if not exists item_components (
  id                       uuid primary key default gen_random_uuid(),
  item_id                  uuid not null references items(id) on delete cascade,
  library_item_id          uuid references library_items(id) on delete set null,
  name                     text not null,
  supplier                 text,
  supplier_email           text,
  brand                    text,
  supplier_item_code       text,
  quantity_per_item        numeric(12,3) not null default 1 check (quantity_per_item > 0),
  unit                     text not null default 'ea',
  price_trade              numeric(12,2) check (price_trade >= 0),
  finish                   text,
  product_url              text,
  lead_time_weeks          numeric(6,1) check (lead_time_weeks >= 0),
  ordered_at               date,
  eta                      date,
  delivered_at             date,
  trade_price_received_at  date,
  trade_price_source       text,
  sort                     integer not null default 0,
  created_by               uuid references profiles(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz
);

create index if not exists idx_item_components_item
  on item_components(item_id, sort)
  where deleted_at is null;
create index if not exists idx_item_components_library
  on item_components(library_item_id)
  where library_item_id is not null and deleted_at is null;

drop trigger if exists trg_item_components_updated_at on item_components;
create trigger trg_item_components_updated_at
  before update on item_components
  for each row execute function set_updated_at();

alter table item_components enable row level security;
drop policy if exists "team_all" on item_components;
create policy "team_all" on item_components
  for all to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

comment on table item_components is
  'Separately purchasable parts that make one client-facing specification item. Component cost and procurement dates roll up to items.';
comment on column item_components.quantity_per_item is
  'Number of this component required for one parent specification item. Project requirement is parent items.quantity multiplied by this value.';
comment on table library_item_components is
  'Reusable assembly recipe copied to item_components whenever its parent library product is added to a project.';

create or replace function refresh_item_assembly(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_priced_count integer;
  v_unit_cost numeric(12,2);
  v_lead_time numeric(6,1);
  v_all_ordered boolean;
  v_ordered_at date;
  v_eta date;
  v_all_delivered boolean;
  v_delivered_at date;
begin
  select
    count(*),
    count(price_trade),
    round(sum(quantity_per_item * price_trade), 2),
    max(lead_time_weeks),
    bool_and(ordered_at is not null),
    max(ordered_at),
    max(eta),
    bool_and(delivered_at is not null),
    max(delivered_at)
  into
    v_count,
    v_priced_count,
    v_unit_cost,
    v_lead_time,
    v_all_ordered,
    v_ordered_at,
    v_eta,
    v_all_delivered,
    v_delivered_at
  from item_components
  where item_id = p_item_id
    and deleted_at is null;

  update items
  set price_trade = case
        when v_count = 0 then null
        when v_priced_count = v_count then v_unit_cost
        else null
      end,
      lead_time_weeks = case when v_count = 0 then null else v_lead_time end,
      ordered_at = case when v_count > 0 and v_all_ordered then v_ordered_at else null end,
      eta = case when v_count = 0 then null else v_eta end,
      delivered_at = case
        when v_count > 0 and v_all_delivered then v_delivered_at
        else null
      end
  where id = p_item_id;
end;
$$;

create or replace function trg_refresh_item_assembly()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform refresh_item_assembly(coalesce(new.item_id, old.item_id));
  if tg_op = 'UPDATE' and new.item_id <> old.item_id then
    perform refresh_item_assembly(old.item_id);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_item_components_rollup on item_components;
create trigger trg_item_components_rollup
  after insert or update or delete on item_components
  for each row execute function trg_refresh_item_assembly();

create or replace function refresh_library_assembly_price(p_library_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_priced_count integer;
  v_price numeric(12,2);
begin
  select
    count(*),
    count(coalesce(component.price_trade, recipe.price_trade)),
    round(sum(recipe.quantity_per_item * coalesce(component.price_trade, recipe.price_trade)), 2)
  into v_count, v_priced_count, v_price
  from library_item_components recipe
  left join library_items component on component.id = recipe.component_library_item_id
  where recipe.parent_library_item_id = p_library_item_id;

  if v_count > 0 then
    update library_items
    set price_trade = case when v_priced_count = v_count then v_price else null end
    where id = p_library_item_id;
  end if;
end;
$$;

create or replace function trg_refresh_library_assembly()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform refresh_library_assembly_price(
    coalesce(new.parent_library_item_id, old.parent_library_item_id)
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_library_item_components_rollup on library_item_components;
create trigger trg_library_item_components_rollup
  after insert or update or delete on library_item_components
  for each row execute function trg_refresh_library_assembly();

create or replace function trg_refresh_parent_library_assemblies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent uuid;
begin
  if old.price_trade is not distinct from new.price_trade then return new; end if;
  for v_parent in
    select distinct parent_library_item_id
    from library_item_components
    where component_library_item_id = new.id
  loop
    perform refresh_library_assembly_price(v_parent);
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_library_items_assembly_price on library_items;
create trigger trg_library_items_assembly_price
  after update of price_trade on library_items
  for each row execute function trg_refresh_parent_library_assemblies();

-- Widen every polymorphic invoice destination to include a component.
alter table invoices
  drop constraint if exists invoices_proposed_match_type_check;
alter table invoices
  add constraint invoices_proposed_match_type_check
    check (proposed_match_type in ('cost_line', 'item', 'item_component'));

alter table invoice_allocations
  drop constraint if exists invoice_allocations_match_type_check;
alter table invoice_allocations
  add constraint invoice_allocations_match_type_check
    check (match_type in ('cost_line', 'item', 'item_component'));

alter table supplier_invoice_lines
  drop constraint if exists supplier_invoice_lines_suggested_match_type_check;
alter table supplier_invoice_lines
  add constraint supplier_invoice_lines_suggested_match_type_check
    check (suggested_match_type in ('cost_line', 'item', 'item_component'));

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
      if v_linked_count = 0 then raise exception 'A matched item has no linked estimate cost line';
      elsif v_linked_count > 1 then raise exception 'A matched item has more than one linked estimate cost line';
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
      if v_linked_count = 0 then raise exception 'A matched assembly has no linked estimate cost line';
      elsif v_linked_count > 1 then raise exception 'A matched assembly has more than one linked estimate cost line';
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

  -- Reuse the setter's validation against current project membership.
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
    else
      if not exists (
        select 1 from item_components component
        join items item on item.id = component.item_id
        where component.id = v_allocation.match_id
          and component.deleted_at is null
          and item.deleted_at is null
          and item.project_id = v_invoice.project_id
      ) then raise exception 'A matched assembly component was not found in this project'; end if;
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

    if v_allocation.match_type = 'cost_line' then
      v_line_id := v_allocation.match_id;
      select item_id into v_item_id from cost_lines where id = v_line_id;
    elsif v_allocation.match_type = 'item' then
      v_item_id := v_allocation.match_id;
      select id into v_line_id
      from cost_lines
      where item_id = v_item_id
        and project_id = v_invoice.project_id
        and deleted_at is null;
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
        and deleted_at is null;
    end if;

    update cost_lines
    set actual_paid_ex_gst = round(coalesce(actual_paid_ex_gst, 0) + v_allocation.amount_ex_gst, 2)
    where id = v_line_id;

    if v_allocation.apply_to_library_cost and v_item_id is not null then
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

      if v_library_item_id is not null then
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

revoke all on function refresh_item_assembly(uuid) from public;
revoke all on function refresh_item_assembly(uuid) from anon, authenticated;
grant execute on function refresh_item_assembly(uuid) to service_role;
revoke all on function refresh_library_assembly_price(uuid) from public;
revoke all on function refresh_library_assembly_price(uuid) from anon, authenticated;
grant execute on function refresh_library_assembly_price(uuid) to service_role;
revoke all on function set_supplier_invoice_allocations(uuid, jsonb) from public;
grant execute on function set_supplier_invoice_allocations(uuid, jsonb) to authenticated;
grant execute on function set_supplier_invoice_allocations(uuid, jsonb) to service_role;
revoke all on function approve_supplier_invoice_allocations(uuid, uuid) from public;
grant execute on function approve_supplier_invoice_allocations(uuid, uuid) to authenticated;
grant execute on function approve_supplier_invoice_allocations(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
