-- Start Aria's documented 12-week Reslu education programme.
-- Enrolments are evidence/workflow records only: they grant no business,
-- professional, approval, or trusted-memory authority.

with reviewer as (
  select id from public.profiles where role = 'admin' order by created_at limit 1
), schedule(module_key, state, started_at, review_due_at) as (
  values
    ('source-ncc',         'in_progress', timestamptz '2026-08-14 09:00:00 Australia/Adelaide', timestamptz '2026-08-28 17:00:00 Australia/Adelaide'),
    ('planning',           'planned',     null, timestamptz '2026-09-11 17:00:00 Australia/Adelaide'),
    ('licensing',          'planned',     null, timestamptz '2026-09-18 17:00:00 Australia/Adelaide'),
    ('whs',                'planned',     null, timestamptz '2026-10-02 17:00:00 Australia/Adelaide'),
    ('environment',        'planned',     null, timestamptz '2026-10-09 17:00:00 Australia/Adelaide'),
    ('procurement',        'planned',     null, timestamptz '2026-10-16 17:00:00 Australia/Adelaide'),
    ('sustainable-design', 'planned',     null, timestamptz '2026-10-23 17:00:00 Australia/Adelaide'),
    ('project-operations', 'planned',     null, timestamptz '2026-10-30 17:00:00 Australia/Adelaide'),
    ('agent-capstone',     'planned',     null, timestamptz '2026-11-06 17:00:00 Australia/Adelaide')
)
insert into public.aria_learning_enrolments (
  module_key, state, started_at, review_due_at, reviewer_profile_id
)
select schedule.module_key, schedule.state, schedule.started_at,
       schedule.review_due_at, reviewer.id
from schedule cross join reviewer
on conflict (module_key) do nothing;

