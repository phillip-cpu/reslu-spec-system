-- Project type is the upstream signal for the draft Timeline and, in later
-- finance slices, the payment-stage and procurement defaults. Existing
-- projects remain nullable so rollout does not guess their type or rewrite an
-- established programme.

alter table projects
  add column if not exists project_type text;

alter table projects
  add column if not exists project_subtype text;

alter table projects
  drop constraint if exists projects_project_type_check;
alter table projects
  add constraint projects_project_type_check
    check (
      project_type is null
      or project_type in (
        'new_build',
        'whole_home_renovation',
        'extension',
        'single_room_renovation'
      )
    );

alter table projects
  drop constraint if exists projects_project_subtype_check;
alter table projects
  add constraint projects_project_subtype_check
    check (
      (project_type = 'single_room_renovation'
        and project_subtype in ('kitchen', 'bathroom', 'ensuite', 'laundry', 'other'))
      or (project_type is distinct from 'single_room_renovation' and project_subtype is null)
    );

create index if not exists idx_projects_project_type
  on projects(project_type)
  where deleted_at is null;

comment on column projects.project_type is
  'Job framework selector: drives the editable draft Timeline template and downstream payment/procurement defaults.';
comment on column projects.project_subtype is
  'Room type for single-room renovations; null for every other project type.';

-- Keep the original website-intake leads.project_type text untouched as the
-- prospect's raw answer. These structured fields are the internal checked
-- classification that carries forward into projects.
alter table leads
  add column if not exists project_type_code text;

alter table leads
  add column if not exists project_subtype text;

alter table leads
  drop constraint if exists leads_project_type_code_check;
alter table leads
  add constraint leads_project_type_code_check
    check (
      project_type_code is null
      or project_type_code in (
        'new_build',
        'whole_home_renovation',
        'extension',
        'single_room_renovation'
      )
    );

alter table leads
  drop constraint if exists leads_project_subtype_check;
alter table leads
  add constraint leads_project_subtype_check
    check (
      (project_type_code = 'single_room_renovation'
        and project_subtype in ('kitchen', 'bathroom', 'ensuite', 'laundry', 'other'))
      or (project_type_code is distinct from 'single_room_renovation' and project_subtype is null)
    );

comment on column leads.project_type_code is
  'Internal checked project type; distinct from the prospect-provided raw leads.project_type answer.';
comment on column leads.project_subtype is
  'Checked room type for a single-room renovation lead; copied into the project when progressed.';

notify pgrst, 'reload schema';
