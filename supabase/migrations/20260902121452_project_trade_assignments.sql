-- One durable contractor choice per project/trade. Scope of Works and
-- unbooked Work tasks inherit this mapping; a task that has been manually
-- overridden or already linked to a visit is deliberately left alone.

create table if not exists public.project_trade_assignments (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  trade_role  text not null,
  role_key    text not null,
  contact_id  uuid references public.contacts(id) on delete set null,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint project_trade_assignments_role_not_blank
    check (btrim(trade_role) <> '' and char_length(btrim(trade_role)) <= 120),
  constraint project_trade_assignments_role_key_matches
    check (role_key = lower(btrim(trade_role))),
  constraint project_trade_assignments_project_role_unique
    unique (project_id, role_key)
);

create index if not exists idx_project_trade_assignments_contact
  on public.project_trade_assignments(contact_id);
create index if not exists idx_project_trade_assignments_created_by
  on public.project_trade_assignments(created_by);

drop trigger if exists trg_project_trade_assignments_updated_at
  on public.project_trade_assignments;
create trigger trg_project_trade_assignments_updated_at
  before update on public.project_trade_assignments
  for each row execute function public.set_updated_at();

alter table public.project_trade_assignments enable row level security;

drop policy if exists "team_all" on public.project_trade_assignments;
create policy "team_all" on public.project_trade_assignments
  for all to authenticated using (true) with check (true);

-- A task keeps the canonical role separately from the actual contact. The
-- boolean distinguishes an inherited project-team contact from an explicit
-- per-task override, which is what lets a later project-team change update
-- only safe, unbooked rows.
alter table public.board_tasks
  add column if not exists trade_role text;

alter table public.board_tasks
  add column if not exists trade_contact_inherited boolean not null default false;

create index if not exists idx_board_tasks_project_trade_role
  on public.board_tasks(project_id, lower(btrim(trade_role)))
  where deleted_at is null and trade_role is not null;

-- Atomically set the project-team mapping and flow it through to every task
-- that still inherits the role default. Linked visits and explicit task
-- contact overrides are historical/intentional and are never rewritten.
create or replace function public.set_project_trade_assignment(
  p_project_id uuid,
  p_trade_role text,
  p_contact_id uuid
)
returns setof public.project_trade_assignments
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_role text := btrim(p_trade_role);
  v_assignment public.project_trade_assignments;
begin
  if v_role = '' or char_length(v_role) > 120 then
    raise exception 'trade_role must be between 1 and 120 characters';
  end if;
  if p_contact_id is null then
    raise exception 'contact_id is required';
  end if;
  if not exists (
    select 1
      from public.contacts
     where id = p_contact_id
       and deleted_at is null
  ) then
    raise exception 'active contact not found';
  end if;

  insert into public.project_trade_assignments (
    project_id,
    trade_role,
    role_key,
    contact_id,
    created_by
  )
  values (
    p_project_id,
    v_role,
    lower(v_role),
    p_contact_id,
    auth.uid()
  )
  on conflict (project_id, role_key) do update
    set trade_role = excluded.trade_role,
        contact_id = excluded.contact_id
  returning * into v_assignment;

  update public.board_tasks
     set contact_id = p_contact_id
   where project_id = p_project_id
     and deleted_at is null
     and visit_id is null
     and trade_contact_inherited = true
     and lower(btrim(trade_role)) = lower(v_role);

  return next v_assignment;
end;
$$;

-- Clearing a project-team role clears only inherited, unbooked task contacts.
-- The tasks keep their role + inheritance flag, so choosing a replacement
-- contractor later reconnects them automatically.
create or replace function public.clear_project_trade_assignment(
  p_project_id uuid,
  p_trade_role text
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_role_key text := lower(btrim(p_trade_role));
  v_deleted integer := 0;
begin
  if v_role_key = '' then
    raise exception 'trade_role is required';
  end if;

  delete from public.project_trade_assignments
   where project_id = p_project_id
     and role_key = v_role_key;
  get diagnostics v_deleted = row_count;

  update public.board_tasks
     set contact_id = null
   where project_id = p_project_id
     and deleted_at is null
     and visit_id is null
     and trade_contact_inherited = true
     and lower(btrim(trade_role)) = v_role_key;

  return v_deleted;
end;
$$;

-- Explicit privileges are intentional: newer Supabase projects may not
-- expose new public-schema tables/functions through the Data API by default.
revoke all on table public.project_trade_assignments
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.project_trade_assignments to authenticated, service_role;
grant execute on function public.set_project_trade_assignment(uuid, text, uuid)
  to authenticated, service_role;
grant execute on function public.clear_project_trade_assignment(uuid, text)
  to authenticated, service_role;

revoke all on function public.set_project_trade_assignment(uuid, text, uuid)
  from public, anon;
revoke all on function public.clear_project_trade_assignment(uuid, text)
  from public, anon;

comment on table public.project_trade_assignments is
  'One project-level Address Book contractor selection per canonical trade role. Reused by Scope of Works and inherited by unbooked Work tasks.';
comment on column public.board_tasks.trade_role is
  'Canonical project trade role (normally an export-presets name such as Carpenter or Plumber). Separate from contact_id so a contractor can change without losing the task role.';
comment on column public.board_tasks.trade_contact_inherited is
  'True when contact_id follows project_trade_assignments. False for explicit per-task contact choices and for tasks already linked to a visit.';

notify pgrst, 'reload schema';
