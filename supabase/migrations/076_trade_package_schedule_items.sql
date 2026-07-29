-- Schedule-only reference items.
--
-- Some selections (for example cabinet hardware) need to remain in the
-- specification schedule for quality/documentation, while their supply,
-- procurement and cost are included in another trade's package.
alter table public.items
  add column if not exists cost_scope text not null default 'direct';

alter table public.items
  drop constraint if exists items_cost_scope_check;

alter table public.items
  add constraint items_cost_scope_check
  check (cost_scope in ('direct', 'trade_package'));

comment on column public.items.cost_scope is
  'direct = separately costed/procured; trade_package = shown in schedules but excluded from room, cost, procurement and ordering requirements.';

-- Moving an existing item into a trade package intentionally clears its
-- room allocations. The schedule row remains; only the separate room
-- requirement disappears.
create or replace function public.clear_trade_package_item_rooms()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.cost_scope = 'trade_package'
     and old.cost_scope is distinct from new.cost_scope then
    delete from public.item_rooms where item_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_items_clear_trade_package_rooms on public.items;
create trigger trg_items_clear_trade_package_rooms
after update of cost_scope on public.items
for each row execute function public.clear_trade_package_item_rooms();

-- Defence in depth: reference items cannot be accidentally put back into a
-- room by a bulk assignment or a direct API/database write.
create or replace function public.prevent_trade_package_room_assignment()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.items
    where id = new.item_id
      and cost_scope = 'trade_package'
  ) then
    raise exception 'Items included in a trade package cannot be assigned to a room';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_item_rooms_prevent_trade_package on public.item_rooms;
create trigger trg_item_rooms_prevent_trade_package
before insert or update of item_id on public.item_rooms
for each row execute function public.prevent_trade_package_room_assignment();

notify pgrst, 'reload schema';
