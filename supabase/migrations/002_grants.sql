-- ============================================================
-- RESLU Spec System — Role grants (fix for "permission denied")
-- ============================================================
-- Symptom: every API read fails with
--   42501  "permission denied for table <name>"
-- for anon, authenticated AND service_role.
--
-- Cause: the tables in 001_initial.sql were created, but the standard
-- Supabase role privileges on the `public` schema were never applied,
-- so no role can touch the tables. Row Level Security still gates
-- *rows* (policies in 001_initial.sql); these GRANTs gate *table access*
-- — both layers are required. Granting here does NOT weaken the RLS
-- model: `authenticated` is already the trusted team role (team_all
-- policy), and `service_role` bypasses RLS by design for the portal.
-- `anon` is deliberately NOT granted — this app never reads public
-- tables anonymously (login uses the auth schema; the portal uses the
-- service role server-side).
--
-- Run this once in the Supabase SQL Editor. Idempotent — safe to re-run.
-- ============================================================

grant usage on schema public to authenticated, service_role;

grant all on all tables    in schema public to authenticated, service_role;
grant all on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

-- Ensure any tables/sequences/functions created later inherit the same grants.
alter default privileges in schema public
  grant all on tables to authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to authenticated, service_role;
