-- Link each project-specific contract claim to the operational event that
-- controls its forecast date. Contract amounts stay on the payment schedule;
-- the construction program supplies timing without copying its dates.

alter table client_payment_schedule
  add column if not exists trigger_type text not null default 'manual';

alter table client_payment_schedule
  add column if not exists schedule_phase_id uuid;

alter table client_payment_schedule
  drop constraint if exists client_payment_schedule_trigger_type_check;
alter table client_payment_schedule
  add constraint client_payment_schedule_trigger_type_check
    check (trigger_type in ('contract_signed', 'schedule_phase', 'manual'));

alter table client_payment_schedule
  drop constraint if exists client_payment_schedule_schedule_phase_id_fkey;
alter table client_payment_schedule
  add constraint client_payment_schedule_schedule_phase_id_fkey
    foreign key (schedule_phase_id)
    references schedule_phases(id) on delete set null;

create index if not exists idx_client_payment_schedule_phase
  on client_payment_schedule(schedule_phase_id)
  where schedule_phase_id is not null and deleted_at is null;

-- Existing package templates explicitly describe deposits as due on contract
-- execution. Preserve that meaning when introducing trigger_type; every other
-- legacy row remains manual until an admin links it to the correct program
-- phase for that particular job.
update client_payment_schedule
set trigger_type = 'contract_signed',
    schedule_phase_id = null,
    milestone_date = null
where lower(trim(label)) like 'deposit%'
  and trigger_type = 'manual';

comment on column client_payment_schedule.trigger_type is
  'Controls the forecast claim date: contract_signed uses client_billing_profiles.contract_signed_at; schedule_phase uses the linked phase end date; manual uses milestone_date.';

comment on column client_payment_schedule.schedule_phase_id is
  'Optional link to the construction program. Its current end_date drives the forecast claim date so program moves flow through without rewriting contract amounts.';

notify pgrst, 'reload schema';
