-- Additional client contract packages that sit above the original contract.
-- A variation remains inside the same project but owns its own value, terms
-- and payment schedule so it is never blended into the base milestones.

create table if not exists client_contract_variations (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references projects(id) on delete cascade,
  label                 text not null,
  amount_inc_gst        numeric(12,2) not null check (amount_inc_gst > 0),
  due_days              int not null default 7 check (due_days >= 0),
  reference             text,
  approved_at           date,
  status                text not null default 'active' check (status in ('active', 'void')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

drop trigger if exists trg_client_contract_variations_updated_at on client_contract_variations;
create trigger trg_client_contract_variations_updated_at
  before update on client_contract_variations
  for each row execute function set_updated_at();

create index if not exists idx_client_contract_variations_project
  on client_contract_variations(project_id, created_at)
  where deleted_at is null;

alter table client_contract_variations enable row level security;
drop policy if exists "team_all" on client_contract_variations;
create policy "team_all" on client_contract_variations
  for all to authenticated using (true) with check (true);

alter table client_payment_schedule
  add column if not exists contract_variation_id uuid;

alter table client_payment_schedule
  drop constraint if exists client_payment_schedule_contract_variation_id_fkey;
alter table client_payment_schedule
  add constraint client_payment_schedule_contract_variation_id_fkey
    foreign key (contract_variation_id)
    references client_contract_variations(id) on delete restrict;

create index if not exists idx_client_payment_schedule_contract_variation
  on client_payment_schedule(contract_variation_id, sort)
  where deleted_at is null;

comment on table client_contract_variations is
  'Additional client-facing contract packages within the same project. Each package has an independent payment schedule and rolls into project/company money-in.';
comment on column client_payment_schedule.contract_variation_id is
  'Null means the original contract schedule. A value assigns this milestone exclusively to an additional variation package.';

notify pgrst, 'reload schema';
