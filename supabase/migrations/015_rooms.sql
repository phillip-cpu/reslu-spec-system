-- ============================================================
-- RESLU Spec System — Rooms + per-room item quantities
-- Feature: on the spec register, multi-select items and bulk-assign them
-- to one or more rooms (Ensuite, Bathroom, Kitchen …), each with its OWN
-- quantity in that room (an item can be qty 2 in Ensuite and 1 in
-- Bathroom). Drives a trade-facing per-room PDF ("what goes in each room").
--
-- Model: `rooms` (per project) + `item_rooms` (item ↔ room join carrying
-- the per-room quantity). This is additive — items.location (single free-
-- text) and items.quantity (overall) are untouched; rooms are a richer,
-- optional layer on top. An item's per-room quantities are independent
-- allocations; the UI surfaces their sum against items.quantity.
--
-- Idempotent throughout (create ... if not exists / drop+create triggers &
-- policies) so a partial apply — the join table's FKs touch the hot `items`
-- table and can lock-timeout — converges on re-run.
-- ============================================================

create table if not exists rooms (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_rooms_project on rooms(project_id, sort);

drop trigger if exists trg_rooms_updated_at on rooms;
create trigger trg_rooms_updated_at
  before update on rooms
  for each row execute function set_updated_at();

-- item ↔ room, carrying the per-room quantity. UNIQUE(item_id, room_id) so
-- an item appears at most once per room (assigning again updates the qty).
-- quantity is numeric to match items.quantity (supports fractional units
-- like 2.5 lm). Both FKs cascade-delete so removing an item or a room
-- cleans up its allocations.
create table if not exists item_rooms (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references items(id) on delete cascade,
  room_id     uuid not null references rooms(id) on delete cascade,
  quantity    numeric not null default 1 check (quantity >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (item_id, room_id)
);

create index if not exists idx_item_rooms_item on item_rooms(item_id);
create index if not exists idx_item_rooms_room on item_rooms(room_id);

drop trigger if exists trg_item_rooms_updated_at on item_rooms;
create trigger trg_item_rooms_updated_at
  before update on item_rooms
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security — plain "team_all" (house style).
-- ============================================================
alter table rooms enable row level security;
alter table item_rooms enable row level security;

drop policy if exists "team_all" on rooms;
create policy "team_all" on rooms
  for all to authenticated using (true) with check (true);
drop policy if exists "team_all" on item_rooms;
create policy "team_all" on item_rooms
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
