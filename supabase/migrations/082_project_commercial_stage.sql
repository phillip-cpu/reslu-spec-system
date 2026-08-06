-- Project delivery stage and signed-contract evidence.
-- Keeps the operational stage on projects, while the client-facing
-- contract amount remains in the existing billing profile (one source
-- of truth for finance, invoices and contract reporting).

alter table projects
  add column if not exists project_stage text not null default 'design';

alter table projects
  drop constraint if exists projects_project_stage_check;
alter table projects
  add constraint projects_project_stage_check
    check (project_stage in (
      'design',
      'quoting',
      'preconstruction',
      'construction',
      'handover',
      'complete',
      'on_hold'
    ));

alter table client_billing_profiles
  add column if not exists contract_reference text;

alter table client_billing_profiles
  add column if not exists contract_signed_at date;

-- Preserve the strongest existing signal when introducing the new stage.
update projects p
set project_stage = 'construction'
from client_billing_profiles billing
where billing.project_id = p.id
  and billing.contract_type = 'construction'
  and p.project_stage = 'design';

create index if not exists idx_projects_project_stage
  on projects(project_stage)
  where deleted_at is null;

comment on column projects.project_stage is
  'Operational delivery stage, separate from active/completed/archive status and from the finance activation lifecycle.';
comment on column client_billing_profiles.contract_reference is
  'Human-readable signed agreement reference; also used as finance activation evidence.';
comment on column client_billing_profiles.contract_signed_at is
  'Date the client contract was signed. Null means no signed contract is recorded.';

notify pgrst, 'reload schema';
