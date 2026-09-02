-- Cover the audit-user foreign key for contact/profile cleanup and satisfy the
-- post-migration Supabase performance advisor.
create index if not exists idx_project_trade_assignments_created_by
  on public.project_trade_assignments(created_by);
