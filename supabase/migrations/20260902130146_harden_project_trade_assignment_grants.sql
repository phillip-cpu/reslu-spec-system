-- The legacy project default privileges grant ALL on new public tables.
-- Reduce the project trade roster to the four operations its authenticated
-- API needs; no team client should be able to TRUNCATE it or create triggers.
revoke all on table public.project_trade_assignments
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.project_trade_assignments to authenticated, service_role;

notify pgrst, 'reload schema';
