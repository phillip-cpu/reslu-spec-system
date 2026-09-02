-- Explicitly connect a directly-procured FF&E item to the Work activity that
-- needs it on site. An item may have more than one requirement (for example a
-- concealed mixer body at rough-in and trim at fit-off); the earliest dated
-- requirement becomes the procurement constraint.

create table if not exists public.item_schedule_requirements (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  item_id        uuid not null references public.items(id) on delete cascade,
  board_task_id  uuid not null references public.board_tasks(id) on delete cascade,
  buffer_days    integer not null default 0,
  notes          text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint item_schedule_requirements_item_task_unique
    unique (item_id, board_task_id),
  constraint item_schedule_requirements_buffer_range
    check (buffer_days between 0 and 365),
  constraint item_schedule_requirements_notes_length
    check (notes is null or char_length(notes) <= 1000)
);

create index if not exists idx_item_schedule_requirements_project
  on public.item_schedule_requirements(project_id, item_id);
create index if not exists idx_item_schedule_requirements_task
  on public.item_schedule_requirements(board_task_id);
create index if not exists idx_item_schedule_requirements_created_by
  on public.item_schedule_requirements(created_by);

drop trigger if exists trg_item_schedule_requirements_updated_at
  on public.item_schedule_requirements;
create trigger trg_item_schedule_requirements_updated_at
  before update on public.item_schedule_requirements
  for each row execute function public.set_updated_at();

-- project_id is deliberately stored for bounded project reads and RLS, so
-- defend it against drift from both linked rows at the database boundary.
-- Reference-only trade-package items cannot create standalone procurement
-- requirements because their cost and purchasing live inside the trade quote.
create or replace function public.validate_item_schedule_requirement()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item_project uuid;
  v_item_scope text;
  v_item_deleted timestamptz;
  v_task_project uuid;
  v_task_deleted timestamptz;
begin
  select project_id, cost_scope, deleted_at
    into v_item_project, v_item_scope, v_item_deleted
    from public.items
   where id = new.item_id;

  if v_item_project is null or v_item_deleted is not null then
    raise exception 'active item not found';
  end if;
  if v_item_scope is distinct from 'direct' then
    raise exception 'trade-package items do not have separate procurement requirements';
  end if;

  select project_id, deleted_at
    into v_task_project, v_task_deleted
    from public.board_tasks
   where id = new.board_task_id;

  if v_task_project is null or v_task_deleted is not null then
    raise exception 'active work activity not found';
  end if;
  if new.project_id <> v_item_project or new.project_id <> v_task_project then
    raise exception 'item and work activity must belong to the same project';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_item_schedule_requirements_validate
  on public.item_schedule_requirements;
create trigger trg_item_schedule_requirements_validate
  before insert or update of project_id, item_id, board_task_id
  on public.item_schedule_requirements
  for each row execute function public.validate_item_schedule_requirement();

alter table public.item_schedule_requirements enable row level security;

drop policy if exists "team_all" on public.item_schedule_requirements;
create policy "team_all" on public.item_schedule_requirements
  for all to authenticated using (true) with check (true);

revoke all on table public.item_schedule_requirements
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.item_schedule_requirements to authenticated, service_role;

revoke all on function public.validate_item_schedule_requirement()
  from public, anon;
grant execute on function public.validate_item_schedule_requirement()
  to authenticated, service_role;

comment on table public.item_schedule_requirements is
  'Required-on-site links from directly procured FF&E items to Work activities. Dates flow from Board/Timeline into procurement and Finance.';
comment on column public.item_schedule_requirements.buffer_days is
  'Optional calendar-day buffer before the linked activity date; subtracted before item lead time when deriving order-by.';

notify pgrst, 'reload schema';
