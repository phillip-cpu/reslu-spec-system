-- ============================================================
-- RESLU Spec System — project delivery allowances.
--
-- Delivery is a project cost, not part of a reusable product's unit
-- price. A delivery allowance is therefore a normal estimate line
-- whose client quote remains intact while approved supplier freight
-- accumulates in actual_paid_ex_gst. Optional FF&E links provide
-- traceability without mutating items.price_trade/library_items.
-- ============================================================

alter table cost_lines
  add column if not exists line_kind text not null default 'standard';

alter table cost_lines
  drop constraint if exists cost_lines_line_kind_check;
alter table cost_lines
  add constraint cost_lines_line_kind_check
  check (line_kind in ('standard', 'delivery_allowance'));

create index if not exists idx_cost_lines_delivery_allowance
  on cost_lines(project_id, section_id)
  where line_kind = 'delivery_allowance' and deleted_at is null;

comment on column cost_lines.line_kind is
  'standard, or delivery_allowance. Delivery allowances retain the quoted client amount while supplier freight posts separately to actual_paid_ex_gst.';

create table if not exists invoice_allocation_delivery_items (
  invoice_allocation_id uuid not null references invoice_allocations(id) on delete cascade,
  item_id uuid not null references items(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (invoice_allocation_id, item_id)
);

create index if not exists idx_invoice_delivery_items_item
  on invoice_allocation_delivery_items(item_id);

alter table invoice_allocation_delivery_items enable row level security;
drop policy if exists "team_all" on invoice_allocation_delivery_items;
create policy "team_all" on invoice_allocation_delivery_items
  for all to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

comment on table invoice_allocation_delivery_items is
  'Optional FF&E context for actual delivery allocations. The financial actual posts to a delivery_allowance cost line; these links never change product or library unit prices.';

create or replace function validate_invoice_delivery_item_link()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invoice_project uuid;
  v_item_project uuid;
  v_match_type text;
  v_line_kind text;
  v_apply_library boolean;
begin
  select invoice.project_id, allocation.match_type, line.line_kind,
         allocation.apply_to_library_cost
  into v_invoice_project, v_match_type, v_line_kind, v_apply_library
  from invoice_allocations allocation
  join invoices invoice on invoice.id = allocation.invoice_id
  left join cost_lines line
    on allocation.match_type = 'cost_line' and line.id = allocation.match_id
  where allocation.id = new.invoice_allocation_id;

  if not found then raise exception 'Invoice allocation not found'; end if;
  if v_match_type <> 'cost_line' or v_line_kind <> 'delivery_allowance' then
    raise exception 'Actual delivery must be allocated to a Delivery allowance';
  end if;
  if v_apply_library then
    raise exception 'Actual delivery cannot update a reusable library price';
  end if;

  select project_id into v_item_project
  from items
  where id = new.item_id and deleted_at is null;
  if not found or v_item_project <> v_invoice_project then
    raise exception 'Related FF&E item must belong to the invoice project';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_invoice_delivery_item_link
  on invoice_allocation_delivery_items;
create trigger trg_validate_invoice_delivery_item_link
  before insert or update on invoice_allocation_delivery_items
  for each row execute function validate_invoice_delivery_item_link();

notify pgrst, 'reload schema';
