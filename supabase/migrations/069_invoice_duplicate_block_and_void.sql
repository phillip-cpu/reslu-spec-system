-- Supplier invoices: supplier-independent duplicate protection and
-- reversible voiding of an approved invoice.

alter table invoices
  add column if not exists voided_by uuid references profiles(id) on delete set null,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text;

alter table invoices drop constraint if exists invoices_status_check;
alter table invoices
  add constraint invoices_status_check
  check (status in ('unmatched', 'proposed', 'approved', 'rejected', 'voided'));

comment on column invoices.voided_by is
  'Admin who voided the supplier invoice. Approved invoices are reversed atomically before this is set.';
comment on column invoices.voided_at is
  'When the invoice was voided. The row and allocations remain as audit evidence.';
comment on column invoices.void_reason is
  'Human-readable reason for voiding, e.g. duplicate invoice entry.';

create or replace function find_live_invoice_duplicate(
  p_project_id uuid,
  p_invoice_number text,
  p_amount_ex_gst numeric,
  p_invoice_date date,
  p_exclude_id uuid default null
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select i.id
  from invoices i
  where i.project_id = p_project_id
    and lower(btrim(i.invoice_number)) = lower(btrim(p_invoice_number))
    and i.amount_ex_gst = round(p_amount_ex_gst, 2)
    and i.invoice_date is not distinct from p_invoice_date
    and i.status not in ('rejected', 'voided')
    and (p_exclude_id is null or i.id <> p_exclude_id)
  order by i.created_at
  limit 1;
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
  v_line_id uuid;
  v_item_id uuid;
  v_linked_count integer;
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
      order by sort, created_at
    loop
      v_line_id := null;
      v_item_id := null;
      v_linked_count := 0;

      if v_allocation.match_type = 'cost_line' then
        v_line_id := v_allocation.match_id;
      elsif v_allocation.match_type = 'item' then
        v_item_id := v_allocation.match_id;
      else
        select component.item_id into v_item_id
        from item_components component
        where component.id = v_allocation.match_id
          and component.deleted_at is null;
      end if;

      if v_item_id is not null then
        select count(*)
        into v_linked_count
        from cost_lines
        where item_id = v_item_id
          and project_id = v_invoice.project_id
          and deleted_at is null;
        if v_linked_count > 1 then
          raise exception 'Cannot reverse an allocation with more than one linked estimate cost line';
        end if;
        if v_linked_count = 1 then
          select id
          into v_line_id
          from cost_lines
          where item_id = v_item_id
            and project_id = v_invoice.project_id
            and deleted_at is null
          limit 1;
        end if;
      end if;

      if v_line_id is not null then
        select actual_paid_ex_gst into v_current_actual
        from cost_lines
        where id = v_line_id
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
        set actual_paid_ex_gst = round(coalesce(actual_paid_ex_gst, 0) - v_allocation.amount_ex_gst, 2)
        where id = v_line_id;
      end if;
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

-- A voided invoice is immutable audit evidence: it cannot be reopened
-- or have its saved allocations changed through a direct RPC call.
create or replace function prevent_voided_invoice_reopen()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'voided' and new.status <> 'voided' then
    raise exception 'A voided invoice cannot be reopened';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_voided_invoice_reopen on invoices;
create trigger trg_prevent_voided_invoice_reopen
  before update of status on invoices
  for each row execute function prevent_voided_invoice_reopen();

create or replace function prevent_voided_invoice_allocation_change()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invoice_id uuid;
begin
  v_invoice_id := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
  if exists (
    select 1 from invoices where id = v_invoice_id and status = 'voided'
  ) then
    raise exception 'Allocations for a voided invoice cannot be changed';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_prevent_voided_invoice_allocation_change on invoice_allocations;
create trigger trg_prevent_voided_invoice_allocation_change
  before insert or update or delete on invoice_allocations
  for each row execute function prevent_voided_invoice_allocation_change();

-- Immediate correction from the 24 Jul 2026 audit: keep the earlier
-- Goldsworthy INV-19072026 row and reverse/void the later duplicate.
do $$
begin
  if exists (
    select 1
    from invoices
    where id = 'c9c2578b-db1f-4d9e-aed6-0fb76397d32e'
      and status = 'approved'
  ) then
    perform void_supplier_invoice(
      'c9c2578b-db1f-4d9e-aed6-0fb76397d32e',
      null,
      'Duplicate of INV-19072026 entered under alternate supplier-name formatting'
    );
  end if;
end;
$$;

drop index if exists idx_invoices_project_supplier_number_live;
create unique index if not exists idx_invoices_project_number_amount_date_live
  on invoices (
    project_id,
    lower(btrim(invoice_number)),
    amount_ex_gst,
    coalesce(invoice_date, date '0001-01-01')
  )
  where status not in ('rejected', 'voided');

revoke all on function find_live_invoice_duplicate(uuid, text, numeric, date, uuid) from public;
grant execute on function find_live_invoice_duplicate(uuid, text, numeric, date, uuid) to authenticated;
grant execute on function find_live_invoice_duplicate(uuid, text, numeric, date, uuid) to service_role;
revoke all on function void_supplier_invoice(uuid, uuid, text) from public;
grant execute on function void_supplier_invoice(uuid, uuid, text) to authenticated;
grant execute on function void_supplier_invoice(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
